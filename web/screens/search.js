// screens/search.js — GLOBAL SEARCH across ALL installed sources, run in
// concurrency-limited batches so the hosted helper isn't hammered with hundreds
// of concurrent upstream searches. Results stream in as each source responds;
// only sources with matches get a section (no wall of empty skeletons).
//
// A language filter narrows the searched set to a single reader language
// (persisted), so you can e.g. search only English sources instead of all 700+.
//
// Sections and the cards inside them are ordered by how well they actually match
// the query, not by which source happened to answer first — see `relevance`.

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

// ---- recent queries -----------------------------------------------------
// A global search costs hundreds of upstream requests, so re-running one you
// already ran is the single cheapest useful thing this screen can offer.
const RECENT_KEY = 'nyora.search.recent';
const RECENT_MAX = 10;
function getRecent() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).slice(0, RECENT_MAX) : [];
  } catch { return []; }
}
function pushRecent(q) {
  const query = String(q || '').trim();
  if (!query) return;
  try {
    const next = [query, ...getRecent().filter((x) => x.toLowerCase() !== query.toLowerCase())].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* private mode */ }
}
function clearRecent() {
  try { localStorage.removeItem(RECENT_KEY); } catch { /* private mode */ }
}

// ---- relevance ----------------------------------------------------------
// Sources vary wildly in search quality: plenty ignore the query and hand back
// their popular list, so a section can arrive with 12 results of which one is
// the manga you asked for. Ordering by arrival puts that noise above a source
// that answered perfectly, which is what this scoring exists to fix.
//
// It only ever REORDERS, never hides. A localized title ("Ван Пис" for One
// Piece) shares no characters with the query and scores 0, so dropping low
// scores would throw away exactly the results a multi-language reader wants.

