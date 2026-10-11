import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(predicate) {
  for (let i=0;i<100;i++) { if (predicate()) return; await tick(); }
  assert.fail('AI request did not settle');
}
async function engine(kind) {
  const instances = [], bitmaps = [], reads = [];
  let holdFetch = null;
  class Worker {
    constructor() { this.messages = []; this.terminated = false; instances.push(this); }
    postMessage(m) {
      this.messages.push(m);
      if (m.type === 'init') queueMicrotask(() => this.onmessage({ data: { type:'ready' } }));
      if (m.type === 'ensure-model') queueMicrotask(() => this.onmessage({data:{type:'model-ready',id:m.id}}));
    }
    terminate() { this.terminated = true; }
  }
  const context = vm.createContext({
    Worker, AbortController, DOMException, Error, Blob, URL, setTimeout, clearTimeout,
    navigator: {}, api: { imageUrl: url=>url }, store:{get:()=>({})},
    translateBatch:async()=>[], refineBatch:async()=>[],
    colorizeModelCached:async()=>true, loadColorizeModel:async()=>{},
    fetch: async (url, {signal}={}) => {
      reads.push(url);
      if (holdFetch) await holdFetch(signal);
      return {ok:true,blob:async()=>new Blob(['page'])};
    },
    createImageBitmap:async()=>{const bitmap={closed:false,close(){this.closed=true;}};bitmaps.push(bitmap);return bitmap;},
  });
  let source = await readFile(new URL(`../web/core/${kind}/engine.js`, import.meta.url),'utf8');
  source = source.replace(/^import .*;\n/gm,'').replace(/^export /gm,'');
  vm.runInContext(source + (kind === 'translate'
    ? '\nglobalThis.run = (url,options={}) => translatePage({url,target:"en",...options}); globalThis.stop = clearTranslator;'
    : '\nglobalThis.run = colorizePage; globalThis.stop = clearColorizeCache;'), context);
  return { context, instances, reads, bitmaps, hold(fn){holdFetch=fn;} };
}

for (const kind of ['translate','colorize']) {
  test(`${kind}: fast scrolling decodes one page; stop cancels active and queued pages`, async()=>{
    const e = await engine(kind);
    const requests = Array.from({length:30},(_,i)=>e.context.run(`blob:page-${i}`));
    const outcomes = Promise.allSettled(requests);
    await until(()=>e.instances[0]?.messages.some(m=>m.type==='page'));
    assert.equal(e.reads.length,1);
    assert.equal(e.bitmaps.length,1);
    e.context.stop();
    const settled = await outcomes;
    assert(settled.every(r=>r.status==='rejected' && r.reason.name==='AbortError'));
    assert(e.instances[0].terminated);
    assert.equal(e.reads.length,1);
    // A later explicit retry gets a fresh worker, rather than a dead promise.
    const retry = e.context.run('blob:retry');
    const retryOutcome = Promise.allSettled([retry]);
    await until(()=>e.instances.length===2 && e.instances[1].messages.some(m=>m.type==='page'));
    e.context.stop(); await retryOutcome;
  });
  test(`${kind}: stopping during image fetch aborts decoding and never revives a worker`, async()=>{
    const e=await engine(kind);
    e.hold(signal=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})));
    const outcome=Promise.allSettled([e.context.run('blob:pending')]);
    await until(()=>e.reads.length===1);
    e.context.stop();
    assert.equal((await outcome)[0].reason.name,'AbortError');
    assert.equal(e.bitmaps.length,0);
    assert.equal(e.instances.length,1);
    assert(e.instances[0].terminated);
  });
}

test('colorization: a fatal inference failure is surfaced without replaying the allocation', async()=>{
  const e=await engine('colorize');
  const outcome=Promise.allSettled([e.context.run('blob:large')]);
  await until(()=>e.instances[0]?.messages.some(m=>m.type==='page'));
  const job=e.instances[0].messages.find(m=>m.type==='page');
  e.instances[0].onmessage({data:{type:'color-error',id:job.id,error:'allocation failed',fatal:true}});
  assert.equal((await outcome)[0].status,'rejected');
  await tick(); assert.equal(e.instances.length,1); assert(e.instances[0].terminated);
  e.context.stop();
});

test('OCR releases inputs, outputs and shared hidden tensors after repeated Japanese decoding', async()=>{
  const live=new Set(); let peak=0;
  class Tensor {
    constructor(type,data,dims){Object.assign(this,{type,data,dims});live.add(this);peak=Math.max(peak,live.size);}
    dispose(){assert(live.delete(this),'tensor disposed twice');}
  }
  class Canvas {
    constructor(w,h){this.width=w;this.height=h;}
    getContext(){return {fillRect(){},drawImage(){},getImageData:()=>({data:new Uint8ClampedArray(this.width*this.height*4)})};}
  }
  const source=await readFile(new URL('../web/core/translate/tl-worker.js',import.meta.url),'utf8');
  const context=vm.createContext({self:{},OffscreenCanvas:Canvas,navigator:{maxTouchPoints:1}});
  vm.runInContext(source+'\nglobalThis.configure = runtime => {ort=runtime;}; globalThis.ocr=mangaOcrBatch; globalThis.owned=runOwned;',context);
  context.configure({Tensor});
  const eng={vocab:['','','','','本'],encoder:{inputNames:['image'],outputNames:['hidden'],async run(){return {hidden:new Tensor('float32',new Float32Array(4),[1,2,2])};}},
    decoder:{outputNames:['logits'],async run({input_ids}){const [n,len]=input_ids.dims; const data=new Float32Array(n*len*5);for(let i=0;i<n*len;i++)data[i*5+(len<3?4:3)]=20;return {logits:new Tensor('float32',data,[n,len,5])};}}};
  for(let i=0;i<20;i++){
    const result=await context.ocr(eng,Array.from({length:9},()=>new Canvas(20,30)));
    assert(result.every(block=>block.text==='本本'),'Latest-token decoding changed OCR output');
    assert.equal(live.size,0,`ORT allocations survived page ${i}`);
  }
  assert(peak<=4,`Unexpected tensor peak: ${peak}`);
  eng.decoder.run=async()=>{throw new Error('allocation failed');};
  await assert.rejects(context.ocr(eng,[new Canvas(20,30)]),/allocation/);
  assert.equal(live.size,0,'failed inference leaked tensors');
});

test('service-worker updates notify without reloading the active page', async()=>{
  const source=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
  const fn=source.slice(source.indexOf('function registerSW()'),source.indexOf('\nfunction wireTopbar()'));
  const handlers={}, notices=[];let reloads=0;
  vm.runInNewContext(fn+'\nregisterSW();',{
    navigator:{serviceWorker:{controller:{},addEventListener:(name,fn)=>handlers[name]=fn}},
    window:{addEventListener(){}},location:{reload:()=>reloads++},toast:msg=>notices.push(msg),
  });
  handlers.controllerchange();handlers.controllerchange();
  assert.equal(reloads,0);assert.equal(notices.length,1);
});


test('translation skips obsolete queued pages before decoding or loading models', async()=>{
  const e=await engine('translate');
  await assert.rejects(e.context.run('blob:offscreen',{shouldProcess:()=>false}),{name:'AbortError'});
  assert.equal(e.reads.length,0);assert.equal(e.instances.length,0);
  e.context.stop();
});
