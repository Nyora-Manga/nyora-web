// core/downloads.js — client-side chapter download manager.
//
// WHY THIS EXISTS
// ---------------
// In the deployed web app every /downloads* request was answered by a stub in
// core/parser-runtime.js, so the download buttons did nothing. There is no JVM
// download service reachable from the browser anyway. This module is the real
// engine: it downloads a chapter's pages through the same image proxy the reader
// uses, packs them into a CBZ/ZIP with core/zip.js, and keeps them for offline
// reading in IndexedDB (and/or saves the file straight to the device).
//
// It works the same in every deployment, because it only depends on api.pages()
// and the helper's image proxy URL — both always available via the Nyora helper.
//
// DESIGN
// ------
//  * Queue metadata (no blobs) lives in localStorage 'nyora.downloads.v1'.
//  * Settings live in localStorage 'nyora.downloads.settings.v1'.
//  * Finished archives (blobs) live in IndexedDB 'nyora-downloads' / 'chapters',
//    keyed by job id, so they survive reloads, can be re-saved, and read offline.
//  * Each job downloads ONE chapter. A "range" download is just many jobs.
//  * Job id == dedupe key == `${sourceId}|${chapterUrl}` so the same chapter is
//    never queued twice; re-enqueuing a FAILED/CANCELLED job re-runs it.
//  * subscribe(fn) lets screens live-update; progress ticks are throttled.

// Downloads must proxy each page through the PUBLIC helper host. api.imageUrl()
// repoints the helper's loopback proxy URL (http://127.0.0.1:8788/image?u=…) to
// api.hasanraza.tech and re-adds the source Referer. parser-runtime's imageUrl
// instead DOUBLE-WRAPPED that loopback URL (→ an unreachable localhost fetch),
// which is why downloads errored. Lazy+cached import to avoid the api.js <->
// downloads.js import cycle (api.js imports this module).
let _apiMod = null;
async function apiImageUrl(url, headers) {
  if (!_apiMod) _apiMod = await import('./api.js');
  return _apiMod.api.imageUrl(url, headers);
}

// ---- constants ---------------------------------------------------------

const QUEUE_KEY = 'nyora.downloads.v1';
const SETTINGS_KEY = 'nyora.downloads.settings.v1';
const DB_NAME = 'nyora-downloads';
const DB_VERSION = 1;
const STORE = 'chapters';

const FORMATS = ['CBZ', 'ZIP'];
const STATUS = {
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
};
const ACTIVE = new Set([STATUS.QUEUED, STATUS.RUNNING]);

const DEFAULT_SETTINGS = {
  format: 'CBZ',         // 'CBZ' | 'ZIP' (identical container; only the extension differs)
  maxConcurrent: 2,      // chapters downloaded in parallel
  imageConcurrency: 4,   // page images fetched in parallel within a chapter
  retries: 2,            // per-image retry attempts before a page is counted failed
  keepOffline: true,     // store the archive in IndexedDB for in-app offline reading
  saveToDevice: false,   // also auto-save each finished chapter file to the device
};

// ---- small utils -------------------------------------------------------

function now() { return Date.now(); }

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function jobId(sourceId, chapterUrl) {
  return `${sourceId || ''}|${chapterUrl || ''}`;
}

function sanitize(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|]+/g, ' ')   // illegal filename chars
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'Untitled';
}

function pad(n, width = 4) {
  return String(n).padStart(width, '0');
}

function extFromType(contentType, url) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('gif')) return 'gif';
  if (ct.includes('avif')) return 'avif';
  if (ct.includes('bmp')) return 'bmp';
  const m = String(url || '').split('?')[0].match(/\.(jpe?g|png|webp|gif|avif|bmp)$/i);
  if (m) return m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  return 'jpg';
}

function isAbort(e) {
  return e && (e.name === 'AbortError' || e.message === 'aborted');
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(abortError()); return; }
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() { clearTimeout(t); reject(abortError()); }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError() {
  try { return new DOMException('aborted', 'AbortError'); }
  catch { const e = new Error('aborted'); e.name = 'AbortError'; return e; }
}

// ---- IndexedDB blob store ----------------------------------------------

let _dbPromise = null;
let _idbAvailable = typeof indexedDB !== 'undefined';

