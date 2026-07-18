// screens/search.js — GLOBAL SEARCH across ALL installed sources, run in
// concurrency-limited batches so the hosted helper isn't hammered with hundreds
// of concurrent upstream searches. Results stream in as each source responds;
// only sources with matches get a section (no wall of empty skeletons).
//
// A language filter narrows the searched set to a single reader language
// (persisted), so you can e.g. search only English sources instead of all 700+.

import { api } from '../core/api.js';
import {
  el, card, spinner, emptyState, errorBox, langLabel, langCode, languageOptions, menuSelect, btn, chip,
} from '../core/ui.js';
import { router, store } from '../core/store.js';

export const meta = { title: 'Search', nav: false, icon: 'search', order: 99 };

const PER_SOURCE_LIMIT = 12;
// How many sources are queried at once. Kept modest: each query can trigger a
// server-side Cloudflare solve, and too many at once overloads the small VM.
const BATCH_SIZE = 6;
// A slow/hung source shouldn't hold a batch slot forever — free it after this.
const PER_SOURCE_TIMEOUT = 25_000;

// Persisted language filter (a source's lang code, or 'all').
const LANG_KEY = 'nyora.search.lang';
function getLangPref() {
  try { return localStorage.getItem(LANG_KEY) || 'all'; } catch { return 'all'; }
}
function setLangPref(v) {
  try { localStorage.setItem(LANG_KEY, v); } catch { /* private mode */ }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

export function render(view, params) {
  view.replaceChildren();

  const runState = { token: 0, total: 0, done: 0, hits: 0 };
  const query = (params && params.q != null ? String(params.q) : '').trim();
  // Every installed, NSFW-respecting source (cached once for this mount) — used
  // both to populate the language dropdown and as the pool each search filters.
  let allSources = null;
  let lang = getLangPref();

  const title = el('h1', { class: 'page-title', style: { marginBottom: '8px' } },
    query ? `Results for “${query}”` : 'Global Search');
  // No in-page search field — the global top-bar search (#searchInput) is the
  // single entry; it's prefilled with the active query below so you refine there.

  // Language filter row — a Material dropdown, rebuilt once sources load.
  const langHost = el('span', { class: 'search-lang-host' });
  const onLangChange = (v) => {
    lang = v;
    setLangPref(lang);
    if (query) runSearch(); else renderEmpty();
  };
  langHost.appendChild(menuSelect([{ value: 'all', label: 'All languages' }], 'all', onLangChange));
  const filters = el('div', { class: 'search-filters' },
    el('span', { class: 'search-filters-label' }, 'Language'),
    langHost,
  );

  const status = el('div', { class: 'search-status', style: { marginBottom: '24px' } });
  const results = el('div', { class: 'search-results' });

  view.append(title, filters, status, results);
  // Drive the global top-bar search: reflect the active query there so it reads
  // as "the" search field, and focus it (caret at end) for quick refining.
  requestAnimationFrame(() => {
    const top = document.getElementById('searchInput');
    if (!top) return;
    top.value = query;
    if (!query) {
      top.focus({ preventScroll: true });
      try { top.setSelectionRange(top.value.length, top.value.length); } catch { /* ignore */ }
    }
  });

  // Sources matching the active language filter ('all' → no restriction).
  function inLang(list) {
    return lang === 'all' ? list : list.filter((s) => langCode(s) === lang);
  }

  // Populate the language dropdown from the loaded source set, keeping the
  // persisted selection if it's still available (else falling back to 'all').
  function populateLangSelect() {
    const opts = languageOptions(allSources || []);
    const available = new Set(['all', ...opts.map((o) => o.code || '')]);
    if (!available.has(lang)) { lang = 'all'; setLangPref('all'); }
    const items = [
      { value: 'all', label: `All languages (${(allSources || []).length})` },
      ...opts.map((o) => ({ value: o.code || '', label: `${o.label} (${o.count})` })),
    ];
    langHost.replaceChildren(menuSelect(items, lang, onLangChange, { label: 'Filter sources by language' }));
    filters.style.display = opts.length > 1 ? '' : 'none';
  }

  // Load (once) every installed, NSFW-respecting source.
  async function ensureSources() {
    if (allSources) return allSources;
    const res = await api.listSources();
    const showNsfw = !!store.get().showNsfw;
    allSources = (res && res.sources || []).filter((s) => s.isInstalled && (showNsfw || !s.isNsfw));
    return allSources;
  }

  function updateProgress() {
    if (searchCache && searchCache.query === query) { searchCache.hits = runState.hits; searchCache.total = runState.total; }
    if (runState.done < runState.total) {
      status.replaceChildren(
        spinner(),
        el('span', null, `Searching ${runState.done}/${runState.total} sources · ${runState.hits} with matches`),
      );
    } else {
      status.replaceChildren(chip(
        runState.hits > 0
          ? `Found matches in ${runState.hits} of ${runState.total} sources`
          : `No matches found for “${query}”`));
    }
  }

  // Append a result section for a source that returned matches.
  function appendResultSection(src, list) {
    const sid = src.id;
    const badge = (src.lang || '').toUpperCase();
    const head = el('div', { class: 'search-result-header' },
      el('div', { class: 'source-meta' },
        el('div', { class: 'medallion-sm' }, badge.slice(0, 2) || '??'),
        el('div', null,
          el('h3', { class: 'source-name' }, src.name || sid),
          el('div', { class: 'source-sub' }, langLabel(src)),
        ),
      ),
      chip(list.length + (list.length >= PER_SOURCE_LIMIT ? '+' : ''), { class: 'btn-sm' }),
    );
    const grid = el('div', { class: 'grid dense' });
    const section = el('section', { class: 'search-source-card-minimal' }, head, grid);
    results.appendChild(section);
    const renderCards = (items) => {
      for (const manga of items) {
        grid.appendChild(card(manga, (m) => router.navigate('details', { sid, url: m.url })));
      }
    };
    // Keep sections scannable: two rows per source, expandable on demand.
    requestAnimationFrame(() => {
      const cols = (getComputedStyle(grid).gridTemplateColumns || '')
        .split(' ').filter(Boolean).length || 3;
      const cap = cols * 2;
      if (list.length <= cap) { renderCards(list); return; }
      renderCards(list.slice(0, cap));
      const more = btn(`Show all (${list.length}${list.length >= PER_SOURCE_LIMIT ? '+' : ''})`, {
        variant: 'ghost', class: 'btn-sm',
        onClick: () => { moreRow.remove(); renderCards(list.slice(cap)); },
      });
      const moreRow = el('div', { class: 'row', style: { justifyContent: 'center', marginTop: '12px' } }, more);
      section.appendChild(moreRow);
    });
  }

  async function searchOne(src, token) {
    try {
      const res = await withTimeout(api.search(src.id, query, 1), PER_SOURCE_TIMEOUT);
      if (token !== runState.token) return;
      const list = ((res && res.entries) || []).slice(0, PER_SOURCE_LIMIT);
      if (list.length) {
        runState.hits++;
        appendResultSection(src, list);
        if (searchCache && searchCache.query === query) searchCache.items.push({ src, list });
      }
    } catch {
      // Failed / blocked / timed-out source — skip silently (don't clutter with
      // an error card per dead source when searching hundreds).
    } finally {
      if (token === runState.token) { runState.done++; updateProgress(); }
    }
  }

  function renderEmpty() {
    title.textContent = 'Global Search';
    status.replaceChildren();
    results.replaceChildren(emptyState('Search across every installed source', 'search'));
    ensureSources().then(populateLangSelect).catch(() => { /* dropdown stays "All languages" */ });
  }

  async function runSearch() {
    const token = ++runState.token;
    runState.total = 0; runState.done = 0; runState.hits = 0;
    searchCache = { query, items: [], hits: 0, total: 0 }; // fresh cache for this run
    results.replaceChildren();
    status.replaceChildren(spinner(), el('span', null, 'Loading sources…'));

    let sources;
    try {
      await ensureSources();
      if (token !== runState.token) return;
      populateLangSelect();
      // Apply the language filter first. When 'all', keep the pinned-only
      // behaviour (pinned = the user's curated search set); a specific language
      // means "search that language", so it spans all its sources, not just pinned.
      sources = inLang(allSources);
      // Search scope preference: 'pinned' = the user's curated set (when any
      // are pinned); 'all' = every installed source. A specific language always
      // spans all of that language's sources.
      if (lang === 'all' && (store.get().searchScope || 'pinned') === 'pinned') {
        const pinned = sources.filter((s) => s.isPinned);
        if (pinned.length) sources = pinned;
      }
    } catch (e) {
      results.replaceChildren(errorBox(e.message));
      return;
    }
    if (!sources.length) {
      results.replaceChildren(emptyState(
        lang === 'all' ? 'No sources installed' : `No ${langLabel({ lang })} sources installed`,
        'compass'));
      return;
    }

    // Pinned first, then the rest — results still stream in as they resolve.
    sources = sources.slice().sort((a, b) => (b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0));
    runState.total = sources.length;
    updateProgress();

    // Concurrency-limited worker pool: BATCH_SIZE workers each pull the next
    // source off the shared cursor until every source has been queried.
    let cursor = 0;
    const worker = async () => {
      while (token === runState.token) {
        const i = cursor++;
        if (i >= sources.length) return;
        await searchOne(sources[i], token);
      }
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_SIZE, sources.length) }, worker));
    if (token === runState.token) updateProgress();
  }

  // Restore the last search's streamed results instantly on back-navigation —
  // no refetch, so the streamed grid + scroll position come back intact.
  function restoreSearchResults() {
    results.replaceChildren();
    for (const it of searchCache.items) appendResultSection(it.src, it.list);
    status.replaceChildren(chip(
      searchCache.hits > 0
        ? `Found matches in ${searchCache.hits} of ${searchCache.total} sources`
        : `No matches found for “${query}”`));
    ensureSources().then(populateLangSelect).catch(() => { /* keep default dropdown */ });
  }

  if (query && searchCache && searchCache.query === query && searchCache.items.length) restoreSearchResults();
  else if (query) runSearch();
  else renderEmpty();
}

// Persists the last query's streamed results across re-renders (back-navigation).
let searchCache = null;

export default { meta, render };
