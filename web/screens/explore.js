// screens/explore.js — android-style Explore.
//
// Landing (default): a universal search field, a 2x2 quick-actions card
// (Local storage / Bookmarks / Random / Downloads), then a "Manga sources"
// grid of installed-source tiles with a "Catalog" action (Manage extensions).
// This mirrors the nyora-android Explore screen.
//
// Tapping a source tile switches the screen into BROWSE mode — the classic
// per-source Popular/Latest/Search grid — with a Back affordance returning to
// the landing. On mobile the browse-header source pill opens a bottom SHEET
// (modal()) with the full source list so the reader can switch sources.
//
// The browse body is a strict state machine (loading / error / empty / grid)
// guarded by an async token, so a stale response can never paint and the area
// is NEVER left blank (the old "black void" bug).

import { api } from '../core/api.js';
import {
  el, $, proxyImage, toast, spinner, skeletonCard, icon, btn, iconBtn, chip,
  sectionHeader, emptyState, errorBox, card, modal, segmented, langLabel,
} from '../core/ui.js';
import { store, router } from '../core/store.js';

export const meta = { title: 'Explore', nav: true, icon: 'compass', order: 0 };

const LAST_SOURCE_KEY = 'nyora.explore.lastSource';
const MOBILE_MQ = '(max-width: 760px)';

function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, String(value)); } catch { /* ignore */ }
}
function isMobile() {
  try { return window.matchMedia(MOBILE_MQ).matches; } catch { return false; }
}
function langCode(src) {
  return (src && src.lang ? String(src.lang) : '').toUpperCase();
}
function medallion(src, cls) {
  return el('div', { class: cls }, langCode(src).slice(0, 2) || '??');
}

