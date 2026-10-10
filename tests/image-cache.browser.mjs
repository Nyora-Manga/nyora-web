// Real service worker + CacheStorage + Chromium. Only the upstream images are fixtures.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const sw = await readFile(new URL('../dist/sw.js', import.meta.url));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC', 'base64');
const requests = [];
const handler = (req, res) => {
  if (req.url.startsWith('/image')) {
    requests.push(req.url);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public,max-age=31536000,immutable' }); res.end(png);
  } else if (req.url === '/sw.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' }); res.end(sw);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Cache test</title>');
  }
};
const servers = [createServer(handler), createServer(handler)];
await Promise.all(servers.map(s => new Promise(resolve => s.listen(0, '127.0.0.1', resolve))));
const base = `http://127.0.0.1:${servers[0].address().port}`;
const remote = `http://127.0.0.1:${servers[1].address().port}/image?fixture=remote`;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await page.goto(base);
  await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; });
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  async function image(url) {
    return page.evaluate(async url => {
      const img = new Image(); img.src = url; await img.decode(); return img.naturalWidth;
    }, url);
  }
  async function expire(url) {
    await page.evaluate(async url => {
      const key = (await caches.keys()).find(k => k.endsWith('-img-age'));
      await (await caches.open(key)).put(new Request(url), new Response(String(Date.now() - 86400001)));
    }, new URL(url, base).href);
    // Simulate expiry of Chromium's separate HTTP/decoded-image caches; the
    // service worker CacheStorage and its deliberately aged entry remain intact.
    await cdp.send('Network.clearBrowserCache');
    await page.reload();
  }
  assert.equal(await image('/image?fixture=one'), 1);
  await image('/image?fixture=two');
  assert.equal(requests.length, 2);
  await expire('/image?fixture=one');
  await image('/image?fixture=one'); await image('/image?fixture=two');
  assert.equal(requests.length, 3);
  assert(requests.every(url => url.includes('nyora_image_day=')));
  // Cross-origin no-CORS images return opaque responses; timestamps still work.
  assert.equal(await image(remote), 1);
  await expire(remote); await image(remote);
  assert.equal(requests.length, 5);
  await expire('/image?fixture=one');
  await context.setOffline(true);
  assert.equal(await image('/image?fixture=one'), 1);
  await context.setOffline(false);
  await cdp.send('Network.clearBrowserCache');
  await page.reload();
  await image('/image?fixture=one');
  assert.equal(requests.length, 6);
  console.log('Browser PASS: daily image expiry, source isolation, opaque CDN images, legacy HTTP-cache bypass, and offline recovery');
} finally {
  await browser.close();
  await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
}
