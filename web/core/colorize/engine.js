// core/colorize/engine.js — main-thread orchestrator for on-device manga
// colorization. Fetches a CORS-clean page bitmap (direct → /image proxy, like
// the translator), hands it to the colorize worker, and returns an object URL
// of the coloured page. Results are cached per page url for the session.

import { api } from '../api.js';
import { colorizeModelCached, loadColorizeModel } from './model.js';

const WORKER_PATH = '/core/colorize/worker.js';

// Is the colorizer model already downloaded (cached)? Lets the settings gate the
// Colorize toggle until it's present.
export async function colorizeModelReady() {
  return colorizeModelCached();
}

// Download + cache the model on the MAIN thread with progress (0..100), so the
// settings can show a real progress bar without spinning up the big GPU session.
// Resolves once cached; the reader's worker then loads it instantly from cache.
export async function downloadColorizeModel(onProgress) {
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch { /* ignore */ }
  await loadColorizeModel({ onProgress });
}

let worker = null;
let readyPromise = null;
let workerInitReject = null;
let nextId = 1;
let nextModelCheckId = 1;
const pending = new Map();  // id → {resolve, reject}
const pendingModelChecks = new Map(); // id → {resolve, reject}
const cache = new Map();     // pageUrl → {promise, url}
const pageQueue = [];
const queuedPages = new Map();
let pageQueueRunning = false;
let pageQueueTimer = null;
let pageSequence = 0;

// Blob URLs are much smaller than raw RGBA pages, but keeping an entire webtoon
// chapter alive still grows without bound. Use a small LRU on low-memory/mobile
// devices and a slightly larger one on desktop. The floor has to stay above the
// number of pages a reader can have coloured on screen at once, or the cache
// would spend its time evicting work it is about to be asked for again.
const deviceMemory = typeof navigator !== 'undefined' ? Number(navigator.deviceMemory) || 4 : 4;
const RESULT_CACHE_LIMIT = deviceMemory <= 4 ? 6 : 12;

// Revoking an object URL breaks any <img> still pointing at it, and only the
// consumer knows which results are on screen. `isRetained` vetoes eviction for
// those; `onEvicted` reports the ones that did go so the page can fall back to
// its original image (and be coloured again if the reader returns to it).
let isResultRetained = null;
let onResultEvicted = null;
export function setColorizeRetention({ isRetained, onEvicted } = {}) {
  isResultRetained = typeof isRetained === 'function' ? isRetained : null;
  onResultEvicted = typeof onEvicted === 'function' ? onEvicted : null;
}

let statusCb = null;
let lastKey = '';
export function onColorizeStatus(cb) { statusCb = cb; }
function status(label, pct) {
  const key = pct == null ? label : `${label}:${Math.floor(pct / 20)}`;
  if (key === lastKey) return;
  lastKey = key;
  if (statusCb) { try { statusCb(pct == null ? label : `${label}… ${pct}%`); } catch { /* ignore */ } }
}

function discardWorker(error) {
  const old = worker;
  worker = null;
  if (old) { try { old.terminate(); } catch { /* ignore */ } }
  if (error && workerInitReject) {
    const reject = workerInitReject;
    workerInitReject = null;
    reject(error);
  }
  if (error) {
    for (const p of pending.values()) p.reject(error);
    pending.clear();
    for (const p of pendingModelChecks.values()) p.reject(error);
    pendingModelChecks.clear();
  }
}