export function render(view, _params) {
  const prefs = store.get();
  view.replaceChildren();

  const state = {
    screen: 'landing', // 'landing' | 'browse'
    sources: [],
    sourcesLoading: true,
    sourcesError: null,
    filter: '',
    showNsfw: !!prefs.showNsfw,
    mode: 'POPULAR',
    query: '',
    entries: [],
    page: 1,
    hasNext: false,
    browseLoading: false,
    browseError: null,
    browseToken: 0,
  };

  // Single root; the screen swaps landing <-> browse in place.
  const root = el('div', { class: 'explore-screen' });
  view.appendChild(root);

  // browsePane is (re)created whenever we enter browse mode.
  let browsePane = null;

  // A live registry of mounted source-list containers (any open mobile sheet).
  // One renderSourceLists() refresh repaints them all.
  const sourceListMounts = new Set();
  let closeSourceSheet = null; // close() of an open mobile source sheet, if any.

  // ---- helpers ------------------------------------------------------------

  function installedVisible() {
    return state.sources.filter((s) => s.isInstalled && (state.showNsfw || !s.isNsfw));
  }

  function filteredSources() {
    let list = installedVisible();
    const q = state.filter.trim().toLowerCase();
    if (q) {
      list = list.filter((s) =>
        (s.name || '').toLowerCase().includes(q) || (s.lang || '').toLowerCase().includes(q));
    }
    return list;
  }

  // ---- screen swap --------------------------------------------------------

  function renderScreen() {
    if (state.screen === 'browse' && store.source) renderBrowseView();
    else renderLanding();
  }

  // ======================= LANDING ========================================

  function renderLanding() {
    state.screen = 'landing';
    root.replaceChildren();

    const home = el('div', { class: 'explore-home' });
    root.appendChild(home);

    home.appendChild(landingSearch());
    home.appendChild(quickActions());
    home.appendChild(sourcesSection());
  }

  function landingSearch() {
    const input = el('input', {
      type: 'search', class: 'discover-search-input',
      placeholder: 'Search all sources', autocomplete: 'off', enterkeyhint: 'search',
      'aria-label': 'Search all sources',
    });
    return el('form', {
      class: 'discover-search', role: 'search',
      onSubmit: (e) => {
        e.preventDefault();
        const q = input.value.trim();
        router.navigate('search', q ? { q } : {});
      },
    }, icon('search'), input);
  }

  function quickAction(label, iconName, onClick) {
    return el('button', {
      class: 'quick-action', type: 'button', onClick,
    },
      el('span', { class: 'qa-icon' }, icon(iconName)),
      el('span', { class: 'qa-label' }, label),
    );
  }

  function quickActions() {
    return el('div', { class: 'quick-actions' },
      quickAction('Local storage', 'folder', () => router.navigate('local')),
      quickAction('Bookmarks', 'bookmark', () => router.navigate('bookmarks')),
      quickAction('Random', 'refresh', () => openRandom()),
      quickAction('Downloads', 'download', () => router.navigate('downloads')),
    );
  }

  function sourcesSection() {
    const wrap = el('div', { class: 'explore-sources' });
    wrap.appendChild(sectionHeader('Manga sources',
      btn('Catalog', { variant: 'ghost', icon: 'download', onClick: openExtensions })));

    const body = el('div', { class: 'explore-sources-body' });
    wrap.appendChild(body);

    if (state.sourcesLoading) {
      body.appendChild(el('div', { class: 'center', style: { padding: '32px 0' } }, spinner()));
      return wrap;
    }
    if (state.sourcesError) {
      body.appendChild(errorBox(state.sourcesError));
      body.appendChild(el('div', { class: 'center', style: { padding: '8px 0 0' } },
        btn('Retry', { variant: 'ghost', icon: 'refresh', onClick: () => loadSources() })));
      return wrap;
    }

    const installed = installedVisible();
    if (!installed.length) {
      body.appendChild(emptyState('No sources installed yet.', 'compass'));
      body.appendChild(el('div', { class: 'center', style: { padding: '4px 0 0' } },
        btn('Open catalog', { variant: 'accent', icon: 'download', onClick: openExtensions })));
      return wrap;
    }

    const byName = (a, b) => (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
    const ordered = installed.slice().sort((a, b) => {
      const p = (b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0);
      return p !== 0 ? p : byName(a, b);
    });

    const grid = el('div', { class: 'source-grid' });
    for (const s of ordered) grid.appendChild(sourceTile(s));
    body.appendChild(grid);
    return wrap;
  }

  function sourceTile(src) {
    return el('button', {
      class: 'source-tile', type: 'button',
      title: src.name || 'Source',
      onClick: () => selectSource(src),
    },
      medallion(src, 'source-tile-badge' + (src.isPinned ? ' pinned' : '')),
      el('span', { class: 'source-tile-name' }, src.name || 'Source'),
      el('span', { class: 'source-tile-sub' }, langLabel(src)),
    );
  }

  // ---- Random -------------------------------------------------------------
  // Pick a random installed source and open a random popular title from it.

  async function openRandom() {
    const installed = installedVisible();
    if (!installed.length) {
      toast('Install a source first — open the catalog.');
      return;
    }
    const src = installed[Math.floor(Math.random() * installed.length)];
    toast('Finding something to read…');
    try {
      const page = 1 + Math.floor(Math.random() * 3);
      let res = await api.popular(src.id, page);
      let entries = (res && res.entries) || [];
      if (!entries.length && page !== 1) {
        res = await api.popular(src.id, 1);
        entries = (res && res.entries) || [];
      }
      if (!entries.length) { toast('Nothing found — try again.'); return; }
      const m = entries[Math.floor(Math.random() * entries.length)];
      router.navigate('details', { sid: src.id, url: m.url });
    } catch (e) {
      toast(friendlyBrowseError(e && e.message));
    }
  }

  // ======================= SOURCE LIST (mobile sheet) =====================

  function sourceRow(src, onSelect) {
    const active = store.source && store.source.id === src.id;
    const pinned = !!src.isPinned;
    const pinBtn = iconBtn('pin', (e) => { e.stopPropagation(); togglePin(src); }, pinned ? 'Unpin' : 'Pin');
    pinBtn.classList.toggle('active', pinned);
    return el('div', {
      class: 'source-row' + (active ? ' active' : ''),
      role: 'button', tabindex: '0',
      onClick: () => onSelect(src),
      onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(src); } },
    },
      medallion(src, 'thumb'),
      el('div', { class: 'row-main' },
        el('div', { class: 'name' }, src.name || 'Source'),
        el('div', { class: 'sub' }, `${langLabel(src)}`),
      ),
      el('div', { class: 'row-actions' }, pinBtn),
    );
  }

  // Fill a container with the full source-list surface: a filter field, the
  // "Manage extensions" row, then Pinned / Installed groups (or a state).
  function fillSourceList(container, onSelect) {
    container.replaceChildren();

    const filterInput = el('input', {
      class: 'src-search field', type: 'search', placeholder: 'Filter sources', value: state.filter,
      onInput: (e) => { state.filter = e.target.value; renderSourceLists(); },
    });
    container.appendChild(filterInput);

    const manageRow = el('div', {
      class: 'source-row manage-row', role: 'button', tabindex: '0',
      onClick: openExtensions,
      onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openExtensions(); } },
    },
      el('div', { class: 'thumb manage-thumb' }, icon('download')),
      el('div', { class: 'row-main' },
        el('div', { class: 'name' }, 'Manage extensions'),
        el('div', { class: 'sub' }, 'Install or remove sources'),
      ),
      el('div', { class: 'row-actions' }, icon('chevron')),
    );
    container.appendChild(manageRow);

    const body = el('div', { class: 'source-list-body' });
    container.appendChild(body);

    if (state.sourcesLoading) {
      body.appendChild(el('div', { class: 'center', style: { padding: '32px 0' } }, spinner()));
      return;
    }
    if (state.sourcesError) {
      body.appendChild(errorBox(state.sourcesError));
      body.appendChild(el('div', { class: 'center', style: { padding: '8px 0 0' } },
        btn('Retry', { variant: 'ghost', icon: 'refresh', onClick: () => loadSources() })));
      return;
    }

    const matched = filteredSources();
    if (!matched.length) {
      const msg = installedVisible().length
        ? 'No sources match that filter.'
        : 'No sources installed — open Manage extensions.';
      body.appendChild(emptyState(msg, 'compass'));
      return;
    }

    const byName = (a, b) => (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
    const pinned = matched.filter((s) => s.isPinned).sort(byName);
    const rest = matched.filter((s) => !s.isPinned).sort(byName);

    if (pinned.length) {
      body.appendChild(el('div', { class: 'lang' }, 'Pinned'));
      pinned.forEach((s) => body.appendChild(sourceRow(s, onSelect)));
    }
    if (rest.length) {
      body.appendChild(el('div', { class: 'lang' }, 'Installed'));
      rest.forEach((s) => body.appendChild(sourceRow(s, onSelect)));
    }
  }

  // Repaint every mounted source list (open sheet).
  function renderSourceLists() {
    for (const m of sourceListMounts) fillSourceList(m.container, m.onSelect);
  }

  function openSourceSheet() {
    const container = el('div', { class: 'source-list source-sheet-list' });
    const mount = {
      container,
      onSelect: (s) => { selectSource(s); if (closeSourceSheet) closeSourceSheet(); },
    };
    sourceListMounts.add(mount);
    fillSourceList(container, mount.onSelect);
    const close = modal({ title: 'Choose source', body: container });
    closeSourceSheet = () => { close(); };
    // When the sheet's backdrop is removed, stop refreshing its (dead) list.
    const rootEl = $('#modalRoot');
    if (rootEl) {
      const observer = new MutationObserver(() => {
        if (!container.isConnected) {
          observer.disconnect();
          sourceListMounts.delete(mount);
          if (closeSourceSheet) closeSourceSheet = null;
        }
      });
      observer.observe(rootEl, { childList: true, subtree: true });
    }
  }

  // ---- extensions sheet ---------------------------------------------------

  function openExtensions() {
    const listWrap = el('div', { class: 'list ext-list' });
    const searchInput = el('input', {
      class: 'field ext-search', type: 'search', placeholder: 'Search extensions…',
    });
    modal({ title: 'Catalog', body: el('div', { class: 'ext-sheet' }, searchInput, listWrap) });

    let entries = [];
    let extToken = 0;

    async function load() {
      const token = ++extToken;
      listWrap.replaceChildren(el('div', { class: 'center' }, spinner()));
      try {
        const res = await api.catalog();
        if (token !== extToken) return;
        entries = (res && res.entries) || [];
        renderExt();
      } catch (e) {
        if (token === extToken) {
          listWrap.replaceChildren(
            errorBox(e.message),
            el('div', { class: 'center', style: { padding: '8px 0 0' } },
              btn('Retry', { variant: 'ghost', icon: 'refresh', onClick: load })),
          );
        }
      }
    }

    function renderExt() {
      listWrap.replaceChildren();
      const q = searchInput.value.trim().toLowerCase();
      const filtered = entries.filter((e) =>
        (state.showNsfw || !e.isNsfw) &&
        ((e.name || '').toLowerCase().includes(q) || (e.lang || '').toLowerCase().includes(q)));
      if (!filtered.length) {
        listWrap.appendChild(emptyState(
          entries.length ? 'No extensions match that search.' : 'No extensions available.', 'download'));
        return;
      }
      for (const e of filtered) {
        listWrap.appendChild(extRow(e));
      }
    }

    function extRow(e) {
      const installBtn = btn(e.isInstalled ? 'Remove' : 'Install', {
        variant: e.isInstalled ? 'ghost' : 'accent',
        class: 'btn-sm',
        icon: e.isInstalled ? 'uninstall' : 'install',
        onClick: async () => {
          installBtn.disabled = true;
          try {
            if (e.isInstalled) await api.uninstallSource(e.id);
            else await api.installSource(e.id);
            e.isInstalled = !e.isInstalled;
            renderExt();
            await loadSources({ keepBrowse: true });
          } catch (err) {
            installBtn.disabled = false;
            toast(err.message);
          }
        },
      });
      return el('div', { class: 'row-item ext-row' + (e.isBroken ? ' broken' : '') },
        el('div', { class: 'row-main' },
          el('div', { class: 'name' }, e.name || 'Extension'),
          el('div', { class: 'sub' }, e.isBroken ? 'Currently unavailable' : langLabel(e)),
        ),
        el('div', { class: 'row-actions' },
          chip((e.lang || '').toUpperCase() || '??'),
          installBtn,
        ),
      );
    }

    searchInput.addEventListener('input', renderExt);
    load();
  }

  // ---- pin / select -------------------------------------------------------

  async function togglePin(src) {
    const next = !src.isPinned;
    src.isPinned = next;
    renderSourceLists();
    try {
      await api.pinSource(src.id, next);
      await loadSources({ keepBrowse: true });
    } catch (e) {
      src.isPinned = !next;
      renderSourceLists();
      toast(`Error: ${e.message}`);
    }
  }

  function selectSource(src) {
    const already = store.source && store.source.id === src.id;
    store.source = src;
    lsSet(LAST_SOURCE_KEY, src.id);
    if (!already) {
      state.mode = 'POPULAR';
      state.query = '';
      state.entries = [];
    }
    state.screen = 'browse';
    renderScreen();
    if (!already || !state.entries.length) loadBrowse(1);
  }

  // ======================= BROWSE =========================================

  function renderBrowseView() {
    state.screen = 'browse';
    root.replaceChildren();
    browsePane = el('div', { class: 'browse-pane explore-browse' });
    root.appendChild(browsePane);
    renderBrowse();
  }

  function backToLanding() {
    state.screen = 'landing';
    renderLanding();
  }

  function renderBrowse() {
    if (!browsePane) return;
    browsePane.replaceChildren();
    browsePane.appendChild(browseHeader());

    if (state.mode === 'SEARCH') {
      const input = el('input', {
        class: 'field browse-search', type: 'search', placeholder: 'Search this source…', value: state.query,
        onKeydown: (e) => {
          if (e.key === 'Enter') { state.query = e.target.value.trim(); state.entries = []; loadBrowse(1); renderBrowse(); }
        },
      });
      browsePane.appendChild(el('div', { class: 'browse-searchbar' }, input,
        iconBtn('search', () => { state.query = input.value.trim(); state.entries = []; loadBrowse(1); renderBrowse(); }, 'Search')));
    }

    const body = el('div', { class: 'browse-body' });
    browsePane.appendChild(body);
    renderBrowseBody(body);
  }

  function browseHeader() {
    const src = store.source;
    const pillKids = src
      ? [
          medallion(src, 'medallion'),
          el('div', { class: 'source-select-main' },
            el('div', { class: 'name' }, src.name || 'Source'),
            el('div', { class: 'sub' }, `${langLabel(src)}`)),
          icon('chevron'),
        ]
      : [
          el('div', { class: 'medallion' }, '??'),
          el('div', { class: 'source-select-main' },
            el('div', { class: 'name' }, 'Choose a source'),
            el('div', { class: 'sub' }, 'Tap to pick')),
          icon('chevron'),
        ];

    const pill = el('button', {
      class: 'source-select', type: 'button',
      title: src ? `Source: ${src.name}` : 'Choose a source',
      onClick: () => openSourceSheet(),
    }, ...pillKids);

    return el('div', { class: 'browse-head' },
      iconBtn('back', backToLanding, 'Back to Explore'),
      pill,
      el('div', { class: 'browse-head-actions' },
        segmented(
          [{ label: 'Popular', value: 'POPULAR' }, { label: 'Latest', value: 'LATEST' }, { label: 'Search', value: 'SEARCH' }],
          state.mode,
          (m) => { if (m === state.mode) return; state.mode = m; state.entries = []; state.browseError = null; loadBrowse(1); renderBrowse(); },
        ),
        iconBtn('refresh', () => loadBrowse(1, true), 'Refresh'),
      ),
    );
  }

  function renderBrowseBody(body) {
    body.replaceChildren();

    // Search mode with no query yet -> a gentle prompt, not a void.
    if (state.mode === 'SEARCH' && !state.query && !state.browseLoading && !state.entries.length && !state.browseError) {
      body.appendChild(emptyState('Type above and press Enter to search.', 'search'));
      return;
    }

    // loading & no entries -> skeleton grid.
    if (state.browseLoading && !state.entries.length) {
      const grid = el('div', { class: 'grid' });
      for (let i = 0; i < 12; i++) grid.appendChild(skeletonCard());
      body.appendChild(grid);
      return;
    }

    // error & no entries -> errorBox + Retry.
    if (state.browseError && !state.entries.length) {
      body.appendChild(errorBox(state.browseError));
      body.appendChild(el('div', { class: 'center', style: { padding: '8px 0 0' } },
        btn('Retry', { variant: 'ghost', icon: 'refresh', onClick: () => loadBrowse(1, true) })));
      return;
    }

    // loaded, no error, 0 entries -> empty + Retry.
    if (!state.browseLoading && !state.entries.length) {
      body.appendChild(emptyState('No titles here — try Latest or another source.'));
      body.appendChild(el('div', { class: 'center', style: { padding: '8px 0 0' } },
        btn('Retry', { variant: 'ghost', icon: 'refresh', onClick: () => loadBrowse(1, true) })));
      return;
    }

    // entries -> grid (+ Load more).
    const grid = el('div', { class: 'grid' });
    state.entries.forEach((m) =>
      grid.appendChild(card(m, (manga) => router.navigate('details', { sid: store.source.id, url: manga.url }))));
    body.appendChild(grid);

    if (state.hasNext) {
      const more = btn(state.browseLoading ? 'Loading…' : 'Load more', {
        variant: 'ghost', class: 'load-more',
        disabled: state.browseLoading,
        onClick: () => loadBrowse(state.page + 1),
      });
      body.appendChild(el('div', { class: 'center' }, more));
    } else if (state.browseLoading) {
      body.appendChild(el('div', { class: 'center' }, spinner()));
    }
  }

  // ---- data ---------------------------------------------------------------

  async function loadSources(opts = {}) {
    if (!opts.keepBrowse) { state.sourcesLoading = true; state.sourcesError = null; }
    try {
      const res = await api.listSources();
      state.sources = (res && res.sources) || [];
      state.sourcesLoading = false;
      state.sourcesError = null;
      renderSourceLists();
      if (state.screen === 'landing') renderLanding();
    } catch (e) {
      state.sourcesLoading = false;
      state.sourcesError = e.message;
      renderSourceLists();
      if (state.screen === 'landing') renderLanding();
    }
  }

  async function loadBrowse(page, force = false) {
    const src = store.source;
    if (!src) return;
    if (state.mode === 'SEARCH' && !state.query) { renderBrowse(); return; }
    const token = ++state.browseToken;
    state.page = page;
    state.browseLoading = true;
    state.browseError = null;
    if (page === 1 && !force) state.entries = [];
    renderBrowse();
    try {
      let res;
      if (state.mode === 'LATEST') res = await api.latest(src.id, page);
      else if (state.mode === 'SEARCH') res = await api.search(src.id, state.query, page);
      else res = await api.popular(src.id, page);
      if (token !== state.browseToken) return;
      const got = (res && res.entries) || [];
      state.entries = page === 1 ? got : state.entries.concat(got);
      state.hasNext = !!(res && res.hasNextPage);
      state.browseLoading = false;
      renderBrowse();
    } catch (e) {
      if (token !== state.browseToken) return;
      state.browseLoading = false;
      state.browseError = friendlyBrowseError(e && e.message);
      renderBrowse();
    }
  }

  // Map raw helper/upstream errors (e.g. ". Status=403, URL=[https://…]") to a
  // clean, jargon-free message — never leak source URLs, status codes, or ids.
  function friendlyBrowseError(msg) {
    const m = String(msg || '');
    if (/\b40[13]\b|cloudflare|just a moment|challenge|forbidden/i.test(m)) {
      return "This source is blocked and can't be reached right now. Try another source.";
    }
    if (/timeout|timed out|unavailable|reset|econn|network/i.test(m)) {
      return 'This source is currently unavailable. Please try again later.';
    }
    return "Couldn't load this source. Try another one.";
  }

  // ---- boot ---------------------------------------------------------------

  renderScreen();
  loadSources();

  // When a cloud sync brings in the user's installed/pinned sources (from
  // another device), refresh the source list/grid. #view is persistent and
  // there's no per-screen teardown hook, so swap a single module-level handler
  // each render instead of stacking listeners.
  if (_onSourcesSynced) window.removeEventListener('nyora:sources-synced', _onSourcesSynced);
  _onSourcesSynced = () => { if (view.isConnected) loadSources({ keepBrowse: true }); };
  window.addEventListener('nyora:sources-synced', _onSourcesSynced);
}

let _onSourcesSynced = null;

export default { meta, render };
