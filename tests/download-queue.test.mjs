import { test } from 'node:test';
import assert from 'node:assert/strict';
const storage = new Map();
globalThis.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,String(v)), removeItem: k => storage.delete(k) };
globalThis.window = { location: { origin: 'https://reader.test' }, dispatchEvent() {} };
const { downloads } = await import('../web/core/downloads.js');
const { api } = await import('../web/core/api.js');
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(predicate) { for(let i=0;i<100;i++){ if(predicate())return; await tick(); } assert.fail('Queue did not settle'); }
test('pause finishes the current chapter, holds queued work, resumes, and retries failed chapters', async () => {
  const calls=[]; let finish;
  const previous = api.pages;
  api.pages = async (_source, url) => { calls.push(url); if(url==='/first')await new Promise(resolve=>finish=resolve); return {pages:[]}; };
  try {
    downloads.saveSettings({maxConcurrent:1});
    downloads.enqueue(['/first','/second'].map(chapterUrl=>({sourceId:'data:fixture',chapterUrl})));
    await until(()=>!!finish);
    downloads.pause(); finish();
    await until(()=>downloads.counts().failed===1);
    await tick();
    assert.deepEqual(calls,['/first']); assert.equal(downloads.counts().queued,1);
    downloads.resume(); await until(()=>downloads.counts().failed===2);
    assert.deepEqual(calls,['/first','/second']);
    downloads.pause(); assert.equal((await downloads.retryFailed()).requeued,2);
    await tick(); assert.equal(downloads.counts().queued,2); assert.equal(calls.length,2);
    downloads.cancelAll();
  } finally { api.pages=previous; }
});