function startWorker() {
  return new Promise((resolve, reject) => {
    workerInitReject = reject;
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      workerInitReject = null;
      discardWorker();
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
      // A crash after ready is almost always the page that was in flight
      // exhausting memory. Marking it fatal is what lets colorizePage rebuild
      // the worker and retry that page once, instead of surfacing a dead-end
      // "Colorize failed" for a page that usually succeeds on a fresh session.
      err.colorizerFatal = true;
      readyPromise = null;
      discardWorker(err);
    };
    worker.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.type === 'progress') status(m.label, m.pct);
      else if (m.type === 'ready') {
        settled = true;
        workerInitReject = null;
        // Surface the backend so a stuck/slow colorize is diagnosable: GPU =
        // WebGPU (fast), CPU = wasm fallback (threads shown; single-thread is slow).
        status(`Colorizer ready — ${m.backend || '?'}${m.backend === 'CPU' ? ` (${m.threads || 1} thread${(m.threads || 1) > 1 ? 's' : ''})` : ''}`);
        resolve();
      }
      else if (m.type === 'init-error') fail(new Error(m.error));
      else if (m.type === 'model-ready' || m.type === 'model-error') {
        const p = pendingModelChecks.get(m.id);
        if (!p) return;
        pendingModelChecks.delete(m.id);
        if (m.type === 'model-ready') {
          if (m.loaded) status(`Colorizer restored to memory — ${m.backend || '?'}`);
          p.resolve();
        } else {
          const error = new Error(m.error || 'Colorizer model could not enter memory');
          error.colorizerFatal = true;
          p.reject(error);
          readyPromise = null;
          discardWorker(error);
        }
      }
      else if (m.type === 'color' || m.type === 'color-error') {
        const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
        if (m.type === 'color') { if (m.ms != null) status(`Coloured a page in ${(m.ms / 1000).toFixed(1)}s`); p.resolve(m); }
        else {
          const error = new Error(m.error);
          error.colorizerFatal = m.fatal === true;
          p.reject(error);
          if (error.colorizerFatal) {
            readyPromise = null;
            discardWorker(error);
            status('Recovering colorizer…');
          }
        }
      }
    };
    status('Preparing colorizer…');
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch { /* ignore */ }
    worker.postMessage({ type: 'init' });
  });
}

function ensureWorker() {
  if (readyPromise) return readyPromise;
  readyPromise = startWorker().catch((error) => {
    readyPromise = null;
    throw error;
  });
  return readyPromise;
}

async function ensureWorkerModelResident() {
  await ensureWorker();
  return new Promise((resolve, reject) => {
    if (!worker) {
      reject(new Error('colorizer was shut down'));
      return;
    }
    const id = nextModelCheckId++;
    pendingModelChecks.set(id, { resolve, reject });
    try {
      // This is intentionally checked before fetching/decoding the page. If the
      // browser evicted the inference session, reload the cached model first so
      // the model ArrayBuffer and a full-resolution page bitmap do not overlap.
      worker.postMessage({ type: 'ensure-model', id });
    } catch (error) {
      pendingModelChecks.delete(id);
      reject(error);
    }
  });
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
    if (!worker) {
      try { bitmap.close(); } catch { /* ignore */ }
      reject(new Error('colorizer was shut down'));
      return;
    }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    try {
      worker.postMessage({ type: 'page', id, bitmap }, [bitmap]);
    } catch (error) {
      pending.delete(id);
      try { bitmap.close(); } catch { /* ignore */ }
      reject(error);
    }
  });
}

function schedulePagePump() {
  if (pageQueueRunning || pageQueueTimer != null || pageQueue.length === 0) return;
  // Let the reader's visible and near-page observers report in the same frame
  // before choosing work. This prevents the near observer from winning simply
  // because its callback happened to run first.
  pageQueueTimer = setTimeout(() => {
    pageQueueTimer = null;
    pumpPageQueue();
  }, 0);
}

function nextPageJob() {
  // Re-measure before choosing. A priority fixed at enqueue time goes stale the
  // moment the reader scrolls: the page that was on screen when it was queued
  // keeps its viewport-band score and outranks the page the user is now looking
  // at. `measure` is the caller's live reading, so a page that scrolled away
  // drops back to the prefetch band on its own.
  for (const job of pageQueue) {
    if (!job.measure) continue;
    try {
      const measured = Number(job.measure());
      if (Number.isFinite(measured)) job.priority = measured;
    } catch { /* keep the last known priority */ }
  }

  let bestIndex = 0;
  for (let i = 1; i < pageQueue.length; i++) {
    const candidate = pageQueue[i];
    const best = pageQueue[bestIndex];
    if (candidate.priority > best.priority
      || (candidate.priority === best.priority && candidate.sequence < best.sequence)) {
      bestIndex = i;
    }
  }
  return pageQueue.splice(bestIndex, 1)[0];
}

async function pumpPageQueue() {
  if (pageQueueRunning || pageQueue.length === 0) return;
  const job = nextPageJob();
  queuedPages.delete(job.url);
  pageQueueRunning = true;
  try {
    await ensureWorkerModelResident();
    job.resolve(await runPage(await fetchBitmap(job.url, job.headers)));
  } catch (error) {
    job.reject(error);
  } finally {
    pageQueueRunning = false;
    schedulePagePump();
  }
}

