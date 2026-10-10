// Deterministic UI regression checks; optional Electron reference uses the same
// fixture data and viewport. Run after npm run build with Playwright installed.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const project = resolve(import.meta.dirname, '..');
const evidence = resolve(project, 'test-results/desktop-parity');
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
const sources=Array.from({length:60},(_,i)=>({id:'data:fixture'+i,name:'Fixture '+String(i).padStart(2,'0'),lang:'en',isInstalled:true,isNsfw:i===59}));
const manga={id:'fixture-manga',title:'Fixture manga',url:'https://example.org/manga',source:{name:sources[0].id},chapters:Array.from({length:30},(_,i)=>({id:'chapter-'+i,url:'https://example.org/chapter/'+i,title:'Chapter '+i,number:i}))};
const host=await serve(resolve(project,'dist'));
const browser=await chromium.launch({headless:true,channel:process.env.CHROMIUM_CHANNEL||'chrome'});
const errors=[];
let reference;
try {
  const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block',reducedMotion:'reduce'});
  await context.addInitScript(()=>{localStorage.setItem('nyora.web.onboarded.v1','1');localStorage.setItem('nyora.changelog.seen','2.6.0');localStorage.setItem('nyora.prefs',JSON.stringify({reduceMotion:true}));});
  const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
  const filters={filters:[{name:'Status',values:['ONGOING','FINISHED']},{name:'Sort',values:['POPULARITY','UPDATED']}],tags:[{key:'action',title:'Action'},{key:'drama',title:'Drama'}],tagsExclusion:true,searchWithFilters:true};
  await page.route('https://**/*', async route=>{
    const url=new URL(route.request().url());
    if(url.pathname === '/app/session') return route.fulfill({json:{token:'test-ticket',expiresIn:300}});
    if(url.pathname.includes('/sources/catalog'))return route.fulfill({json:{entries:sources}});
    if(url.pathname.includes('/sources/filters'))return route.fulfill({json:filters});
    if(url.pathname.includes('/manga/details'))return route.fulfill({json:{manga,chapters:manga.chapters}});
    if(/\/sources\/(popular|latest|search)/.test(url.pathname))return route.fulfill({json:{entries:[manga],hasNextPage:false}});
    if(url.pathname==='/image')return route.fulfill({contentType:'image/png',body:await readFile(resolve(project,'web/icon.png'))});
    return route.abort();
  });
  const metrics = {};
  const selectors = {
    settings: ['.desktop-context', '.desktop-main-nav', '.reading-settings-categories', '.reading-settings-detail', '.reading-appearance-preview'],
    library: ['.library-header', '.library-welcome'], sources: ['.reading-source-toolbar', '.source-tile'],
    downloads: ['.reading-room-empty'],
  };
  async function measure(page, name) {
    const result = {};
    for (const selector of selectors[name] || []) result[selector] = await page.locator(selector).first().evaluate(el => {
      const { x, y, width, height } = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return { x, y, width, height, background: s.backgroundColor, font: s.font, color: s.color };
    });
    return result;
  }
  const goto=async route=>{await page.goto(host.url+'/#/'+route);await page.locator('#splash').waitFor({state:'detached'});};
  await goto('settings');
  await page.locator('.reading-settings-detail .reading-appearance-preview').waitFor();
  const category=page.locator('.reading-settings-categories');const before=await category.boundingBox();
  await page.locator('.reading-settings-detail').evaluate(el=>el.scrollTop=1000);
  assert.deepEqual(await category.boundingBox(),before,'Settings categories remain pinned while preferences scroll');
  await page.locator('.reading-settings-detail').evaluate(el=>el.scrollTop=0);
  await page.screenshot({path:resolve(evidence,'web-settings.png')});
  metrics.settings = await measure(page, 'settings');
  await goto('settings?s=sync');await page.locator('.desktop-sync-form').waitFor();
  await page.screenshot({path:resolve(evidence,'web-sync.png')});
  await goto('library');await page.locator('.library-welcome').waitFor();
  await page.screenshot({path:resolve(evidence,'web-library.png')});
  metrics.library = await measure(page, 'library');
  await page.getByRole('button',{name:'Search manga or actions'}).click();
  await page.locator('.desktop-command-input').fill('history');
  await page.keyboard.press('Enter');await page.waitForURL(/#\/history/);
  await page.getByRole('button',{name:'Search manga or actions'}).click();
  await page.locator('.desktop-command-input').waitFor();
  await page.screenshot({path:resolve(evidence,'web-search-dialog.png')});
  await page.keyboard.press('Escape');await page.locator('.desktop-command-dialog').waitFor({state:'detached'});
  await goto('explore');await page.locator('.source-tile').first().waitFor();
  assert.equal(await page.getByText('Fixture 59',{exact:true}).count(),0,'Adult source stays hidden with default preferences');
  const toolbar=page.locator('.reading-source-toolbar');const toolbarBefore=await toolbar.boundingBox();
  await page.locator('.explore-sources-body').evaluate(el=>el.scrollTop=1000);
  assert.deepEqual(await toolbar.boundingBox(),toolbarBefore,'Sources filters remain pinned while results scroll');
  await page.locator('.explore-sources-body').evaluate(el=>el.scrollTop=0);
  await page.getByRole('searchbox',{name:'Search sources',exact:true}).fill('Fixture 01');
  assert.equal(await page.locator('.source-tile').count(),1);
  await page.getByRole('searchbox',{name:'Search sources',exact:true}).fill('');
  await page.screenshot({path:resolve(evidence,'web-sources.png')});
  metrics.sources = await measure(page, 'sources');
  await goto('explore?source=data%3Afixture0');await page.getByRole('button',{name:'Filter & sort',exact:true}).click();
  await page.getByRole('button',{name:'Include Action',exact:true}).click();
  await page.screenshot({path:resolve(evidence,'web-filters.png')});
  await page.getByRole('button',{name:'Apply',exact:true}).click();
  await page.locator('.browse-filter-summary').waitFor();
  await page.getByRole('dialog').waitFor({state:'detached'});
  await page.locator('#view').click({position:{x:5,y:5}});
  await page.keyboard.press('Control+5'); await page.waitForURL(/#\/downloads/);
  await goto('downloads');await page.getByRole('heading',{name:'Ready for offline reading'}).waitFor();
  await page.screenshot({path:resolve(evidence,'web-downloads.png')});
  metrics.downloads = await measure(page, 'downloads');
  await goto('local');await page.getByRole('button',{name:'Open archive'}).waitFor();
  await goto('details?sid=data%3Afixture0&url=https%3A%2F%2Fexample.org%2Fmanga');
  await page.getByRole('searchbox',{name:'Search chapters'}).fill('Chapter 29');
  assert.equal(await page.locator('.d2-ch').count(),1);
  await page.screenshot({path:resolve(evidence,'web-details.png')});
  await goto('settings');
  await page.getByRole('button',{name:'Collapse sidebar',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Expand sidebar',exact:true}).getAttribute('aria-expanded'),'false');
  await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(()=>!document.documentElement.dataset.nyoraPlatform);
  assert.equal(await page.locator('.desktop-context').count(),0);
  assert.equal(await page.locator('.reading-settings-layout').count(),0);
  assert(await page.locator('#tabbar').isVisible());
  await page.screenshot({path:resolve(evidence,'web-mobile.png')});
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('.reading-appearance-preview').waitFor();
  assert.equal(await page.locator('.desktop-main-nav').count(),1);
  assert.equal(await page.locator('.desktop-context').count(),1);
  // Persisted browser data drives the actual shared library controls.
  await page.evaluate(manga => {
    const other = { ...manga, id: 'second', title: 'Another manga', url: 'https://example.org/second', coverUrl: '/icon.png' };
    manga.coverUrl = '/icon.png';
    localStorage.setItem('nyora.library.v1', JSON.stringify({
      favourites: { [manga.id]: { manga, addedAt: 1 }, second: { manga: other, addedAt: 2 } },
      history: { [manga.id]: { manga, mangaId: manga.id, sourceId: manga.source.name, chapterUrl: manga.chapters[0].url, chapterTitle: 'Chapter 0', page: 2, total: 10, updatedAt: 5 } },
    }));
  }, manga);
  await page.reload();
  await goto('library');
  await page.getByRole('button', { name: 'Resume chapter', exact: true }).waitFor();
  await page.getByRole('combobox', { name: 'Sort library' }).selectOption('title');
  assert.equal(await page.locator('.card-open').first().getAttribute('aria-label'), 'Open Another manga');
  await page.getByRole('searchbox', { name: 'Search your library' }).fill('Fixture');
  assert.equal(await page.locator('.card-open').count(), 1);
  await page.getByRole('button', { name: 'Actions for Fixture manga' }).click();
  await page.getByRole('menu').waitFor(); assert(page.url().endsWith('#/library'));
  await page.keyboard.press('Escape');
  await page.screenshot({path:resolve(evidence,'web-library-populated.png')});
  await page.getByRole('searchbox', { name: 'Search your library' }).fill('');
  await page.locator('.library-filter-toggle').click();
  await page.getByRole('combobox', { name: 'Filter library by reading history' }).selectOption('no-history');
  assert.equal(await page.locator('.card-open').count(), 1);
  assert.equal(await page.locator('.card-open').first().getAttribute('aria-label'), 'Open Another manga');
  await goto('settings?s=sync');
  const email = page.getByRole('textbox', {name:'Email',exact:true});
  const appearance = () => email.evaluate(el=>{const s=getComputedStyle(el);return {border:s.borderColor,radius:s.borderRadius,transform:s.transform,bg:s.backgroundColor};});
  const unfocused=await appearance(); await email.focus(); await page.waitForTimeout(250); const focused=await appearance();
  assert.equal(focused.border, unfocused.border); assert.equal(focused.radius, unfocused.radius); assert.equal(focused.transform, unfocused.transform); assert.notEqual(focused.bg, unfocused.bg);
  for (const route of ['library', 'explore']) {
    await page.setViewportSize({width:390,height:844}); await goto(route);
    await page.screenshot({path:resolve(evidence, 'web-mobile-'+route+'.png')});
    assert(await page.locator('#tabbar').isVisible());
    assert(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth), 'No mobile horizontal overflow');
  }
  assert.deepEqual(errors,[],'No browser exceptions');
  console.log('PASS: pinned Settings/Sources, real command palette, filters, chapters, empty states, rail and responsive navigation.');
  if(process.env.NYORA_DESKTOP_DIST){
    reference=await serve(resolve(process.env.NYORA_DESKTOP_DIST));
    const desktopContext=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block',reducedMotion:'reduce'});
    await desktopContext.addInitScript(({sources,manga})=>{
      let prefs={reduceMotion:true};
      window.nyoraDesktop={runtimeStatus:async()=>({runtime:'electron',verificationAvailable:true}),verificationStatus:async()=>[],serviceRequest:async({operation,params})=>{
        if(operation==='ui.preferences.get')return prefs;
        if(operation==='ui.preferences.save'){Object.assign(prefs,params.patch);return prefs;}
        if(operation==='sources.list')return {sources};
        if(operation==='sources.catalog')return {entries:sources};
        if(operation==='library.categories')return {categories:[]};
        if(operation==='library.stats')return {};
        if(operation==='downloads.snapshot')return {entries:[],settings:{format:'CBZ',maxConcurrent:2,imageConcurrency:4,retries:2,keepOffline:true,saveToDevice:false}};
        if(operation==='tracking.capabilities')return {trackers:[]};
        if(operation==='sync.status')return {isConfigured:true,isAuthenticated:false,email:''};
        if(operation==='content.details')return {manga,chapters:manga.chapters};
        if(operation==='library.mangaPrefs')return {present:false};
        if(operation==='library.readMarks')return {read:[],unread:[]};
        return {entries:[],filters:[]};
      }};
    },{sources,manga});
    const desktopPage=await desktopContext.newPage();desktopPage.setDefaultTimeout(8000);
    await desktopPage.route('https://**/*',route=>route.abort());
    for(const [name,route] of [['settings','settings'],['sync','settings?s=sync'],['library','library'],['sources','explore'],['downloads','downloads']]){
      await desktopPage.goto(reference.url+'/#/'+route);await desktopPage.locator('#splash').waitFor({state:'detached'});
      await desktopPage.locator('.desktop-main-nav').waitFor();
      if (selectors[name]?.length) await desktopPage.locator(selectors[name].at(-1)).first().waitFor();
      await desktopPage.screenshot({path:resolve(evidence,'electron-'+name+'.png')});
      if(metrics[name]) assert.deepEqual(await measure(desktopPage, name), metrics[name], name+' geometry, typography and surfaces match Electron');
    }
    console.log('Electron reference screenshots captured with the same viewport and fixture data.');
  }
} finally {await browser.close();await new Promise(r=>host.server.close(r));if(reference)await new Promise(r=>reference.server.close(r));}
console.log('Screenshots: '+evidence);
