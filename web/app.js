// Nyora Web — app shell bootstrap + router dispatch.
//
// router.start() only fires the onChange listener with the parsed route; it does
// NOT render anything itself. This module owns the render dispatch: it maps a
// route name to a screen's render() and mounts it into #view.

import { store, router } from './core/store.js';
import { el, icon, $, toast, btn, errorBox } from './core/ui.js';
import library from './core/library.js';
import { revealView } from './core/motion.js';

import { meta as discoverMeta, render as discoverRender } from './screens/discover.js';
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
import { meta as browserMeta, render as browserRender } from './screens/browser.js';
import { shouldShowWelcome, showWelcome } from './screens/welcome.js';
import { shouldShowChangelog, showChangelog, markChangelogSeen } from './core/changelog.js';
import { runMigrations } from './core/migrations.js';

const routes = {
  discover: discoverRender,
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
  browser: browserRender,
};

const metas = {
  discover: discoverMeta,
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
    // Single Discover: AniList-primary feed with a MangaBaka fallback (see discover.js).
    // The old second "Discover" (suggestions.js, MangaBaka grid) was removed from the nav
    // to avoid two Discover entries; it stays as the "Show all" drill-down only.
    { key: 'discover', label: 'Discover', icon: 'home' },
    { key: 'explore', label: 'Explore', icon: 'compass' },
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

// Per-route scroll memory: returning to a list (e.g. back from a manga) restores
// where you were instead of jumping to the top. Reserved cover aspect-ratios make
// the list height stable before images load, so the restore lands accurately.
const scrollPos = new Map();
let prevScrollKey = null;

function dispatch(route) {
  const name = routes[route.name] ? route.name : 'explore';
  const fn = routes[name];
  // Save the outgoing screen's scroll before its content is replaced.
  if (prevScrollKey !== null) scrollPos.set(prevScrollKey, view.scrollTop);
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
  } catch {
    view.replaceChildren(errorBox('Something went wrong loading this screen. Please try again.'));
  }
  // Restore this screen's remembered scroll position (0 = fresh navigation).
  const scrollKey = name + '?' + JSON.stringify(route.params || {});
  const savedY = scrollPos.get(scrollKey) || 0;
  requestAnimationFrame(() => { try { view.scrollTop = savedY; } catch { /* ignore */ } });
  prevScrollKey = scrollKey;
  syncNav(name);
  syncTabbar(name);
}

function syncNav(name) {
  const items = document.querySelectorAll('#sidebar [data-route]');
  for (const item of items) {
    const on = item.getAttribute('data-route') === name;
    item.classList.toggle('active', on);
    if (on) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
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
      title: item.label, // rail mode hides labels — the tooltip still names it
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
      onClick: () => router.navigate('discover'),
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

// Mobile bottom tab bar (app-like), styled as a floating rounded pill to match
// the android app. Four primary destinations — Discover / Library / Explore /
// History — with a detached circular "continue reading" reader FAB to the
// right. The rest of the destinations live in the drawer. Shown only at the
// phone breakpoint (CSS-gated).
const TABBAR_KEYS = ['discover', 'library', 'explore', 'history'];
// Bottom-nav glyphs mirroring the nyora-android design (chart / bars / compass /
// clock), independent of the sidebar icons.
const TABBAR_ICONS = { discover: 'trending', library: 'bars', explore: 'compass', history: 'history' };
function buildTabbar() {
  const bar = $('#tabbar');
  if (!bar) return;
  const pill = el('div', { class: 'tabbar-pill' },
    ...TABBAR_KEYS.filter((k) => metas[k]).map((key) =>
      el('a', { 'data-tab': key, href: `#/${key}`, onClick: () => { document.body.classList.remove('nav-open'); } },
        icon(TABBAR_ICONS[key] || metas[key].icon),
        el('span', null, metas[key].title),
      ),
    ),
  );
  const fab = el('button', {
    id: 'readerFab',
    class: 'tabbar-fab',
    type: 'button',
    'aria-label': 'Continue reading',
    title: 'Continue reading',
    onClick: () => { document.body.classList.remove('nav-open'); continueReading(); },
  }, icon('read'));
  bar.replaceChildren(pill, fab);
}
function syncTabbar(name) {
  for (const a of document.querySelectorAll('#tabbar [data-tab]')) {
    const on = a.getAttribute('data-tab') === name;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

// PWA: register the service worker (no-op in dev/insecure contexts).
// updateViaCache:'none' forces the browser to revalidate sw.js on every check,
// and an auto-reload on controllerchange means new deploys take effect on the
// next load instead of getting stuck behind a stale cached build.
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  // Local development uses the service worker too: sw.js serves same-origin
  // code network-first on localhost (edits are never stale) while still
  // injecting the COOP/COEP headers the translator needs for wasm threads.
  // Do NOT tear it down / clear caches here — the old localhost teardown wiped
  // 'nyora-tl-models' on every reload, re-downloading ~125 MB of AI models.
  // If this page is already controlled by a SW, a controllerchange means a NEW
  // worker took over (an update) — reload once so the fresh app/assets are used.
  const wasControlled = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (wasControlled && !reloaded) { reloaded = true; location.reload(); }
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      .then((reg) => { try { reg.update(); } catch { /* ignore */ } })
      .catch(() => { /* ignore */ });
  });
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

// ── PWA install prompt ───────────────────────────────────────────────────────
// Chrome/Edge/Android fire `beforeinstallprompt` when the app is installable.
// Stash it and offer a dismissible banner; the native chooser opens on tap. Once
// installed (or dismissed) we never nag again.
function setupInstallPrompt() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) return;
  let deferred = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    if (localStorage.getItem('nyora.install.dismissed') === '1') return;
    showBanner();
  });
  window.addEventListener('appinstalled', () => {
    localStorage.setItem('nyora.install.dismissed', '1');
    const b = $('.install-banner'); if (b) b.remove();
  });

  function showBanner() {
    if ($('.install-banner')) return;
    const banner = el('div', { class: 'install-banner' },
      el('img', { src: '/icon.png', class: 'install-banner-icon', alt: '' }),
      el('div', { class: 'install-banner-text' },
        el('strong', {}, 'Install Nyora'),
        el('span', {}, 'Add it to your home screen — full-screen and offline-ready.'),
      ),
      el('div', { class: 'install-banner-actions' },
        btn('Later', { variant: 'ghost', onClick: dismiss }),
        btn('Install', { variant: 'accent', onClick: doInstall }),
      ),
    );
    document.body.appendChild(banner);
    requestAnimationFrame(() => banner.classList.add('show'));
  }
  async function doInstall() {
    const b = $('.install-banner'); if (b) b.remove();
    if (!deferred) return;
    deferred.prompt();
    try { await deferred.userChoice; } catch { /* ignore */ }
    deferred = null;
  }
  function dismiss() {
    localStorage.setItem('nyora.install.dismissed', '1');
    const b = $('.install-banner');
    if (b) { b.classList.remove('show'); setTimeout(() => b.remove(), 250); }
  }
}

