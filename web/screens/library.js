// screens/library.js — Library: Favourites + Downloads.
//
// Android-style Library: a two-way subsection toggle at the top switches
// between Favourites (favourite categories, filterable/sortable grid) and
// Downloads (the offline download queue). History and Stats remain their own
// sidebar destinations. All state lives in the browser (see core/library.js).

import {
  el, card, toast, skeletonCard, icon, btn, chip, emptyState,
  errorBox, promptDialog, confirmDialog, modal, segmented,
} from '../core/ui.js';
import library from '../core/library.js';
import { api } from '../core/api.js';
import { router } from '../core/store.js';
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
    _sourcesCache = [];
  }
  return _sourcesCache;
}

function refName(manga) {
  const s = manga && manga.source;
  if (!s) return '';
  if (typeof s === 'string') return s;
  return s.name || s.id || '';
}

function resolveSid(manga, sources) {
  const name = refName(manga);
  if (!name) return '';
  const normalized = name.startsWith('JS_') ? name.slice(3) : name;
  const match = (sources || []).find(
    (src) =>
      src && src.isInstalled !== false &&
      (src.id === name ||
        src.id === `parser:${normalized}` ||
        (src.id && src.id.endsWith(':' + normalized)) ||
        src.name === name),
  );
  return match ? match.id : name;
}

// ---- sort ----------------------------------------------------------------

const SORTS = [
  { label: 'Recent', value: 'recent' },
  { label: 'Title', value: 'title' },
];

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
    tab: (params && params.tab === 'downloads') ? 'downloads' : 'favourites',
    dlLoaded: false,
  };

  // --- header: title + subtle count -------------------------------------
  const countEl = el('span', {
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
  const sortSeg = segmented(SORTS, state.sort, (v) => {
    state.sort = v;
    renderGrid();
  });
  const sortRow = el('div', { class: 'row library-sort-row', style: { marginBottom: '14px' } }, sortSeg);

  const chipsEl = el('div', { class: 'chips library-filter-row', style: { marginBottom: '20px' } });
  const gridHost = el('div');

  const favSection = el('div', { class: 'library-favourites' }, sortRow, chipsEl, gridHost);

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

  function renderSkeleton() {
    const grid = el('div', { class: 'grid' });
    for (let i = 0; i < 12; i++) grid.appendChild(skeletonCard());
    gridHost.replaceChildren(grid);
  }

  function renderGrid() {
    let entries;
    try {
      entries = sortEntries(favEntries(), state.sort);
    } catch (e) {
      gridHost.replaceChildren(errorBox(e.message));
      return;
    }

    if (!entries.length) {
      gridHost.replaceChildren(renderEmpty());
      return;
    }

    const grid = el('div', { class: 'grid' });
    for (const manga of entries) {
      grid.appendChild(
        card(manga, () => {
          const sid = resolveSid(manga, state.sources);
          if (!sid) { toast('Source not installed'); return; }
          router.navigate('details', { sid, url: manga.url });
        }),
      );
    }
    gridHost.replaceChildren(grid);
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
    const wrap = emptyState("It's kind of empty here…", 'inbox');
    wrap.appendChild(
      btn('Explore', { variant: 'accent', icon: 'compass', onClick: () => router.navigate('explore') }),
    );
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
      attachManageGesture(pill, cat);
      chipsEl.appendChild(pill);
    }

    // "+ New" — create a category.
    chipsEl.appendChild(
      chip('+ New', { onClick: () => createCategory() }),
    );

    // A small, unobtrusive "Manage" affordance when there is something to manage.
    if (state.categories.length) {
      const manage = chip('Manage', { onClick: () => openManagePicker() });
      manage.title = 'Rename or delete a collection';
      chipsEl.appendChild(manage);
    }
  }

  // Long-press (touch) and context-menu (mouse) on a category chip jumps
  // straight to its manage sheet — a quiet power-user affordance.
  function attachManageGesture(pill, cat) {
    let timer = null;
    const start = () => {
      timer = setTimeout(() => { timer = null; openManageSheet(cat); }, 500);
    };
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    pill.addEventListener('touchstart', start, { passive: true });
    pill.addEventListener('touchend', cancel);
    pill.addEventListener('touchmove', cancel);
    pill.addEventListener('contextmenu', (e) => { e.preventDefault(); openManageSheet(cat); });
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

  // Resolve sources in the background; a card tap before this lands still
  // falls back to the raw source ref name.
  installedSources().then((sources) => { state.sources = sources || []; });
}

export default { meta, render };
