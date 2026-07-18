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
// Names can contain regex metacharacters (e.g. "Aki (Devil)"), so anything that
// becomes a RegExp must be escaped first.
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

// FANDOM: the canonical English spellings, for a far bigger roster than
// AniList's main cast. Fandom's wiki-discovery API (community.fandom.com/api/v1)
// answers 403 to browsers, but every wiki's own MediaWiki api.php allows
// anonymous CORS (origin=*) — so resolve the wiki by probing slug candidates
// built from the series title. Verified against jujutsu-kaisen, spy-x-family,
// chainsawman, onepiece, demonslayer, attackontitan.
function wikiSlugs(titles) {
  const out = [];
  for (const t of titles) {
    const s = String(t || '').toLowerCase().trim();
    if (!s) continue;
    const flat = s.replace(/[^a-z0-9]/g, '');
    const dash = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    for (const c of [flat, dash]) if (c && c.length > 1 && !out.includes(c)) out.push(c);
  }
  return out.slice(0, 4);
}

async function fandomRoster(titles) {
  for (const slug of wikiSlugs(titles)) {
    try {
      const res = await fetch(`https://${slug}.fandom.com/api.php?action=query&list=categorymembers`
        + '&cmtitle=Category:Characters&cmnamespace=0&cmlimit=200&format=json&origin=*');
      if (!res.ok) continue;
      const members = ((((await res.json()) || {}).query) || {}).categorymembers || [];
      // Article pages only; drop disambiguations/subpages and absurdly long titles.
      const names = members.map((m) => String(m.title || '').trim())
        .filter((n) => n && n.length <= 40 && !/[:/(]/.test(n));
      if (names.length >= 5) return { wiki: `${slug}.fandom.com`, names };
    } catch { /* try the next slug candidate */ }
  }
  return null;
}

// → { name, genres, desc, names:[{native,romaji}], roster:[English], wiki } | null
function seriesGlossary(title) {
  const q = String(title || '').trim();
  if (!q) return Promise.resolve(null);
  let p = seriesCache.get(q);
  if (!p) {
    p = (async () => {
      const mb = await mangaBakaResolve(q).catch(() => null);
      const CHARS = 'characters(perPage:25,sort:ROLE){nodes{name{full native}}}';
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
      if (!name) return null;
      const genres = (media && media.genres && media.genres.length ? media.genres : (mb ? mb.genres : [])) || [];
      const desc = (media && stripHtml(media.description).slice(0, 600)) || (mb ? mb.description : '');
      // native → romanized pairs: the ONLY way to spot a name in Japanese OCR text.
      const names = (((media && media.characters && media.characters.nodes) || [])
        .map((c) => ({
          native: String((c.name && c.name.native) || '').trim(),
          romaji: String((c.name && c.name.full) || '').trim(),
        }))
        .filter((n) => n.romaji));
      const fandom = await fandomRoster([
        name, media && media.title && media.title.romaji, mb && mb.title, q,
      ]).catch(() => null);
      const roster = fandom ? fandom.names : [];
      // Let the wiki's canonical spelling win over AniList's romanisation.
      const merged = names.map((n) => ({ ...n, romaji: preferRoster(n.romaji, roster) }));
      return { name, genres, desc, names: merged, roster, wiki: fandom ? fandom.wiki : '' };
    })().catch(() => null);
    seriesCache.set(q, p);
  }
  return p;
}

// AniList romanises with doubled vowels ("Satoru Gojou", "Yuuji Itadori") while
// the wiki carries the spelling readers actually know ("Satoru Gojo", "Yuji
// Itadori"). Fold both to a comparable key so the wiki's spelling can win.
function romajiKey(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip macrons (ō → o)
    .replace(/[^a-z]/g, '')
    .replace(/ou/g, 'o').replace(/oo/g, 'o')
    .replace(/uu/g, 'u').replace(/aa/g, 'a')
    .replace(/ee/g, 'e').replace(/ii/g, 'i');
}
function preferRoster(romaji, roster) {
  if (!roster || !roster.length) return romaji;
  const k = romajiKey(romaji);
  if (!k) return romaji;
  return roster.find((n) => romajiKey(n) === k) || romaji;
}

// A Japanese name appears as the full name OR just the surname/given part, split
// by ・/space. Longest variant first so "早川アキ" wins over a bare "アキ".
function nameVariants(native) {
  const n = String(native || '').trim();
  if (!n) return [];
  const parts = n.split(/[\s・･·]+/).filter((p) => p.length >= 2);
  return [n, ...parts].sort((a, b) => b.length - a.length);
}

// Which characters actually appear on THIS page? Longest match first, so
// substituting the full name never leaves a half-replaced "早川Aki".
function detectNames(texts, names) {
  const hay = texts.join('\n');
  const hits = [];
  for (const e of names) {
    if (!e.native) continue;
    const match = nameVariants(e.native).find((v) => hay.includes(v));
    if (match) hits.push({ native: e.native, romaji: e.romaji, match });
  }
  return hits.sort((a, b) => b.match.length - a.match.length);
}

// Swap native names for their canonical romanization BEFORE machine translation
// so Google passes the name straight through instead of inventing a reading.
// This fixes names even with NO LLM key configured.
function applyNames(texts, hits) {
  if (!hits.length) return texts;
  return texts.map((t) => hits.reduce(
    // Function replacement, not a string: h.romaji comes from the wiki roster,
    // and as a string `$&`/`$'`/`` $` ``/`$1` are substitution patterns — a name
    // containing $ would corrupt the text before it reaches the translator.
    (s, h) => s.replace(new RegExp(escapeRe(h.match), 'g'), () => h.romaji), t));
}

// Prompt context: synopsis + a FOCUSED glossary (only the characters detected on
// this page) plus the wiki roster for canonical spellings — far more useful to
// the model than dumping the entire cast.
function glossaryContext(g, hits) {
  if (!g) return '';
  let s = `Series: ${g.name}. Genres: ${g.genres.join(', ')}. Synopsis: ${g.desc}`;
  if (hits.length) {
    s += '\nCharacters on this page (native = canonical English, already substituted): '
      + hits.map((h) => `${h.match} = ${h.romaji}`).join('; ');
  }
  if (g.roster.length) {
    s += `\nCanonical name spellings from the ${g.wiki} wiki — use these exact spellings: `
      + g.roster.slice(0, 60).join('; ');
  }
  return s;
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
    // Tear down the worker and reject everything in flight. Safe at any point:
    // before init settles it also rejects the init promise; after the worker is
    // ready (an uncatchable post-init crash) it still clears readyPromise/worker
    // and rejects every pending page, so translatePage rejects and the reader
    // can retry with a fresh worker. Idempotent — each in-flight page rejects
    // exactly once (cleared here; normal completion already deletes its entry).
    const teardown = (e) => {
      const err = e instanceof Error ? e : new Error(String(e));
      if (worker) { try { worker.terminate(); } catch { /* ignore */ } worker = null; }
      readyPromise = null;
      pending.forEach((p) => { try { p.reject(err); } catch { /* ignore */ } });
      pending.clear();
      if (!settled) { settled = true; reject(err); }
    };
    try {
      worker = new Worker(WORKER_PATH, { type: 'module' });
    } catch (e) { teardown(e); return; }
    // ALWAYS tears down, even after 'ready': an un-terminated worker with the
    // pending map left unresolved would hang every page on the pill forever.
    worker.onerror = (e) => teardown(new Error((e && e.message) || 'translation worker failed'));
    worker.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.type === 'progress') {
        status(m.label, m.pct);
      } else if (m.type === 'ready') {
        settled = true;
        status('Translation models ready');
        resolve();
      } else if (m.type === 'init-error') {
        teardown(new Error(m.error));
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

  // Character-name glossary (the "Fetch series context" pref). Resolve the
  // series once, find which characters are actually ON this page, and hand MT
  // the canonical romanization instead of letting it guess a reading. Runs
  // regardless of whether an LLM key is set, so names improve for everyone.
  const rawTexts = blocks.map((b) => b.text);
  let glossary = null;
  let hits = [];
  if (store.get().aiFandom === true) {
    glossary = await seriesGlossary(title).catch(() => null);
    if (glossary) hits = detectNames(rawTexts, glossary.names);
  }
  const srcTexts = applyNames(rawTexts, hits);

  // Cache key includes the substitutions so toggling the glossary re-translates.
  const key = `${ocrKey}|${target}|${hits.map((h) => h.match).join(',')}`;
  let textsP = mtCache.get(key);
  if (!textsP) {
    textsP = translateBatch(srcTexts, target, source);
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
      // Feed the LLM the name-substituted source (so it keeps the canonical
      // spellings) plus a glossary focused on the characters on this page.
      const context = ai.fandom ? glossaryContext(glossary, hits) : '';
      return refineBatch(srcTexts, texts, target, { ...ai, context });
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
