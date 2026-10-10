import {createHash} from 'node:crypto';
import {buildIndex,relatedSeries} from '../../web/core/series-index.js';
export const ORIGIN='https://web.nyora.xyz';
export const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const h=escapeHtml;
const human=value=>String(value||'').toLowerCase().replace(/_/g,' ').replace(/^./,c=>c.toUpperCase());
const kind=s=>s.country==='KR'?'Manhwa':s.country==='CN'?'Manhua':'Manga';
const open=s=>`/#/search?q=${encodeURIComponent(s.title)}`;
function shell({title,description,path,cover,body,script}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(title)}</title><meta name="description" content="${h(description)}">
<meta name="robots" content="index, follow, max-image-preview:large"><meta name="color-scheme" content="dark light">
<link rel="canonical" href="${ORIGIN}${h(path)}"><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/catalog/styles.css">
<meta property="og:type" content="website"><meta property="og:site_name" content="Nyora"><meta property="og:title" content="${h(title)}"><meta property="og:description" content="${h(description)}"><meta property="og:url" content="${ORIGIN}${h(path)}">
<meta property="og:image" content="${ORIGIN}${h(cover||'/og.png')}"><meta name="twitter:card" content="summary_large_image">
</head><body><a class="skip-link" href="#content">Skip to content</a>
<header class="site-header"><a class="brand" href="/"><img src="/icon.png" width="32" height="32" alt="">NYORA</a><nav aria-label="Main navigation"><a href="/manga/"${path==='/manga/'?' aria-current="page"':''}>Manga catalogue</a><a class="button subtle" href="/#/discover">Open app <span aria-hidden="true">↗</span></a></nav></header>
<main id="content">${body}</main><footer><a href="/manga/">Browse all series</a><span>Made for your next read.</span><a href="https://nyora.xyz/privacy/">Privacy</a><a href="https://nyora.xyz/">About Nyora</a></footer>
${script?'<script type="module" src="/catalog/search.js"></script>':''}</body></html>`;
}
export function card(s) {
 return `<li class="series-card" data-series-id="${s.id}"><a href="${h(s.path)}"><div class="cover"><img src="${h(s.cover)}" width="230" height="345" alt="${h(s.title)} cover" loading="lazy" decoding="async"></div><span class="card-kind">${kind(s)}${s.year?' · '+s.year:''}</span><h2>${h(s.title)}</h2><p>${h(s.genres.slice(0,2).join(' · '))}</p></a></li>`;
}
export function renderCatalogue(series) {
 return shell({title:'Manga catalogue — Find your next read · Nyora',description:'Explore manga and manhwa by title, genre or story. Browse series summaries, discover related titles and open your next read in Nyora.',path:'/manga/',script:true,body:`
<section class="catalogue-intro"><p class="eyebrow">The reading room</p><h1>Find your next<br><em>can’t-put-down.</em></h1><p>Familiar favourites. Stories waiting to be found.<br>Explore the collection, then make it yours in Nyora.</p></section>
<section aria-label="Manga catalogue"><form class="catalogue-search" role="search"><label for="series-query">Search the collection</label><div class="search-controls"><input id="series-query" type="search" autocomplete="off" placeholder="Title, genre, or a story you’re looking for…" maxlength="300"><button class="button" type="submit">Search</button></div><p id="search-status" role="status" aria-live="polite">${series.length} series in the collection</p></form><noscript><p>Browse every series below. Enable JavaScript to search the collection.</p></noscript>
<ul class="series-grid" id="series-results">${series.map(card).join('\n')}</ul><p id="search-empty" hidden>No matches in this collection. Try another title or <a href="/#/search">search Nyora’s sources</a>.</p></section>`});
}
export function renderSeries(s,related) {
 const description=`${s.title}: ${s.description}`.slice(0,158).replace(/\s+\S*$/,'')+'…';
 const facts=[['Format',kind(s)],['Status',human(s.status)],['First published',s.year],['Chapters',s.chapters],['Volumes',s.volumes]].filter(([,v])=>v);
 return shell({title:`${s.title} — Synopsis & related manga · Nyora`,description,path:s.path,cover:s.cover,body:`
<nav class="breadcrumb" aria-label="Breadcrumb"><a href="/manga/">Manga catalogue</a><span aria-hidden="true">/</span><span>${h(s.title)}</span></nav>
<article><div class="series-hero"><div class="hero-cover"><img src="${h(s.cover)}" width="230" height="345" fetchpriority="high" alt="${h(s.title)} cover"></div><div class="series-heading"><p class="eyebrow">${kind(s)}${s.year?' · '+s.year:''}</p><h1>${h(s.title)}</h1>${s.creators.length?`<p class="creators">By ${h(s.creators.join(' · '))}</p>`:''}<ul class="genres" aria-label="Genres">${s.genres.map(g=>`<li>${h(g)}</li>`).join('')}</ul><a class="button primary" href="${h(open(s))}">Open in Nyora <span aria-hidden="true">↗</span></a><p class="handoff-note">Find this title across your selected sources.</p></div></div>
<div class="series-body"><section class="synopsis"><h2>About the story</h2><p>${h(s.description)}</p>${s.aliases.length?`<details><summary>Also known as</summary><ul>${s.aliases.map(a=>`<li>${h(a)}</li>`).join('')}</ul></details>`:''}</section><aside class="series-facts" aria-label="Series information"><dl>${facts.map(([k,v])=>`<div><dt>${h(k)}</dt><dd>${h(v)}</dd></div>`).join('')}</dl><p class="attribution">Metadata: <a href="${h(s.metadataUrl)}" rel="noopener">AniList</a><br>Updated <time datetime="${s.lastmod}">${s.lastmod}</time></p></aside></div></article>
${related.length?`<section class="related"><div class="section-title"><div><p class="eyebrow">Keep exploring</p><h2>More stories to get lost in</h2></div><a href="/manga/">View collection <span aria-hidden="true">↗</span></a></div><ul class="series-grid related-grid">${related.map(card).join('\n')}</ul></section>`:''}`});
}
export function createPages(snapshot,{previous={},day}) {
 const index=buildIndex(snapshot.series),records=new Map(snapshot.series.map(s=>[s.id,s]));
 const pages=new Map([['/manga/',renderCatalogue(snapshot.series)]]);
 for(const s of snapshot.series)pages.set(s.path,renderSeries(s,relatedSeries(index,s.id).map(id=>records.get(id))));
 const manifest={version:1,pages:{}};
 for(const [path,html] of pages) {
   const hash=createHash('sha256').update(html).digest('hex');
   const prior=previous.pages?.[path];
   manifest.pages[path]={hash,lastmod:prior?.hash===hash?prior.lastmod:day};
 }
 return {pages,index,manifest};
}
export function renderSitemap(manifest,rootDate) {
 const entries=[['/',rootDate],...Object.entries(manifest.pages).map(([path,v])=>[path,v.lastmod])];
 return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.map(([path,date])=>`  <url><loc>${ORIGIN}${h(path)}</loc><lastmod>${date}</lastmod></url>`).join('\n')}\n</urlset>\n`;
}
