// Deterministic phone layout and interaction checks. Run after npm run build.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const project = resolve(import.meta.dirname, '..');
const evidence = resolve(project, 'test-results/mobile-parity');
await mkdir(evidence, {recursive:true});
async function serve(root) {
  const server = createServer(async (req,res)=>{
    try {
      const name = new URL(req.url,'http://localhost').pathname;
      const path = resolve(root, '.'+(name === '/' ? '/index.html' : name));
      if(!path.startsWith(root+'/'))throw Error('Path');
      const bytes=await readFile(path);
      res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.ttf':'font/ttf','.svg':'image/svg+xml'})[extname(path)]||'application/octet-stream');
      res.end(bytes);
    } catch {res.statusCode=404;res.end();}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {server,url:'http://127.0.0.1:'+server.address().port};
}
const sources=Array.from({length:60},(_,i)=>({id:'data:fixture'+i,name:'Fixture '+String(i).padStart(2,'0'),lang:i % 3 === 0 ? 'ja' : 'en',isInstalled:true,isNsfw:i===59}));
const manga={id:'fixture-manga',title:'Fixture manga',url:'https://example.org/manga',source:{name:sources[0].id},chapters:Array.from({length:30},(_,i)=>({id:'chapter-'+i,url:'https://example.org/chapter/'+i,title:'Chapter '+i,number:i}))};
const catalogue=JSON.parse(await readFile(resolve(project,'data/series.json'),'utf8')).series.slice(0,8);
const books=catalogue.map((entry,i)=>({...manga,id:'book-'+i,title:entry.title,coverUrl:entry.cover,url:'https://example.org/manga/'+i}));
const feedItems=catalogue.map(entry=>({id:entry.id,title:{english:entry.title,romaji:entry.title},coverImage:{large:entry.cover},description:entry.description,genres:entry.genres,averageScore:85,format:'MANGA',countryOfOrigin:'JP',status:entry.status}));
const host=await serve(resolve(project,'dist'));
const browser=await chromium.launch({headless:true,channel:process.env.CHROMIUM_CHANNEL||'chrome'});
const errors=[];
try {
  const context=await browser.newContext({viewport:{width:1440,height:1000},hasTouch:true,serviceWorkers:'block',reducedMotion:'reduce'});
  await context.addInitScript(()=>{localStorage.setItem('nyora.web.onboarded.v1','1');localStorage.setItem('nyora.changelog.seen','2.6.0');localStorage.setItem('nyora.prefs',JSON.stringify({reduceMotion:true}));});
  const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
  const filters={filters:[{name:'Status',values:['ONGOING','FINISHED']},{name:'Sort',values:['POPULARITY','UPDATED']}],tags:[{key:'action',title:'Action'},{key:'drama',title:'Drama'}],tagsExclusion:true,searchWithFilters:true};
  await page.route('https://**/*', async route=>{
    const url=new URL(route.request().url());
    if(url.pathname === '/app/session') return route.fulfill({json:{token:'test-ticket',expiresIn:300}});
    if(url.pathname.includes('/sources/catalog'))return route.fulfill({json:{entries:sources}});
    if(url.pathname.includes('/sources/filters'))return route.fulfill({json:filters});
    if(url.pathname.includes('/manga/pages'))return route.fulfill({json:{pages:[{url:host.url+'/icon.png'}]}});
    if(url.pathname.includes('/manga/details'))return route.fulfill({json:{manga,chapters:manga.chapters}});
    if(/\/sources\/(popular|latest|search)/.test(url.pathname))return route.fulfill({json:{entries:books,hasNextPage:false}});
    if(url.pathname==='/image')return route.fulfill({contentType:'image/png',body:await readFile(resolve(project,'web/icon.png'))});
    return route.abort();
  });


  const goto=async route=>{await page.goto(host.url+'/#/'+route);await page.locator('#splash').waitFor({state:'detached'});await page.waitForFunction(name=>document.body.dataset.route===name,route.split('?')[0]);await page.evaluate(()=>new Promise(requestAnimationFrame));};
  await context.addInitScript(items=>localStorage.setItem('nyora.discover.feed.v2',JSON.stringify({at:Date.now(),feed:{trending:items,manhwa:items,manga:items,manhua:[],action:[],romance:[],fantasy:[]}})),feedItems);
  const noOverflow=async label=>assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),label+' has no document overflow');
  for(const width of [320,390,760]) {
    await page.setViewportSize({width,height:844});
    for(const route of ['library','explore','settings','settings?s=appearance','settings?s=sync','search','discover','downloads']) {
      await goto(route);
      if(route==='explore')await page.locator('.source-tile').first().waitFor();
      if(route==='discover')await page.locator('.discover-hero-title').waitFor();
      await noOverflow(width+' '+route);
      assert.equal(await page.locator('#tabbar a').count(),5);
      assert(await page.locator('#tabbar').isVisible());
      const tab=route.split('?')[0] === 'downloads' ? 'library' : route.split('?')[0];
      if(tab !== 'search')assert.equal(await page.locator('#tabbar [aria-current=page]').getAttribute('data-tab'),tab);
      await page.screenshot({path:resolve(evidence,`${width}-${route.replace(/[^a-z]/g,'-')}.png`)});
    }
    await goto('explore');await page.locator('.source-tile').first().waitFor();
    const toolbar=page.locator('.reading-source-toolbar');const before=await toolbar.boundingBox();
    const results=page.locator('.explore-sources-body');
    await results.evaluate(el=>el.scrollTop=1000);
    assert(await results.evaluate(el=>el.scrollTop>0),'Source results can scroll');
    assert.deepEqual(await toolbar.boundingBox(),before,'Source filters remain pinned');
    await results.evaluate(el=>el.scrollTop=0);
    const pin=page.getByRole('button',{name:'Pin source',exact:true}).first();await pin.click();
    await page.getByRole('button',{name:'Pinned only',exact:true}).click();
    assert.equal(await page.locator('.source-tile').count(),1);
    await page.getByRole('button',{name:'Unpin source',exact:true}).click();
    await page.getByRole('button',{name:'Pinned only',exact:true}).click();
    await page.getByRole('searchbox',{name:'Search sources',exact:true}).fill('Fixture 01');
    assert.equal(await page.locator('.source-tile').count(),1);
    await goto('explore?source=data%3Afixture0');
    await page.getByRole('button',{name:/^Filter & sort/}).click();
    const dialog=page.getByRole('dialog');await dialog.waitFor();
    const box=await dialog.boundingBox();assert(box.x>=0 && box.x+box.width<=width+1,'Filter sheet fits phone');
    await page.getByRole('button',{name:'Reset',exact:true}).click();
    await page.getByRole('button',{name:'Include Action',exact:true}).click();
    await page.screenshot({path:resolve(evidence,`${width}-source-filters.png`)});
    await page.getByRole('button',{name:'Apply',exact:true}).click();
    await dialog.waitFor({state:'detached'});await page.locator('.browse-filter-summary').waitFor();
    await noOverflow('Source browsing');
    await goto('settings?s=sync');
    const email=page.getByRole('textbox',{name:'Email',exact:true});
    const style=()=>email.evaluate(el=>{const s=getComputedStyle(el);return {border:s.borderColor,background:s.backgroundColor,transform:s.transform,radius:s.borderRadius,fontSize:s.fontSize};});
    const idle=await style();await email.focus();await page.waitForTimeout(170);const focused=await style();
    assert.equal(focused.border,idle.border);assert.equal(focused.transform,idle.transform);assert.equal(focused.radius,idle.radius);assert.notEqual(focused.background,idle.background);assert.equal(focused.fontSize,'16px');
    await goto('search');await page.getByRole('searchbox',{name:'Search manga',exact:true}).fill('Chainsaw');
    await page.locator('.search-page-header').getByRole('button',{name:'Search',exact:true}).click();
    await page.waitForURL(/q=Chainsaw/);await page.locator('.search-results .card').first().waitFor();
    await noOverflow('Search results');await page.screenshot({path:resolve(evidence,`${width}-search-results.png`)});
  }
  await page.evaluate(books=>localStorage.setItem('nyora.library.v1',JSON.stringify({favourites:Object.fromEntries(books.map(manga=>[manga.id,{manga,addedAt:1}])),history:{[books[0].id]:{manga:books[0],mangaId:books[0].id,sourceId:books[0].source.name,chapterUrl:'https://example.org/chapter/0',chapterTitle:'Chapter 1',page:2,total:10,updatedAt:5}}})),books);
  await page.reload();
  await page.setViewportSize({width:390,height:844});await goto('library');
  await page.getByRole('button',{name:'Resume chapter',exact:true}).waitFor();
  await page.getByRole('searchbox',{name:'Search your library'}).fill('Chainsaw');
  assert.equal(await page.locator('.card-open').count(),1);
  await page.locator('.library-filter-toggle').click();
  const panel=await page.locator('.library-filter-panel').boundingBox();await page.screenshot({path:resolve(evidence,'390-library-filter.png')});assert(panel.x>=0&&panel.x+panel.width<=390,'Library filters stay on screen '+JSON.stringify(panel));
  await page.locator('.library-filter-toggle').click();
  await page.getByRole('searchbox',{name:'Search your library'}).fill('');
  await page.screenshot({path:resolve(evidence,'390-library-populated.png')});
  await page.locator('#navToggle').click();assert(await page.locator('#sidebar [data-route="downloads"]').isVisible());
  await page.locator('#sidebar [data-route="downloads"]').click();await page.waitForURL(/downloads/);assert(!await page.locator('body').evaluate(el=>el.classList.contains('nav-open')));
  await goto('settings?s=appearance');await page.getByRole('button',{name:'Light',exact:true}).click();
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='LIGHT');
  for(const route of ['explore','library','settings','discover']){await goto(route);await page.screenshot({path:resolve(evidence,'390-light-'+route+'.png')});await noOverflow('Light '+route);}
  // The compact-sidebar preference must not hide labels in a phone drawer.
  await page.setViewportSize({width:1440,height:1000});await goto('settings');
  await page.getByRole('button',{name:'Collapse sidebar',exact:true}).click();
  await page.setViewportSize({width:390,height:844});await page.waitForFunction(()=>document.documentElement.dataset.nyoraPlatform==='mobile');
  assert.equal(await page.locator('.desktop-context').count(),0);assert(await page.locator('#tabbar').isVisible());
  await page.locator('#navToggle').click();assert(await page.locator('#sidebar [data-route="library"] span:not(.icon)').isVisible());
  await page.setViewportSize({width:1440,height:1000});await page.locator('.desktop-context').waitFor();
  assert.equal(await page.locator('.desktop-main-nav').count(),1);assert.equal(await page.locator('.desktop-context').count(),1);assert(!await page.locator('#tabbar').isVisible());
  await page.setViewportSize({width:390,height:844});
  await goto('details?sid=data%3Afixture0&url=https%3A%2F%2Fexample.org%2Fmanga');
  await page.getByRole('searchbox',{name:'Search chapters'}).fill('Chapter 29');
  assert.equal(await page.locator('.d2-ch').count(),1);
  assert.equal(await page.locator('#view').evaluate(el=>getComputedStyle(el).padding),'0px');
  await goto('reader?sid=data%3Afixture0&url=https%3A%2F%2Fexample.org%2Fmanga&chapterUrl=https%3A%2F%2Fexample.org%2Fchapter%2F0');
  await page.locator('.reader-view').waitFor();
  assert(!await page.locator('#tabbar').isVisible());assert(!await page.locator('#topbar').isVisible());
  assert.equal(await page.locator('#view').evaluate(el=>getComputedStyle(el).padding),'0px');
  await goto('library');assert(await page.locator('#tabbar').isVisible());
  await page.setViewportSize({width:667,height:375});await goto('explore');await page.locator('.source-tile').first().waitFor();
  assert(await page.locator('.explore-sources-body').evaluate(el=>el.clientHeight>0),'Landscape sources retain scrollable space');
  await noOverflow('Landscape');
  assert.deepEqual(errors,[],'No browser errors');
  console.log('PASS: mobile widths, shared themes, pinned Sources, pin/search/filter actions, library tools, drawer, typing focus, search and desktop round trip.');
} finally { await browser.close(); await new Promise(r=>host.server.close(r)); }