function openDB() {
  if (!_idbAvailable) return Promise.resolve(null);
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch { _idbAvailable = false; resolve(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { _idbAvailable = false; resolve(null); };
  });
  return _dbPromise;
}

async function idbPut(record) {
  const db = await openDB();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, 'readwrite');
      t.objectStore(STORE).put(record);
      t.oncomplete = () => resolve(true);
      t.onabort = t.onerror = () => resolve(false);
    } catch { resolve(false); }
  });
}

async function idbGet(id) {
  const db = await openDB();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function idbDelete(id) {
  const db = await openDB();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, 'readwrite');
      t.objectStore(STORE).delete(id);
      t.oncomplete = t.onabort = t.onerror = () => resolve();
    } catch { resolve(); }
  });
}

// ---- in-memory + persisted state ---------------------------------------

let settings = loadSettings();
let jobs = loadJobs();

const controllers = new Map();   // id -> AbortController (running jobs only)
const subscribers = new Set();
let notifyTimer = null;

function loadSettings() {
  const base = { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') {
        if (FORMATS.includes(String(p.format).toUpperCase())) base.format = String(p.format).toUpperCase();
        base.maxConcurrent = clampInt(p.maxConcurrent, 1, 5, base.maxConcurrent);
        base.imageConcurrency = clampInt(p.imageConcurrency, 1, 8, base.imageConcurrency);
        base.retries = clampInt(p.retries, 0, 5, base.retries);
        if (typeof p.keepOffline === 'boolean') base.keepOffline = p.keepOffline;
        if (typeof p.saveToDevice === 'boolean') base.saveToDevice = p.saveToDevice;
      }
    }
  } catch { /* defaults */ }
  return base;
}

function persistSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

function loadJobs() {
  let list = [];
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) list = p;
    }
  } catch { /* ignore */ }
  // An interrupted RUNNING job (the tab was closed mid-download) is requeued.
  for (const j of list) {
    if (j.status === STATUS.RUNNING) {
      j.status = STATUS.QUEUED;
      j.startedAt = 0;
      j.completedPages = 0;
      j.failedPages = 0;
    }
  }
  return list;
}

function persistJobs() {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(jobs)); } catch { /* ignore */ }
}

// ---- notifications -----------------------------------------------------

function notify() {
  if (notifyTimer) { clearTimeout(notifyTimer); notifyTimer = null; }
  for (const fn of subscribers) { try { fn(); } catch { /* ignore */ } }
}

function notifyThrottled() {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => { notifyTimer = null; notify(); }, 200);
}

function commit({ throttle = false } = {}) {
  persistJobs();
  if (throttle) notifyThrottled(); else notify();
}

// ---- page image fetching -----------------------------------------------

async function fetchImage(page, signal) {
  const src = await apiImageUrl(page && page.url, page && page.headers);
  if (!src) throw new Error('no url');
  let lastErr = null;
  for (let attempt = 0; attempt <= settings.retries; attempt++) {
    if (signal.aborted) throw abortError();
    try {
      const res = await fetch(src, { signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (!buf.length) throw new Error('empty response');
      return { data: buf, ext: extFromType(res.headers.get('content-type'), page.url) };
    } catch (e) {
      if (isAbort(e)) throw e;
      lastErr = e;
      if (attempt < settings.retries) await delay(300 * (attempt + 1), signal);
    }
  }
  throw lastErr || new Error('failed');
}

// Fetch every page with a bounded worker pool, recording per-page success so a
// few bad pages don't sink the whole chapter. Returns results[] (entry or null).
async function fetchPages(pages, job, signal) {
  const results = new Array(pages.length).fill(null);
  let cursor = 0;
  const poolSize = Math.min(clampInt(settings.imageConcurrency, 1, 8, 4), pages.length || 1);

  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= pages.length) return;
      if (signal.aborted) throw abortError();
      try {
        results[i] = await fetchImage(pages[i], signal);
        job.completedPages++;
      } catch (e) {
        if (isAbort(e)) throw e;
        job.failedPages++;
      }
      commit({ throttle: true });
    }
  }

  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return results;
}

// ---- the job runner ----------------------------------------------------

