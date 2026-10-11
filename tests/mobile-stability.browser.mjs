import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch({headless:true});
const base = process.env.NYORA_TEST_URL || 'http://127.0.0.1:8899';
try {
  const context = await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,serviceWorkers:'block',
    userAgent:'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'});
  await context.addInitScript(() => {
    localStorage.setItem('nyora.web.onboarded.v1','1');
    localStorage.setItem('nyora.changelog.seen','2.7.0');
    localStorage.setItem('nyora.prefs',JSON.stringify({experimental:true,reader:{translate:true,colorize:true,mode:new URL(location.href).searchParams.get('mode') || 'WEBTOON'}}));
    if(new URL(location.href).searchParams.has('mode'))localStorage.removeItem('nyora.library.v1');
    sessionStorage.clear(); // Whole-browser recovery may not preserve the old AI marker.
    const NativeWorker=window.Worker;
    window.__workers=new Set(); window.__peakWorkers=0;
    window.Worker=class extends NativeWorker {
      constructor(...args){super(...args);window.__workers.add(this);window.__peakWorkers=Math.max(window.__peakWorkers,window.__workers.size);}
      terminate(){window.__workers.delete(this);super.terminate();}
    };
  });
  const page=await context.newPage();page.setDefaultTimeout(12000);
  const errors=[], imageRequests=[], modelRequests=[]; let navigations=0;
  page.on('pageerror',e=>errors.push(e.message));
  page.on('crash',()=>errors.push('Browser page crashed'));
  page.on('framenavigated',f=>{if(f===page.mainFrame())navigations++;});
  page.on('request',r=>{
    if(r.url().includes('/page-'))imageRequests.push(r.url());
    if(/onnx|tl-worker|colorize\/worker/.test(r.url()))modelRequests.push(r.url());
  });
  const manga={id:'mobile-fixture',title:'Long mobile chapter',url:'https://fixture.test/manga',source:{name:'data:fixture'}};
  const chapters=[{id:'one',url:'https://fixture.test/chapter/1',title:'Chapter 1',number:1}];
  // Real workers/canvas/queues and renderer; substitute model inference only.
  await page.route('**/core/translate/tl-worker.js*',route=>route.fulfill({contentType:'text/javascript',body:`
    onmessage=({data:m})=>{
      if(m.type==='init')postMessage({type:'ready'});
      if(m.type==='page'){const w=m.bitmap.width,h=m.bitmap.height;m.bitmap.close();setTimeout(()=>postMessage({type:'page-result',id:m.id,blocks:[{x:0,y:0,w:w/2,h:h/4,bg:'rgb(255, 255, 255)',text:'本'}]}),30);}
    };`}));
  await page.route('**/core/colorize/worker.js*',route=>route.fulfill({contentType:'text/javascript',body:`
    onmessage=async({data:m})=>{
      if(m.type==='init')postMessage({type:'ready',backend:'test'});
      if(m.type==='ensure-model')postMessage({type:'model-ready',id:m.id});
      if(m.type==='page'){const c=new OffscreenCanvas(m.bitmap.width,m.bitmap.height);m.bitmap.close();const ctx=c.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,c.width,c.height);const blob=await c.convertToBlob();setTimeout(()=>postMessage({type:'color',id:m.id,blob}),30);}
    };`}));
  const pagePng=await page.evaluate(async()=>{const c=document.createElement('canvas');c.width=400;c.height=1200;c.getContext('2d').fillRect(0,0,400,1200);return [...new Uint8Array(await (await new Promise(r=>c.toBlob(r))).arrayBuffer())];});
  await page.route('https://**/*',route=>{
    if(route.request().url().startsWith('https://translate.googleapis.com/'))return route.fulfill({json:[[ ['Book','本',null,null] ],null,'ja']});
    const u=new URL(route.request().url());
    if(u.pathname.startsWith('/page-'))return route.fulfill({contentType:'image/png',body:Buffer.from(pagePng)});
    if(u.pathname==='/app/session')return route.fulfill({json:{token:'test-ticket',expiresIn:300}});
    if(u.pathname.includes('/sources/catalog'))return route.fulfill({json:{entries:[{id:'data:fixture',name:'Fixture',lang:'ja'}]}});
    if(u.pathname.includes('/manga/details'))return route.fulfill({json:{manga,chapters}});
    if(u.pathname.includes('/manga/pages'))return route.fulfill({json:{pages:Array.from({length:100},(_,i)=>({url:`https://fixture.test/page-${i}.svg`}))}});
    return route.abort();
  });
  const route='/#/reader?sid=data%3Afixture&url='+encodeURIComponent(manga.url)+'&chapterUrl='+encodeURIComponent(chapters[0].url);
  await page.goto(base+route);
  await page.waitForFunction(()=>document.querySelector('img.reader-page')?.naturalHeight===1200);
  assert.equal(await page.locator('.reader.webtoon .reader-page').count(),100);
  assert(new Set(imageRequests).size<=3,'Opening a chapter does not fetch all its pages');
  await page.locator('.tl-block').filter({hasText:'Book'}).first().waitFor();
  await page.locator('.reader-bar.top').getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByText('AI colorize (beta)',{exact:true}).locator('..').locator('.switch').click();
  assert(await page.locator('[data-ai-toggle="translate"]').isChecked());
  await page.getByRole('dialog').getByRole('button',{name:'Done',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('img.reader-page[data-page="0"]')?.__colorized===true);
  const initialNavigations=navigations;
  const jump=async index=>{
    await page.locator('.reader-slider').evaluate((slider,i)=>{slider.value=String(i+1);slider.dispatchEvent(new Event('input',{bubbles:true}));},index);
    await page.waitForFunction(i=>document.querySelector(`img.reader-page[data-page="${i}"]`)?.naturalHeight===1200,index);
    assert(await page.locator('img.reader-page').count()<=3,'Decoded image nodes stay bounded');
  };
  for(const i of [10,25,50,75,99,50,0]) await jump(i);
  assert.equal(await page.locator('.reader.webtoon .reader-page').count(),100,'Page slots survive eviction');
  await page.locator('.reader.webtoon').evaluate(el=>el.scrollTop=1300);
  await page.waitForFunction(()=>document.querySelector('img.reader-page[data-page="1"]')?.naturalHeight===1200);
  assert(await page.locator('img.reader-page').count()<=3);
  assert.equal(navigations,initialNavigations,'Scrolling does not navigate/reload');
  await page.waitForFunction(()=>document.querySelector('img.reader-page[data-page="1"]')?.__colorized===true);
  await page.locator('.tl-block').filter({hasText:'Book'}).first().waitFor();
  assert(await page.locator('.tl-overlay').count()<=3, 'Old overlays are removed');
  assert.equal(await page.evaluate(()=>window.__peakWorkers),1,'Translation and colorization never retain two workers');
  assert((await page.locator('img.reader-page[data-page="1"]').getAttribute('src')).startsWith('blob:'),'Color output replaces the displayed image');
  const beforeExit=await page.locator('img.reader-page[data-page="1"]').getAttribute('src');
  await page.goto(base+'/#/settings?s=experimental');
  await page.getByText('Downloaded models',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.__workers.size),0,'Reader exit releases inference memory');
  assert.equal(await page.evaluate(async u=>{try{await fetch(u);return true;}catch{return false;}},beforeExit),false,'Result blobs are revoked on exit');
  await page.evaluate(async()=>{
    const cache=await caches.open('nyora-tl-models');
    await cache.put('/fixture-model',new Response('small fixture',{headers:{'content-length':String(120*1024*1024)}}));
  });
  await page.reload();
  await page.getByText('1 file · 120 MB',{exact:true}).waitFor();
  for (const mode of ['PAGED','PAGED_RTL','VERTICAL']) {
    await page.goto(base+'/?mode='+mode+route.slice(1)+'&page=40');
    await page.waitForFunction(()=>document.querySelector('img.reader-page[data-page="40"]')?.naturalHeight===1200);
    await jump(60); await jump(0);
    assert.equal(await page.locator('.reader-slide').count(),100);
    assert(await page.evaluate(()=>window.__peakWorkers)<=1);
  }
  assert.deepEqual(errors,[]);
  console.log('Mobile stability: 100-page window, backwards restore, combined translation/colorization, single resident worker, settings storage and no navigation/crash errors passed.');
} finally {await browser.close();}
