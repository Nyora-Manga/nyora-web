import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const script = await readFile(new URL('../web/sw.js', import.meta.url), 'utf8');
for (const cached of [false, true]) test(`ONNX module workers receive isolation headers (${cached ? 'cached' : 'network'})`, async () => {
  const handlers = {};
  const context = vm.createContext({
    self: { location: new URL('https://web.nyora.xyz'), addEventListener: (type, fn) => { handlers[type] = fn; } },
    URL, Request, Response, Headers,
    fetch: async () => new Response('export {};'),
    caches: { open: async () => ({ match: async () => cached ? new Response('cached module') : undefined, put: async () => {} }) },
  });
  vm.runInContext(script, context);
  let response;
  handlers.fetch({ request: new Request('https://web.nyora.xyz/vendor/ort/ort-wasm-simd-threaded.jsep.mjs'), respondWith: p => { response = p; } });
  assert.equal((await response).headers.get('Cross-Origin-Embedder-Policy'), 'credentialless');
});
test('canonical reader URLs never trigger domain migration', async () => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const external = html.match(/<script src="(\/boot\/migrate.js)[^"]*"><\/script>/);
  const migration = external ? await readFile(new URL(`../web${external[1]}`, import.meta.url), 'utf8') : html.match(/<script>([\s\S]*?)<\/script>/)[1];
  let redirected = false;
  const location = new URL('https://web.nyora.xyz/#/reader?chapterUrl=test');
  location.replace = () => { redirected = true; };
  vm.runInNewContext(migration, { location, localStorage: { length: 0 }, document: { documentElement: { style: {} } } });
  assert.equal(redirected, false);
  assert.equal(location.hash, '#/reader?chapterUrl=test');
});