/** NFKD-fold to a comparable form: accents stripped, punctuation → single spaces. */
function fold(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function scoreText(text, q, qTokens) {
  const t = fold(text);
  if (!t || !q) return 0;
  if (t === q) return 1;
  if (t.startsWith(q)) return 0.9;
  if (t.includes(q)) return 0.8;
  // Sources punctuate and space titles inconsistently ("OnePiece", "Dr.STONE",
  // "JoJo's"), so retry the same tests with spacing removed — ranked just under
  // their spaced equivalents — before falling back to token overlap.
  const ts = t.replace(/ /g, '');
  const qs = q.replace(/ /g, '');
  if (qs) {
    if (ts === qs) return 0.95;
    if (ts.startsWith(qs)) return 0.85;
    if (ts.includes(qs)) return 0.75;
  }
  if (!qTokens.length) return 0;
  const words = new Set(t.split(' '));
  const hits = qTokens.reduce((n, tok) => n + (words.has(tok) ? 1 : 0), 0);
  if (!hits) return 0;
  return hits === qTokens.length ? 0.65 : 0.35 * (hits / qTokens.length);
}

/** Best match across the primary title and any alternate titles. */
function relevance(manga, q, qTokens) {
  let best = scoreText(manga && manga.title, q, qTokens);
  const alts = (manga && manga.altTitles) || [];
  if (Array.isArray(alts)) {
    for (const alt of alts) {
      if (best >= 1) break;
      // Slightly discounted so a primary-title match wins an otherwise equal tie.
      best = Math.max(best, scoreText(alt, q, qTokens) * 0.95);
    }
  }
  return best;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

export function render(view, params) {
  view.replaceChildren();

  const runState = { token: 0, total: 0, done: 0, hits: 0, failed: 0, results: 0, stopped: false };
  const query = (params && params.q != null ? String(params.q) : '').trim();
  const qFolded = fold(query);
  const qTokens = qFolded ? qFolded.split(' ').filter(Boolean) : [];
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

  function stopSearch() {
    // Invalidating the token is what actually stops the pool: every worker and
    // every in-flight searchOne checks it before touching the DOM or looping.
    runState.token++;
    runState.stopped = true;
    updateProgress();
  }

  function summaryText() {
    if (!runState.hits) return `No matches found for “${query}”`;
    const sources = `${runState.hits} of ${runState.done} source${runState.done === 1 ? '' : 's'}`;
    return `${runState.results} result${runState.results === 1 ? '' : 's'} from ${sources}`;
  }

  function updateProgress() {
    if (searchCache && searchCache.query === query) {
      searchCache.hits = runState.hits;
      searchCache.total = runState.total;
      searchCache.done = runState.done;
      searchCache.failed = runState.failed;
      searchCache.results = runState.results;
    }
    if (!runState.stopped && runState.done < runState.total) {
      status.replaceChildren(
        spinner(),
        el('span', null, `Searching ${runState.done}/${runState.total} sources · ${runState.hits} with matches`),
        btn('Stop', { variant: 'ghost', class: 'btn-sm', onClick: stopSearch }),
      );
      return;
    }
    const kids = [chip(runState.stopped ? `Stopped · ${summaryText()}` : summaryText())];
    // Sources that errored, timed out or are blocked are skipped silently per
    // source; saying so once is the honest version of "we searched everything".
    if (runState.failed) {
      kids.push(el('span', { class: 'search-status-note' },
        `${runState.failed} source${runState.failed === 1 ? '' : 's'} didn’t respond`));
    }
    status.replaceChildren(...kids);
  }

  // ---- ranked, streaming section list -----------------------------------
  // Sections are placed by score as they arrive rather than appended, so the
  // source that actually matched leads. Placed sections are never moved again,
  // and once the reader has scrolled we stop inserting above them entirely —
  // re-ranking under someone mid-read is worse than a slightly stale order.
  let placed = [];
  let colsCache = 0;
  let userScrolled = false;
  const scroller = document.scrollingElement || document.documentElement;
  // Detach the previous visit's listeners before adding this visit's, the way
  // explore/history do — the router re-runs render() on every navigation here,
  // and window listeners would otherwise stack up one pair per visit.
  if (_onScroll) window.removeEventListener('scroll', _onScroll);
  if (_onResize) window.removeEventListener('resize', _onResize);
  _onScroll = () => { if ((scroller.scrollTop || window.scrollY || 0) > 240) userScrolled = true; };
  _onResize = () => { colsCache = 0; };
  window.addEventListener('scroll', _onScroll, { passive: true });
  window.addEventListener('resize', _onResize, { passive: true });

  /** Descending by best match, then by how much of the section matched. */
  function rankBefore(a, b) {
    if (a.best !== b.best) return a.best > b.best;
    return a.frac > b.frac;
  }

  function insertRanked(section, key) {
    if (userScrolled) { results.appendChild(section); placed.push({ ...key, node: section }); return; }
    let i = 0;
    while (i < placed.length && !rankBefore(key, placed[i])) i++;
    if (i === placed.length) results.appendChild(section);
    else results.insertBefore(section, placed[i].node);
    placed.splice(i, 0, { ...key, node: section });
  }

  // Column count drives the "two rows then Show all" cap. Reading it costs a
  // forced layout, so measure once per run instead of once per source — with
  // 300 sources that was 300 synchronous reflows on a slow laptop.
  function columnsOf(grid) {
    if (!colsCache) {
      colsCache = (getComputedStyle(grid).gridTemplateColumns || '').split(' ').filter(Boolean).length || 3;
    }
    return colsCache;
  }

  // Append a result section for a source that returned matches.
  function appendResultSection(src, rawList) {
    const sid = src.id;
    // Best matches first, so the two visible rows are the relevant ones rather
    // than whatever order the source used.
    const scored = rawList
      .map((manga, i) => ({ manga, score: relevance(manga, qFolded, qTokens), i }))
      .sort((a, b) => (b.score - a.score) || (a.i - b.i));
    const list = scored.map((s) => s.manga);
    const best = scored.length ? scored[0].score : 0;
    const frac = scored.length ? scored.filter((s) => s.score > 0).length / scored.length : 0;

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
    insertRanked(section, { best, frac });
    const renderCards = (items) => {
      for (const manga of items) {
        grid.appendChild(card(manga, (m) => router.navigate('details', { sid, url: m.url })));
      }
    };
    // Keep sections scannable: two rows per source, expandable on demand.
    requestAnimationFrame(() => {
      const cap = columnsOf(grid) * 2;
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
        runState.results += list.length;
        appendResultSection(src, list);
        if (searchCache && searchCache.query === query) searchCache.items.push({ src, list });
      }
    } catch {
      // Failed / blocked / timed-out source — no error card per dead source when
      // searching hundreds of them; the count is surfaced once in the status.
      if (token === runState.token) runState.failed++;
    } finally {
      if (token === runState.token) { runState.done++; updateProgress(); }
    }
  }

  function renderEmpty() {
    title.textContent = 'Global Search';
    status.replaceChildren();
    const recent = getRecent();
    const blocks = [];
    if (recent.length) {
      blocks.push(el('div', { class: 'search-recent' },
        el('div', { class: 'search-recent-head' },
          el('span', { class: 'search-filters-label' }, 'Recent searches'),
          btn('Clear', {
            variant: 'ghost',
            class: 'btn-sm',
            onClick: () => { clearRecent(); renderEmpty(); },
          }),
        ),
        el('div', { class: 'search-recent-chips' },
          ...recent.map((q) => chip(q, { onClick: () => router.navigate('search', { q }) })),
        ),
      ));
    }
    blocks.push(emptyState('Search across every installed source', 'search'));
    results.replaceChildren(...blocks);
    ensureSources().then(populateLangSelect).catch(() => { /* dropdown stays "All languages" */ });
  }

  async function runSearch() {
    const token = ++runState.token;
    runState.total = 0; runState.done = 0; runState.hits = 0;
    runState.failed = 0; runState.results = 0; runState.stopped = false;
    placed = []; colsCache = 0;
    searchCache = { query, items: [], hits: 0, total: 0, done: 0, failed: 0, results: 0 }; // fresh cache
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

    // Only remember queries we actually ran against real sources.
    pushRecent(query);

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
  // no refetch, so the streamed grid + scroll position come back intact. The
  // same ranking is reapplied, so the restored order matches what was on screen.
  function restoreSearchResults() {
    results.replaceChildren();
    placed = []; colsCache = 0;
    runState.hits = searchCache.hits;
    runState.total = searchCache.total;
    runState.done = searchCache.done || searchCache.total;
    runState.failed = searchCache.failed || 0;
    runState.results = searchCache.results || 0;
    runState.stopped = false;
    for (const it of searchCache.items) appendResultSection(it.src, it.list);
    updateProgress();
    ensureSources().then(populateLangSelect).catch(() => { /* keep default dropdown */ });
  }

  if (query && searchCache && searchCache.query === query && searchCache.items.length) restoreSearchResults();
  else if (query) runSearch();
  else renderEmpty();
}

// Persists the last query's streamed results across re-renders (back-navigation).
let searchCache = null;
// The live window listeners, held at module scope so each render can detach the
// previous visit's pair (see render()).
let _onScroll = null;
let _onResize = null;

export default { meta, render };
