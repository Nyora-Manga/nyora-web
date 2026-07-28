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
//           {type:'ensure-model', id} → model-ready|model-error
//           {type:'page', id, bitmap} → color {id,width,height,blob} | color-error

import { deleteCachedColorizeModel, loadColorizeModel } from './model.js';

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
    ensureInit().then(() => post({ type: 'ready', backend: webgpu ? 'GPU' : 'CPU', threads: (ort && ort.env.wasm.numThreads) || 1 }))
      .catch((e) => post({ type: 'init-error', error: String((e && e.message) || e) }));
  } else if (m.type === 'ensure-model') {
    // Through the same queue as inference. Off it, a re-init triggered while a
    // page was mid-run could build a second InferenceSession alongside the one
    // still executing — two copies of the model resident at once, on exactly
    // the device that just failed to hold one.
    let wasResident = false;
    queue = queue
      // Read at the front of the queue, not when the message arrived: a job
      // ahead of us may have rebuilt the session in the meantime.
      .then(() => { wasResident = hasModelSession(); })
      .then(() => ensureInit())
      .then(() => post({
        type: 'model-ready',
        id: m.id,
        loaded: !wasResident,
        backend: webgpu ? 'GPU' : 'CPU',
        threads: (ort && ort.env.wasm.numThreads) || 1,
      }))
      .catch((e) => post({
        type: 'model-error',
        id: m.id,
        error: String((e && e.message) || e),
      }));
  } else if (m.type === 'page') {
    queue = queue.then(() => ensureInit()).then(() => handle(m.id, m.bitmap))
      .catch((e) => {
        closeBitmap(m.bitmap);
        const error = String((e && e.message) || e);
        post({ type: 'color-error', id: m.id, error, fatal: (e && e.colorizerFatal === true) || isMemoryFailure(error) });
      });
  }
};

function hasModelSession() {
  return !!session && typeof session.run === 'function';
}

function ensureInit() {
  // Cache residency and memory residency are different states. A resolved old
  // promise says only that initialization succeeded once; the live ORT session
  // is the authoritative signal that the model is still in memory.
  if (hasModelSession()) return Promise.resolve();
  if (!initPromise) {
    initPromise = init()
      .then(() => {
        if (!hasModelSession()) throw new Error('Colorizer model did not enter memory');
      })
      .finally(() => { initPromise = null; });
  }
  return initPromise;
}

async function init() {
  try {
    post({ type: 'progress', label: 'Loading AI runtime', pct: 0 });
    if (!ort) ort = await import(ORT_URL);
    ort.env.wasm.wasmPaths = ORT_WASM_PATH;
    // Multi-thread the wasm backend when the page is cross-origin isolated (the
    // SW injects COOP/COEP, so it is). WebGPU is still tried first.
    if (self.crossOriginIsolated) {
      ort.env.wasm.numThreads = Math.min(8, Math.max(1, (navigator.hardwareConcurrency || 4) - 1));
    }
    const loaded = await loadColorizeModel({
      onProgress: (pct) => post({ type: 'progress', label: 'Loading colorizer model', pct }),
    });
    post({ type: 'progress', label: 'Adding colorizer model to memory', pct: 100 });
    const buf = await loaded.blob.arrayBuffer();
    try {
      await createModelSession(buf);
    } catch (error) {
      if (!loaded.fromCache) throw error;
      // A size-valid cache entry can still be unreadable to ONNX (for example a
      // browser/storage corruption). Evict it and retry the network exactly once.
      post({ type: 'progress', label: 'Repairing colorizer model cache', pct: 0 });
      await deleteCachedColorizeModel();
      const fresh = await loadColorizeModel({
        forceDownload: true,
        onProgress: (pct) => post({ type: 'progress', label: 'Downloading colorizer model', pct }),
      });
      post({ type: 'progress', label: 'Adding colorizer model to memory', pct: 100 });
      await createModelSession(await fresh.blob.arrayBuffer());
    }
  } catch (error) {
    await releaseModelSession();
    throw error;
  }
}

async function releaseModelSession() {
  const old = session;
  session = null;
  webgpu = false;
  try { if (old && typeof old.release === 'function') await old.release(); } catch { /* best effort */ }
}