// ── pull-to-refresh (mobile) ─────────────────────────────────────────────────
// Drag down from the very top of #view to re-render the current screen. Skipped
// in the reader/details (own scroll chrome) and whenever #view isn't at the top.
function setupPullToRefresh() {
  const scroller = view; // #view is the scrolling <main>
  const THRESH = 72, MAX = 120;
  let startY = 0, pulling = false, dist = 0, indicator = null;

  const eligible = () => {
    const name = document.body.dataset.route;
    return name !== 'reader' && name !== 'details' && scroller.scrollTop <= 0;
  };
  const ensureIndicator = () => {
    if (!indicator) { indicator = el('div', { class: 'ptr-indicator' }, icon('refresh')); document.body.appendChild(indicator); }
    return indicator;
  };
  const hide = () => { if (indicator) { indicator.style.transform = ''; indicator.style.opacity = '0'; indicator.classList.remove('ready'); } };

  scroller.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || !eligible()) { pulling = false; return; }
    startY = e.touches[0].clientY; pulling = true; dist = 0;
  }, { passive: true });
  scroller.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    dist = e.touches[0].clientY - startY;
    if (dist <= 0) { pulling = false; hide(); return; }
    const pull = Math.min(dist, MAX);
    const ind = ensureIndicator();
    ind.style.transform = `translateX(-50%) translateY(${Math.min(pull, THRESH + 8)}px) rotate(${pull * 2.4}deg)`;
    ind.style.opacity = String(Math.min(1, pull / THRESH));
    ind.classList.toggle('ready', pull >= THRESH);
  }, { passive: true });
  scroller.addEventListener('touchend', () => {
    if (!pulling) return;
    pulling = false;
    if (dist >= THRESH) { const r = router.current(); if (r && r.name) { dispatch(r); toast('Refreshed'); } }
    hide();
  }, { passive: true });
}

store.applyTheme();
buildSidebar();
buildMobileNav();
buildTabbar();
wireTopbar();
setupInstallPrompt();
setupPullToRefresh();
registerSW();
router.onChange(dispatch);

// First-run welcome / start screen (sign in with Google, continue as guest,
// restore from backup). Show it BEFORE any main content renders so the app shell
// never flashes behind it; only start routing — which renders the first screen
// into #view — once the user proceeds.
if (shouldShowWelcome()) {
  // Genuine first run — the welcome screen is the introduction, so record the
  // version rather than stacking a "what's new" dialog on top of it.
  markChangelogSeen();
  showWelcome(() => router.start(routes, 'discover'));
} else {
  router.start(routes, 'discover');
  // Existing installs have no stored version, so this fires once for people
  // already using the app. Wait for the splash to clear so it doesn't animate
  // in behind it.
  if (shouldShowChangelog()) setTimeout(() => showChangelog(), 900);
}

// Fade out the boot splash once the shell + first screen have painted, so the
// user never sees the empty black shell while modules were loading.
function hideSplash() {
  const s = document.getElementById('splash');
  if (!s) return;
  s.classList.add('splash-hide');
  const done = () => { if (s.parentNode) s.remove(); };
  s.addEventListener('transitionend', done, { once: true });
  setTimeout(done, 800);
}
requestAnimationFrame(() => requestAnimationFrame(hideSplash));

// One-time local data repairs. Deliberately after first paint and idle-deferred
// so they never delay the UI; they re-render the current screen only if they
// actually changed something.
function startMigrations() {
  runMigrations().catch(() => { /* best-effort by design */ });
}
window.addEventListener('nyora:migrated', () => {
  // Repaired rows are already on screen — refresh so they pick up the metadata.
  try { router.reload ? router.reload() : dispatch(); } catch { /* ignore */ }
});
if (typeof requestIdleCallback === 'function') requestIdleCallback(startMigrations, { timeout: 8000 });
else setTimeout(startMigrations, 4000);

// Splash failsafes: #splash is a fixed full-screen overlay, so any boot throw or
// failed module load that skips the rAF above would leave it covering the app
// forever. These belts-and-braces removals guarantee it always clears — the
// normal successful boot still fades it after first paint (the rAF above wins).
window.addEventListener('load', hideSplash);
setTimeout(hideSplash, 5000);
// A boot error reveals the shell instead of a permanent splash. once:true so
// these never interfere after the app is up and running.
window.addEventListener('error', hideSplash, { once: true });
window.addEventListener('unhandledrejection', hideSplash, { once: true });
