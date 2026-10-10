import { sourceId } from '../core/source-identity.js';

// Presentation only: exact source identities and acknowledged native snapshots.
const identity = (manga) => {
  const source = sourceId(manga?.sourceId || manga?.source || manga?.manga?.source);
  const url = manga?.mangaUrl ?? manga?.url ?? manga?.manga?.url;
  return source && typeof url === 'string' && url ? JSON.stringify([source, url]) : '';
};
const text = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase().trim();

export const LIBRARY_SORTS = [
  ['recent','Recently added'],['oldest','First added'],['title','Title · A–Z'],['title-desc','Title · Z–A'],
  ['rating','Highest rated'],['new-chapters','New chapters'],['progress','Reading progress'],['unread','Least read'],
  ['read','Recently read'],['read-oldest','Longest since read'],['updated','Latest chapter'],
].map(([value,label])=>({value,label}));

export function selectLibraryEntries(entries, filters = {}, history = [], context = {}) {
  const readAt = new Map(), latestHistory = new Map();
  for (const row of history) {
    const key = identity(row);
    if (!key) continue;
    const timestamp = Number(row.updatedAt);
    if (!latestHistory.has(key) || timestamp > Number(latestHistory.get(key).updatedAt)) latestHistory.set(key, row);
    readAt.set(key, Math.max(readAt.get(key) || 0, Number.isFinite(timestamp) ? timestamp : 0));
  }
  const metrics = new Map(entries.map(manga => {
    const latest = latestHistory.get(identity(manga));
    const chapters = [...(manga.chapters || [])].sort((a,b)=>Number(a.number)-Number(b.number));
    const at = latest ? chapters.findIndex(c=>c.id === latest.chapterId || c.url === latest.chapterId || c.url === latest.chapterUrl) : -1;
    const branch = at >= 0 ? chapters[at].branch : undefined;
    const selected = at < 0 ? chapters : chapters.filter(c=>(c.branch ?? '') === (branch ?? ''));
    const current = at >= 0 ? selected.indexOf(chapters[at]) : -1;
    const marks = context.readMarks?.[String(manga.id)] || {};
    let read = 0;
    for (const [index,chapter] of selected.entries()) {
      const marked = list => list?.includes(chapter.url) || list?.includes(chapter.id);
      if (marked(marks.unread)) continue;
      read += marked(marks.read) || current >= 0 && index < current ? 1 : index === current ? Math.max(0,Math.min(1,Number(latest.percent)||0)) : 0;
    }
    const newChapters = (context.updates || []).filter(row=>String(row.mangaId)===String(manga.id) && sourceId(row.sourceId)===sourceId(manga.source)).reduce((n,row)=>Math.max(n,Number(row.newChapters)||0),0);
    const downloaded = (context.downloads || []).some(row=>row.status==='COMPLETED' && row.offline === true && sourceId(row.sourceId)===sourceId(manga.source) && (row.mangaUrl ? row.mangaUrl===manga.url : String(row.mangaId)===String(manga.id)));
    return [manga,{progress:selected.length ? read/selected.length : 0,completed:selected.length>0 && read>=selected.length,downloaded,newChapters,updated:chapters.reduce((n,c)=>Math.max(n,Number(c.uploadDate)||0),0)}];
  }));
  const query = text(filters.query);
  const result = entries.filter(manga => {
    if (filters.source && sourceId(manga.source) !== filters.source) return false;
    if (query && ![manga.title, ...(Array.isArray(manga.altTitles) ? manga.altTitles : [])].some(title => text(title).includes(query))) return false;
    const data = metrics.get(manga);
    if (filters.downloaded && !data.downloaded || filters.completed && !data.completed || filters.newChapters && !data.newChapters) return false;
    const hasHistory = readAt.has(identity(manga));
    if (filters.reading === 'with-history' && !hasHistory) return false;
    if (filters.reading === 'no-history' && hasHistory) return false;
    return true;
  });
  if (filters.sort === 'title' || filters.sort === 'title-desc') result.sort((a, b) => (filters.sort === 'title-desc' ? -1 : 1) * String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' }));
  if (filters.sort === 'read') result.sort((a, b) => (readAt.get(identity(b)) || 0) - (readAt.get(identity(a)) || 0));
  if (filters.sort === 'read-oldest') result.sort((a,b)=>(readAt.get(identity(a))||0)-(readAt.get(identity(b))||0));
  if (filters.sort === 'recent' && result.some(m=>m.libraryAddedAt)) result.sort((a,b)=>Number(b.libraryAddedAt||0)-Number(a.libraryAddedAt||0));
  if (filters.sort === 'oldest') result.sort((a,b)=>Number(a.libraryAddedAt||0)-Number(b.libraryAddedAt||0));
  if (filters.sort === 'rating') result.sort((a,b)=>(Number(b.rating) || 0)-(Number(a.rating) || 0));
  const metric = {'new-chapters':'newChapters',progress:'progress',unread:'progress',updated:'updated'}[filters.sort];
  if(metric) result.sort((a,b)=>(filters.sort==='unread' ? -1 : 1)*(metrics.get(b)[metric]-metrics.get(a)[metric]));
  return result;
}

export function librarySourceOptions(entries, sources = []) {
  const labels = new Map(sources.map(source => [source.id, source.name]));
  const ids = new Set(entries.map(manga => sourceId(manga.source)).filter(Boolean));
  return [...ids].map(id => ({ value: id, label: labels.get(id) || id.slice(5) })).sort((a, b) => a.label.localeCompare(b.label));
}

export function hasLibraryFilters(filters) {
  return !!(filters.downloaded || filters.completed || filters.newChapters || text(filters.query) || filters.source || filters.reading && filters.reading !== 'all');
}

export function resetLibraryFilters(filters) {
  return { ...filters, query: '', source: '', reading: 'all', downloaded:false, completed:false, newChapters:false };
}
