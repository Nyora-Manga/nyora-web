import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalReader, getLocalReader } from '../web/core/local-reader.js';

test('local reader owns readable page URLs until disposal and never exposes them in the route', async () => {
  const route = createLocalReader({ title: 'Private file', pages: [new Blob(['page one']), new Blob(['page two'])] });
  assert(!JSON.stringify(route).includes('Private file'));
  assert(!JSON.stringify(route).includes('blob:'));
  const reader = getLocalReader(route.local);
  const urls = reader.pages.map(p => p.url);
  assert.deepEqual(await Promise.all(urls.map(async url => (await fetch(url)).text())), ['page one', 'page two']);
  reader.dispose();
  assert.equal(getLocalReader(route.local), null);
  for (const url of urls) await assert.rejects(fetch(url));
  reader.dispose(); // cleanup is safe if navigation tears down twice
});

test('local reader rejects empty books and remote URLs as page input', () => {
  assert.throws(() => createLocalReader({ title: 'Empty', pages: [] }), /no readable pages/);
  assert.throws(() => createLocalReader({ title: 'Remote', pages: ['https://example.com/page.png'] }), /no readable pages/);
});

test('failed local reader allocation revokes already allocated page URLs', async () => {
  const create = URL.createObjectURL;
  let first;
  URL.createObjectURL = blob => {
    if (first) throw new Error('allocation failed');
    return first = create(blob);
  };
  try {
    assert.throws(() => createLocalReader({ title: 'Book', pages: [new Blob(['1']), new Blob(['2'])] }), /allocation failed/);
  } finally { URL.createObjectURL = create; }
  await assert.rejects(fetch(first));
});
