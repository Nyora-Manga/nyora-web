import { browserLibrary, browserFiles } from '../desktop/browser-services.js';
import { downloads } from '../core/downloads.js';
import { createLibraryResume, importLibraryComics } from '../desktop/library-presentation.js';
import { LIBRARY_SORTS, selectLibraryEntries, librarySourceOptions, hasLibraryFilters, resetLibraryFilters } from '../desktop/library-tools.js';
// Electron library presentation backed by browser storage.

import {
  el, card, toast, skeletonCard, icon, btn, chip, emptyState,
  errorBox, promptDialog, confirmDialog, modal, segmented, attachContextMenu,
} from '../core/ui.js';
import library from '../core/library.js';
import { api } from '../core/api.js';
import { sourceId } from '../core/source-identity.js';
import { router, store } from '../core/store.js';
import { render as downloadsRender } from './downloads.js';

export const meta = { title: 'Library', nav: true, icon: 'library', order: 10 };

// ---- source resolution --------------------------------------------------
// A favourite stores the manga's source as a polymorphic ref; map it to an
// installed source id so a card tap can open details on the right source.

let _sourcesCache = null;

async function installedSources() {
  if (_sourcesCache) return _sourcesCache;
  try {
    const res = await api.listSources();
    _sourcesCache = Array.isArray(res) ? res : (res && res.sources) || [];
  } catch {
    return [];
  }
  return _sourcesCache;
}

function refName(manga) {
  const s = manga && manga.source;
  if (!s) return '';
  if (typeof s === 'string') return s;
  return s.name || s.id || '';
}

function resolveSid(manga) {
  return sourceId(manga?.source);
}

// ---- sort ----------------------------------------------------------------

const SORTS = LIBRARY_SORTS;

function sortEntries(entries, sort) {
  if (sort !== 'title') return entries; // 'recent' = the store's natural order
  return entries
    .slice()
    .sort((a, b) =>
      String((a && a.title) || '').localeCompare(String((b && b.title) || ''), undefined, {
        sensitivity: 'base',
      }));
}

// ---- render --------------------------------------------------------------

