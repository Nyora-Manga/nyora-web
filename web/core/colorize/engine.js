// core/colorize/engine.js — main-thread orchestrator for on-device manga
// colorization. Fetches a CORS-clean page bitmap (direct → /image proxy, like
// the translator), hands it to the colorize worker, and returns an object URL
// of the coloured page. Results are cached per page url for the session.

import { api } from '../api.js';
import { MODEL_URL, MODEL_BYTES, MODEL_CACHE, MODEL_SHA256, migrateCachedModel } from './model.js';

const WORKER_PATH = '/core/colorize/worker.js';

// Is the colorizer model already downloaded (cached)? Lets the settings gate the
// Colorize toggle until it's present.
export async function colorizeModelReady() {
  try {
    const c = await caches.open(MODEL_CACHE);
    // Re-keys a pre-pin download rather than reporting "not downloaded".
    return await migrateCachedModel(c, MODEL_URL);
  } catch { return false; }
}

// Download + cache the model on the MAIN thread with progress (0..100), so the
// settings can show a real progress bar without spinning up the big GPU session.
// Resolves once cached; the reader's worker then loads it instantly from cache.
export async function downloadColorizeModel(onProgress) {
  const cache = await caches.open(MODEL_CACHE).catch(() => null);
  if (cache && await migrateCachedModel(cache, MODEL_URL)) { if (onProgress) onProgress(100); return; }
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch { /* ignore */ }
  const res = await fetch(MODEL_URL);
  if (!res.ok || !res.body) throw new Error(`Model download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || MODEL_BYTES;
  const reader = res.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    if (onProgress) onProgress(Math.min(100, Math.round((got / total) * 100)));
  }
  const blob = new Blob(chunks);
  // Verify before caching so a tampered or truncated download surfaces here,
  // in the settings UI with a real error, instead of being cached and only
  // failing later inside the worker.
  const buf = await blob.arrayBuffer();
  const got2 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  if (got2 !== MODEL_SHA256) throw new Error('Model failed its integrity check — download rejected');
  if (cache) await cache.put(MODEL_URL, new Response(blob)).catch(() => {});
  if (onProgress) onProgress(100);
}

let worker = null;
let readyPromise = null;
let nextId = 1;
const pending = new Map();  // id → {resolve, reject}
const cache = new Map();     // pageUrl → Promise<objectURL>

let statusCb = null;
let lastKey = '';
export function onColorizeStatus(cb) { statusCb = cb; }
function status(label, pct) {
  const key = pct == null ? label : `${label}:${Math.floor(pct / 20)}`;
  if (key === lastKey) return;
  lastKey = key;
  if (statusCb) { try { statusCb(pct == null ? label : `${label}… ${pct}%`); } catch { /* ignore */ } }
}

function ensureWorker() {
  if (readyPromise) return readyPromise;
  readyPromise = new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e) => {
      if (settled) return; settled = true; readyPromise = null;
      if (worker) { try { worker.terminate(); } catch { /* ignore */ } worker = null; }
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    try { worker = new Worker(WORKER_PATH, { type: 'module' }); } catch (e) { fail(e); return; }
    worker.onerror = (e) => {
      const err = new Error((e && e.message) || 'colorize worker failed');
      // A crash BEFORE ready rejects init. A crash AFTER ready (an OOM on a big
      // page is the realistic case) used to hit `if (settled) return` and be
      // swallowed whole: the worker was left running, readyPromise stayed
      // resolved, and every in-flight runPage promise hung forever — so
      // colorize died silently with no toast and no retry. Tear down properly
      // and reject the in-flight work so the next page can rebuild the worker.
      if (!settled) { fail(err); return; }
      readyPromise = null;
      if (worker) { try { worker.terminate(); } catch { /* ignore */ } worker = null; }
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    };
    worker.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.type === 'progress') status(m.label, m.pct);
      else if (m.type === 'ready') { settled = true; status('Colorizer ready'); resolve(); }
      else if (m.type === 'init-error') fail(new Error(m.error));
      else if (m.type === 'color' || m.type === 'color-error') {
        const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
        if (m.type === 'color') p.resolve(m);
        else p.reject(new Error(m.error));
      }
    };
    status('Preparing colorizer…');
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch { /* ignore */ }
    worker.postMessage({ type: 'init' });
  });
  return readyPromise;
}

async function fetchBitmap(url, headers) {
  const abs = url.startsWith('//') ? 'https:' + url : url;
  let blob = null;
  if (/^https?:/i.test(abs) && !abs.includes('/image?u=')) {
    try { const r = await fetch(abs, { mode: 'cors', referrerPolicy: 'no-referrer' }); if (r.ok) blob = await r.blob(); }
    catch { /* proxy below */ }
  }
  if (!blob) { const r = await fetch(api.imageUrl(abs, headers)); if (!r.ok) throw new Error(`page not readable (${r.status})`); blob = await r.blob(); }
  return createImageBitmap(blob);
}

function runPage(bitmap) {
  return new Promise((resolve, reject) => {
    // fetchBitmap awaits a network round trip between ensureWorker() and here,
    // so the worker can be torn down in the gap — postMessage on null would
    // surface as a raw "Cannot read properties of null" toast.
    if (!worker) { reject(new Error('colorizer was shut down')); return; }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ type: 'page', id, bitmap }, [bitmap]);
  });
}

// Colorize one page → object URL of the coloured image (cached per url).
export async function colorizePage(url, headers) {
  let p = cache.get(url);
  if (p) return p;
  p = (async () => {
    await ensureWorker();
    const bmp = await fetchBitmap(url, headers);
    const res = await runPage(bmp);
    const cv = document.createElement('canvas');
    cv.width = res.width; cv.height = res.height;
    cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(res.data), res.width, res.height), 0, 0);
    const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
    return URL.createObjectURL(blob);
  })();
  cache.set(url, p);
  p.catch(() => cache.delete(url));
  return p;
}

export function clearColorizeCache() {
  for (const p of cache.values()) { p.then((u) => { try { URL.revokeObjectURL(u); } catch { /* ignore */ } }).catch(() => {}); }
  cache.clear();
}
