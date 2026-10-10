// Explicit allowlist, never an unbounded crawl. Refresh all records or publish none.
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {normalizeMedia,finalizeRecord,validateSnapshot,safeCover} from './series/metadata.mjs';
const file='data/series.json',coverDir='data/series-covers';
const day=new Date().toISOString().slice(0,10);
const local=JSON.parse(await readFile(file,'utf8'));
let baseline=local;
if(process.argv.includes('--published')) {
  try {
    async function publishedFile(name) {
      if(process.env.NYORA_PUBLISHED_SERIES_DIR) {
        const bytes=await readFile(`${process.env.NYORA_PUBLISHED_SERIES_DIR}/${name}`,'utf8');
        return bytes.trim()?JSON.parse(bytes):null;
      }
      const response=await fetch(`https://web.nyora.xyz/manga/${name}`,{signal:AbortSignal.timeout(15000),cache:'no-store'});
      if(response.status===404)return null;
      if(!response.ok)throw Error(`Published ${name}: HTTP ${response.status}`);
      return response.json();
    }
    const publishedData=await publishedFile('catalog.json');
    const published=publishedData?validateSnapshot(publishedData):local;
    // Never accept an upstream file that expands the checked-in allowlist.
    baseline={...local,series:published.series.filter(s=>local.ids.includes(s.id))};
    const manifest=await publishedFile('page-manifest.json');
    if(!manifest && publishedData)throw Error('Published catalogue is missing its manifest');
    await writeFile('data/series-page-manifest.json',JSON.stringify(manifest||{}));
  } catch(error) {
    // Failing closed preserves dates instead of reverting to an old checked-in copy.
    throw Error(`Cannot read published catalogue: ${error.message}`);
  }
}
const query=`query($ids:[Int]) { Page(perPage:100) { media(id_in:$ids,type:MANGA) {
 id title {english romaji native} synonyms description(asHtml:false) genres status format countryOfOrigin
 startDate {year} chapters volumes isAdult coverImage {large} staff(perPage:25) {edges {role node {name {full}}}}
} } }`;
let media;
if(process.env.NYORA_SERIES_INPUT)media=JSON.parse(await readFile(process.env.NYORA_SERIES_INPUT,'utf8'));
else {
  const response=await fetch('https://graphql.anilist.co',{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({query,variables:{ids:local.ids}}),signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error(`AniList HTTP ${response.status}`);
  const json=await response.json();if(json.errors)throw Error('AniList rejected metadata query');media=json.data?.Page?.media;
}
if(!Array.isArray(media)||local.ids.some(id=>!media.some(m=>m.id===id)))throw Error('Incomplete metadata response; keeping the published snapshot');
await mkdir(coverDir,{recursive:true});
const series=[];
for(const id of local.ids) {
  const previous=baseline.series.find(s=>s.id===id)||local.series.find(s=>s.id===id);
  const record=normalizeMedia(media.find(m=>m.id===id),previous,day);
  if(!record)continue; // fail closed if a title becomes adult or loses required metadata
  if(!safeCover(record.coverSource))throw Error('Cover host is not allowed');
  const response=await fetch(record.coverSource,{signal:AbortSignal.timeout(15000),redirect:'error'});
  if(!response.ok || Number(response.headers.get('content-length'))>2_000_000)throw Error(`Cover ${id} unavailable or oversized`);
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length>2_000_000)throw Error('Oversized cover');
  const ext=bytes.subarray(0,3).equals(Buffer.from([255,216,255]))?'jpg':bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'png':bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'?'webp':null;
  if(!ext)throw Error(`Invalid raster cover ${id}`);
  const name=`${id}-${createHash('sha256').update(bytes).digest('hex').slice(0,12)}.${ext}`;
  await writeFile(`${coverDir}/${name}`,bytes);
  record.cover=`/manga/covers/${name}`;
  series.push(finalizeRecord(record,previous,day));
}
if(!series.length)throw Error('No publishable series; refusing to empty the catalogue');
const snapshot=validateSnapshot({version:1,ids:local.ids,series});
await writeFile(file+'.tmp',JSON.stringify(snapshot,null,2)+'\n');
await rename(file+'.tmp',file);
console.log(`Refreshed ${series.length} non-adult series; ${local.ids.length-series.length} excluded.`);