async function createModelSession(buf) {
  await releaseModelSession();
  const hasGpu = typeof navigator !== 'undefined' && !!navigator.gpu;
  if (hasGpu) {
    try { session = await ort.InferenceSession.create(buf, { executionProviders: ['webgpu', 'wasm'] }); webgpu = true; }
    catch { session = null; }
  }
  if (!session) session = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
}

async function handle(id, bitmap) {
  const t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
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
  // resize_pad fixes the SHORT side and lets the long one follow the aspect
  // ratio, which is fine for a page and ruinous for a webtoon strip: an
  // 800x12000 image asks for a [1,5,8640,576] input — a 99 MB input tensor, a
  // 60 MB output, and minutes of inference before it very likely dies of an
  // allocation failure. Cap the pixel budget and let tall pages run at a lower
  // model resolution; only chroma comes from the model (luminance is taken from
  // the full-resolution original in composePageBlob), so the visible cost is
  // slightly softer colour, against a page that otherwise never colours at all.
  const MAX_MODEL_PIXELS = 576 * 1536;
  const overBudget = (vw * vh) / MAX_MODEL_PIXELS;
  if (overBudget > 1) {
    const shrink = Math.sqrt(overBudget);
    vw = Math.max(32, Math.floor(vw / shrink));
    vh = Math.max(32, Math.floor(vh / shrink));
  }
  const mw = Math.max(32, Math.ceil(vw / 32) * 32);
  const mh = Math.max(32, Math.ceil(vh / 32) * 32);

  let colorCanvas = null;
  try {
    colorCanvas = await inferColorCanvas(bitmap, vw, vh, mw, mh);
    const blob = await composePageBlob(bitmap, colorCanvas, { width: OW, height: OH, validWidth: vw, validHeight: vh });
    const ms = Math.round(((typeof performance !== 'undefined') ? performance.now() : Date.now()) - t0);
    post({ type: 'color', id, width: OW, height: OH, blob, ms });
  } finally {
    closeBitmap(bitmap);
    releaseCanvas(colorCanvas);
  }
}

async function inferColorCanvas(bitmap, vw, vh, mw, mh) {
  const modelCanvas = new OffscreenCanvas(mw, mh);
  const modelContext = modelCanvas.getContext('2d', { willReadFrequently: true });
  modelContext.fillStyle = '#fff';
  modelContext.fillRect(0, 0, mw, mh);
  modelContext.drawImage(bitmap, 0, 0, vw, vh);
  const modelPixels = modelContext.getImageData(0, 0, mw, mh).data;
  const plane = mw * mh;

  // Fill channel zero directly and leave hint channels 1–4 at zero. The old
  // code allocated a second full grayscale plane before copying it here.
  const inputData = new Float32Array(5 * plane);
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    inputData[i] = (0.299 * modelPixels[p] + 0.587 * modelPixels[p + 1] + 0.114 * modelPixels[p + 2]) / 255;
  }
  releaseCanvas(modelCanvas);

  const inputTensor = new ort.Tensor('float32', inputData, [1, 5, mh, mw]);
  let outputs = null;
  try {
    try {
      outputs = await session.run({ input: inputTensor });
    } catch (error) {
      // The JS wrapper can survive browser memory pressure or a lost GPU device
      // while its native session is no longer usable. Mark it non-resident now;
      // the next ensure-model request will recreate it from persistent cache.
      await releaseModelSession();
      const failure = new Error(`colorizer inference failed: ${String((error && error.message) || error)}`);
      failure.colorizerFatal = true;
      throw failure;
    }
    const rgbTensor = outputs.rgb;
    if (!rgbTensor || !rgbTensor.data) throw new Error('colorizer model returned no RGB output');
    const rgb = rgbTensor.data; // [1,3,mh,mw] 0..1
    const colorCanvas = new OffscreenCanvas(mw, mh);
    const colorContext = colorCanvas.getContext('2d');
    const colorImage = colorContext.createImageData(mw, mh);
    for (let i = 0; i < plane; i++) {
      colorImage.data[i * 4] = clamp255(rgb[i] * 255);
      colorImage.data[i * 4 + 1] = clamp255(rgb[plane + i] * 255);
      colorImage.data[i * 4 + 2] = clamp255(rgb[2 * plane + i] * 255);
      colorImage.data[i * 4 + 3] = 255;
    }
    colorContext.putImageData(colorImage, 0, 0);
    return colorCanvas;
  } finally {
    if (outputs) {
      for (const tensor of Object.values(outputs)) {
        try { if (tensor && typeof tensor.dispose === 'function') tensor.dispose(); } catch { /* ignore */ }
      }
    }
    try { if (typeof inputTensor.dispose === 'function') inputTensor.dispose(); } catch { /* ignore */ }
  }
}