async function runJob(job) {
  job.status = STATUS.RUNNING;
  job.startedAt = now();
  job.error = '';
  job.warning = '';
  job.completedPages = 0;
  job.failedPages = 0;
  job.totalPages = 0;
  job.savedToDevice = false;
  job.offline = false;
  job.bytes = 0;
  job.fileName = '';
  const controller = new AbortController();
  controllers.set(job.id, controller);
  commit();

  try {
    const { api } = await import('./api.js');
    const data = await api.pages(job.sourceId, job.chapterUrl);
    if (controller.signal.aborted) throw abortError();
    const pages = (data && data.pages) || [];
    if (!pages.length) throw new Error('No pages found for this chapter');
    job.totalPages = pages.length;
    commit();

    const results = await fetchPages(pages, job, controller.signal);
    if (controller.signal.aborted) throw abortError(); // cancel/remove landed during fetch

    const zip = await import('./zip.js');
    const files = [];
    let idx = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r) continue;
      idx++;
      files.push({ name: `${pad(idx)}.${r.ext}`, data: r.data });
    }
    if (!files.length) throw new Error('Every page failed to download');

    const blob = zip.buildZip(files);
    if (controller.signal.aborted) throw abortError(); // cancel/remove landed during zip build
    const ext = (job.format === 'ZIP' ? 'zip' : 'cbz');
    const fileName = `${sanitize(job.mangaTitle)} - ${sanitize(job.chapterTitle)}.${ext}`;
    job.bytes = blob.size;
    job.fileName = fileName;

    // Keep offline (IndexedDB) when asked and possible.
    let stored = false;
    if (settings.keepOffline) {
      stored = await idbPut({ id: job.id, blob, name: fileName, bytes: blob.size, savedAt: now() });
    }
    job.offline = stored;

    // If the job was removed/cancelled while we were storing, clean up the blob
    // and bail instead of resurrecting a gone job or orphaning a blob in IDB.
    if (findIndex(job.id) < 0) { if (stored) await idbDelete(job.id); return; }
    if (controller.signal.aborted) { if (stored) await idbDelete(job.id); throw abortError(); }

    // Never waste a finished download: when it isn't kept offline (toggle off, or
    // IndexedDB store failed/quota), save the file to the device so the work the
    // user paid for in bandwidth isn't silently discarded.
    if (settings.saveToDevice || !stored) {
      try { triggerDownload(blob, fileName); job.savedToDevice = true; } catch { /* re-save from the list */ }
    }

    const warns = [];
    if (job.failedPages > 0) warns.push(`${job.failedPages} page${job.failedPages === 1 ? '' : 's'} missing`);
    if (settings.keepOffline && !stored) warns.push('offline storage unavailable — saved to device');
    job.warning = warns.join(' · ');

    job.status = STATUS.COMPLETED;
    job.finishedAt = now();
  } catch (e) {
    if (controller.signal.aborted || job.status === STATUS.CANCELLED) {
      if (job.status !== STATUS.CANCELLED) job.status = STATUS.CANCELLED;
      job.finishedAt = now();
    } else {
      job.status = STATUS.FAILED;
      job.error = (e && e.message) ? e.message : 'Download failed';
      job.finishedAt = now();
    }
  } finally {
    controllers.delete(job.id);
    commit();
    pump();
  }
}

// Start queued jobs up to the concurrency limit.
function pump() {
  const running = jobs.filter((j) => j.status === STATUS.RUNNING).length;
  let slots = clampInt(settings.maxConcurrent, 1, 5, 2) - running;
  if (slots <= 0) return;
  for (const job of jobs) {
    if (slots <= 0) break;
    if (job.status === STATUS.QUEUED) {
      slots--;
      void runJob(job);
    }
  }
}

// ---- save helpers ------------------------------------------------------

function triggerDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }, 4000);
}

// ---- public job factory + queries --------------------------------------

