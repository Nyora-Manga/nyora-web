import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const script = await readFile(new URL('../web/sw.js', import.meta.url), 'utf8');
function harness() {
  let now = 1800000000000;
  const stores = new Map(), calls = [];
  let online = true;
  const caches = { async open(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    const data = stores.get(name), key = r => typeof r === 'string' ? r : r.url;
    return { async match(r) { return data.get(key(r))?.clone(); }, async put(r, v) { data.set(key(r), v.clone()); } };
  }};
  const context = vm.createContext({
    self: { location: new URL('https://web.nyora.xyz'), addEventListener() {} },
    URL, Request, Response, Headers, caches,
    Date: class extends Date { static now() { return now; } },
    fetch: async req => { calls.push(req); if (!online) throw new Error('offline'); return new Response('image-' + calls.length); },
  });
  vm.runInContext(script, context);
  return { calls, caches, context,
    advance(ms) { now += ms; }, offline() { online = false; }, online() { online = true; },
    async image(url) { return context.cacheFirstImage(new Request(url), 'images'); },
  };
}

test('each source image refreshes after 24 hours without expiring another fresh image', async () => {
  const h = harness(), a = 'https://a.example/1.png', b = 'https://b.example/1.png';
  assert.equal(await (await h.image(a)).text(), 'image-1');
  h.advance(12 * 3600000);
  await h.image(b);
  h.advance(12 * 3600000);
  assert.equal(await (await h.image(a)).text(), 'image-3');
  assert.equal(await (await h.image(b)).text(), 'image-2');
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].cache, 'reload');
  assert.equal(h.calls[2].credentials, 'omit');
});

test('expired images remain readable offline and refresh on the next online request', async () => {
  const h = harness(), url = 'https://a.example/1.png';
  await h.image(url); h.advance(86400000); h.offline();
  assert.equal(await (await h.image(url)).text(), 'image-1');
  h.online();
  assert.equal(await (await h.image(url)).text(), 'image-3');
});

test('legacy images without an age are reloaded and helper URLs bypass old immutable cache entries', async () => {
  const h = harness(), url = 'https://api.nyora.xyz/image?u=https%3A%2F%2Fa.example%2F1.png';
  await (await h.caches.open('images')).put(new Request(url), new Response('old'));
  assert.equal(await (await h.image(url)).text(), 'image-1');
  const fetched = new URL(h.calls[0].url);
  assert.equal(fetched.searchParams.get('u'), 'https://a.example/1.png');
  assert(fetched.searchParams.has('nyora_image_day'));
  h.advance(86400000); await h.image(url);
  assert.notEqual(h.calls[0].url, h.calls[1].url);
});

test('a partial response does not replace a complete cached image', async () => {
  const h = harness(), url = 'https://a.example/1.png';
  await h.image(url); h.advance(86400000);
  h.context.fetch = async () => new Response('partial', { status: 206 });
  assert.equal(await (await h.image(url)).text(), 'image-1');
  assert.equal(await (await (await h.caches.open('images')).match(new Request(url))).text(), 'image-1');
});
