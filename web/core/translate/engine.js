// core/translate/engine.js — main-thread orchestrator of the in-image manga
// translator. Port of nyora-android's ai/MangaTranslator.kt:
//
//   page image → readable bitmap → [worker: bubble detection + OCR + bg
//   sampling] → machine translation (mt.js, same gtx endpoint as Android) →
//   overlay rendering (overlay.js).
//
// Everything runs client-side. The only server ever touched is the EXISTING
// helper /image proxy, and only as a CORS fallback when a CDN won't hand the
// pixels to fetch() directly (an <img> can display them, but a canvas can't
// read them without CORS).
//
// Caches mirror Android's ConcurrentHashMaps: in-memory only, keyed by page
// URL (OCR result) and page URL + target language (translated texts).

import { api } from '../api.js';
import { store } from '../store.js';
import { translateBatch, refineBatch } from './mt.js';

const WORKER_PATH = '/core/translate/tl-worker.js';

let worker = null;
let readyPromise = null;
let nextId = 1;
const pending = new Map();   // id → {resolve, reject}
const ocrCache = new Map();     // pageUrl → Promise<blocks>
const mtCache = new Map();      // pageUrl|target → Promise<texts>
const refineCache = new Map();  // pageUrl|target|model → Promise<texts|null>
let refineFailToasted = false;

// LLM refinement config (Android's ai_endpoint / ai_api_key / ai_model): active
// only when an API key is set. Empty endpoint/model use the provider defaults.
function aiConfig() {
  const p = store.get();
  if (!p.aiApiKey) return null;
  return {
    provider: p.aiProvider === 'anthropic' ? 'anthropic' : 'openai',
    endpoint: p.aiEndpoint || '',
    apiKey: p.aiApiKey,
    model: p.aiModel || '',
    fandom: p.aiFandom === true,
  };
}

// Series/fandom context for accurate names & terms — hybrid lookup:
//   1. MangaBaka resolves the (often messy scanlation) title — it aggregates
//      AniList/MAL/Kitsu/MangaUpdates and matches secondary ja/ko/romanized
//      titles far better than fuzzy search. It also returns the AniList ID.
//   2. AniList, queried BY ID, supplies what MangaBaka lacks: the character
//      roster with native → romanized names (the big accuracy win).
// Either half failing degrades gracefully; one lookup per title, cached.
const seriesCache = new Map();

const stripHtml = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

async function mangaBakaResolve(q) {
  const res = await fetch(`https://api.mangabaka.dev/v1/series/search?q=${encodeURIComponent(q)}&limit=1`,
    { headers: { Accept: 'application/json' } });
  const item = ((await res.json()) || {}).data?.[0];
  if (!item) return null;
  return {
    title: item.title || q,
    description: stripHtml(item.description).slice(0, 600),
    genres: Array.isArray(item.genres) ? item.genres.slice(0, 8) : [],
    anilistId: Number(item.source && item.source.anilist && (item.source.anilist.id ?? item.source.anilist)) || null,
  };
}

async function anilistMedia(vars, selector) {
  const res = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(vars ? { query: selector, variables: vars } : { query: selector }),
  });
  return ((await res.json()) || {}).data?.Media || null;
}

function seriesContext(title) {
  const q = String(title || '').trim();
  if (!q) return Promise.resolve('');
  let p = seriesCache.get(q);
  if (!p) {
    p = (async () => {
      const mb = await mangaBakaResolve(q).catch(() => null);
      const CHARS = 'characters(perPage:15,sort:ROLE){nodes{name{full native}}}';
      let media = null;
      if (mb && mb.anilistId) {
        media = await anilistMedia({ id: mb.anilistId },
          `query($id:Int){Media(id:$id,type:MANGA){title{romaji english} description(asHtml:false) genres ${CHARS}}}`)
          .catch(() => null);
      }
      if (!media) {
        // No MangaBaka hit / no AniList ID — fall back to fuzzy title search.
        media = await anilistMedia({ q: (mb && mb.title) || q },
          `query($q:String){Media(search:$q,type:MANGA){title{romaji english} description(asHtml:false) genres ${CHARS}}}`)
          .catch(() => null);
      }
      const name = (media && (media.title.english || media.title.romaji)) || (mb && mb.title) || '';
      if (!name) return '';
      const genres = (media && media.genres && media.genres.length ? media.genres : (mb ? mb.genres : [])) || [];
      const desc = (media && stripHtml(media.description).slice(0, 600)) || (mb ? mb.description : '');
      const chars = (((media && media.characters && media.characters.nodes) || [])
        .map((c) => (c.name.native ? `${c.name.native} = ${c.name.full}` : c.name.full))
        .filter(Boolean)).join('; ');
      return `Series: ${name}. Genres: ${genres.join(', ')}. Synopsis: ${desc}`
        + (chars ? `\nCharacter names (native = romanized): ${chars}` : '');
    })().catch(() => '');
    seriesCache.set(q, p);
  }
  return p;
}

let statusCb = null;
let lastStatusKey = '';

// The reader subscribes to human-readable status lines (model download
// progress, readiness) and shows them as toasts.
export function onTranslatorStatus(cb) { statusCb = cb; }

function status(label, pct) {
  // Throttle download chatter to 20% steps so toasts don't strobe.
  const key = pct == null ? label : `${label}:${Math.floor(pct / 20)}`;
  if (key === lastStatusKey) return;
  lastStatusKey = key;
  if (statusCb) {
    try { statusCb(pct == null ? label : `${label}… ${pct}%`); } catch { /* ignore */ }
  }
}

