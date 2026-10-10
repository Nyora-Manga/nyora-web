import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';
import {validateSnapshot} from './series/metadata.mjs';
import {createPages,renderSitemap} from './series/render.mjs';
const snapshot=validateSnapshot(JSON.parse(await readFile('data/series.json','utf8')));
let previous={};
try {previous=JSON.parse(await readFile('data/series-page-manifest.json','utf8'));} catch(error) {if(error.code!=='ENOENT')throw error;}
const day=new Date().toISOString().slice(0,10);
const {pages,index,manifest}=createPages(snapshot,{previous,day});
await mkdir('dist/manga/covers',{recursive:true});
for(const [path,html] of pages) {await mkdir('dist'+path,{recursive:true});await writeFile('dist'+path+'index.html',html);}
for(const s of snapshot.series)await copyFile('data/series-covers/'+s.cover.split('/').at(-1),'dist'+s.cover);
await writeFile('dist/manga/catalog.json',JSON.stringify(snapshot));
await writeFile('dist/manga/search-index.json',JSON.stringify(index));
await writeFile('dist/manga/page-manifest.json',JSON.stringify(manifest));
const releaseDate=process.env.NYORA_RELEASE_DATE||execFileSync('git',['show','-s','--format=%cs','HEAD'],{encoding:'utf8'}).trim();
await writeFile('dist/sitemap.xml',renderSitemap(manifest,releaseDate));
await build({entryPoints:['web/catalog/search.js'],outfile:'dist/catalog/search.js',bundle:true,minify:true,format:'esm',target:'es2020'});
console.log(`Built ${snapshot.series.length} series pages and ${Object.keys(index.terms).length} TF-IDF terms.`);
