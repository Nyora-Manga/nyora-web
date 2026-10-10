import {createHash} from 'node:crypto';

export function plainText(value) {
  const entities={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',rsquo:'’',lsquo:'‘',rdquo:'”',ldquo:'“',mdash:'—',ndash:'–',hellip:'…'};
  return String(value||'').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,' ')
    .replace(/<[^>]*>/g,' ').replace(/&(#x[\da-f]+|#\d+|\w+);/gi,(whole,key)=> {
      if(key[0]!=='#')return entities[key.toLowerCase()]||whole;
      const code=key[1].toLowerCase()==='x'?parseInt(key.slice(2),16):Number(key.slice(1));
      return code>0&&code<=0x10ffff?String.fromCodePoint(code):'';
    }).replace(/\s+/g,' ').trim();
}
export function safeCover(url) {
  try {
    const u=new URL(url);
    return u.protocol==='https:' && /^s[45]\.anilist\.co$/.test(u.hostname) && !u.username && !u.password && !u.port && u.pathname.startsWith('/file/anilistcdn/media/manga/cover/');
  } catch {return false;}
}
export function normalizeMedia(media, previous, day) {
  if(!Number.isSafeInteger(media.id)||media.id<1)throw Error('Invalid series identity');
  if(media.isAdult!==false || (media.genres||[]).includes('Hentai'))return null;
  const title=plainText(media.title?.english||media.title?.romaji);
  const description=plainText(media.description);
  const coverSource=media.coverImage?.large;
  if(!title || description.length<100 || !safeCover(coverSource))return null;
  const slug=(title.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,90)||'series');
  const aliases=[...new Set([...Object.values(media.title||{}),...(media.synonyms||[])].map(plainText).filter(s=>s&&s!==title))];
  const creators=[...new Set((media.staff?.edges||[]).filter(e=>/story|art/i.test(e.role)&&!/assistant/i.test(e.role)).map(e=>plainText(e.node?.name?.full)).filter(Boolean))];
  const record={id:media.id,path:previous?.path||`/manga/${slug}-${media.id}/`,title,aliases,description,genres:(media.genres||[]).map(plainText),creators,status:plainText(media.status),format:plainText(media.format),country:plainText(media.countryOfOrigin),year:media.startDate?.year||null,chapters:media.chapters||null,volumes:media.volumes||null,isAdult:false,metadataUrl:`https://anilist.co/manga/${media.id}`,coverSource,cover:previous?.cover||null};
  return finalizeRecord(record,previous,day);
}
export function contentHash(record) {
  const {lastmod,hash,...content}=record;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}
export function finalizeRecord(record,previous,day) {
  const hash=contentHash(record);
  return {...record,hash,lastmod:previous?.hash===hash?previous.lastmod:day};
}
export function validateSnapshot(snapshot) {
  if(snapshot?.version!==1 || !Array.isArray(snapshot.ids)|| !snapshot.ids.length || snapshot.ids.length>100 || !Array.isArray(snapshot.series))throw Error('Invalid catalogue snapshot');
  const ids=new Set(),paths=new Set();
  for(const s of snapshot.series) {
    if(!snapshot.ids.includes(s.id)||ids.has(s.id)||paths.has(s.path)||s.isAdult!==false||s.genres?.includes('Hentai')||!s.title||s.description?.length<100||!/^\/manga\/[a-z0-9-]+\/$/.test(s.path))throw Error('Invalid series record');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(s.lastmod)||!safeCover(s.coverSource)||!/^\/manga\/covers\/\d+-[a-f0-9]{12}\.(jpg|png|webp)$/.test(s.cover)||s.hash!==contentHash(s))throw Error('Invalid series cover, date or hash');
    ids.add(s.id);paths.add(s.path);
  }
  return snapshot;
}
