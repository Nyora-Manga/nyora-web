// core/colorize/model.js — the single loading + persistence path for the
// on-device colorizer model. Imported by both the settings/main thread and the
// inference worker so cache validation, downloads and errors cannot diverge.
//
// Model: manga-colorization-v2 (qweasdd) — a GAN trained on MANGA/anime art, not
// photos. This is the model the browser manga colorizers (e.g. Chromanga) ship,
// and it's the right call here: the 2025 SOTA line-art colorizers (MangaNinja,
// ControlNet/FLUX LoRAs) are multi-GB diffusion models that need a colour
// REFERENCE image and many sampling steps — they can't run in a browser tab.
// DDColor was tried and rejected: it's photo-trained, so manga came out wrong.
// Nyora's public GitHub mirror keeps the browser download independent of the
// upstream hosting provider. Pin the raw URL to a commit so a future model
// update gets a new Cache API key and cannot silently replace cached bytes.
export const MODEL_URL = 'https://raw.githubusercontent.com/Nyora-Manga/manga-colorization-v2-onnx/044b94a18a5a2e92cb320d8d69cc7583941d3678/manga-colorize-fp16.onnx';
export const MODEL_BYTES = 61_650_260; // ~62 MB
// SHA-256 of the file at the pinned commit above. The download is checked
// against it before anything is cached, so a truncated, corrupted or swapped
// response fails here — visibly, in the settings UI — rather than being stored
// and only surfacing later as an unexplained worker failure.
export const MODEL_SHA256 = '39660d0047ea6f1a0ddee6aa89054997f95ea566f4d56ff762f66dbcf1a1a7ef';
export const MODEL_CACHE = 'nyora-tl-models'; // shared persistent bucket (survives SW upgrades)
export const MODEL_ID = 'manga-colorization-v2-fp16@044b94a';

// Written onto the cached response as provenance only — nothing reads them back
// (see readCachedModel). Useful when inspecting the Cache API by hand.
const META_ID = 'x-nyora-model-id';
const META_BYTES = 'x-nyora-model-bytes';
const LEGACY_URLS = [
  'https://huggingface.co/Faridzar/manga-colorization-v2-onnx/resolve/5515e06d31b08ffd107af686cba5e98e95e8d4cf/manga-colorize-fp16.onnx',
  'https://huggingface.co/Faridzar/manga-colorization-v2-onnx/resolve/main/manga-colorize-fp16.onnx',
];

let activeDownload = null;
let activeProgress = 0;
const progressListeners = new Set();

function reportProgress(pct) {
  const next = Math.max(0, Math.min(100, Math.round(pct)));
  if (next === activeProgress && next !== 100) return;
  activeProgress = next;
  for (const cb of progressListeners) {
    try { cb(next); } catch { /* a UI callback must never break the download */ }
  }
}

function modelResponse(blob) {
  return new Response(blob, {
    headers: {
      'content-type': 'application/octet-stream',
      [META_ID]: MODEL_ID,
      [META_BYTES]: String(MODEL_BYTES),
    },
  });
}

async function openModelCache() {
  if (!globalThis.caches) throw new Error('Model storage is unavailable in this browser');
  try { return await caches.open(MODEL_CACHE); }
  catch { throw new Error('Model storage could not be opened'); }
}

async function deleteEntry(cache, url) {
  try { await cache.delete(url); } catch { /* best-effort stale-entry cleanup */ }
}

// Hands back whatever is cached, unexamined.
//
// Nothing is re-verified on this path by design. The bytes were checked against
// MODEL_SHA256 before they were ever written, and MODEL_URL is pinned to a
// commit, so a hit on this key IS the model — re-hashing or even re-measuring
// 62 MB on every reader open buys nothing and delays the load. If a cache entry
// is somehow damaged, ONNX will fail to parse it and init()'s repair path
// evicts the entry and re-downloads once, which is the cheaper place to pay.
async function readCachedModel(cache) {
  const hit = await cache.match(MODEL_URL).catch(() => null);
  if (!hit) return null;
  try { return await hit.blob(); } catch { return null; }
}

// Presence only — deliberately does NOT read the body, so the settings gate
// costs a cache lookup rather than materializing 62 MB.
export async function colorizeModelCached() {
  try {
    const cache = await openModelCache();
    return !!(await cache.match(MODEL_URL).catch(() => null));
  } catch { return false; }
}

export async function deleteCachedColorizeModel() {
  const cache = await openModelCache();
  await deleteEntry(cache, MODEL_URL);
}

function storageError(error) {
  const name = String(error && error.name || '');
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return new Error('Not enough device storage to save the colorization model');
  }
  return new Error('The colorization model downloaded, but could not be saved on this device');
}

// Rejects anything whose bytes are not the pinned model. Silently skipped where
// SubtleCrypto is unavailable — that is a non-secure context (a plain-http dev
// server), and refusing to download there would break local work for no gain;
// production is HTTPS, where the check always runs.
async function verifyModelBytes(bytes) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) return;
  let hex;
  try {
    const digest = await subtle.digest('SHA-256', bytes);
    hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return; // the platform refused to hash; the length check still applies
  }
  if (hex !== MODEL_SHA256) {
    throw new Error('The colorization model failed its integrity check — download rejected');
  }
}

async function downloadModel(cache) {
  // The old host keys are never used again. Removing them first avoids keeping
  // two 59 MB copies and frees room before the replacement is persisted.
  await Promise.all(LEGACY_URLS.map((url) => deleteEntry(cache, url)));

  const res = await fetch(MODEL_URL, {
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  if (!res.ok || !res.body) throw new Error(`Model download failed (${res.status})`);

  const serverBytes = Number(res.headers.get('content-length') || 0);
  if (serverBytes && serverBytes !== MODEL_BYTES) {
    throw new Error(`Model download has an unexpected size (${serverBytes} bytes)`);
  }

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  let lastPct = -1;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      const pct = Math.min(99, Math.floor((received / MODEL_BYTES) * 100));
      if (pct !== lastPct) { lastPct = pct; reportProgress(pct); }
    }
  } catch {
    try { await reader.cancel(); } catch { /* ignore */ }
    throw new Error('Model download was interrupted');
  }

  if (received !== MODEL_BYTES) {
    throw new Error(`Model download was incomplete (${received} of ${MODEL_BYTES} bytes)`);
  }

  // Flatten once and hash that, rather than blob → arrayBuffer, so the bytes
  // exist in exactly one extra copy while this runs.
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  chunks.length = 0;
  await verifyModelBytes(bytes);

  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  try {
    await cache.put(MODEL_URL, modelResponse(blob));
  } catch (error) {
    await deleteEntry(cache, MODEL_URL);
    throw storageError(error);
  }

  // A successful Cache.put is required: settings must never unlock the feature
  // after a best-effort write that vanished or was rejected by the browser.
  const saved = await cache.match(MODEL_URL).catch(() => null);
  if (!saved) throw new Error('The browser did not retain the downloaded model');
  reportProgress(100);
  return blob;
}

// Returns a model Blob and whether it came from persistent storage. Downloads
// are single-flight inside each execution context, and every caller receives
// the same progress stream.
export async function loadColorizeModel({ onProgress, forceDownload = false } = {}) {
  if (typeof onProgress === 'function') {
    progressListeners.add(onProgress);
    if (activeDownload) {
      try { onProgress(activeProgress); } catch { /* ignore */ }
    }
  }

  try {
    const cache = await openModelCache();
    if (!forceDownload) {
      const cached = await readCachedModel(cache);
      if (cached) {
        if (onProgress) {
          try { onProgress(100); } catch { /* ignore */ }
        }
        return { blob: cached, fromCache: true };
      }
    }

    if (!activeDownload) {
      activeProgress = 0;
      activeDownload = downloadModel(cache).finally(() => {
        activeDownload = null;
        activeProgress = 0;
      });
    }
    return { blob: await activeDownload, fromCache: false };
  } finally {
    if (typeof onProgress === 'function') progressListeners.delete(onProgress);
  }
}
