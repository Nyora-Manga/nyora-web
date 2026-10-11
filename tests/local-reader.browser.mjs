// Run against the source dev server with Playwright installed.
// Only the directory picker, inference workers, and translation service are
// substituted. File decoding, reader, engines, overlays and navigation are real.
import assert from 'node:assert/strict';
import { buildZip } from '../web/core/zip.js';
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC', 'base64'));
const archiveBytes = [...new Uint8Array(await buildZip([{ name: '1.png', data: png }]).arrayBuffer())];
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const base = process.env.NYORA_TEST_URL || 'http://127.0.0.1:8899';
try {
  const phone = process.env.AI_MOBILE === '1';
  const context = await browser.newContext({ serviceWorkers: 'block', hasTouch: phone });
  await context.addInitScript(({ archiveBytes }) => {
    const NativeWorker = window.Worker;
    window.__aiWorkers = new Set();
    window.Worker = class extends NativeWorker {
      constructor(...args) { super(...args); window.__aiWorkers.add(this); }
      terminate() { window.__aiWorkers.delete(this); super.terminate(); }
    };
    localStorage.setItem('nyora.web.onboarded.v1', '1');
    localStorage.setItem('nyora.changelog.seen', '2.6.0');
    const plain = new URL(location.href).searchParams.has('plain-reader');
    localStorage.setItem('nyora.prefs', JSON.stringify({ experimental: !plain,
      reader: { mode: plain ? 'PAGED' : 'WEBTOON', translate: true, colorize: plain,
        translateFrom: 'auto', translateTo: 'en' } }));
    localStorage.setItem('nyora.downloads.v1', JSON.stringify([{ id: 'offline-fixture',
      sourceId: 'data:fixture', chapterUrl: '/chapter/1', mangaTitle: 'Downloaded test book',
      chapterTitle: 'Chapter 1', status: 'COMPLETED', offline: true, completedPages: 1 }]));
    window.showDirectoryPicker = async () => ({ name: 'Local test book', async *entries() {
      yield ['Archived book.cbz', { kind: 'file', getFile: async () => new File([new Uint8Array(archiveBytes)], 'Archived book.cbz') }];
      for (const name of ['10.png', '2.png']) {
        yield [name, { kind: 'file', getFile: async () => {
          const canvas = document.createElement('canvas');
          canvas.width = name === '2.png' ? 400 : 500; canvas.height = 600;
          const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, 600);
          const blob = await new Promise(resolve => canvas.toBlob(resolve));
          return new File([blob], name, { type: 'image/png' });
        } }];
      }
    } });
  }, { archiveBytes });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [], helperReads = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (/api\.nyora\.xyz\/(manga|image|sources)/.test(r.url())) helperReads.push(r.url()); });
  // Startup catalogue migration is separate from reading local pages.
  await page.route('https://api.nyora.xyz/**', route => route.fulfill({ json: new URL(route.request().url()).pathname === '/app/session' ? {token:'test-ticket',expiresIn:300} : {
    entries: [{ id: 'data:fixture', name: 'Fixture', lang: 'en' }],
  } }));
  await page.route('**/core/translate/tl-worker.js*', route => route.fulfill({ contentType: 'text/javascript', body: `
    onmessage = ({data:m}) => {
      if (m.type === 'init') postMessage({type:'ready'});
      if (m.type === 'page') {
        const w=m.bitmap.width,h=m.bitmap.height; m.bitmap.close();
        postMessage({type:'page-result',id:m.id,blocks:[{x:0,y:0,w:w/2,h:h/4,bg:'rgb(255, 255, 255)',text:'本を読みます'}]});
      }
    };` }));
  await page.route('**/core/colorize/worker.js*', route => route.fulfill({ contentType: 'text/javascript', body: `
    onmessage = async ({data:m}) => {
      if (m.type === 'init') postMessage({type:'ready',backend:'test'});
      if (m.type === 'ensure-model') postMessage({type:'model-ready',id:m.id});
      if (m.type === 'page') {
        const c=new OffscreenCanvas(m.bitmap.width,m.bitmap.height);
        m.bitmap.close();const ctx=c.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,c.width,c.height);
        postMessage({type:'color',id:m.id,blob:await c.convertToBlob()});
      }
    };` }));
  await page.route('https://translate.googleapis.com/**', route => route.fulfill({ json: [[['I read books.', '本を読みます', null, null]], null, 'ja'] }));
  await page.goto(base + '/#/local');
  await page.getByRole('button', { name: /^Choose folder$/i }).first().click();
  await page.locator('.local-body .row-item').filter({ hasText: 'Local test book' }).getByRole('button', { name: 'Read', exact: true }).click();
  await page.waitForURL(/#\/reader\?local=/, { timeout: 5000 });
  await page.locator('.reader-view').waitFor();
  await page.waitForFunction(() => document.querySelector('img.reader-page')?.naturalWidth === 400);
  await page.locator('.tl-block').filter({ hasText: 'I read books.' }).first().waitFor();
  const original = await page.locator('img.reader-page').first().getAttribute('src');
  assert(original.startsWith('blob:'));
  await page.locator('.reader-bar.top').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByText('AI colorize (beta)', { exact: true }).locator('..').locator('.switch').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelector('img.reader-page')?.__colorized === true);
  assert.notEqual(await page.locator('img.reader-page').first().getAttribute('src'), original);
  if (phone) {
    assert.equal(await page.evaluate(() => window.__aiWorkers.size), 1, 'Phone never keeps both model workers resident');
    assert.equal(await page.locator('.tl-overlay').count(), 0);
    if (await page.locator('.reader-view.controls-hidden').count()) await page.locator('img.reader-page').first().click({position:{x:250,y:250}});
    await page.locator('.reader-bar.top').getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByText('Translate pages (beta)', { exact: true }).locator('..').locator('.switch').click();
    assert.equal(await page.locator('[data-ai-toggle="colorize"]').isChecked(), false);
    await page.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('dialog').waitFor({state:'detached'});
    await page.locator('.tl-block').filter({ hasText: 'I read books.' }).first().waitFor();
    assert.equal(await page.evaluate(() => window.__aiWorkers.size), 1);
    assert.equal(await page.locator('img.reader-page').first().getAttribute('src'), original);
  }
  if (await page.locator('.reader-view.controls-hidden').count()) await page.locator('img.reader-page').first().click({ position: { x: 250, y: 250 } });
  await page.locator('.reader-bar.top').getByRole('button', { name: 'Back to files', exact: true }).click();
  await page.locator('.local-body .row-item').filter({ hasText: 'Local test book' }).waitFor();
  assert.equal(await page.evaluate(() => document.body.classList.contains('reader-active')), false);
  assert.equal(await page.evaluate(() => window.__aiWorkers.size), 0, 'Leaving the reader terminates both AI workers');
  assert.equal(await page.evaluate(async url => { try { await fetch(url); return true; } catch { return false; } }, original), false);
  await page.locator('.local-body .row-item').filter({ hasText: 'Local test book' }).getByRole('button', { name: 'Read', exact: true }).click();
  await page.locator('.reader-view').waitFor();
  await page.waitForFunction(() => document.querySelector('img.reader-page')?.naturalWidth === 400);
  await page.locator('.reader-bar.top').getByRole('button', { name: 'Back to files', exact: true }).click();
  await page.locator('.local-body .row-item').filter({ hasText: 'Archived book' }).getByRole('button', { name: 'Read', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('img.reader-page')?.naturalWidth === 1);
  await page.locator('.tl-block').filter({ hasText: 'I read books.' }).first().waitFor();
  assert.equal(await page.evaluate(() => (localStorage.getItem('nyora.library.v1') || '').includes('local:')), false,
    'Local reader sessions do not leak into the persistent/synced library');
  assert.equal(helperReads.filter(url => /\/(manga|image)\b/.test(url)).length, 0, 'Local pages never go to the helper');
  assert.deepEqual(errors, []);
  await page.reload();
  await page.getByText(/Reopen this book/).waitFor();
  await page.getByRole('button', { name: 'Back to files', exact: true }).click();
  await page.getByRole('button', { name: /^Choose folder$/i }).first().waitFor();
  // Seed a real offline archive in the same IndexedDB store used by downloads.
  await page.evaluate(async bytes => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('nyora-downloads', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('chapters', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('chapters', 'readwrite');
      tx.objectStore('chapters').put({ id: 'offline-fixture', blob: new Blob([new Uint8Array(bytes)]) });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close(); location.hash = '#/downloads';
  }, archiveBytes);
  await page.getByRole('button', { name: 'Read offline', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('img.reader-page')?.naturalWidth === 1);
  assert.equal(await page.locator('.tl-block').count(), 0, 'Reload recovery does not restart interrupted AI');
  assert.equal(await page.evaluate(() => window.__aiWorkers.size), 0);
  await page.locator('.reader-bar.top').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByText('Translate pages (beta)', { exact: true }).locator('..').locator('.switch').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('dialog').waitFor({state:'detached'});
  if (await page.locator('.reader-view.controls-hidden').count()) await page.locator('img.reader-page').first().click();
  await page.locator('.tl-block').filter({ hasText: 'I read books.' }).first().waitFor();
  const downloadedUrl = await page.locator('img.reader-page').getAttribute('src');
  await page.locator('.reader-bar.top').getByRole('button', { name: 'Back to downloads', exact: true }).click();
  await page.getByRole('button', { name: 'Read offline', exact: true }).waitFor();
  assert.equal(await page.evaluate(async url => { try { await fetch(url); return true; } catch { return false; } }, downloadedUrl), false);
  // The shared reader still honors the master feature gate and paged controls.
  await page.goto(base + '/?plain-reader#/local');
  await page.getByRole('button', { name: /^Choose folder$/i }).first().click();
  await page.locator('.local-body .row-item').filter({ hasText: 'Local test book' }).getByRole('button', { name: 'Read', exact: true }).click();
  await page.locator('.reader-paged-track').waitFor();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('.reader-paged-track')?.scrollLeft > 0);
  await page.locator('.reader-bar.top').getByRole('button', { name: 'Settings', exact: true }).click();
  assert.equal(await page.getByText('Translate pages (beta)', { exact: true }).count(), 0);
  assert.equal(await page.getByText('AI colorize (beta)', { exact: true }).count(), 0);
  assert.equal(await page.locator('.tl-overlay').count(), 0);
  assert.equal(helperReads.filter(url => /\/(manga|image)\b/.test(url)).length, 0);
  assert.deepEqual(errors, []);
  console.log('PASS: folders, CBZ and offline downloads share the reader; AI integration, feature gate, paged controls, cleanup and expired-session recovery');
} finally { await browser.close(); }