function makeJob(desc) {
  const sourceId = desc.sourceId;
  const chapterUrl = desc.chapterUrl;
  return {
    id: jobId(sourceId, chapterUrl),
    sourceId,
    mangaId: desc.mangaId != null ? String(desc.mangaId) : `${sourceId}|${desc.mangaUrl || ''}`,
    mangaUrl: desc.mangaUrl || '',
    mangaTitle: desc.mangaTitle || 'Manga',
    chapterUrl,
    chapterId: desc.chapterId != null ? desc.chapterId : chapterUrl,
    chapterTitle: desc.chapterTitle || 'Chapter',
    chapterNumber: desc.chapterNumber != null ? desc.chapterNumber : null,
    status: STATUS.QUEUED,
    totalPages: 0,
    completedPages: 0,
    failedPages: 0,
    bytes: 0,
    fileName: '',
    offline: false,
    savedToDevice: false,
    error: '',
    warning: '',
    format: settings.format,
    createdAt: now(),
    startedAt: 0,
    finishedAt: 0,
  };
}

function findIndex(id) {
  return jobs.findIndex((j) => j.id === id);
}

// ---- the manager surface -----------------------------------------------

export const downloads = {
  STATUS,
  FORMATS,

  // ---- settings ----
  getSettings() {
    return { ...settings };
  },

  saveSettings(patch) {
    if (patch && typeof patch === 'object') {
      if (patch.format != null && FORMATS.includes(String(patch.format).toUpperCase())) {
        settings.format = String(patch.format).toUpperCase();
      }
      if (patch.maxConcurrent != null) settings.maxConcurrent = clampInt(patch.maxConcurrent, 1, 5, settings.maxConcurrent);
      if (patch.imageConcurrency != null) settings.imageConcurrency = clampInt(patch.imageConcurrency, 1, 8, settings.imageConcurrency);
      if (patch.retries != null) settings.retries = clampInt(patch.retries, 0, 5, settings.retries);
      if (typeof patch.keepOffline === 'boolean') settings.keepOffline = patch.keepOffline;
      if (typeof patch.saveToDevice === 'boolean') settings.saveToDevice = patch.saveToDevice;
    }
    persistSettings();
    notify();
    pump(); // a raised concurrency limit may free new slots
    return { ...settings };
  },

  // ---- queue queries ----
  // Active jobs first (queued/running, oldest first), then finished (newest first).
  list() {
    const active = jobs.filter((j) => ACTIVE.has(j.status))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const done = jobs.filter((j) => !ACTIVE.has(j.status))
      .sort((a, b) => (b.finishedAt || b.createdAt || 0) - (a.finishedAt || a.createdAt || 0));
    return [...active, ...done].map((j) => ({ ...j }));
  },

  get(id) {
    const j = jobs.find((x) => x.id === id);
    return j ? { ...j } : null;
  },

  // Status of a specific chapter (for the details screen), or null if unknown.
  statusOf(sourceId, chapterUrl) {
    const j = jobs.find((x) => x.id === jobId(sourceId, chapterUrl));
    return j ? { ...j } : null;
  },

  counts() {
    const c = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0, totalBytes: 0 };
    for (const j of jobs) {
      if (j.status === STATUS.QUEUED) c.queued++;
      else if (j.status === STATUS.RUNNING) c.running++;
      else if (j.status === STATUS.COMPLETED) { c.completed++; c.totalBytes += Number(j.bytes) || 0; }
      else if (j.status === STATUS.FAILED) c.failed++;
      else if (j.status === STATUS.CANCELLED) c.cancelled++;
    }
    return c;
  },

  // ---- mutations ----
  // descs: array of { sourceId, mangaId, mangaUrl, mangaTitle, chapterUrl,
  //                   chapterId, chapterTitle, chapterNumber }.
  // Skips chapters already queued/running/completed; re-queues failed/cancelled.
  enqueue(descs) {
    const items = Array.isArray(descs) ? descs : [descs];
    let added = 0; let requeued = 0; let skipped = 0;
    for (const desc of items) {
      if (!desc || !desc.sourceId || !desc.chapterUrl) { skipped++; continue; }
      const id = jobId(desc.sourceId, desc.chapterUrl);
      const i = findIndex(id);
      if (i >= 0) {
        const existing = jobs[i];
        if (existing.status === STATUS.FAILED || existing.status === STATUS.CANCELLED) {
          const fresh = makeJob(desc);
          fresh.createdAt = now();
          jobs[i] = fresh;
          requeued++;
        } else {
          skipped++;
        }
      } else {
        jobs.push(makeJob(desc));
        added++;
      }
    }
    if (added || requeued) { commit(); pump(); }
    return { added, requeued, skipped };
  },

  cancel(id) {
    const i = findIndex(id);
    if (i < 0) return { ok: false };
    const job = jobs[i];
    if (!ACTIVE.has(job.status)) return { ok: false };
    job.status = STATUS.CANCELLED;
    job.finishedAt = now();
    const c = controllers.get(id);
    if (c) { try { c.abort(); } catch { /* ignore */ } }
    commit();
    pump();
    return { ok: true };
  },

  cancelAll() {
    let n = 0;
    for (const job of jobs) {
      if (ACTIVE.has(job.status)) {
        job.status = STATUS.CANCELLED;
        job.finishedAt = now();
        const c = controllers.get(job.id);
        if (c) { try { c.abort(); } catch { /* ignore */ } }
        n++;
      }
    }
    if (n) { commit(); pump(); }
    return { cancelled: n };
  },

  async retry(id) {
    const i = findIndex(id);
    if (i < 0) return { ok: false };
    const job = jobs[i];
    if (job.status !== STATUS.FAILED && job.status !== STATUS.CANCELLED && !(job.status === STATUS.COMPLETED && job.failedPages > 0)) {
      return { ok: false };
    }
    await idbDelete(id); // drop any stale/partial blob before re-running
    job.status = STATUS.QUEUED;
    job.error = '';
    job.warning = '';
    job.completedPages = 0;
    job.failedPages = 0;
    job.totalPages = 0;
    job.startedAt = 0;
    job.finishedAt = 0;
    job.offline = false;
    job.bytes = 0;
    job.fileName = '';
    job.savedToDevice = false;
    commit();
    pump();
    return { ok: true };
  },

  async remove(id) {
    const i = findIndex(id);
    if (i < 0) return { ok: false };
    const job = jobs[i];
    if (ACTIVE.has(job.status)) {
      job.status = STATUS.CANCELLED;
      const c = controllers.get(id);
      if (c) { try { c.abort(); } catch { /* ignore */ } }
    }
    jobs.splice(i, 1);
    await idbDelete(id);
    commit();
    pump();
    return { ok: true };
  },

  async clearCompleted() {
    const remove = jobs.filter((j) => j.status === STATUS.COMPLETED || j.status === STATUS.FAILED || j.status === STATUS.CANCELLED);
    jobs = jobs.filter((j) => ACTIVE.has(j.status));
    for (const j of remove) await idbDelete(j.id);
    commit();
    return { removed: remove.length };
  },

  async clearAll() {
    this.cancelAll();
    const all = jobs.slice();
    jobs = [];
    for (const j of all) await idbDelete(j.id);
    commit();
    return { removed: all.length };
  },

  // ---- offline blob access ----
  async getBlob(id) {
    const rec = await idbGet(id);
    return rec ? rec.blob : null;
  },

  async saveToDevice(id) {
    const job = this.get(id);
    const rec = await idbGet(id);
    if (!rec || !rec.blob) return { ok: false };
    const name = rec.name || (job ? `${sanitize(job.mangaTitle)} - ${sanitize(job.chapterTitle)}.cbz` : 'chapter.cbz');
    triggerDownload(rec.blob, name);
    return { ok: true };
  },

  // Bundle several finished chapters into one .zip of CBZ files, saved to device.
  async saveBundle(ids, zipName) {
    const zip = await import('./zip.js');
    const files = [];
    for (const id of ids) {
      const rec = await idbGet(id);
      if (rec && rec.blob) {
        const bytes = new Uint8Array(await rec.blob.arrayBuffer());
        files.push({ name: rec.name || `${id}.cbz`, data: bytes });
      }
    }
    if (!files.length) return { ok: false, count: 0 };
    const blob = zip.buildZip(files);
    triggerDownload(blob, sanitize(zipName || 'nyora-download') + '.zip');
    return { ok: true, count: files.length };
  },

  // ---- events ----
  subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  },
};

// Resume any queued / interrupted work once the app has settled.
try { setTimeout(() => pump(), 0); } catch { /* non-browser */ }

export default downloads;
