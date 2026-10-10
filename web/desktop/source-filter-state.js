export const filterLabel = value => ({ UPDATED:'Recently updated', UPDATED_ASC:'Oldest updates', POPULARITY:'Most popular', POPULARITY_ASC:'Least popular', NEWEST:'Newest releases', NEWEST_ASC:'Oldest releases', ALPHABETICAL:'Title · A–Z', ALPHABETICAL_DESC:'Title · Z–A', RATING:'Highest rated', RATING_ASC:'Lowest rated', RELEVANCE:'Relevance', ADDED:'Recently added', ADDED_ASC:'First added', FINISHED:'Completed', ABANDONED:'Cancelled', PAUSED:'On hiatus', SAFE:'General audience', SUGGESTIVE:'Suggestive', ADULT:'Adult', State:'Publication status', Type:'Format', Rating:'Content rating', Locale:'Chapter language', Sort:'Sort by' }[value] || String(value).toLowerCase().replaceAll('_',' ').replace(/^./, c=>c.toUpperCase()));
export function setTag(draft, key, mode, options) {
  const next = structuredClone(draft);
  next.Tags = (next.Tags || []).filter(value => value !== key);
  next['Excluded tags'] = (next['Excluded tags'] || []).filter(value => value !== key);
  if (mode === 'include') next.Tags = options.multipleTags ? [...next.Tags, key] : [key];
  if (mode === 'exclude' && options.tagsExclusion) next['Excluded tags'].push(key);
  return next;
}
export function toWireFilters(draft, options) {
  const wire = [], keys = new Set((options.tags || []).map(tag => tag.key));
  for (const name of ['Tags', 'Excluded tags']) {
    if (name === 'Excluded tags' && !options.tagsExclusion) continue;
    let selected = [...new Set((draft[name] || []).filter(key => keys.has(key)))];
    if (name === 'Tags' && !options.multipleTags) selected = selected.slice(0,1);
    if (name === 'Excluded tags') selected = selected.filter(key => !(draft.Tags || []).includes(key));
    if (selected.length) wire.push({name,type:'text',value:selected.join(',')});
  }
  for (const field of options.filters || []) {
    let value = String(draft[field.name] || '').trim();
    if (field.values?.length) {
      const selected = [...new Set(value.split(',').filter(v => field.values.includes(v)))];
      value = (field.multiple ? selected : selected.slice(0, 1)).join(',');
    }
    if (!value) continue;
    wire.push({name:field.name,type:'text',value});
  }
  return wire;
}
export function validateFilterDraft(draft, options, query) {
  if (draft.Year && !/^\d{4}$/.test(draft.Year)) return 'Enter a four-digit publication year.';
  if (draft.Locale && !/^[a-zA-Z]{2,3}(?:-[a-zA-Z]{2,4})?$/.test(draft.Locale)) return 'Enter a language code, such as en, ja, or pt-BR.';
  if (query.trim() && toWireFilters(draft, options).length && !options.searchWithFilters) return 'This source keeps text search separate from filters. Clear the title search to use these filters.';
  return '';
}
export function draftFromWire(wire = []) {
  return Object.fromEntries(wire.map(filter => [filter.name, ['Tags','Excluded tags'].includes(filter.name) ? filter.value.split(',') : filter.value]));
}
