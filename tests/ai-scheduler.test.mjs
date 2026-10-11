import test from 'node:test';
import assert from 'node:assert/strict';
import { runSharedInference } from '../web/core/ai-scheduler.js';

test('translation and colorization share one resident model and skip obsolete pages', async () => {
  const resident = new Set(), events = [];
  let unblock;
  const held = new Promise(r => {unblock=r;});
  const release = kind => () => {resident.delete(kind);events.push('release '+kind);};
  const task = kind => async () => {
    resident.add(kind); assert.equal(resident.size,1);
    events.push('run '+kind); if(kind==='translate') await held;
  };
  const first=runSharedInference('translate',release('translate'),task('translate'));
  const stale=new AbortController();
  const skipped=runSharedInference('colorize',release('colorize'),task('colorize'),{signal:stale.signal}).catch(e=>e.name);
  stale.abort();
  const next=runSharedInference('colorize',release('colorize'),task('colorize'));
  unblock(); await first; assert.equal(await skipped,'AbortError'); await next;
  assert.deepEqual(events,['run translate','release translate','run colorize']);
});

test('leaving an active page releases its worker and the next tool can proceed', async () => {
  const page=new AbortController(); let rejectTask, released=0;
  const running=runSharedInference('abort-test',()=>{released++;rejectTask?.(new DOMException('Stopped','AbortError'));},()=>new Promise((_,reject)=>{rejectTask=reject;}),{signal:page.signal});
  const settled=running.catch(e=>e.name);
  await new Promise(r=>setTimeout(r,0)); page.abort();
  assert.equal(await settled,'AbortError'); assert.equal(released,1);
  assert.equal(await runSharedInference('recovery',()=>{},async()=>42),42);
});