// Serialize the whole fetch → bitmap → inference path while allowing a page
// that becomes visible to jump ahead of queued prefetch work.
function enqueuePage(url, headers, priority, measure) {
  const job = {
    url,
    headers,
    priority: Number.isFinite(priority) ? priority : 0,
    measure: typeof measure === 'function' ? measure : null,
    sequence: pageSequence++,
    resolve: null,
    reject: null,
  };
  const promise = new Promise((resolve, reject) => {
    job.resolve = resolve;
    job.reject = reject;
  });
  pageQueue.push(job);
  queuedPages.set(url, job);
  schedulePagePump();
  return promise;
}

function promoteQueuedPage(url, priority, measure) {
  const job = queuedPages.get(url);
  if (!job) return;
  if (Number.isFinite(priority)) job.priority = Math.max(job.priority, priority);
  // A later caller's measure is the fresher one — it belongs to whichever image
  // is asking for this page now.
  if (typeof measure === 'function') job.measure = measure;
}

function stopQueuedPages(error) {
  if (pageQueueTimer != null) {
    clearTimeout(pageQueueTimer);
    pageQueueTimer = null;
  }
  for (const job of pageQueue.splice(0)) job.reject(error);
  queuedPages.clear();
}

function trimResultCache(exceptKey) {
  while (cache.size > RESULT_CACHE_LIMIT) {
    let evicted = false;
    for (const [key, entry] of cache) {
      if (key === exceptKey || !entry.url) continue;
      if (isResultRetained) {
        let retained = false;
        try { retained = isResultRetained(key) === true; } catch { /* treat as free */ }
        if (retained) continue;
      }
      cache.delete(key);
      try { URL.revokeObjectURL(entry.url); } catch { /* ignore */ }
      if (onResultEvicted) { try { onResultEvicted(key); } catch { /* ignore */ } }
      evicted = true;
      break;
    }
    // Every excess entry is either still running or still on screen. Running
    // ones trim again from their completion handler, and an on-screen result
    // must outlive the limit — never revoke a URL an <img> is displaying.
    if (!evicted) break;
  }
}

// Colorize one page → object URL of the coloured image (cached per url).
// `priority` is promotable while queued; viewport pages use a much higher band
// than nearby prefetch pages.
export async function colorizePage(url, headers, { priority = 0, measure } = {}) {
  priority = Number(priority) || 0;
  let entry = cache.get(url);
  if (entry) {
    entry.priority = Math.max(entry.priority, priority);
    promoteQueuedPage(url, entry.priority, measure);
    // Touch for LRU ordering.
    cache.delete(url);
    cache.set(url, entry);
    return entry.promise;
  }

  entry = { promise: null, url: null, priority };
  entry.promise = (async () => {
    let res;
    try {
      res = await enqueuePage(url, headers, entry.priority, measure);
    } catch (error) {
      if (!error || error.colorizerFatal !== true) throw error;
      // Device loss / inference-memory failures poison the current ORT session.
      // The message handler has already torn it down; rebuild from the cached
      // model and retry this page exactly once.
      res = await enqueuePage(url, headers, entry.priority, measure);
    }
    if (!(res.blob instanceof Blob) || !res.blob.size) {
      throw new Error('colorizer returned an empty page');
    }
    return URL.createObjectURL(res.blob);
  })();
  cache.set(url, entry);
  entry.promise.then((objectUrl) => {
    entry.url = objectUrl;
    trimResultCache(url);
  }, () => {
    if (cache.get(url) === entry) cache.delete(url);
  });
  return entry.promise;
}

export function clearColorizeCache() {
  const stopped = new Error('colorizer stopped');
  // The hooks close over the reader that is going away; the pages it owned are
  // being revoked wholesale here, so it must not be told about them one by one.
  setColorizeRetention();
  readyPromise = null;
  discardWorker(stopped);
  stopQueuedPages(stopped);
  for (const entry of cache.values()) {
    if (entry.url) {
      try { URL.revokeObjectURL(entry.url); } catch { /* ignore */ }
    } else {
      entry.promise.then((u) => {
        try { URL.revokeObjectURL(u); } catch { /* ignore */ }
      }).catch(() => {});
    }
  }
  cache.clear();
  lastKey = '';
}