export function render(view, params) {
  view.replaceChildren();

  const state = {
    categories: [],
    activeCategoryId: null, // null = "All"
    sources: [],
    sort: 'recent',
    tools: { query: '', source: '', reading: 'all' },
    tab: (params && params.tab === 'downloads') ? 'downloads' : 'favourites',
    dlLoaded: false,
  };

  // --- header: title + subtle count -------------------------------------
  const countEl = el('span', { class: 'library-result-count', 'aria-live': 'polite',
    style: { color: 'var(--text-faint)', fontSize: '13px', fontWeight: '600', whiteSpace: 'nowrap' },
  });
  const header = el('div', { class: 'section-header library-header', style: { marginTop: '0', marginBottom: '16px' } },
    el('h1', { class: 'page-title', style: { margin: '0' } }, 'Library'),
    el('div', { class: 'section-actions' }, countEl),
  );

  // --- subsection toggle: Favourites | Downloads ------------------------
  const tabSeg = segmented(
    [{ label: 'Favourites', value: 'favourites' }, { label: 'Downloads', value: 'downloads' }],
    state.tab,
    (v) => selectTab(v),
  );
  const tabRow = el('div', { class: 'row library-tab-row', style: { marginBottom: '18px' } }, tabSeg);

  // --- Favourites subsection --------------------------------------------
  const sortSeg = el('select', { class: 'input library-sort-select', 'aria-label': 'Sort library',
    onChange: event => { state.sort = event.target.value; renderGrid(); } },
    ...SORTS.map(item => el('option', { value: item.value }, item.label)));
  const sortRow = el('div', { class: 'row library-sort-row', style: { marginBottom: '14px' } }, sortSeg);

  const chipsEl = el('div', { class: 'chips library-filter-row', style: { marginBottom: '20px' } });
  const gridHost = el('div');

  const librarySearch = el('input', { class: 'input', type: 'search', placeholder: 'Search your library', 'aria-label': 'Search your library',
    onInput: event => { state.tools.query = event.target.value; renderGrid(); } });
  const sourceFilter = el('select', { class: 'input', 'aria-label': 'Filter library by source',
    onChange: event => { state.tools.source = event.target.value; renderGrid(); } });
  const readingFilter = el('select', { class: 'input', 'aria-label': 'Filter library by reading history', 'aria-describedby': 'library-history-filter-note',
    onChange: event => { state.tools.reading = event.target.value; renderGrid(); } },
    el('option', { value: 'all' }, 'All reading states'),
    el('option', { value: 'with-history' }, 'With recent history'),
    el('option', { value: 'no-history' }, 'No recent history'));
  const quickControls = [['downloaded','Downloaded'],['completed','Completed'],['newChapters','New chapters']].map(([key,label]) => {
    const input = el('input',{type:'checkbox',onChange:event=>{state.tools[key]=event.target.checked;renderGrid();}});
    return {key,input,node:el('label',{class:'library-quick-filter'},input,el('span',null,label))};
  });
  const clearFilters = btn('Clear filters', { variant: 'ghost', onClick: resetFilters });
  const historyNote = el('p', { id: 'library-history-filter-note', class: 'hint library-history-note' },
    'Uses saved recent history. Clearing history or reading privately affects this view.');
  const toolField = (label, control) => el('label', { class: 'library-tools-field' }, el('span', null, label), control);
  const filterSummary = el('summary', { class: 'library-filter-toggle' }, 'Filters');
  const filterDisclosure = el('details', { class: 'library-filter-disclosure' }, filterSummary,
    el('div', { class: 'library-filter-panel' }, toolField('Source', sourceFilter),
      toolField('Reading history', readingFilter), ...quickControls.map(c=>c.node), historyNote, clearFilters));
  const toolsRow = el('div', { class: 'library-tools', role: 'group', 'aria-label': 'Library filters' },
    librarySearch, filterDisclosure, sortRow);
  const subnav = el('nav', { class: 'library-subnav', 'aria-label': 'Library views' },
    ...[['history', 'History'], ['bookmarks', 'Bookmarks'], ['stats', 'Stats']].map(([route, label]) =>
      btn(label, { variant: 'ghost', onClick: () => router.navigate(route) })));
  header.appendChild(subnav);
  const resume = createLibraryResume({ services: browserLibrary, el, btn, icon, router });
  const favSection = el('div', { class: 'library-favourites' },
    ...(resume ? [resume] : []), chipsEl, toolsRow, gridHost);
  filterDisclosure.addEventListener?.('keydown', event => {
    if (event.key === 'Escape') { filterDisclosure.open = false; filterSummary.focus(); }
  });

  function updateSourceFilter() {
    const entries = library.favourites().entries || [];
    sourceFilter.replaceChildren(el('option', { value: '' }, 'All sources'),
      ...librarySourceOptions(entries, state.sources).map(option => el('option', { value: option.value }, option.label)));
    sourceFilter.value = state.tools.source;
  }
  function resetFilters() {
    state.tools = resetLibraryFilters(state.tools);
    librarySearch.value = ''; sourceFilter.value = ''; readingFilter.value = 'all';
    quickControls.forEach(c=>{c.input.checked=false;});
    renderGrid();
  }
  function renderNoMatches() {
    const empty = emptyState('No titles match these filters.', 'search');
    empty.appendChild(btn('Reset filters', { variant: 'ghost', onClick: resetFilters }));
    return empty;
  }

  // --- Downloads subsection (lazy: mounted on first visit) --------------
  const dlSection = el('div', { class: 'library-downloads' });

  view.append(header, tabRow, favSection, dlSection);

  // ---- subsection switching ------------------------------------------

  function selectTab(tab) {
    if (state.tab === tab) return;
    state.tab = tab;
    applyTab();
  }

  function applyTab() {
    const onFav = state.tab === 'favourites';
    tabRow.hidden = onFav;
    favSection.style.display = onFav ? '' : 'none';
    dlSection.style.display = onFav ? 'none' : '';
    countEl.style.display = onFav ? '' : 'none';
    if (!onFav && !state.dlLoaded) {
      state.dlLoaded = true;
      // downloads.render() owns the host it is given; bridge its teardown up
      // to the library view so app.js drops the subscription on navigate-away.
      downloadsRender(dlSection);
      view.__downloadsTeardown = dlSection.__downloadsTeardown;
    }
  }

  // ---- data helpers --------------------------------------------------

  function favEntries() {
    return state.activeCategoryId == null
      ? (library.favourites().entries || [])
      : (library.categoryManga(state.activeCategoryId).entries || []);
  }

  function updateCount() {
    let n = 0;
    try { n = (library.favourites().entries || []).length; } catch { n = 0; }
    countEl.textContent = n === 1 ? '1 title' : `${n} titles`;
  }

  // ---- grid rendering ------------------------------------------------

  // How many favourite tiles are built per pass, and the observer driving the
  // rest. Both live in the render closure so they die with the screen.
  const GRID_CHUNK = 24;
  let gridObserver = null;
  function stopGridGrowth() {
    if (gridObserver) { gridObserver.disconnect(); gridObserver = null; }
  }

  function renderSkeleton() {
    const grid = el('div', { class: 'grid' });
    for (let i = 0; i < 12; i++) grid.appendChild(skeletonCard());
    gridHost.replaceChildren(grid);
  }

  function renderGrid() {
    stopGridGrowth();   // any previous grid's sentinel is about to be discarded
    let entries, unfiltered;
    try {
      unfiltered = favEntries();
      const snapshot = browserLibrary?.snapshot() || {};
      const known = new Map((snapshot.favourites || []).map(m=>[String(m.id),m]));
      entries = selectLibraryEntries(unfiltered.map(m=>({...m,libraryAddedAt:known.get(String(m.id))?.libraryAddedAt || 0})),
        { ...state.tools, sort: state.sort }, library.history().entries || [],
        {...snapshot,downloads:downloads?.list() || []});
      const filtered = hasLibraryFilters(state.tools);
      const totalTitles = (library.favourites().entries || []).length;
      toolsRow.hidden = !totalTitles;
      chipsEl.hidden = !totalTitles && !state.categories.length;
      const filterCount = Number(!!state.tools.source) + Number(state.tools.reading !== 'all') + quickControls.filter(c=>state.tools[c.key]).length;
      filterSummary.textContent = filterCount ? 'Filters (' + filterCount + ')' : 'Filters';
      clearFilters.hidden = !filtered;
      historyNote.hidden = state.tools.reading === 'all' && !['read','read-oldest'].includes(state.sort);
      countEl.textContent = filtered ? entries.length + ' of ' + unfiltered.length + ' titles' : (entries.length === 1 ? '1 title' : entries.length + ' titles');
    } catch (e) {
      gridHost.replaceChildren(errorBox(e.message));
      return;
    }

    if (!entries.length) {
      gridHost.replaceChildren(unfiltered.length && hasLibraryFilters(state.tools) ? renderNoMatches() : renderEmpty());
      return;
    }

    const grid = el('div', { class: 'grid' });
    const openManga = (manga) => {
      const sid = resolveSid(manga, state.sources);
      if (!sid) { toast('Source not installed'); return; }
      router.navigate('details', { sid, url: manga.url });
    };

    // A favourites list has no upper bound — a heavy library is hundreds of
    // titles, and every card is an <md-elevated-card>, so building them all is
    // one long task plus that many cover requests for the dozen tiles on
    // screen. Render a screenful and grow as the user scrolls to the end.
    let built = 0;
    const growGrid = () => {
      const end = Math.min(entries.length, built + GRID_CHUNK);
      const frag = document.createDocumentFragment();
      for (; built < end; built++) frag.appendChild(card(entries[built], openManga));
      grid.appendChild(frag);
      return built >= entries.length;
    };

    const done = growGrid();
    gridHost.replaceChildren(grid);

    if (!done) {
      // A sentinel after the grid, kept as the last child so one observer
      // serves every chunk. rootMargin buys a chunk before the user arrives.
      const sentinel = el('div', { class: 'grid-sentinel', 'aria-hidden': 'true' });
      gridHost.appendChild(sentinel);
      gridObserver = new IntersectionObserver((es) => {
        if (!es.some((e) => e.isIntersecting)) return;
        if (growGrid()) { stopGridGrowth(); return; }
        // The sentinel sits after the grid, so it just moved down — but if it
        // is still inside the margin nothing has *changed* and no further
        // callback would come. Re-observing forces a fresh reading, so a tall
        // viewport keeps filling until the sentinel is genuinely out of reach.
        gridObserver.unobserve(sentinel);
        gridObserver.observe(sentinel);
      }, { rootMargin: '700px 0px' });
      gridObserver.observe(sentinel);
    }

    // The source `details` endpoint often returns no cover, so favourites can be
    // stored cover-less (blank tile). Resolve the cover from the source's search
    // (which DOES include covers), persist it, and repaint — once, in background.
    const missing = entries.filter((m) => !m.coverUrl && !m.largeCoverUrl);
    if (missing.length && !renderGrid._backfilling) {
      renderGrid._backfilling = true;
      backfillCovers(missing).then((changed) => {
        renderGrid._backfilling = false;
        if (changed && gridHost.isConnected) renderGrid();
      }).catch(() => { renderGrid._backfilling = false; });
    }
  }

  // Resolve missing favourite covers via the source search (matched by URL, then
  // by exact title) and persist them. Best-effort + capped so it never hammers.
  async function backfillCovers(entries) {
    let changed = false;
    const norm = (t) => (t || '').trim().toLowerCase();
    // Ensure the installed-source list is loaded, or resolveSid() can't map a
    // favourite to its source id and the popular/latest fetch is skipped.
    if (!state.sources || !state.sources.length) {
      try { state.sources = (await installedSources()) || []; } catch { /* ignore */ }
    }
    // Group the cover-less favourites by source; resolve the free cache first.
    const bySid = new Map();
    for (const m of entries) {
      const needCover = !m.coverUrl && !m.largeCoverUrl;
      const needTitle = !m.title || m.title === 'Untitled';
      if (!needCover && !needTitle) continue;
      // 1) Free: the persisted grid cache (cover + title, populated by browsing).
      const c = store.cachedManga(m.url) || {};
      const gotCover = c.coverUrl || c.largeCoverUrl;
      const gotTitle = c.title;
      if ((gotCover || gotTitle) && library.setFavouriteCover(m, gotCover, (gotTitle || '').trim())) changed = true;
      // 2) Still missing → fetch from the source's popular/latest below.
      if ((needCover && !gotCover) || (needTitle && !gotTitle)) {
        const sid = resolveSid(m, state.sources);
        if (!sid) continue;
        if (!bySid.has(sid)) bySid.set(sid, []);
        bySid.get(sid).push(m);
      }
    }
    // For each source: scan popular + latest (page 1) into url/title → cover maps,
    // then targeted search for anything still missing. Covers live in these lists
    // even though the `details` endpoint omits them.
    for (const [sid, list] of bySid) {
      const byUrl = new Map(); const byTitle = new Map();
      const collect = (res) => {
        for (const e of ((res && res.entries) || [])) {
          if (e.url && !byUrl.has(e.url)) byUrl.set(e.url, e);
          if (e.title && !byTitle.has(norm(e.title))) byTitle.set(norm(e.title), e);
        }
      };
      try { collect(await api.popular(sid, 1)); } catch { /* skip */ }
      try { collect(await api.latest(sid, 1)); } catch { /* skip */ }
      for (const m of list) {
        let hit = byUrl.get(m.url) || (m.title && byTitle.get(norm(m.title)));
        if (!hit && m.title) {
          try { collect(await api.search(sid, m.title, 1)); hit = byUrl.get(m.url) || byTitle.get(norm(m.title)); }
          catch { /* skip */ }
        }
        if (hit) {
          const cover = hit.coverUrl || hit.largeCoverUrl;
          if (library.setFavouriteCover(m, cover, (hit.title || '').trim())) changed = true;
        }
      }
    }
    return changed;
  }

  function renderEmpty() {
    // Distinguish a no-match search / empty category from a truly empty library.
    if (state.activeCategoryId != null) {
      const cat = state.categories.find((c) => c.id === state.activeCategoryId);
      const wrap = emptyState(
        `“${(cat && cat.title) || 'This collection'}” is empty.`,
        'folder',
      );
      wrap.appendChild(
        btn('All favourites', {
          variant: 'ghost',
          onClick: () => { selectCategory(null); },
        }),
      );
      return wrap;
    }
    const wrap = el('section', { class: 'library-welcome', 'aria-label': 'Empty library' },
      el('div', { class: 'library-welcome-mark', 'aria-hidden': 'true' }, icon('library')),
      el('h2', null, 'Your library starts here'),
      el('p', null, 'Save a title from a source, or bring your own comics. Your next chapter will be waiting here.'),
      el('div', { class: 'library-welcome-actions' },
        btn('Browse sources', { variant: 'accent', icon: 'compass', onClick: () => router.navigate('explore') }),
        btn('Import comics', { variant: 'ghost', icon: 'folder', onClick: () => importLibraryComics({ files: browserFiles, router, toast }) })));
    return wrap;
  }

  // ---- category chips ------------------------------------------------

  function selectCategory(id) {
    if (state.activeCategoryId === id) return;
    state.activeCategoryId = id;
    renderChips();
    renderGrid();
  }

  function renderChips() {
    chipsEl.replaceChildren();

    // "All" — a regular pill, active when no category is selected.
    chipsEl.appendChild(
      chip('All', {
        active: state.activeCategoryId == null,
        onClick: () => selectCategory(null),
      }),
    );

    // One pill per category. Long-press (or right-click) opens manage.
    for (const cat of state.categories) {
      const count = cat.mangaCount ?? 0;
      const label = count > 0 ? `${cat.title} · ${count}` : cat.title;
      const pill = chip(label, {
        active: state.activeCategoryId === cat.id,
        onClick: () => selectCategory(cat.id),
      });
      attachContextMenu(pill, () => [
        { label: 'Rename', icon: 'settings', onClick: () => renameCategory(cat) },
        { label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteCategory(cat) },
      ]);
      chipsEl.appendChild(pill);
    }

    // "+ New" — create a category.
    chipsEl.appendChild(
      chip('+ New', { onClick: () => createCategory() }),
    );

    // A small, unobtrusive "Manage" affordance when there is something to manage.
    if (state.categories.length) {
      const manage = chip('Manage', { onClick: () => openManagePicker() });
      chipsEl.appendChild(manage);
    }
  }

  // ---- category management -------------------------------------------

  function reloadCategories() {
    try {
      state.categories = (library.categories().categories) || [];
    } catch {
      state.categories = [];
    }
    if (
      state.activeCategoryId != null &&
      !state.categories.some((c) => c.id === state.activeCategoryId)
    ) {
      state.activeCategoryId = null;
    }
    updateCount();
    renderChips();
    renderGrid();
  }

  function createCategory() {
    promptDialog('New collection', '').then((title) => {
      const t = (title || '').trim();
      if (!t) return;
      try { library.createCategory(t); toast('Collection created'); reloadCategories(); }
      catch (e) { toast('Failed: ' + e.message); }
    });
  }

  function renameCategory(cat) {
    promptDialog('Rename collection', cat.title).then((title) => {
      const t = (title || '').trim();
      if (!t || t === cat.title) return;
      try { library.renameCategory(cat.id, t); toast('Renamed'); reloadCategories(); }
      catch (e) { toast('Failed: ' + e.message); }
    });
  }

  function deleteCategory(cat) {
    confirmDialog(`Delete the collection “${cat.title}”? Favourites in it are kept.`).then((ok) => {
      if (!ok) return;
      try { library.deleteCategory(cat.id); toast('Deleted'); reloadCategories(); }
      catch (e) { toast('Failed: ' + e.message); }
    });
  }

  // Per-category sheet: rename or delete.
  function openManageSheet(cat) {
    let close = () => {};
    const body = el('div', { class: 'row', style: { gap: '10px' } },
      btn('Rename', {
        variant: 'ghost', icon: 'settings',
        onClick: () => { close(); renameCategory(cat); },
      }),
      btn('Delete', {
        class: 'btn-danger', icon: 'trash',
        onClick: () => { close(); deleteCategory(cat); },
      }),
    );
    close = modal({ title: cat.title, body });
  }

  // Picker invoked from the "Manage" chip: choose which collection to manage.
  function openManagePicker() {
    if (!state.categories.length) return;
    let close = () => {};
    const list = el('div', { class: 'list' });
    for (const cat of state.categories) {
      const row = el('div', {
        class: 'row-item', role: 'button', tabindex: '0',
        style: { cursor: 'pointer' },
        onClick: () => { close(); openManageSheet(cat); },
        onKeyDown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); close(); openManageSheet(cat); }
        },
      },
        icon('folder'),
        el('div', { class: 'row-main' },
          el('div', { class: 'name' }, cat.title),
          el('div', { class: 'sub' },
            `${cat.mangaCount ?? 0} ${(cat.mangaCount ?? 0) === 1 ? 'title' : 'titles'}`),
        ),
        el('span', { class: 'row-actions' }, icon('chevron')),
      );
      list.appendChild(row);
    }
    close = modal({ title: 'Manage collections', body: list });
  }

  // ---- boot ----------------------------------------------------------

  updateSourceFilter();

  renderSkeleton();

  try {
    state.categories = (library.categories().categories) || [];
  } catch {
    state.categories = [];
  }
  updateCount();
  renderChips();
  renderGrid();
  applyTab();
  const offLibrary = library.onChange(()=>{if(favSection.isConnected){updateSourceFilter();renderGrid();}});
  const nativeDownloads = downloads;
  const offDownloads = nativeDownloads?.subscribe(()=>{if(favSection.isConnected)renderGrid();});

  const observer = new MutationObserver(()=>{if(!favSection.isConnected){offLibrary?.();offDownloads?.();observer.disconnect();}});
  observer.observe(view,{childList:true});

  // Loading the catalogue also upgrades any saved legacy source references.
  installedSources().then((sources) => { if (!favSection.isConnected) return; state.sources = sources || []; updateSourceFilter(); });
}

export default { meta, render };