async function composePageBlob(bitmap, colorCanvas, { width, height, validWidth, validHeight }) {
  // Compose in ~1M-pixel strips. Previously colorFull + orig + outData and two
  // full-size canvases existed together, exceeding hundreds of MB on tall pages.
  const tileRows = Math.max(32, Math.min(512, height, Math.floor(1_048_576 / Math.max(1, width))));
  const colorTile = new OffscreenCanvas(width, tileRows);
  const originalTile = new OffscreenCanvas(width, tileRows);
  const resultCanvas = new OffscreenCanvas(width, height);
  const colorContext = colorTile.getContext('2d', { willReadFrequently: true });
  const originalContext = originalTile.getContext('2d', { willReadFrequently: true });
  const resultContext = resultCanvas.getContext('2d');
  const SAT = 1.28;

  try {
    for (let y = 0; y < height; y += tileRows) {
      const rows = Math.min(tileRows, height - y);
      colorContext.clearRect(0, 0, width, tileRows);
      originalContext.clearRect(0, 0, width, tileRows);
      colorContext.imageSmoothingEnabled = true;
      colorContext.drawImage(colorCanvas, 0, 0, validWidth, validHeight, 0, -y, width, height);
      originalContext.drawImage(bitmap, 0, y, width, rows, 0, 0, width, rows);

      const colored = colorContext.getImageData(0, 0, width, rows);
      const original = originalContext.getImageData(0, 0, width, rows).data;
      const data = colored.data;
      for (let p = 0; p < data.length; p += 4) {
        const Y = 0.299 * original[p] + 0.587 * original[p + 1] + 0.114 * original[p + 2];
        const cr = data[p], cg = data[p + 1], cb = data[p + 2];
        const Cb = (-0.168736 * cr - 0.331264 * cg + 0.5 * cb) * SAT;
        const Cr = (0.5 * cr - 0.418688 * cg - 0.081312 * cb) * SAT;
        data[p] = clamp255(Y + 1.402 * Cr);
        data[p + 1] = clamp255(Y - 0.344136 * Cb - 0.714136 * Cr);
        data[p + 2] = clamp255(Y + 1.772 * Cb);
        data[p + 3] = 255;
      }
      resultContext.putImageData(colored, 0, y);
    }
    // WebP, not PNG — for MEMORY, not speed. The engine keeps 6–12 finished
    // pages alive as blob URLs, so the encoding is what the result cache costs:
    // measured on a detailed page, PNG 1602 KB vs WebP 601 KB, and the gap
    // widens on flatter art. Encode time is a wash and can go either way (that
    // same page: 75 ms PNG, 119 ms WebP) — irrelevant either way next to an
    // inference step measured in seconds. Quality 0.92 is safe here because the
    // crisp part of the image is luminance carried over from the original.
    // A browser that cannot encode WebP falls back to PNG on its own, per the
    // canvas spec, so this needs no capability check.
    return await resultCanvas.convertToBlob({ type: 'image/webp', quality: 0.92 });
  } finally {
    releaseCanvas(colorTile);
    releaseCanvas(originalTile);
    releaseCanvas(resultCanvas);
  }
}

function closeBitmap(bitmap) {
  try { if (bitmap && typeof bitmap.close === 'function') bitmap.close(); } catch { /* ignore */ }
}

function releaseCanvas(canvas) {
  if (!canvas) return;
  try { canvas.width = 1; canvas.height = 1; } catch { /* ignore */ }
}

function isMemoryFailure(message) {
  return /out of memory|memory access|allocation|device lost|gpu device|buffer map|session.*invalid/i.test(message);
}

function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }
