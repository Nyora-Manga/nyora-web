// Nyora Web — app shell bootstrap + router dispatch.
//
// router.start() only fires the onChange listener with the parsed route; it does
// NOT render anything itself. This module owns the render dispatch: it maps a
// route name to a screen's render() and mounts it into #view.

import { store, router } from './core/store.js';
import { el, icon, $, toast } from './core/ui.js';
import library from './core/library.js';
import { revealView } from './core/motion.js';

import { meta as exploreMeta, render as exploreRender } from './screens/explore.js';
import { meta as libraryMeta, render as libraryRender } from './screens/library.js';
import { meta as historyMeta, render as historyRender } from './screens/history.js';
import { meta as bookmarksMeta, render as bookmarksRender } from './screens/bookmarks.js';
import { meta as updatesMeta, render as updatesRender } from './screens/updates.js';
import { meta as localMeta, render as localRender } from './screens/local.js';
import { meta as suggestionsMeta, render as suggestionsRender } from './screens/suggestions.js';
import { meta as statsMeta, render as statsRender } from './screens/stats.js';
import { meta as downloadsMeta, render as downloadsRender } from './screens/downloads.js';
import { meta as settingsMeta, render as settingsRender } from './screens/settings.js';
import { meta as detailsMeta, render as detailsRender } from './screens/details.js';
import { meta as readerMeta, render as readerRender } from './screens/reader.js';
import { meta as searchMeta, render as searchRender } from './screens/search.js';
import { meta as trackerMeta, render as trackerRender } from './screens/tracker.js';
import { meta as browserMeta, render as browserRender } from './screens/browser.js';
import { shouldShowWelcome, showWelcome } from './screens/welcome.js';

const routes = {
  explore: exploreRender,
  library: libraryRender,
  history: historyRender,
  bookmarks: bookmarksRender,
  updates: updatesRender,
  local: localRender,
  suggestions: suggestionsRender,
  stats: statsRender,
  downloads: downloadsRender,
  settings: settingsRender,
  details: detailsRender,
  reader: readerRender,
  search: searchRender,
  tracker: trackerRender,
  browser: browserRender,
};

const metas = {
  explore: exploreMeta,
  library: libraryMeta,
  history: historyMeta,
  bookmarks: bookmarksMeta,
  updates: updatesMeta,
  local: localMeta,
  suggestions: suggestionsMeta,
  stats: statsMeta,
  downloads: downloadsMeta,
  settings: settingsMeta,
  details: detailsMeta,
  reader: readerMeta,
  search: searchMeta,
  tracker: trackerMeta,
  browser: browserMeta,
};

// Grouped sidebar nav (desktop wireframe): four labelled sections. Each item
// maps to a route; label/icon here drive the sidebar. `continue:true` (Reader)
// resumes the most recent history entry instead of routing to a screen.
const NAV_GROUPS = [
  { label: 'Library', items: [
    { key: 'history', label: 'History', icon: 'history' },
    { key: 'library', label: 'Favourites', icon: 'heart' },
    { key: 'local', label: 'Local', icon: 'folder' },
    { key: 'bookmarks', label: 'Bookmarks', icon: 'bookmark' },
    { key: 'downloads', label: 'Downloads', icon: 'download' },
  ] },
  { label: 'Discover', items: [
    { key: 'explore', label: 'Explore', icon: 'compass' },
    { key: 'suggestions', label: 'Discover', icon: 'trending' },
    { key: 'updates', label: 'Updates', icon: 'bell' },
    { key: 'browser', label: 'Browser', icon: 'globe' },
  ] },
  { label: 'Reading', items: [
    { key: 'reader', label: 'Reader', icon: 'book', continue: true },
    { key: 'stats', label: 'Stats', icon: 'stats' },
    { key: 'search', label: 'Search', icon: 'search' },
  ] },
  { label: 'App', items: [
    { key: 'settings', label: 'Settings', icon: 'settings' },
  ] },
];

// Reader nav entry resumes the most recent history item.
function continueReading() {
  const h = (library.history(1).entries || [])[0];
  if (!h || !h.manga) { toast('No reading history yet — open a chapter first.'); return; }
  const src = h.manga.source;
  const sid = h.sourceId || (src && (src.name || src.id)) || '';
  router.navigate('reader', { sid, url: h.manga.url, chapterUrl: h.chapterUrl || h.chapterId });
}

const BASE_TITLE = 'Nyora — Free Online Manga Reader in Your Browser';
const view = $('#view');

function dispatch(route) {
  const name = routes[route.name] ? route.name : 'explore';
  const fn = routes[name];
  document.body.dataset.route = name;
  document.title = name === 'explore' ? BASE_TITLE : ((metas[name] && metas[name].title) ? metas[name].title + ' · Nyora' : BASE_TITLE);

  // Leaving the reader for any other screen: run its teardown so the immersive
  // body classes (reader-active / reader-immersive) and its key/scroll listeners
  // are cleared. Without this they persist and the topbar stays hidden until a
  // refresh. Reader -> reader (chapter change) is left to reader.render itself.
  if (name !== 'reader') {
    document.body.classList.remove('reader-active', 'reader-immersive');
    if (view.__readerTeardown) {
      try { view.__readerTeardown(); } catch { /* ignore */ }
      view.__readerTeardown = null;
    }
  }

  // Leaving the downloads screen: drop its manager subscription and revoke any
  // offline-reader object URLs, so neither leaks when the user navigates away
  // (the in-screen self-clean only fires on a manager event, which may never
  // come for an idle queue).
  if (name !== 'downloads' && view.__downloadsTeardown) {
    try { view.__downloadsTeardown(); } catch { /* ignore */ }
    view.__downloadsTeardown = null;
  }

  // The search bar AND the whole topbar are hidden on the manga detail page and
  // the reader (both have their own chrome/back button); shown everywhere else.
  // Toggled every navigation, so they always self-correct.
  const immersive = name === 'details' || name === 'reader';
  document.body.classList.toggle('hide-search', immersive);
  document.body.classList.toggle('hide-topbar', immersive);
  document.body.classList.toggle('screen-reader', name === 'reader');

  const label = $('#sourceLabel');
  if (label) label.textContent = (store.source && store.source.name) || 'Sources';
  try {
    fn(view, route.params || {});
    revealView(view, name);
  } catch (e) {
    view.replaceChildren(el('div', { class: 'error-box' }, String((e && e.message) || e)));
  }
  syncNav(name);
  syncTabbar(name);
}

function syncNav(name) {
  const items = document.querySelectorAll('#sidebar [data-route]');
  for (const item of items) {
    item.classList.toggle('active', item.getAttribute('data-route') === name);
  }
}

function buildSidebar() {
  const sidebar = $('#sidebar');
  if (!sidebar) return;

  const brand = el('div', { class: 'brand', onClick: () => router.navigate('explore') },
    el('img', { src: '/icon.png', class: 'logo-img' }),
    el('span', { style: { marginLeft: '12px' } }, 'NYORA'),
  );

  const navItem = (item) => el(
    'div',
    {
      class: 'nav-item',
      'data-route': item.key,
      role: 'button',
      tabindex: '0',
      onClick: () => {
        document.body.classList.remove('nav-open');
        if (item.continue) continueReading();
        else router.navigate(item.key);
      },
      onKeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.continue ? continueReading() : router.navigate(item.key); }
      },
    },
    icon(item.icon),
    el('span', null, item.label),
  );

  const children = [brand];
  for (const group of NAV_GROUPS) {
    children.push(el('div', { class: 'nav-label' }, group.label));
    for (const item of group.items) {
      if (!routes[item.key]) continue; // skip if the route isn't registered
      children.push(navItem(item));
    }
  }
  sidebar.replaceChildren(...children);
}

function buildMobileNav() {
  const topbar = $('#topbar');
  if (topbar && !$('#navToggle')) {
    const toggle = el('button', { id: 'navToggle', class: 'nav-toggle', 'aria-label': 'Menu', onClick: () => document.body.classList.toggle('nav-open') },
      icon('menu'),
      el('span', { class: 'nav-toggle-label' }, 'Menu'),
    );
    topbar.insertBefore(toggle, topbar.firstChild);
  }
  if (topbar && !$('#mobileBrand')) {
    const brand = el('button', {
      id: 'mobileBrand',
      class: 'mobile-brand',
      type: 'button',
      'aria-label': 'Go to Discover',
      onClick: () => router.navigate('suggestions'),
    },
      el('img', { src: '/icon.png', alt: '', class: 'mobile-brand-logo' }),
      el('span', { class: 'mobile-brand-text' }, 'NYORA'),
    );
    const toggle = $('#navToggle');
    topbar.insertBefore(brand, toggle ? toggle.nextSibling : topbar.firstChild);
  }
  if (topbar && !$('#mobileSearch')) {
    const search = el('button', {
      id: 'mobileSearch',
      class: 'mobile-search-action',
      type: 'button',
      'aria-label': 'Search',
      onClick: () => openMobileSearch(),
    }, icon('search'));
    const toggle = $('#navToggle');
    topbar.insertBefore(search, toggle || null);
  }
  buildMobileSearchPanel();
  if (!$('#navScrim')) {
    document.body.appendChild(el('div', { id: 'navScrim', class: 'nav-scrim', onClick: () => document.body.classList.remove('nav-open') }));
  }
}

function closeMobileSearch() {
  document.body.classList.remove('search-open');
}

function openMobileSearch() {
  const panel = $('#mobileSearchPanel');
  const input = $('#mobileSearchInput');
  if (!panel || !input) {
    router.navigate('search');
    return;
  }
  const current = router.current();
  input.value = current.name === 'search' && current.params && current.params.q ? current.params.q : '';
  document.body.classList.remove('nav-open');
  document.body.classList.add('search-open');
  requestAnimationFrame(() => {
    input.focus({ preventScroll: true });
    try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* ignore */ }
  });
}

function buildMobileSearchPanel() {
  if ($('#mobileSearchPanel')) return;
  const input = el('input', {
    id: 'mobileSearchInput',
    type: 'search',
    placeholder: 'Search all sources',
    autocomplete: 'off',
    enterkeyhint: 'search',
    'aria-label': 'Search all sources',
  });
  const submit = el('button', {
    class: 'mobile-search-submit',
    type: 'submit',
    'aria-label': 'Search',
  }, icon('chevron'));
  const close = el('button', {
    class: 'mobile-search-close',
    type: 'button',
    'aria-label': 'Close search',
    onClick: () => closeMobileSearch(),
  }, icon('close'));
  const form = el('form', {
    id: 'mobileSearchPanel',
    class: 'mobile-search-panel',
    role: 'search',
    onSubmit: (e) => {
      e.preventDefault();
      const q = input.value.trim();
      closeMobileSearch();
      if (q) router.navigate('search', { q });
      else router.navigate('search');
    },
  },
    el('div', { class: 'mobile-search-field' },
      icon('search'),
      input,
      submit,
    ),
    close,
  );
  const scrim = el('div', { id: 'mobileSearchScrim', class: 'mobile-search-scrim', onClick: () => closeMobileSearch() });
  document.body.append(scrim, form);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMobileSearch();
  });
}

// Mobile bottom tab bar (app-like). Mirrors the 5 primary destinations; the
// rest live in the drawer. Shown only at the phone breakpoint (CSS-gated).
const TABBAR_KEYS = ['suggestions', 'explore', 'library', 'updates', 'settings'];
function buildTabbar() {
  const bar = $('#tabbar');
  if (!bar) return;
  bar.replaceChildren(
    ...TABBAR_KEYS.filter((k) => metas[k]).map((key) =>
      el('a', { 'data-tab': key, href: `#/${key}`, onClick: () => { document.body.classList.remove('nav-open'); } },
        icon(metas[key].icon),
        el('span', null, metas[key].title),
      ),
    ),
  );
}
function syncTabbar(name) {
  for (const a of document.querySelectorAll('#tabbar [data-tab]')) {
    a.classList.toggle('active', a.getAttribute('data-tab') === name);
  }
}

// PWA: register the service worker (no-op in dev/insecure contexts).
function registerSW() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => { /* ignore */ });
    });
  }
}

function wireTopbar() {
  const form = $('#searchForm');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = $('#searchInput').value.trim();
      if (q) router.navigate('search', { q });
    });
  }
  const sourceBtn = $('#sourceBtn');
  if (sourceBtn) {
    sourceBtn.addEventListener('click', () => router.navigate('explore'));
  }
}

store.applyTheme();
buildSidebar();
buildMobileNav();
buildTabbar();
wireTopbar();
registerSW();
router.onChange(dispatch);

// First-run welcome / start screen (sign in with Google, continue as guest,
// restore from backup). Show it BEFORE any main content renders so the app shell
// never flashes behind it; only start routing — which renders the first screen
// into #view — once the user proceeds.
if (shouldShowWelcome()) {
  showWelcome(() => router.start(routes, 'suggestions'));
} else {
  router.start(routes, 'suggestions');
}
