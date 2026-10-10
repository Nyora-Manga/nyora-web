import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildIndex,searchIndex,relatedSeries,tokenize} from '../web/core/series-index.js';
import {normalizeMedia,validateSnapshot,plainText,finalizeRecord,safeCover} from '../scripts/series/metadata.mjs';
import {createPages,renderSitemap,renderSeries} from '../scripts/series/render.mjs';
const snapshot=validateSnapshot(JSON.parse(await readFile(new URL('../data/series.json',import.meta.url),'utf8')));
const index=buildIndex(snapshot.series);

test('TF-IDF finds exact titles, aliases, native names and descriptive concepts',()=>{
 for(const query of ['Solo Leveling','Na Honjaman Level Up','나 혼자만 레벨업'])assert.equal(searchIndex(index,query)[0].id,105398,query);
 assert.equal(searchIndex(index,'one piece')[0].id,30013);
 assert.equal(searchIndex(index,'呪術廻戦')[0].id,101517);
 assert(searchIndex(index,'hunters monsters').some(s=>s.id===105398));
 assert.deepEqual(searchIndex(index,'xyzzzzunknown123'),[]);
 assert.deepEqual(searchIndex(index,'the and of'),[]);
 assert.deepEqual(searchIndex(index,''),[]);
 assert(tokenize('Pokémon').includes('pokemon'));
 for(const term of Object.values(index.terms)) {
   assert(Number.isFinite(term.idf));
   for(const [,weight] of term.postings)assert(Number.isFinite(weight)&&weight>0);
 }
});
test('TF-IDF favours title matches over incidental synopsis mentions and is prototype safe',()=>{
 const d=[{id:1,title:'Moon Garden',aliases:[],genres:['Fantasy'],description:'A gardener in the sky.'},{id:2,title:'Sky',aliases:[],genres:['Fantasy'],description:'Sky sky sky sky moon garden sky.'}];
 const dictionary=JSON.parse(JSON.stringify(buildIndex(d)));
 assert.equal(searchIndex(dictionary,'Moon Garden')[0].id,1);
 assert.doesNotThrow(()=>searchIndex(dictionary,'constructor __proto__ toString'));
 assert.equal(relatedSeries(dictionary,1)[0],2);
 assert.deepEqual(relatedSeries(dictionary,99),[]);
 assert(!relatedSeries(index,105398).includes(105398));
});
const media={id:1,title:{english:'A series'},description:'A real description of a story about friends, adventures and discoveries. '.repeat(3),genres:['Adventure'],isAdult:false,coverImage:{large:'https://s4.anilist.co/file/anilistcdn/media/manga/cover/medium/1.jpg'},staff:{edges:[]}};
test('metadata excludes adult, unknown-age, incomplete and unsafe records',()=>{
 for(const override of [{isAdult:true},{isAdult:undefined},{genres:['Hentai']},{description:'Tiny'},{coverImage:{large:'https://evil.test/cover.jpg'}}])assert.equal(normalizeMedia({...media,...override},null,'2026-10-10'),null);
 assert.equal(safeCover('https://s4.anilist.co@evil.test/file/anilistcdn/media/manga/cover/a.jpg'),false);
 assert.equal(safeCover('http://s4.anilist.co/file/anilistcdn/media/manga/cover/a.jpg'),false);
 assert.equal(plainText('<script>evil()</script><b>Hi &amp; bye</b>'),'Hi & bye');
 assert.throws(()=>validateSnapshot({...snapshot,series:[...snapshot.series,snapshot.series[0]]}));
});
test('metadata title changes preserve URLs, unchanged content preserves lastmod',()=>{
 const first=normalizeMedia(media,null,'2026-10-10');
 const second=normalizeMedia(media,first,'2026-10-11');
 assert.equal(second.lastmod,'2026-10-10');
 const renamed=normalizeMedia({...media,title:{english:'New name'}},first,'2026-10-12');
 assert.equal(renamed.path,first.path);assert.equal(renamed.lastmod,'2026-10-12');
 assert.equal(finalizeRecord({...first,chapters:20},first,'2026-10-12').lastmod,'2026-10-12');
});
test('every public series is rendered without JS and linked in the sitemap and catalogue',()=>{
 const result=createPages(snapshot,{day:'2026-10-10'});
 assert.equal(result.pages.size,snapshot.series.length+1);
 const xml=renderSitemap(result.manifest,'2026-10-10');
 assert.equal((xml.match(/<url>/g)||[]).length,result.pages.size+1);
 for(const s of snapshot.series) {
   const page=result.pages.get(s.path);
   assert(page.includes(`<link rel="canonical" href="https://web.nyora.xyz${s.path}">`));
   assert(page.includes('About the story'));assert(page.includes('Open in Nyora'));
   assert(page.includes(s.cover));assert(page.includes('Keep exploring'));
   assert(result.pages.get('/manga/').includes(`href="${s.path}"`));
   assert(xml.includes(`https://web.nyora.xyz${s.path}</loc>`));
 }
 assert(!xml.includes('#/'));
 assert(!result.pages.get('/manga/').includes('SearchAction'));
});
test('sitemap dates remain unchanged on daily rebuilds; actual document edits advance them',()=>{
 const first=createPages(snapshot,{day:'2026-10-10'});
 const second=createPages(snapshot,{day:'2026-10-11',previous:first.manifest});
 assert.deepEqual(first.manifest,second.manifest);
 const changed=structuredClone(snapshot);changed.series[0].description+=' This description has been corrected.';
 const third=createPages(changed,{day:'2026-10-12',previous:first.manifest});
 assert.equal(third.manifest.pages[changed.series[0].path].lastmod,'2026-10-12');
 const unchanged=Object.keys(first.manifest.pages).filter(p=>third.manifest.pages[p].hash===first.manifest.pages[p].hash);
 assert(unchanged.length>0);for(const p of unchanged)assert.equal(third.manifest.pages[p].lastmod,'2026-10-10');
});
test('remote metadata cannot inject HTML or scripts into public documents',()=>{
 const malicious={...snapshot.series[0],title:'<img src=x onerror=alert(1)>',description:'</p><script>alert(2)</script>',aliases:['" onmouseover="evil()'],genres:['<script>']};
 const html=renderSeries(malicious,[]);
 assert(!html.includes('<script>'));assert(!html.includes('<img src=x'));
 assert(html.includes('&lt;script&gt;'));assert(html.includes('&quot; onmouseover=&quot;'));
});

test('a partial daily metadata response leaves the last snapshot intact',async()=>{
 const {mkdtemp,mkdir,writeFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const dir=await mkdtemp(join(tmpdir(),'nyora-series-refresh-'));
 try {
   await mkdir(join(dir,'data'));
   const bytes=JSON.stringify(snapshot);
   await writeFile(join(dir,'data/series.json'),bytes);
   await writeFile(join(dir,'incomplete.json'),'[]');
   await assert.rejects(promisify(execFile)(process.execPath,[new URL('../scripts/refresh-series.mjs',import.meta.url).pathname],{cwd:dir,env:{...process.env,NYORA_SERIES_INPUT:join(dir,'incomplete.json')}}),/Incomplete metadata response/);
   assert.equal(await readFile(join(dir,'data/series.json'),'utf8'),bytes);
 }finally{await rm(dir,{recursive:true,force:true});}
});