function ensureWorker() {
  if (readyPromise) return readyPromise;
  readyPromise = new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      readyPromise = null;
      if (worker) { try { worker.terminate(); } catch { /* ignore */ } worker = null; }
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    try {
      worker = new Worker(WORKER_PATH, { type: 'module' });
    } catch (e) { fail(e); return; }
    worker.onerror = (e) => fail(new Error((e && e.message) || 'translation worker failed'));
    worker.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.type === 'progress') {
        status(m.label, m.pct);
      } else if (m.type === 'ready') {
        settled = true;
        status('Translation models ready');
        resolve();
      } else if (m.type === 'init-error') {
        fail(new Error(m.error));
      } else if (m.type === 'page-progress') {
        const p = pending.get(m.id);
        if (p && p.onProgress) { try { p.onProgress(m); } catch { /* ignore */ } }
      } else if (m.type === 'page-result' || m.type === 'page-error') {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.type === 'page-result') p.resolve(m.blocks);
        else p.reject(new Error(m.error));
      }
    };
    status('Preparing on-device translator (models download on first use)');
    // Ask the browser to protect our storage (the model cache is ~125 MB) from
    // quota eviction. Best-effort; browsers may silently decline.
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch { /* ignore */ }
    worker.postMessage({ type: 'init' });
  });
  return readyPromise;
}

// A readable bitmap of the page: the raw CDN first (works when the CDN sends
// CORS headers), else the helper /image proxy, which always does.
async function fetchBitmap(url, headers) {
  const abs = url.startsWith('//') ? 'https:' + url : url;
  let blob = null;
  // Helper-loopback proxy URLs (http://127.0.0.1:8788/image?u=…) never resolve
  // from the browser — api.imageUrl() repoints them to the public helper host,
  // so skip the doomed direct attempt.
  if (/^https?:/i.test(abs) && !abs.includes('/image?u=')) {
    try {
      const r = await fetch(abs, { mode: 'cors', referrerPolicy: 'no-referrer' });
      if (r.ok) blob = await r.blob();
    } catch { /* CORS-blocked — proxy below */ }
  }
  if (!blob) {
    const r = await fetch(api.imageUrl(abs, headers));
    if (!r.ok) throw new Error(`page image not readable (${r.status})`);
    blob = await r.blob();
  }
  return createImageBitmap(blob);
}

function runPage(bitmap, lang, onProgress) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ type: 'page', id, bitmap, lang }, [bitmap]);
  });
}

// Translate one page. `source` is the page's language ('ja'|'zh'|'ko'|'en') —
// it picks the OCR engine in the worker and the MT source language. onUpdate
// streams Android's state machine: detected boxes with OCR progress counts,
// then a 'translate' stage, then the final translated texts (progress:null).
export async function translatePage({ url, headers, target, source = 'ja', title, onUpdate }) {
  await ensureWorker();

  const ocrKey = `${url}|${source}`;
  let blocksP = ocrCache.get(ocrKey);
  if (!blocksP) {
    blocksP = fetchBitmap(url, headers).then((bmp) => runPage(bmp, source, (m) => {
      if (onUpdate) {
        onUpdate({
          blocks: m.boxes || [],
          texts: null,
          progress: { stage: 'ocr', done: m.done, total: m.total },
        });
      }
    }));
    ocrCache.set(ocrKey, blocksP);
    blocksP.catch(() => ocrCache.delete(ocrKey));
  }
  const blocks = await blocksP;
  if (!blocks.length) {
    if (onUpdate) onUpdate({ blocks, texts: [], progress: null });
    return { blocks, texts: [] };
  }
  if (onUpdate) onUpdate({ blocks, texts: null, progress: { stage: 'translate' } });

  const key = `${ocrKey}|${target}`;
  let textsP = mtCache.get(key);
  if (!textsP) {
    textsP = translateBatch(blocks.map((b) => b.text), target, source);
    mtCache.set(key, textsP);
    textsP.catch(() => mtCache.delete(key));
  }
  const texts = await textsP;
  const ai = aiConfig();
  if (onUpdate) onUpdate({ blocks, texts, progress: ai ? { stage: 'refine' } : null });
  if (!ai) return { blocks, texts };

  // Refinement tier: show the fast MT immediately (above), then swap in the
  // LLM's page-coherent translation when it lands. Any failure keeps the MT.
  const rKey = `${key}|${ai.provider}|${ai.model}`;
  let refinedP = refineCache.get(rKey);
  if (!refinedP) {
    refinedP = (async () => {
      const context = ai.fandom ? await seriesContext(title) : '';
      return refineBatch(blocks.map((b) => b.text), texts, target, { ...ai, context });
    })();
    refineCache.set(rKey, refinedP);
    refinedP.catch(() => refineCache.delete(rKey));
  }
  try {
    const refined = await refinedP;
    if (refined) {
      if (onUpdate) onUpdate({ blocks, texts: refined, progress: null });
      return { blocks, texts: refined };
    }
  } catch (e) {
    if (!refineFailToasted) {
      refineFailToasted = true;
      status(`AI refinement failed — using fast translation (${(e && e.message) || e})`);
    }
  }
  if (onUpdate) onUpdate({ blocks, texts, progress: null });
  return { blocks, texts };
}
