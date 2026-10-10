// Shared, dependency-free TF-IDF scoring for the public catalogue and its links.
const STOP = new Set('a an and are as at be been but by for from had has have he her his i in is it its of on or she that the their them they this to was were will with you your'.split(' '));
export function fold(text) {
  return String(text || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}
export function tokenize(text) {
  return (fold(text).match(/[\p{L}\p{N}]+/gu) || []).flatMap(word => {
    if (STOP.has(word)) return [];
    // Native Japanese/Korean/Chinese aliases remain searchable without a model.
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(word)) {
      const chars = [...word];
      return [word, ...chars.slice(0, -1).map((c, i) => c + chars[i + 1])];
    }
    return [word];
  });
}
function counts(text) {
  const out = new Map();
  for (const word of tokenize(text)) out.set(word, (out.get(word) || 0) + 1);
  return out;
}
export function buildIndex(series) {
  const documents = series.map(s => ({id:s.id, path:s.path, title:s.title, aliases:s.aliases, genres:s.genres}));
  const terms = Object.create(null);
  const vectors = series.map(s => {
    const vector = new Map();
    for (const [text, weight] of [[s.title,6],[(s.aliases||[]).join(' '),4],[(s.genres||[]).join(' '),2],[(s.creators||[]).join(' '),2],[s.description,1]]) {
      for (const [term, count] of counts(text)) vector.set(term,(vector.get(term)||0)+weight*(1+Math.log(count)));
    }
    for (const term of vector.keys()) {
      terms[term] ??= {idf:0, postings:[]};
      terms[term].idf++;
    }
    return vector;
  });
  for (const term of Object.values(terms)) term.idf = Math.log((1+series.length)/(1+term.idf))+1;
  vectors.forEach((vector, doc) => {
    let norm=0;
    for(const [term,tf] of vector) { const weight=tf*terms[term].idf;vector.set(term,weight);norm+=weight*weight; }
    norm=Math.sqrt(norm)||1;
    for(const [term,weight] of vector) terms[term].postings.push([doc,weight/norm]);
  });
  return {version:1, documents, terms};
}
export function searchIndex(index, query, limit=40) {
  const queryTerms=counts(String(query||'').slice(0,300));
  const scores=new Map();let norm=0;
  for(const [term,count] of queryTerms) {
    if(!Object.hasOwn(index.terms,term))continue;
    const weight=(1+Math.log(count))*index.terms[term].idf;
    queryTerms.set(term,weight);norm+=weight*weight;
  }
  norm=Math.sqrt(norm)||1;
  for(const [term,weight] of queryTerms) {
    if(!Object.hasOwn(index.terms,term))continue;
    for(const [doc,score] of index.terms[term].postings) scores.set(doc,(scores.get(doc)||0)+score*weight/norm);
  }
  const phrase=fold(query).trim();
  for(const [doc,score] of scores) {
    const titles=[index.documents[doc].title,...(index.documents[doc].aliases||[])].map(fold);
    scores.set(doc,score+(titles.includes(phrase)?2:0));
  }
  return [...scores].sort((a,b)=>b[1]-a[1]||a[0]-b[0]).slice(0,limit).map(([doc,score])=>({...index.documents[doc],score}));
}
export function relatedSeries(index, id, limit=4) {
  const doc=index.documents.findIndex(d=>d.id===id),scores=new Map();
  if(doc<0)return [];
  for(const term of Object.values(index.terms)) {
    const self=term.postings.find(([i])=>i===doc);
    if(!self)continue;
    for(const [other,weight] of term.postings) {
      if(other===doc || !index.documents[doc].genres.some(g=>index.documents[other].genres.includes(g)))continue;
      scores.set(other,(scores.get(other)||0)+self[1]*weight);
    }
  }
  return [...scores].sort((a,b)=>b[1]-a[1]||a[0]-b[0]).slice(0,limit).map(([i])=>index.documents[i].id);
}
