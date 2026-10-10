// The ONNX double emulates silent CPU fallback and a constrained allocator;
// the worker protocol, bitmap decoding and canvas composition remain real.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MODEL_URL, MODEL_CACHE } from '../web/core/colorize/model.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const base = process.env.NYORA_TEST_URL || 'http://127.0.0.1:8899';
const source = await readFile(new URL('../web/core/colorize/worker.js', import.meta.url), 'utf8');
let failures = 0;
try {
  for (const scenario of ['cpu-label', 'cpu-memory', 'cpu-tall', 'gpu']) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      await page.route('**/colorizer-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Colorizer test</title>' }));
      await page.route('**/core/colorize/worker.js', route => route.fulfill({ contentType: 'text/javascript',
        body: "Object.defineProperty(navigator, 'gpu', {value:{}, configurable:true});\n" + source }));
      await page.route('**/vendor/ort/ort.min.mjs', route => route.fulfill({ contentType: 'text/javascript', body: `
        export const env={wasm:{},webgpu:{}};
        export class Tensor { constructor(type,data,dims){Object.assign(this,{type,data,dims});} dispose(){} }
        export const InferenceSession={async create(bytes,options){
          const providers=options.executionProviders;
          const gpu=${JSON.stringify(scenario)}==='gpu' && providers.includes('webgpu');
          if(!gpu && !providers.includes('wasm')) throw new Error('GPU adapter unavailable');
          return {async release(){},async run({input}){
            const [,,h,w]=input.dims;
            if(['cpu-memory','cpu-tall'].includes(${JSON.stringify(scenario)}) && h*w>384*1024) throw new Error('CPU allocation failed');
            const rgb=new Float32Array(3*h*w);rgb.fill(.25,0,h*w);rgb.fill(.5,h*w,2*h*w);rgb.fill(.75,2*h*w);
            return {rgb:new Tensor('float32',rgb,[1,3,h,w])};
          }};
        }};` }));
      await page.goto(base + '/colorizer-test');
      await page.evaluate(async ({ url, cache }) => {
        await (await caches.open(cache)).put(url, new Response(new Uint8Array([1])));
      }, { url: MODEL_URL, cache: MODEL_CACHE });
      const height = scenario === 'cpu-tall' ? 12000 : 600;
      const result = await page.evaluate(height => new Promise(resolve => {
        const worker = new Worker('/core/colorize/worker.js', { type: 'module' });
        let backend;
        const finish = result => { clearTimeout(timer); worker.terminate(); resolve({ ...result, backend }); };
        const timer = setTimeout(() => finish({ error: 'worker timeout' }), 15000);
        worker.onerror = event => finish({ error: event.message });
        worker.onmessage = async ({ data }) => {
          if (data.type.endsWith('error')) finish({ error: data.error });
          if (data.type === 'ready') {
            backend = data.backend;
            const canvas = new OffscreenCanvas(400, height);
            const ctx = canvas.getContext('2d'); ctx.fillStyle = '#888'; ctx.fillRect(0, 0, 400, height);
            const bitmap = await createImageBitmap(canvas);
            worker.postMessage({ type: 'page', id: 1, bitmap }, [bitmap]);
          }
          if (data.type === 'color') {
            const bitmap = await createImageBitmap(data.blob);
            const width = bitmap.width, height = bitmap.height; bitmap.close();
            finish({ width, height, bytes: data.blob.size });
          }
        };
        worker.postMessage({ type: 'init' });
      }), height);
      assert.equal(result.error, undefined, `${scenario}: ${result.error}`);
      assert.equal(result.backend, scenario === 'gpu' ? 'GPU' : 'CPU');
      assert.equal(result.width, 400); assert.equal(result.height, height);
      assert(result.bytes > 0);
      console.log(`PASS ${scenario}: correct backend and complete full-size output`);
    } catch (error) {
      failures++; console.error(`FAIL ${scenario}: ${error.message}`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
if (failures) process.exitCode = 1;
