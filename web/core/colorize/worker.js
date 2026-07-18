// core/colorize/worker.js — on-device manga colorization. Runs
// manga-colorization-v2 (fp16 ONNX, ~62 MB, MIT) via onnxruntime-web (WebGPU,
// wasm fallback) entirely in the browser: pages never leave the device.
//
// This model is trained on MANGA/anime art (the same weights the browser manga
// colorizers ship). A photo-trained model (DDColor) was tried and produced wrong
// colours on line art, so we're back on the manga-specific generator.
//
// I/O (verified): input `input` float32 [1,5,H,W] — channel 0 = grayscale in
// [0,1], channels 1-4 = 0 (automatic, no colour hint); output `rgb` float32
// [1,3,H,W] in 0..1. H,W must be multiples of 32.
//
// Quality notes:
//  - to keep line art CRISP the model's colour is combined with the ORIGINAL
//    full-resolution luminance (YCbCr): Cb/Cr from the (upscaled) model output,
//    Y from the source → coloured page with sharp lines.
//
// Protocol: {type:'init'} → progress*/ready|init-error
//           {type:'page', id, bitmap} → color {id,width,height,data} | color-error

import { MODEL_URL, MODEL_BYTES, MODEL_CACHE, MODEL_SHA256 } from './model.js';

// onnxruntime is SELF-HOSTED (web/vendor/ort/). It used to load from jsDelivr,
// but a dynamic import() cannot carry an integrity attribute and neither can
// ORT's own wasm fetches — so the runtime AND its wasm binaries were entirely
// unverified third-party code, in a worker that sees every page image. Serving
// them from our own origin makes that code same-origin and lets the CSP pin
// script-src to 'self'. Update via web/vendor/ort/README.txt.
const ORT_URL = '/vendor/ort/ort.min.mjs';
const ORT_WASM_PATH = '/vendor/ort/';

let ort = null;
let session = null;
let webgpu = false;
let initPromise = null;
let queue = Promise.resolve();

const post = (m, t) => self.postMessage(m, t || []);

self.onmessage = (ev) => {
  const m = ev.data || {};
  if (m.type === 'init') {
    ensureInit().then(() => post({ type: 'ready' }))
      .catch((e) => post({ type: 'init-error', error: String((e && e.message) || e) }));
  } else if (m.type === 'page') {
    queue = queue.then(() => ensureInit()).then(() => handle(m.id, m.bitmap))
      .catch((e) => post({ type: 'color-error', id: m.id, error: String((e && e.message) || e) }));
  }
};

function ensureInit() {
  if (!initPromise) initPromise = init().catch((e) => { initPromise = null; throw e; });
  return initPromise;
}

async function init() {
  post({ type: 'progress', label: 'Loading AI runtime', pct: 0 });
  ort = await import(ORT_URL);
  ort.env.wasm.wasmPaths = ORT_WASM_PATH;
  if (self.crossOriginIsolated) ort.env.wasm.numThreads = Math.min(8, Math.max(1, (navigator.hardwareConcurrency || 4) - 1));
  const buf = await fetchWithProgress(MODEL_URL, 'colorizer model', MODEL_BYTES);
  const hasGpu = typeof navigator !== 'undefined' && !!navigator.gpu;
  if (hasGpu) {
    try { session = await ort.InferenceSession.create(buf, { executionProviders: ['webgpu', 'wasm'] }); webgpu = true; }
    catch { session = null; }
  }
  if (!session) session = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
}

async function verifyDigest(buf, label) {
  const got = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  if (got !== MODEL_SHA256) throw new Error(`${label} failed integrity check — refusing to load it`);
}

async function fetchWithProgress(url, label, sizeHint) {
  const cache = await caches.open(MODEL_CACHE).catch(() => null);
  if (cache) {
    const hit = await cache.match(url).catch(() => null);
    if (hit) {
      // Re-verify cached bytes: this cache survives service worker cleanup, so
      // a bad copy would otherwise persist across deploys.
      const cached = await hit.arrayBuffer();
      try { await verifyDigest(cached, label); return cached; }
      catch (e) { await cache.delete(url).catch(() => {}); throw e; }
    }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${label} download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || sizeHint || 0;
  const reader = res.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    if (total) post({ type: 'progress', label: `Downloading ${label}`, pct: Math.min(100, Math.round((got / total) * 100)) });
  }
  const blob = new Blob(chunks);
  const buf = await blob.arrayBuffer();
  await verifyDigest(buf, label); // BEFORE caching, so bad bytes never persist
  if (cache) await cache.put(url, new Response(blob)).catch(() => {});
  return buf;
}

async function handle(id, bitmap) {
  const OW = bitmap.width;
  const OH = bitmap.height;
  // Match the reference implementation's resize_pad EXACTLY (utils/utils.py):
  // portrait pages are resized to WIDTH = SIZE, landscape to HEIGHT = SIZE*1.5,
  // then padded to a multiple of 32 with white. Running this GAN far off its
  // design point (we previously used a 1280px long side) gains nothing —
  // measured against the author's own sample it was no better, and staying on
  // the trained resolution keeps colours consistent.
  const SIZE = 576;
  let vw, vh; // valid (unpadded) model region
  if (OH < OW) { vh = Math.round(SIZE * 1.5); vw = Math.ceil(OW / (OH / (SIZE * 1.5))); }
  else { vw = SIZE; vh = Math.ceil(OH / (OW / SIZE)); }
  const mw = Math.max(32, Math.ceil(vw / 32) * 32);
  const mh = Math.max(32, Math.ceil(vh / 32) * 32);

  // draw the page into the padded model canvas (white pad)
  const mc = new OffscreenCanvas(mw, mh);
  const mx = mc.getContext('2d', { willReadFrequently: true });
  mx.fillStyle = '#fff'; mx.fillRect(0, 0, mw, mh);
  mx.drawImage(bitmap, 0, 0, vw, vh);
  const md = mx.getImageData(0, 0, mw, mh).data;
  const plane = mw * mh;

  // grayscale → model input (ch1-4 stay 0 = automatic colourisation, no hint)
  const gray = new Float32Array(plane);
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    gray[i] = (0.299 * md[p] + 0.587 * md[p + 1] + 0.114 * md[p + 2]) / 255;
  }
  const input = new Float32Array(5 * plane);
  input.set(gray, 0);

  const out = await session.run({ input: new ort.Tensor('float32', input, [1, 5, mh, mw]) });
  const rgb = out.rgb.data; // [1,3,mh,mw] 0..1

  // model colour → an ImageBitmap we can upscale, then luminance-combine with
  // the ORIGINAL full-res page (Y from source, Cb/Cr from model) for crisp lines.
  const colorCanvas = new OffscreenCanvas(mw, mh);
  const cx = colorCanvas.getContext('2d');
  const cimg = cx.createImageData(mw, mh);
  for (let i = 0; i < plane; i++) {
    cimg.data[i * 4] = clamp255(rgb[i] * 255);
    cimg.data[i * 4 + 1] = clamp255(rgb[plane + i] * 255);
    cimg.data[i * 4 + 2] = clamp255(rgb[2 * plane + i] * 255);
    cimg.data[i * 4 + 3] = 255;
  }
  cx.putImageData(cimg, 0, 0);

  // upscale model colour to original size (only the valid, unpadded region)
  const up = new OffscreenCanvas(OW, OH);
  const ux = up.getContext('2d', { willReadFrequently: true });
  ux.imageSmoothingEnabled = true;
  ux.drawImage(colorCanvas, 0, 0, vw, vh, 0, 0, OW, OH);
  const colorFull = ux.getImageData(0, 0, OW, OH).data;

  // original page at full res for luminance
  const oc = new OffscreenCanvas(OW, OH);
  const ox = oc.getContext('2d', { willReadFrequently: true });
  ox.drawImage(bitmap, 0, 0);
  const orig = ox.getImageData(0, 0, OW, OH).data;
  bitmap.close();

  // Combine: keep source Y (crisp line art), take Cb/Cr from the model colour,
  // scaled by SAT. The raw generator output is noticeably duller than the
  // author's own published samples — measured on their sample page our chroma
  // was 45.4 vs their 57.0, and 1.28× lands on it. This is a chroma-only gain:
  // luminance (the line art) is untouched.
  const SAT = 1.28;
  const outData = new Uint8ClampedArray(OW * OH * 4);
  for (let i = 0; i < OW * OH; i++) {
    const p = i * 4;
    const Y = 0.299 * orig[p] + 0.587 * orig[p + 1] + 0.114 * orig[p + 2];
    const cr = colorFull[p], cg = colorFull[p + 1], cb = colorFull[p + 2];
    const Cb = (-0.168736 * cr - 0.331264 * cg + 0.5 * cb) * SAT;
    const Cr = (0.5 * cr - 0.418688 * cg - 0.081312 * cb) * SAT;
    outData[p] = clamp255(Y + 1.402 * Cr);
    outData[p + 1] = clamp255(Y - 0.344136 * Cb - 0.714136 * Cr);
    outData[p + 2] = clamp255(Y + 1.772 * Cb);
    outData[p + 3] = 255;
  }
  post({ type: 'color', id, width: OW, height: OH, data: outData.buffer }, [outData.buffer]);
}

function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }
