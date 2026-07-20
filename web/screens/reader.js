// screens/reader.js — the chapter reader (full redesign, mac/linux parity).
//
// Renders a chapter's pages in one of three modes and matches the desktop
// readers' behaviour:
//
//   WEBTOON    vertical continuous scroll (default)
//   PAGED      one page at a time, click zones LEFT=prev / RIGHT=next
//   PAGED_RTL  one page at a time, click zones flipped (right-to-left manga)
//
// Reading prefs cascade: the global default lives in store.get().reader
// ({mode, fit, prefetch}); per-manga overrides (mode, fit, prefetch + the
// colour grade) live in library.mangaPrefs(mangaId) and are written back via
// library.saveMangaPrefs so each title keeps its own reading setup.
//
// Chrome:
//   .reader-bar.top    — back, manga + chapter title, [settings, bookmark,
//                        chapter-list] actions.
//   .reader-bar.bottom — prev/next CHAPTER, page counter, a page slider (paged).
//   .reader-progress   — fixed top bar reflecting position in the chapter.
//
// Navigation: click zones (RTL-aware) + keyboard (ArrowLeft/Right, ArrowUp/Down,
// space; n/p = next/prev chapter; f = fit; Home/End = first/last page; Escape =
// back). Prefetch warms the next chapter's pages when near the end.
//
// Auto-scroll (hands-free): toggled from the top-bar play/pause button, or a =
// toggle (space also toggles it in WEBTOON); +/- adjusts speed. WEBTOON drives a
// smooth time-based scroll (px/sec by level); PAGED auto-advances one page every
// N seconds. It rolls across chapter boundaries so a whole binge plays through.
// Speed level (1–10) persists per-manga and has a slider in Settings.
//
// Persistence: library.recordHistory({manga, sourceId, chapterUrl, chapterId,
// chapterTitle, page, total}) fires (debounced) as the reader advances and is
// marked finished (page = last) at the end. Per-page bookmarks via
// library.addBookmark / checkBookmark / removeBookmark.
//
// Colour correction (brightness/contrast/saturation/invert + palette presets)
// is a CSS `filter` applied to every .reader-page, edited live in the settings
// modal and stored in the per-manga prefs.

import { api } from '../core/api.js';
import {
  el, $, $$, proxyImage, applyImage, toast, spinner, icon, btn, iconBtn,
  emptyState, errorBox, modal, segmented, fmt, menuSelect, m3Range,
  promptDialog, chip,
} from '../core/ui.js';
import { store, router } from '../core/store.js';
import library from '../core/library.js';
import tracking from '../core/tracking.js';
import { translatePage, onTranslatorStatus } from '../core/translate/engine.js';
import { attachOverlay } from '../core/translate/overlay.js';
import { TL_LANGS, TL_SOURCES } from '../core/translate/mt.js';
import { colorizePage, onColorizeStatus, clearColorizeCache, colorizeModelReady } from '../core/colorize/engine.js';

export const meta = { title: 'Reader', nav: false, icon: 'library', order: 99 };

// Turn an internal error into something a reader should see — never the raw
// "Unsupported source: ASURASCANS_US" / MangaSourceRef developer jargon.
function readerError(e, fallback) {
  const m = (e && e.message) ? e.message : String(e || '');
  if (/unsupported source|mangasourceref|parser:|\bjs_/i.test(m)) {
    return "This source isn't available right now — open it from Explore to read.";
  }
  return fallback + (m ? ': ' + m : '');
}

// ---------------------------------------------------------------------------
// Colour grade — CSS-filter equivalent of the desktop reader's ColorFilter.
// ---------------------------------------------------------------------------

const PALETTES = [
  '', 'Grayscale', 'HighContrast', 'Soft', 'Sepia', 'Noir',
  'Cool', 'Warm', 'DuotoneRed', 'DuotoneBlue',
];

const PALETTE_LABEL = (p) => (p ? p.replace(/([a-z])([A-Z])/g, '$1 $2') : 'None');

function paletteFilter(palette) {
  switch (palette) {
    case 'Grayscale': return 'grayscale(1)';
    case 'HighContrast': return 'contrast(1.55)';
    case 'Soft': return 'contrast(0.82) sepia(0.1)';
    case 'Sepia': return 'sepia(1)';
    case 'Noir': return 'grayscale(1) contrast(1.45)';
    case 'Cool': return 'hue-rotate(-12deg) saturate(1.1) brightness(1.02)';
    case 'Warm': return 'sepia(0.25) saturate(1.15) brightness(1.03)';
    case 'DuotoneRed': return 'grayscale(1) sepia(1) saturate(4) hue-rotate(-20deg)';
    case 'DuotoneBlue': return 'grayscale(1) sepia(1) saturate(5) hue-rotate(180deg)';
    default: return '';
  }
}

function defaultGrade() {
  return { brightness: 0, contrast: 1, saturation: 1, invert: 0, palette: '' };
}

function isNeutralGrade(g) {
  return g.brightness === 0 && g.contrast === 1 && g.saturation === 1 &&
    !g.invert && !g.palette;
}

function buildFilter(g) {
  if (isNeutralGrade(g)) return '';
  const parts = [];
  if (g.brightness !== 0) parts.push(`brightness(${(1 + g.brightness).toFixed(3)})`);
  if (g.contrast !== 1) parts.push(`contrast(${g.contrast.toFixed(3)})`);
  if (g.saturation !== 1) parts.push(`saturate(${g.saturation.toFixed(3)})`);
  if (g.invert) parts.push(`invert(${g.invert.toFixed(3)})`);
  const pal = paletteFilter(g.palette);
  if (pal) parts.push(pal);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

export function render(view, params) {
  const sid = params && params.sid;
  const mangaUrl = params && params.url;
  const startChapterUrl = params && params.chapterUrl;
  // Resume coordinate: History / Bookmarks pass the last-read page. Applied once,
  // to the chapter the reader opens on (chapter turns always start at page 0).
  const startPage = Math.max(0, parseInt(params && params.page, 10) || 0);

  if (view.__readerTeardown) {
    try { view.__readerTeardown(); } catch { /* ignore */ }
    view.__readerTeardown = null;
  }

  // Hide app-level UI
  document.body.classList.add('reader-active');
  // Distraction-free: restore the persisted "hide sidebar" preference.
  document.body.classList.toggle('reader-immersive', !!(store.get().reader || {}).immersive);

  view.replaceChildren(el('div', { class: 'reader-loading-screen' }, loadingBlock('Loading chapter…')));

  if (!sid || !mangaUrl || !startChapterUrl) {
    view.replaceChildren(errorBox('Reader needs a source, manga and chapter.'));
    return;
  }

  // ── live state ───────────────────────────────────────────────────────────
  const st = {
    sid,
    mangaUrl,
    chapterUrl: startChapterUrl,
    manga: null,
    chapters: [],
    index: -1,
    pages: [],
    currentPage: 0,
    bookmarked: false,
    grade: defaultGrade(),
    destroyed: false,
    controlsVisible: true,
  };

  const gp = store.get().reader || {};
  let mode = gp.mode || 'WEBTOON';
  let fit = gp.fit || 'WIDTH';
  let prefetch = gp.prefetch !== false;
  // Webtoon column width as a PERCENTAGE of the reader area (30–100). Values
  // > 100 are legacy pixel widths (e.g. 880/1200) — migrate them to the default.
  const clampWidth = (v) => { v = Number(v); return (!v || v > 100) ? 70 : Math.max(30, Math.min(100, Math.round(v))); };
  let webtoonWidth = clampWidth(gp.webtoonWidth);
  // In-image AI translation + colorization are gated behind the Experimental
  // master switch (Settings → Experimental). When it's off the reader shows no
  // translate/colorize toggles and never auto-applies them, even if the per-manga
  // prefs are on — the overlays/colorized pages simply don't appear.
  const experimental = store.get().experimental === true;
  let translate = experimental && gp.translate === true;
  let translateTo = gp.translateTo || 'en';
  let translateFrom = gp.translateFrom || 'auto'; // 'auto'|'ja'|'zh'|'ko'|'en'
  // Colorize additionally requires the ~62 MB model to ALREADY be downloaded in
  // Settings → Experimental → Colorization. Starting false and only opting in
  // once that's confirmed means it stays off by default even when a stale
  // `colorize: true` is left in prefs from an earlier session, and no page can
  // trigger a surprise 62 MB fetch just because Experimental got switched on.
  let colorize = false; // AI manga colorization
  let colorReady = false; // model present in the cache
  if (experimental) {
    colorizeModelReady().then((ready) => {
      if (st.destroyed) return;
      colorReady = ready;
      if (!ready) {
        // Model isn't there (cache cleared, or the pref predates the download
        // gate) — drop the stale pref so it stops re-arming on every open.
        if (gp.colorize === true) store.set({ reader: { colorize: false } });
        return;
      }
      if (gp.colorize === true) { colorize = true; syncChrome(); beginColorizeAll(); }
    }).catch(() => {});
  }
  // On phones the reader area is already narrow, so the full column width is the
  // sensible default — anything less just wastes screen. When still on the global
  // default (70%), snap webtoon to 100% on phone; an explicit per-manga width
  // (applied below) or a user-dragged value is still honoured.
  const isPhone = typeof window !== 'undefined' && !!window.matchMedia
    && window.matchMedia('(max-width: 760px)').matches;
  if (isPhone && webtoonWidth === 70) webtoonWidth = 100;

  // Auto-scroll: a hands-free reading mode. In WEBTOON it drives a smooth,
  // time-based vertical scroll (px/sec by level); in PAGED/PAGED_RTL it auto-
  // advances one page every N seconds. It rides over chapter boundaries so a
  // whole binge plays through. `autoLevel` (1–10) is the shared speed and is
  // persisted; `autoOn` is session intent (always starts off).
  const clampLevel = (v) => { v = Math.round(Number(v)); return Number.isFinite(v) ? Math.max(1, Math.min(10, v)) : 4; };
  let autoLevel = clampLevel(gp.autoScrollLevel);
  let autoOn = false;
  let autoRaf = null;
  let autoLastTs = 0;
  let autoAccum = 0;

  let scrollListener = null;
  let scrollTarget = null;
  let zoomReset = null;   // paged-mode zoom controller's reset(), set per render

  // ── teardown / keyboard ────────────────────────────────────────────────
  function onKey(e) {
    if (e.defaultPrevented) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if ($('#modalRoot .modal-backdrop')) return;
    const rtl = mode === 'PAGED_RTL';
    switch (e.key) {
      case 'ArrowRight': e.preventDefault(); pageStep(rtl ? -1 : 1); break;
      case 'ArrowLeft': e.preventDefault(); pageStep(rtl ? 1 : -1); break;
      case 'ArrowDown':
        if (mode === 'WEBTOON') return;
        e.preventDefault(); pageStep(1); break;
      case ' ':
        // Space toggles auto-scroll in WEBTOON (where it has no page meaning);
        // in PAGED it turns the page.
        e.preventDefault();
        if (mode === 'WEBTOON') toggleAuto(); else pageStep(1);
        break;
      case 'ArrowUp':
        if (mode === 'WEBTOON') return;
        e.preventDefault(); pageStep(-1); break;
      case 'n': case 'N': e.preventDefault(); goReadingChapter(1); break;   // next chapter
      case 'p': case 'P': e.preventDefault(); goReadingChapter(-1); break;  // previous chapter
      case 'f': case 'F': e.preventDefault(); toggleFit(); break;
      case 'a': case 'A': e.preventDefault(); toggleAuto(); break;          // auto-scroll
      case 't': case 'T': e.preventDefault(); if (translate) setTlVisible(!tlVisible); break; // peek original
      case '+': case '=': e.preventDefault(); bumpSpeed(1); break;          // faster
      case '-': case '_': e.preventDefault(); bumpSpeed(-1); break;         // slower
      case 'Home': e.preventDefault(); jumpTo(0); break;
      case 'End': e.preventDefault(); jumpTo(st.pages.length - 1); break;
      case 'Escape': e.preventDefault(); backToDetails(); break;
      default: break;
    }
  }

  document.addEventListener('keydown', onKey);

  // ── screen wake lock ─ keep the display awake while reading (best-effort) ────
  // The OS releases the lock automatically when the tab is hidden, so re-acquire
  // on visibilitychange. Silently no-ops where the API is unsupported/denied.
  let wakeLock = null;
  async function acquireWakeLock() {
    try {
      if ((store.get().reader || {}).keepAwake === false) return; // user opted out
      if ('wakeLock' in navigator && document.visibilityState === 'visible' && !st.destroyed) {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch { /* denied / unsupported — ignore */ }
  }
  function releaseWakeLock() { try { if (wakeLock) wakeLock.release(); } catch { /* ignore */ } wakeLock = null; }
  function onVisibility() { if (document.visibilityState === 'visible') acquireWakeLock(); }
  document.addEventListener('visibilitychange', onVisibility);
  acquireWakeLock();

  function teardown() {
    st.destroyed = true;
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
    document.removeEventListener('visibilitychange', onVisibility);
    releaseWakeLock();
    document.body.classList.remove('reader-active');
    document.body.classList.remove('reader-immersive');
    document.body.classList.remove('reader-fullscreen');
    if (document.fullscreenElement) { try { document.exitFullscreen(); } catch { /* ignore */ } }
    cancelAutoLoop();
    resetTranslations();
    resetColorize();
    clearColorizeCache();  // revoke the session's cached full-res colorized blob URLs
    if (scrollListener) { (scrollTarget || window).removeEventListener('scroll', scrollListener); scrollListener = null; scrollTarget = null; }
  }
  view.__readerTeardown = teardown;

  // Toggle the distraction-free "hide sidebar" mode (desktop). Persisted so it
  // sticks across chapters/sessions; the sidebar returns automatically when the
  // reader closes (CSS gates it on .reader-active.reader-immersive).
  function toggleImmersive(e) {
    if (e) e.stopPropagation();
    const on = !document.body.classList.contains('reader-immersive');
    document.body.classList.toggle('reader-immersive', on);
    store.set({ reader: { immersive: on } });
    $$('.reader-sidebar-toggle', view).forEach((n) => {
      n.classList.toggle('active', on);
      n.title = on ? 'Show sidebar' : 'Hide sidebar';
    });
    toast(on ? 'Sidebar hidden' : 'Sidebar shown');
  }

  // Toggle true browser fullscreen (Fullscreen API) for the best reading view —
  // hides the browser chrome AND the app sidebar (via .reader-fullscreen).
  function toggleFullscreen(e) {
    if (e) e.stopPropagation();
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (!fsEl) {
      const de = document.documentElement;
      const req = de.requestFullscreen || de.webkitRequestFullscreen;
      if (req) { Promise.resolve(req.call(de)).catch(() => toast('Fullscreen not available')); }
      else toast('Fullscreen not supported');
    } else {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) { Promise.resolve(exit.call(document)).catch(() => {}); }
    }
  }
  function onFullscreenChange() {
    const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
    document.body.classList.toggle('reader-fullscreen', on);
    $$('.reader-fs-toggle', view).forEach((n) => {
      n.classList.toggle('active', on);
      n.title = on ? 'Exit fullscreen' : 'Fullscreen';
      n.replaceChildren(icon(on ? 'fullscreenExit' : 'fullscreen'));
    });
  }
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  // ── navigation ─────────────────────────────────────────────────────────
  function backToDetails() {
    router.navigate('details', { sid: st.sid, url: st.mangaUrl });
  }

  function toggleControls() {
    st.controlsVisible = !st.controlsVisible;
    const rv = $('.reader-view', view);
    if (rv) rv.classList.toggle('controls-hidden', !st.controlsVisible);
  }

  // Chapter array ordering VARIES by source (MangaDex = oldest-first; many
  // scanlation sites = newest-first). Detect the reading direction from chapter
  // numbers so "next" is always the higher-numbered chapter regardless of order.
  // Returns the index delta that moves to the NEXT (later) chapter.
  function nextDelta() {
    const ch = st.chapters;
    if (ch.length < 2) return 1;
    const a = Number(ch[0] && ch[0].number);
    const b = Number(ch[ch.length - 1] && ch[ch.length - 1].number);
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a < b ? 1 : -1;
    return 1; // fallback: assume oldest-first
  }
  // reading: +1 = next chapter, -1 = previous chapter (order-independent).
  function goReadingChapter(reading, opts) { goChapter(reading * nextDelta(), opts); }
  function chapterExists(reading) {
    const t = st.index + reading * nextDelta();
    return t >= 0 && t < st.chapters.length;
  }

  function goChapter(direction, opts) {
    if (st.index < 0 || !st.chapters.length) return;
    const target = st.index + direction;
    if (target < 0 || target >= st.chapters.length) {
      toast('No more chapters this way.');
      return;
    }
    transitionChapter(target, opts);
  }

  // Seamless chapter swap: no loading screen, no screen re-mount. Pages come
  // from the prefetch cache when warm (instant); the DOM is rebuilt in place,
  // the chapter title/counter refresh, and the URL hash is updated silently
  // (replaceState — a router.navigate would fire hashchange and re-mount the
  // whole reader, which is exactly the refresh this avoids).
  let chapterSwapping = false;
  let lastChapterSwapTs = 0;
  async function transitionChapter(target, opts = {}) {
    if (chapterSwapping || st.destroyed) return;
    const ch = st.chapters[target];
    if (!ch) return;
    chapterSwapping = true;
    try {
      let pages = pagesCache.get(ch.url);
      if (!pages) {
        toast('Loading chapter…');
        const data = await api.pages(st.sid, ch.url);
        pages = data.pages || [];
        pagesCache.set(ch.url, pages);
      }
      if (st.destroyed) return;
      if (!pages.length) { toast('That chapter has no pages.'); return; }
      st.index = target;
      st.chapterUrl = ch.url;
      st.pages = pages;
      // Reading backwards lands on the END of the previous chapter (continuity).
      st.currentPage = opts.atEnd ? pages.length - 1 : 0;
      syncUrl();
      renderReader();
      lastChapterSwapTs = Date.now();
      toast(fmt.chapterTitle(ch, target));
      recordHistory(st.currentPage);
      checkBookmark();
      maybePrefetch();
    } catch (e) {
      toast(readerError(e, 'Could not load chapter'));
    } finally {
      chapterSwapping = false;
    }
  }

  // Reflect the current chapter in the hash WITHOUT firing hashchange, so a
  // reload/share deep-links to the right chapter but the reader isn't re-mounted.
  function syncUrl() {
    try {
      history.replaceState(null, '', '#/reader?sid=' + encodeURIComponent(st.sid)
        + '&url=' + encodeURIComponent(st.mangaUrl)
        + '&chapterUrl=' + encodeURIComponent(st.chapterUrl));
    } catch { /* ignore */ }
  }

  function pageStep(delta) {
    if (!st.pages.length) return;
    const last = st.pages.length - 1;
    const target = st.currentPage + delta;
    // Reading forward past the last page → NEXT chapter; back before first →
    // prev chapter, landing on its last page.
    if (target < 0) { goReadingChapter(-1, { atEnd: true }); return; }
    if (target > last) { goReadingChapter(1); return; }
    setPage(target, true);
  }

  // ── data loading ─────────────────────────────────────────────────────────
  // Pages are the long pole; details only feed titles, chapter nav and prefs.
  // Fire both immediately and never let a slow (or broken) details call block
  // the first page paint — details hydrate the chrome whenever they land.
  async function loadAll() {
    const pagesP = api.pages(st.sid, st.chapterUrl);
    let details = null;
    try {
      details = await Promise.race([
        api.details(st.sid, st.mangaUrl),
        pagesP.then(() => null).catch(() => null),
      ]);
    } catch { details = null; }
    if (st.destroyed) return;
    applyDetails(details);
    loadPrefs();
    if (!details) hydrateDetailsLate();
    await loadPages(st.index, startPage, pagesP);
  }

  function applyDetails(details) {
    const manga = details && details.manga;
    st.manga = manga || st.manga
      || { id: st.mangaUrl, title: 'Reading', url: st.mangaUrl, __placeholder: true };
    // Some sources omit the cover (and occasionally the title) in details —
    // recover them from the card grid's manga cache so history records with
    // artwork and a real name.
    if (st.manga && st.manga.url) {
      const hint = store.cachedManga(st.manga.url);
      if (hint) {
        if (!st.manga.coverUrl && !st.manga.largeCoverUrl) {
          st.manga.coverUrl = hint.coverUrl || '';
          st.manga.largeCoverUrl = hint.largeCoverUrl || '';
        }
        if (!st.manga.title && hint.title) st.manga.title = hint.title;
      }
    }
    // cachedManga is an in-memory Map, so it's empty after a reload or when the
    // reader is opened straight from a link — exactly the cases that produced
    // cover-less "Untitled" rows. Fall back to what we already persisted for
    // this manga, which survives both.
    if (st.manga && (!st.manga.title || (!st.manga.coverUrl && !st.manga.largeCoverUrl))) {
      try {
        const key = st.manga.id != null ? String(st.manga.id) : '';
        const url = st.manga.url || '';
        const prior = (library.history().entries || []).find((e) => e.manga
          && (String(e.manga.id) === key || (url && e.manga.url === url)));
        if (prior && prior.manga) {
          if (!st.manga.title && prior.manga.title) st.manga.title = prior.manga.title;
          if (!st.manga.coverUrl && !st.manga.largeCoverUrl) {
            st.manga.coverUrl = prior.manga.coverUrl || '';
            st.manga.largeCoverUrl = prior.manga.largeCoverUrl || '';
          }
        }
      } catch { /* history unavailable — keep what we have */ }
    }
    st.chapters = (details && details.chapters) || st.chapters || [];
    st.index = st.chapters.findIndex((c) => c.url === st.chapterUrl);
    if (st.index < 0) st.index = 0;
  }

  function hydrateDetailsLate() {
    api.details(st.sid, st.mangaUrl).then((details) => {
      if (st.destroyed || !details) return;
      const prevMode = mode;
      applyDetails(details);
      loadPrefs();
      if (!st.pages.length) return; // pages failed/pending — nothing to hydrate
      if (mode !== prevMode) { renderReader(); return; } // per-manga mode pref
      applyReaderWidth();
      const f = filterStr();
      $$('.reader-page', view).forEach((img) => { img.style.filter = f; });
      syncChrome();
      recordHistory(st.currentPage);
      checkBookmark();
      maybePrefetch();
    }).catch(() => { /* reader stays usable without details */ });
  }

  // Rebuild the top/bottom bars in place (title + chapter prev/next state).
  function syncChrome() {
    $$('.reader-bar.top', view).forEach((n) => n.replaceWith(bar('top')));
    $$('.reader-bar.bottom', view).forEach((n) => n.replaceWith(bar('bottom')));
    syncPosition();
    syncAutoUi();
  }

  function loadPrefs() {
    try {
      const p = library.mangaPrefs(st.manga.id) || {};
      if (Object.keys(p).length) {
        st.grade = {
          brightness: Number(p.brightness) || 0,
          contrast: p.contrast != null ? Number(p.contrast) : 1,
          saturation: p.saturation != null ? Number(p.saturation) : 1,
          invert: Number(p.invert) || 0,
          palette: p.palette || '',
        };
        if (p.readerMode && ['WEBTOON', 'PAGED', 'PAGED_RTL'].includes(p.readerMode)) mode = p.readerMode;
        if (p.readerFit && ['WIDTH', 'HEIGHT'].includes(p.readerFit)) fit = p.readerFit;
        if (typeof p.prefetch === 'boolean') prefetch = p.prefetch;
        if (p.webtoonWidth) webtoonWidth = clampWidth(p.webtoonWidth);
        if (p.autoScrollLevel != null) autoLevel = clampLevel(p.autoScrollLevel);
        // Translate & colorize are GLOBAL toggles (Settings → Experimental), not
        // per-manga — otherwise a title previously saved with them on would
        // resurrect the feature (and the reader button) after you turned the
        // "Translate/Colorize pages" toggle off. Only the language choice is
        // remembered per title.
        if (p.translateTo) translateTo = p.translateTo;
        if (p.translateFrom) translateFrom = p.translateFrom;
      }
    } catch { /* keep defaults */ }
  }

  async function loadPages(chapterIndex, startPage = 0, pagesPromise = null) {
    st.index = chapterIndex;
    if (st.index >= 0 && st.index < st.chapters.length) {
      st.chapterUrl = st.chapters[st.index].url;
    }
    st.currentPage = 0;
    if (scrollListener) { (scrollTarget || window).removeEventListener('scroll', scrollListener); scrollListener = null; scrollTarget = null; }
    view.replaceChildren(el('div', { class: 'reader-loading-screen' }, bar('top', true), loadingBlock('Loading pages…')));
    try {
      const data = await (pagesPromise || api.pages(st.sid, st.chapterUrl));
      if (st.destroyed) return;
      st.pages = data.pages || [];
      pagesCache.set(st.chapterUrl, st.pages);
      // Resume to the requested page (clamped) — renderReader positions to it.
      st.currentPage = Math.max(0, Math.min(st.pages.length - 1, Number(startPage) || 0));
      renderReader();
      recordHistory(st.currentPage);
      checkBookmark();
      maybePrefetch();
    } catch (e) {
      if (st.destroyed) return;
      view.replaceChildren(
        bar('top', true),
        errorBox(readerError(e, 'This chapter failed to load')),
        el('div', { style: { display: 'flex', justifyContent: 'center', marginTop: '16px' } },
          btn('Retry', { icon: 'refresh', onClick: () => loadPages(chapterIndex, startPage) })),
      );
    }
  }

  // ── history + bookmarks + grade persistence ──────────────────────────────
  let historyTimer = null;
  function recordHistory(page) {
    if (!st.manga || st.manga.__placeholder) return;
    const chapter = st.chapters[st.index];
    if (historyTimer) clearTimeout(historyTimer);
    historyTimer = setTimeout(() => {
      historyTimer = null;
      try {
        library.recordHistory({
          manga: st.manga,
          sourceId: st.sid,
          sourceNsfw: api.isSourceNsfw(st.sid),
          chapterUrl: st.chapterUrl,
          chapterId: st.chapterUrl,
          chapterTitle: chapter ? fmt.chapterTitle(chapter, st.index) : '',
          chapterNumber: chapter && chapter.number != null ? chapter.number : null,
          page,
          total: st.pages.length,
        });
        // Best-effort scrobble to any connected trackers (deduped per chapter).
        if (chapter && chapter.number != null) {
          tracking.scrobbleAll({ mangaId: st.manga.id, title: st.manga.title, chapter: chapter.number });
        }
      } catch { /* best-effort */ }
    }, 350);
  }

  function checkBookmark() {
    if (!st.manga || st.manga.__placeholder) return;
    try {
      const r = library.checkBookmark({
        mangaId: st.manga.id, chapterId: st.chapterUrl, page: st.currentPage,
      });
      st.bookmarked = !!(r && r.bookmarked);
    } catch { st.bookmarked = false; }
    syncBookmarkButtons();
  }

  function toggleBookmark() {
    if (!st.manga || st.manga.__placeholder) return;
    const chapter = st.chapters[st.index];
    try {
      if (st.bookmarked) {
        library.removeBookmark({ mangaId: st.manga.id, chapterId: st.chapterUrl, page: st.currentPage });
        st.bookmarked = false;
        toast('Bookmark removed');
      } else {
        library.addBookmark({
          manga: st.manga,
          sourceId: st.sid,
          chapterUrl: st.chapterUrl,
          chapterId: st.chapterUrl,
          chapterTitle: chapter ? fmt.chapterTitle(chapter, st.index) : '',
          page: st.currentPage,
          note: '',
        });
        st.bookmarked = true;
        toast(`Page ${st.currentPage + 1} bookmarked`);
      }
    } catch (e) { toast(e.message || 'Bookmark failed'); }
    syncBookmarkButtons();
  }

  function savePrefs() {
    if (!st.manga || st.manga.__placeholder) return;
    try {
      library.saveMangaPrefs({
        mangaId: st.manga.id,
        readerMode: mode,
        readerFit: fit,
        prefetch,
        webtoonWidth,
        autoScrollLevel: autoLevel,
        translateTo,
        translateFrom,
        brightness: st.grade.brightness,
        contrast: st.grade.contrast,
        saturation: st.grade.saturation,
        invert: st.grade.invert,
        palette: st.grade.palette,
      });
    } catch { /* best-effort */ }
  }

  // Chapter pages cache — prefetched chapters swap in instantly.
  const pagesCache = new Map(); // chapterUrl → pages[]

  function maybePrefetch() {
    if (!prefetch) return;
    const next = st.index + nextDelta();
    if (next < 0 || next >= st.chapters.length) return;
    const url = st.chapters[next].url;
    if (pagesCache.has(url)) return;
    api.pages(st.sid, url).then((d) => pagesCache.set(url, d.pages || [])).catch(() => {});
  }

  // ── in-image AI translation ───────────────────────────────────────────────
  // Client-side port of Android's MangaTranslator: bubble detection + OCR run
  // in a worker (models download on first use), machine translation via the
  // same free endpoint Android uses, results drawn as an overlay per page.
  // Pages translate lazily as they approach the viewport.
  const tlHandles = new Map(); // img → overlay handle
  let tlObserver = null;
  let tlErrorToasted = false;
  onTranslatorStatus((msg) => { if (!st.destroyed) toast(msg); });

  function ensureTlObserver() {
    if (!tlObserver) {
      tlObserver = new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          tlObserver.unobserve(en.target);
          queueTranslate(en.target);
        }
      }, { rootMargin: '75% 0px' });
    }
    return tlObserver;
  }

  function observeTranslate(img) {
    if (translate && img.__tlPage) ensureTlObserver().observe(img);
  }

  // Effective OCR/source language: the explicit setting, or (auto) the manga
  // source's language from its details/catalog entry. Unknown → Japanese.
  let tlSrcPromise = null;
  function resolveSourceLang() {
    if (translateFrom !== 'auto') return Promise.resolve(translateFrom);
    if (!tlSrcPromise) {
      const norm = (c) => {
        c = String(c || '').toLowerCase();
        if (c.startsWith('zh')) return 'zh';
        if (c.startsWith('ko')) return 'ko';
        if (c.startsWith('ja')) return 'ja';
        if (c.startsWith('en')) return 'en';
        return '';
      };
      tlSrcPromise = (async () => {
        const s = st.manga && st.manga.source;
        let code = norm(s && (s.lang || s.locale));
        if (!code) {
          try {
            const { sources } = await api.listSources();
            const entry = (sources || []).find((x) => x.id === st.sid);
            code = norm(entry && (entry.lang || entry.locale));
          } catch { /* fall through */ }
        }
        return code || 'ja';
      })();
    }
    return tlSrcPromise;
  }

  async function queueTranslate(img) {
    if (st.destroyed || !translate || !img.isConnected || !img.__tlPage) return;
    if (!img.complete || !img.naturalWidth) {
      img.addEventListener('load', () => queueTranslate(img), { once: true });
      return;
    }
    if (tlHandles.has(img)) return;
    const handle = attachOverlay(img);
    tlHandles.set(img, handle);
    translatePage({
      url: img.__tlPage.url,
      headers: img.__tlPage.headers,
      target: translateTo,
      source: await resolveSourceLang(),
      title: (st.manga && !st.manga.__placeholder && st.manga.title) || '',
      onUpdate: ({ blocks, texts, progress }) => {
        if (st.destroyed || !translate || tlHandles.get(img) !== handle) return;
        handle.setBlocks(blocks, texts, progress);
      },
    }).catch((e) => {
      if (tlHandles.get(img) === handle) { handle.destroy(); tlHandles.delete(img); }
      if (!tlErrorToasted && !st.destroyed && translate) {
        tlErrorToasted = true;
        toast('Translation failed: ' + ((e && e.message) || e));
      }
    });
  }

  function resetTranslations() {
    if (tlObserver) { tlObserver.disconnect(); tlObserver = null; }
    tlHandles.forEach((h) => { try { h.destroy(); } catch { /* ignore */ } });
    tlHandles.clear();
  }

  function beginTranslateAll() {
    $$('img.reader-page', view).forEach((img) => observeTranslate(img));
  }

  function setTranslate(on) {
    translate = !!on;
    store.set({ reader: { translate } });
    savePrefs();
    if (translate) beginTranslateAll();
    else resetTranslations();
    syncChrome(); // the overlay eye toggle appears/disappears with the feature
  }

  // Session-only overlay visibility — a quick "peek at the original" switch;
  // OCR/translation keep running underneath, only the painted blocks hide.
  let tlVisible = true;
  function setTlVisible(on) {
    tlVisible = !!on;
    const rv = $('.reader-view', view);
    if (rv) rv.classList.toggle('tl-hidden', !tlVisible);
    $$('.reader-tl-toggle', view).forEach((n) => {
      n.classList.toggle('active', !tlVisible);
      n.title = tlVisible ? 'Hide translation (t)' : 'Show translation (t)';
      n.replaceChildren(icon(tlVisible ? 'eye' : 'eyeOff'));
    });
    toast(tlVisible ? 'Translation shown' : 'Original shown');
  }

  function setTranslateTo(lang) {
    if (lang === translateTo) return;
    translateTo = lang;
    store.set({ reader: { translateTo } });
    savePrefs();
    if (translate) { resetTranslations(); beginTranslateAll(); }
  }

  function setTranslateFrom(lang) {
    if (lang === translateFrom) return;
    translateFrom = lang;
    tlSrcPromise = null;
    store.set({ reader: { translateFrom } });
    savePrefs();
    if (translate) { resetTranslations(); beginTranslateAll(); }
  }

  // ── Colorize (on-device manga colorization) ───────────────────────────────
  // Swaps each visible page's image for an AI-coloured version. The colourised
  // image keeps the page's crisp line art (luminance) with model chroma. Result
  // cached per page url; toggling off restores the original.
  let colorizeObserver = null;
  let colorizeErrored = false;
  onColorizeStatus((m) => { if (!st.destroyed) toast(m); });

  function observeColorize(img) {
    if (colorize && img.__tlPage) colorizeObs().observe(img);
  }
  function colorizeObs() {
    if (!colorizeObserver) {
      colorizeObserver = new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          colorizeObserver.unobserve(en.target);
          applyColorize(en.target);
        }
      }, { rootMargin: '100% 0px' });
    }
    return colorizeObserver;
  }
  async function applyColorize(img) {
    if (st.destroyed || !colorize || !img.__tlPage) return;
    try {
      const url = await colorizePage(img.__tlPage.url, img.__tlPage.headers);
      if (st.destroyed || !colorize || !img.isConnected) return;
      if (img.__colorOrig == null) img.__colorOrig = img.getAttribute('src') || '';
      img.src = url;
    } catch (e) {
      if (!colorizeErrored && !st.destroyed && colorize) { colorizeErrored = true; toast('Colorize failed: ' + ((e && e.message) || e)); }
    }
  }
  function resetColorize() {
    if (colorizeObserver) { colorizeObserver.disconnect(); colorizeObserver = null; }
  }
  function restoreColorize() {
    $$('img.reader-page', view).forEach((img) => {
      if (img.__colorOrig != null) { img.src = img.__colorOrig; img.__colorOrig = null; }
    });
  }
  function beginColorizeAll() { $$('img.reader-page', view).forEach((img) => observeColorize(img)); }
  function setColorize(on) {
    colorize = !!on;
    store.set({ reader: { colorize } });
    savePrefs();
    if (colorize) beginColorizeAll();
    else { resetColorize(); restoreColorize(); }
    $$('.reader-color-toggle', view).forEach((n) => n.classList.toggle('active', colorize));
  }

  // ── auto-scroll ────────────────────────────────────────────────────────────
  // Level → speed. WEBTOON: pixels per second. PAGED: milliseconds per page.
  function webtoonPxPerSec() { return 24 + (autoLevel - 1) * 26; }        // 24 … 258 px/s
  function pagedDelayMs() { return Math.max(1500, 9500 - autoLevel * 780); } // ~8.7s … 1.7s
  function webtoonScrollEl() { return $('.reader.webtoon', view); }

  // Single time-based rAF clock for both modes — no setTimeout races, and it's
  // trivially cancelled/restarted on every renderReader (mode or chapter change).
  function autoFrame(ts) {
    if (!autoOn) { autoRaf = null; return; }
    if (!autoLastTs) autoLastTs = ts;
    // Clamp dt so a backgrounded tab (rAF pauses) doesn't bank a giant jump.
    const dt = Math.min(100, ts - autoLastTs);
    autoLastTs = ts;
    if (mode === 'WEBTOON') {
      const target = webtoonScrollEl();
      if (target) {
        autoAccum += webtoonPxPerSec() * (dt / 1000);
        const whole = Math.floor(autoAccum);
        if (whole >= 1) {
          autoAccum -= whole;
          const before = target.scrollTop;
          target.scrollTop = before + whole;
          const moved = target.scrollTop - before;
          const canScroll = target.scrollHeight > target.clientHeight + 4;
          const atBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 2;
          // Only end on the LAST page — guards against lazy-loaded images that
          // briefly make scrollHeight look short (which would skip a chapter).
          const onLastPage = st.currentPage >= st.pages.length - 1;
          if (onLastPage && (atBottom || !canScroll)) { autoReachedEnd(); return; }
          // Hit a wall while lower images still load — don't bank a jump.
          if (moved < whole - 0.5) autoAccum = 0;
        }
      }
    } else {
      autoAccum += dt;
      if (autoAccum >= pagedDelayMs()) {
        autoAccum = 0;
        if (st.currentPage >= st.pages.length - 1) { autoReachedEnd(); return; }
        pageStep(1);
      }
    }
    autoRaf = requestAnimationFrame(autoFrame);
  }

  // End of the current chapter while auto-scrolling: roll on to the next chapter
  // (auto stays on → the loop restarts once it renders) or stop at the very end.
  function autoReachedEnd() {
    autoRaf = null;
    if (chapterExists(1)) { goReadingChapter(1); }
    else { stopAuto(); toast('You’re all caught up — last chapter.'); }
  }

  function cancelAutoLoop() { if (autoRaf) cancelAnimationFrame(autoRaf); autoRaf = null; }
  function startAutoLoop() { autoLastTs = 0; autoAccum = 0; cancelAutoLoop(); autoRaf = requestAnimationFrame(autoFrame); }

  function startAuto() {
    if (!st.pages.length) return;
    autoOn = true;
    if (!st.controlsVisible) toggleControls();  // reveal chrome so the pause control shows
    startAutoLoop();
    syncAutoUi();
  }
  function stopAuto() { autoOn = false; cancelAutoLoop(); syncAutoUi(); }
  function toggleAuto() { autoOn ? stopAuto() : startAuto(); }

  function bumpSpeed(delta, silent) {
    const next = clampLevel(autoLevel + delta);
    if (next === autoLevel) return;
    autoLevel = next;
    store.set({ reader: { autoScrollLevel: autoLevel } });
    savePrefs();
    syncAutoUi();
    if (!silent) toast(`Auto-scroll speed ${autoLevel}/10`);
  }

  function jumpTo(page) {
    if (!st.pages.length) return;
    setPage(Math.max(0, Math.min(st.pages.length - 1, page)), true);
  }

  // Tap the page counter → jump to any page (works in every mode; webtoon has no
  // seek slider otherwise).
  async function promptJump() {
    const total = st.pages.length;
    if (!total) return;
    const ans = await promptDialog(`Go to page (1–${total})`, String(st.currentPage + 1));
    if (ans == null) return;
    const n = parseInt(ans, 10);
    if (Number.isFinite(n) && n >= 1 && n <= total) jumpTo(n - 1);
    else toast('Enter a page number in range.');
  }

  // Reflect auto-scroll state on the top-bar toggle button (the on/off control)
  // and the speed slider in Settings (whichever are mounted).
  function syncAutoUi() {
    $$('.reader-auto-toggle', view).forEach((n) => {
      n.classList.toggle('active', autoOn);
      n.replaceChildren(icon(autoOn ? 'pause' : 'play'));
      n.title = autoOn ? 'Stop auto-scroll (a)' : 'Auto-scroll (a / space)';
    });
    $$('.reader-autospeed', view).forEach((n) => { if (Number(n.value) !== autoLevel) n.value = String(autoLevel); });
  }

  // ── view-state setters ────────────────────────────────────────────────────
  function setPage(page, scrollIntoView) {
    const last = st.pages.length - 1;
    st.currentPage = Math.max(0, Math.min(last < 0 ? 0 : last, page));
    syncPosition();
    recordHistory(st.currentPage);
    checkBookmark();
    if (mode === 'WEBTOON') {
      if (scrollIntoView) {
        const img = $(`[data-page="${st.currentPage}"]`, view);
        if (img) img.scrollIntoView({ behavior: scrollIntoView === 'instant' ? 'auto' : 'smooth', block: 'start' });
      }
    } else {
      goToSlide(st.currentPage, scrollIntoView === true);
    }
  }

  function toggleFit() {
    fit = fit === 'WIDTH' ? 'HEIGHT' : 'WIDTH';
    store.set({ reader: { fit } });
    savePrefs();
    renderReader();
  }

  function setMode(next) {
    if (next === mode) return;
    mode = next;
    store.set({ reader: { mode } });
    savePrefs();
    renderReader();
  }

  function setPrefetch(on) {
    prefetch = !!on;
    store.set({ reader: { prefetch } });
    savePrefs();
    if (prefetch) maybePrefetch();
  }

  function setWebtoonWidth(w) {
    webtoonWidth = w;
    store.set({ reader: { webtoonWidth: w } });
    savePrefs();
    applyReaderWidth();
  }

  function applyReaderWidth() {
    view.style.setProperty('--reader-width', `${webtoonWidth}%`);
  }

  // ── DOM helpers ────────────────────────────────────────────────────────────
  const filterStr = () => buildFilter(st.grade);

  function pageImg(p, i) {
    const img = el('img', {
      class: 'reader-page',
      loading: 'lazy',
      decoding: 'async',
      alt: `Page ${i + 1}`,
      'data-page': String(i),
    });
    // Derive a source-domain Referer (like Android) for the proxy fallback —
    // many CDNs gate page images on it. Page-supplied headers win.
    const dom = st.manga && st.manga.source && st.manga.source.domain;
    const headers = Object.assign(dom ? { Referer: `https://${dom}/` } : {}, p.headers || {});
    // On load, pin the real aspect-ratio (webtoon) so the reserved skeleton slot
    // snaps to the exact height — no reflow of the pages below, so the scroll
    // position, the X/Y counter and auto-scroll all stay stable.
    img.addEventListener('load', () => {
      img.classList.add('loaded');
      if (mode === 'WEBTOON' && img.naturalWidth && img.naturalHeight) {
        img.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
      }
    }, { once: true });
    applyImage(img, p.url, headers, () => { img.replaceWith(brokenPage(p, i)); });
    img.__tlPage = { url: p.url, headers };
    observeTranslate(img);
    observeColorize(img);
    const f = filterStr();
    if (f) img.style.filter = f;
    return img;
  }

  // Append a cache-buster so a retry actually re-fetches instead of serving the
  // browser's cached failure.
  function bustPage(p) {
    const url = p && p.url;
    if (!url) return p;
    const sep = url.includes('?') ? '&' : '?';
    return Object.assign({}, p, { url: `${url}${sep}_r=${Date.now()}` });
  }

  function brokenPage(p, i) {
    const node = el('div', {
      class: 'reader-page reader-page-broken', 'data-page': String(i),
      style: {
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        minHeight: '220px', width: '100%', maxWidth: 'var(--reader-width, 880px)',
        color: 'var(--text-dim)', gap: '12px', padding: '24px 12px',
      },
    },
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        icon('close'), `Page ${i + 1} failed to load`),
      btn('Reload', {
        variant: 'ghost', class: 'btn-sm', icon: 'refresh',
        onClick: () => node.replaceWith(pageImg(bustPage(p), i)),
      }),
    );
    return node;
  }

  // ── control bars ───────────────────────────────────────────────────────────
  function currentChapterTitle() {
    const chapter = st.chapters[st.index];
    return chapter ? fmt.chapterTitle(chapter, st.index)
      : (st.manga ? st.manga.title : 'Reading');
  }

  function bar(place, minimal) {
    if (place === 'top') {
      const back = iconBtn('back', backToDetails, 'Back to details');
      
      const titleWrap = el('div', { class: 'reader-title', title: currentChapterTitle() },
        st.manga ? el('span', { class: 't-manga' }, st.manga.title || '') : null,
        el('span', { class: 't-chapter' }, currentChapterTitle()),
      );

      if (minimal) {
        return el('div', { class: 'reader-bar top' },
          el('div', { class: 'reader-title-group' }, back, titleWrap));
      }

      const bmBtn = iconBtn('bookmark', toggleBookmark, 'Bookmark');
      bmBtn.classList.add('reader-btn', 'reader-bm');
      if (st.bookmarked) bmBtn.classList.add('active');

      const autoBtn = iconBtn(autoOn ? 'pause' : 'play', toggleAuto, autoOn ? 'Stop auto-scroll (a)' : 'Auto-scroll (a / space)');
      autoBtn.classList.add('reader-btn', 'reader-auto-toggle');
      if (autoOn) autoBtn.classList.add('active');

      let tlBtn = null;
      if (translate) {
        tlBtn = iconBtn(tlVisible ? 'eye' : 'eyeOff', (e) => { if (e) e.stopPropagation(); setTlVisible(!tlVisible); },
          tlVisible ? 'Hide translation (t)' : 'Show translation (t)');
        tlBtn.classList.add('reader-btn', 'reader-tl-toggle');
        if (!tlVisible) tlBtn.classList.add('active');
      }

      // Colorize toggle only exists when the Colorize feature is actually on
      // (like the translate button gates on `translate`) — turning experimental
      // on alone must NOT surface it while "Colorize pages" is off.
      let colorBtn = null;
      if (colorize) {
        colorBtn = iconBtn('droplet', (e) => { if (e) e.stopPropagation(); setColorize(!colorize); },
          colorize ? 'Colorize on' : 'Colorize (AI)');
        colorBtn.classList.add('reader-btn', 'reader-color-toggle');
        if (colorize) colorBtn.classList.add('active');
      }

      const listBtn = iconBtn('list', openChapterList, 'Chapters');
      listBtn.classList.add('reader-btn');

      const settingsBtn = iconBtn('settings', openSettings, 'Settings');
      settingsBtn.classList.add('reader-btn');

      const immersive = document.body.classList.contains('reader-immersive');
      const sidebarBtn = iconBtn('panel', toggleImmersive, immersive ? 'Show sidebar' : 'Hide sidebar');
      sidebarBtn.classList.add('reader-btn', 'reader-sidebar-toggle');
      if (immersive) sidebarBtn.classList.add('active');

      const fsOn = !!(document.fullscreenElement || document.webkitFullscreenElement);
      const fsBtn = iconBtn(fsOn ? 'fullscreenExit' : 'fullscreen', toggleFullscreen, fsOn ? 'Exit fullscreen' : 'Fullscreen');
      fsBtn.classList.add('reader-btn', 'reader-fs-toggle');
      if (fsOn) fsBtn.classList.add('active');

      return el('div', { class: 'reader-bar top' },
        el('div', { class: 'reader-title-group' }, back, titleWrap),
        el('div', { class: 'reader-actions' },
          autoBtn, colorBtn, tlBtn, sidebarBtn, fsBtn, bmBtn, listBtn, settingsBtn,
        ),
      );
    }

    // Order-independent: prev = lower-numbered chapter, next = higher-numbered.
    const hasPrev = st.index >= 0 && chapterExists(-1);
    const hasNext = st.index >= 0 && chapterExists(1);

    const prevBtn = el('button', {
      class: 'reader-btn', type: 'button', disabled: !hasPrev ? true : null,
      onClick: (e) => { e.stopPropagation(); goReadingChapter(-1); },
      title: 'Previous chapter (p)'
    }, icon('back'));

    const nextBtn = el('button', {
      class: 'reader-btn', type: 'button', disabled: !hasNext ? true : null,
      onClick: (e) => { e.stopPropagation(); goReadingChapter(1); },
      title: 'Next chapter (n)'
    }, icon('chevron'));

    const counter = el('span', {
      class: 'reader-counter', role: 'button', tabindex: '0',
      title: 'Go to page', 'aria-label': 'Go to page',
      onClick: (e) => { e.stopPropagation(); promptJump(); },
      onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); promptJump(); } },
    }, `${st.currentPage + 1} / ${st.pages.length || 0}`);

    let slider = null;
    if (st.pages.length > 1) {
      slider = el('input', {
        type: 'range', class: 'reader-slider', 'aria-label': 'Page',
        min: '1', max: String(st.pages.length), step: '1',
        value: String(st.currentPage + 1),
      });
      // 'instant' — dragging should jump, not chase a smooth scroll per tick.
      slider.addEventListener('input', () => setPage(Number(slider.value) - 1, 'instant'));
      slider.addEventListener('click', (e) => e.stopPropagation());
      m3Range(slider);
    }

    return el('div', { class: 'reader-bar bottom' },
      prevBtn,
      counter,
      slider || el('span', { style: { flex: '1 1 auto' } }),
      nextBtn,
    );
  }

  function syncPosition() {
    const total = st.pages.length || 0;
    $$('.reader-bar .reader-counter', view).forEach((n) => {
      n.textContent = `${st.currentPage + 1} / ${total}`;
    });
    $$('.reader-slider', view).forEach((n) => {
      if (Number(n.value) !== st.currentPage + 1) n.value = String(st.currentPage + 1);
      const max = Number(n.max) || 1;
      if (max > 1) n.style.setProperty('--p', ((st.currentPage / (max - 1)) * 100) + '%');
    });
    const prg = $('.reader-progress', view);
    if (prg) {
      const pct = total > 1 ? (st.currentPage / (total - 1)) * 100 : (total ? 100 : 0);
      prg.style.width = `${pct}%`;
    }
  }
  function syncBookmarkButtons() {
    $$('.reader-bm', view).forEach((n) => n.classList.toggle('active', st.bookmarked));
  }

  // Horizontal swipe → prev/next chapter (WEBTOON only; paged already uses
  // horizontal swipe to flip pages). A gesture counts when it's fast, clearly
  // horizontal, and long enough — so it never fights the vertical page scroll.
  function bindWebtoonSwipe(scrollEl) {
    let x0 = 0, y0 = 0, t0 = 0, tracking = false;
    scrollEl.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { tracking = false; return; }
      const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; t0 = Date.now(); tracking = true;
    }, { passive: true });
    scrollEl.addEventListener('touchend', (e) => {
      if (!tracking) return; tracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - x0, dy = t.clientY - y0, dt = Date.now() - t0;
      if (dt < 600 && Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy) * 2.2) {
        if (dx < 0) goReadingChapter(1);   // swipe left  → next chapter
        else goReadingChapter(-1);         // swipe right → previous chapter
      }
    }, { passive: true });
  }

  // ── body renderers ─────────────────────────────────────────────────────────
  function renderReader() {
    // A running loop must not outlive the DOM it scrolls (mode/chapter change).
    cancelAutoLoop();
    resetTranslations();   // overlays/observer die with the old DOM
    resetColorize();       // observer dies with the old imgs (cache survives)
    zoomReset = null;   // the previous render's zoom controller is gone
    if (scrollListener) { (scrollTarget || window).removeEventListener('scroll', scrollListener); scrollListener = null; scrollTarget = null; }
    if (!st.pages.length) {
      view.replaceChildren(bar('top', true), emptyState('This chapter returned no pages.'));
      return;
    }

    applyReaderWidth();
    const readerView = el('div', {
      class: 'reader-view' + (st.controlsVisible ? '' : ' controls-hidden') + (tlVisible ? '' : ' tl-hidden'),
    });
    readerView.addEventListener('click', toggleControls);

    if (mode === 'WEBTOON') {
      const reader = el('div', { class: 'reader webtoon' + (fit === 'HEIGHT' ? ' fit-height' : '') });
      bindWebtoonSwipe(reader);
      st.pages.forEach((p, i) => reader.appendChild(pageImg(p, i)));
      reader.appendChild(endCard());
      readerView.append(progressBar(), bar('top'), reader, bar('bottom'));
      view.replaceChildren(readerView);
      installScrollSpy();
      // Jump to the resume page (reserved aspect-ratios make positions valid
      // before images load), then warm a window around it.
      if (st.currentPage > 0) {
        requestAnimationFrame(() => {
          const node = $(`.reader.webtoon [data-page="${st.currentPage}"]`, view);
          if (node) node.scrollIntoView({ block: 'start' });
        });
      }
      eagerWebtoon(st.currentPage);
    } else {
      // Paged / Paged-RTL — a horizontal scroll-snap track: each page is a full
      // viewport slide. Native swipe + momentum on touch; RTL handled by dir.
      const rtl = mode === 'PAGED_RTL';
      const track = el('div', {
        class: 'reader-paged-track' + (fit === 'HEIGHT' ? ' fit-height' : ' fit-width'),
      });
      if (rtl) track.dir = 'rtl';
      st.pages.forEach((p, i) => {
        track.appendChild(el('div', { class: 'reader-slide', 'data-page': String(i) }, pageImg(p, i)));
      });
      // Tap zones (desktop / non-swipe): left = prev, right = next (flipped for
      // RTL). Disabled entirely by the "tap to turn pages" preference.
      const zones = [];
      if ((store.get().reader || {}).tapZones !== false) {
        const left = el('div', { class: 'reader-zone left', title: rtl ? 'Next' : 'Previous' });
        const right = el('div', { class: 'reader-zone right', title: rtl ? 'Previous' : 'Next' });
        left.addEventListener('click', (e) => { e.stopPropagation(); pageStep(rtl ? 1 : -1); });
        right.addEventListener('click', (e) => { e.stopPropagation(); pageStep(rtl ? -1 : 1); });
        zones.push(left, right);
      }
      const stage = el('div', { class: 'reader-paged' }, track, ...zones);
      // Update currentPage from whichever slide is snapped under the centre.
      let raf = null;
      track.addEventListener('scroll', () => {
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = null; updatePagedCurrent(track); });
      }, { passive: true });
      readerView.append(progressBar(), bar('top'), stage, bar('bottom'));
      view.replaceChildren(readerView);
      attachPagedZoom(stage, track);
      goToSlide(st.currentPage, false);
      preloadAround(st.currentPage);
    }
    syncPosition();
    syncAutoUi();
    if (autoOn) startAutoLoop();
  }

  // Webtoon tail card: makes "end of chapter" a deliberate moment (and the auto-
  // scroll landing spot) instead of an abrupt stop, with quick chapter jumps.
  function endCard() {
    const hasPrev = chapterExists(-1);
    const hasNext = chapterExists(1);
    const actions = el('div', { class: 'reader-end-actions' },
      hasPrev ? btn('Previous', { variant: 'ghost', icon: 'back', onClick: (e) => { e.stopPropagation(); goReadingChapter(-1); } }) : null,
      hasNext
        ? btn('Next chapter', { variant: 'accent', onClick: (e) => { e.stopPropagation(); goReadingChapter(1); } })
        : el('span', { class: 'reader-end-last' }, 'Last chapter'),
    );
    return el('div', { class: 'reader-end' },
      el('div', { class: 'reader-end-title' }, hasNext ? 'End of chapter' : 'You’re all caught up'),
      actions,
    );
  }

  function progressBar() {
    return el('div', { class: 'reader-progress', style: { width: '0%' } });
  }

  function installScrollSpy() {
    // The webtoon pages scroll INSIDE `.reader.webtoon` (flex:1; overflow-y:auto),
    // not the window: `.reader-view` is height:100vh; overflow:hidden with fixed
    // top/bottom bars. Listening on `window` never fired, so currentPage — and the
    // bottom `X / Y` indicator — never advanced while scrolling. Attach to the real
    // scroll container, and measure the current page against that container's centre.
    scrollTarget = $('.reader.webtoon', view) || window;
    let ticking = false;
    scrollListener = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const reader = $('.reader.webtoon', view);
        if (!reader) return;
        const box = reader.getBoundingClientRect();
        const mid = box.top + box.height / 2;
        let best = 0; let bestDist = Infinity;
        reader.querySelectorAll('[data-page]').forEach((node) => {
          const r = node.getBoundingClientRect();
          const c = r.top + r.height / 2;
          const d = Math.abs(c - mid);
          if (d < bestDist) { bestDist = d; best = Number(node.dataset.page); }
        });
        if (best !== st.currentPage) {
          st.currentPage = best;
          syncPosition();
          recordHistory(best);
          checkBookmark();
          eagerWebtoon(best);
          if (best >= st.pages.length - 2) maybePrefetch();
        }
      });
    };
    scrollTarget.addEventListener('scroll', scrollListener, { passive: true });
    if (scrollTarget !== window) bindWebtoonBoundaryGestures(scrollTarget);
  }

  // Continuous reading (webtoon): a deliberate gesture PAST a chapter boundary
  // rolls straight into the next/previous chapter — wheel or swipe, no button.
  // Intent matters: position-based triggers bounce (landing at the end of a
  // chapter would instantly re-advance), so only accumulated input while the
  // container is already pinned at the boundary counts, with a cooldown after
  // each swap so momentum can't chain through chapters.
  function bindWebtoonBoundaryGestures(scrollEl) {
    if ((store.get().reader || {}).edgeGestures === false) return; // user opted out
    const atTop = () => scrollEl.scrollTop <= 2;
    const atBottom = () => scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 2;
    const ready = () => Date.now() - lastChapterSwapTs > 700 && !chapterSwapping;
    // Dwell-arming: scroll momentum can slam into the boundary and keep firing
    // wheel/touch events — those must never count. The boundary only "arms"
    // after you've SAT on it for a beat; only then does a fresh gesture flip
    // the chapter.
    let bottomSince = 0;
    let topSince = 0;
    function updateDwell() {
      const now = Date.now();
      bottomSince = atBottom() ? (bottomSince || now) : 0;
      topSince = atTop() ? (topSince || now) : 0;
    }
    const armed = (dir) => {
      const since = dir === 1 ? bottomSince : topSince;
      return !!since && Date.now() - since > 350;
    };
    scrollEl.addEventListener('scroll', updateDwell, { passive: true });
    updateDwell();

    // Wheel events arrive in "bursts" (a physical scroll gesture + its
    // momentum tail, gaps < ~300ms). A burst that BEGAN before the boundary
    // armed is momentum — ignore it entirely, however long it runs. Only a
    // fresh burst started while resting on the armed boundary can flip.
    let wheelAccum = 0;
    let lastWheelAt = 0;
    let burstStartedArmed = false;
    scrollEl.addEventListener('wheel', (e) => {
      updateDwell();
      const now = Date.now();
      const newBurst = now - lastWheelAt > 300;
      lastWheelAt = now;
      const dir = e.deltaY > 0 ? 1 : -1;
      if ((dir === 1 && !atBottom()) || (dir === -1 && !atTop())) {
        wheelAccum = 0;
        burstStartedArmed = false;
        return;
      }
      if (newBurst) { burstStartedArmed = armed(dir); wheelAccum = 0; }
      if (!burstStartedArmed) { wheelAccum = 0; return; }
      if (Math.sign(wheelAccum) !== dir) wheelAccum = 0;
      wheelAccum += e.deltaY;
      if (Math.abs(wheelAccum) > 480 && ready() && chapterExists(dir)) {
        wheelAccum = 0;
        burstStartedArmed = false;
        goReadingChapter(dir, dir === -1 ? { atEnd: true } : undefined);
      }
    }, { passive: true });
    // Touch: a firm vertical swipe STARTED while already resting on the boundary.
    let t0y = 0;
    let t0TopArmed = false;
    let t0BottomArmed = false;
    scrollEl.addEventListener('touchstart', (e) => {
      updateDwell();
      if (e.touches.length !== 1) { t0TopArmed = t0BottomArmed = false; return; }
      t0y = e.touches[0].clientY;
      t0TopArmed = atTop() && armed(-1);
      t0BottomArmed = atBottom() && armed(1);
    }, { passive: true });
    scrollEl.addEventListener('touchend', (e) => {
      const t = e.changedTouches[0];
      if (!t || !ready()) return;
      const dy = t.clientY - t0y;
      if (t0BottomArmed && atBottom() && dy < -90 && chapterExists(1)) goReadingChapter(1);
      else if (t0TopArmed && atTop() && dy > 90 && chapterExists(-1)) goReadingChapter(-1, { atEnd: true });
    }, { passive: true });
  }

  // Paged: scroll the given slide to centre (browser handles RTL). `smooth` for
  // user-driven page turns, instant for the initial paint / restore.
  function goToSlide(i, smooth) {
    const track = $('.reader-paged-track', view);
    if (!track) return;
    if (zoomReset) zoomReset();   // leave zoom before turning the page
    const slide = track.children[i];
    if (!slide) return;
    slide.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', inline: 'center', block: 'nearest' });
    preloadAround(i);
  }

  // Eager-load the current page + a forward window so a swipe never lands on blank.
  function preloadAround(i) {
    const track = $('.reader-paged-track', view);
    if (!track) return;
    for (let j = i - 1; j <= i + 3; j++) {
      const img = track.children[j] && track.children[j].querySelector('img');
      if (img) img.loading = 'eager';
    }
  }

  // Webtoon look-ahead: promote a window of upcoming pages from lazy → eager so
  // fast scrolling doesn't outrun native lazy-loading and land on blanks.
  function eagerWebtoon(center) {
    const reader = $('.reader.webtoon', view);
    if (!reader) return;
    const from = Math.max(0, center - 1);
    const to = Math.min(st.pages.length - 1, center + 4);
    for (let j = from; j <= to; j++) {
      const img = reader.querySelector(`img[data-page="${j}"]`);
      if (img && img.loading === 'lazy') img.loading = 'eager';
    }
  }

  // Which slide is centred → currentPage. getBoundingClientRect is physical so
  // this works identically for LTR and RTL.
  function updatePagedCurrent(track) {
    const r = track.getBoundingClientRect();
    const mid = r.left + r.width / 2;
    let best = st.currentPage; let bestDist = Infinity;
    for (const slide of track.children) {
      const sr = slide.getBoundingClientRect();
      const d = Math.abs((sr.left + sr.width / 2) - mid);
      if (d < bestDist) { bestDist = d; best = Number(slide.dataset.page); }
    }
    if (best !== st.currentPage) {
      st.currentPage = best;
      if (zoomReset) zoomReset();
      syncPosition();
      recordHistory(best);
      checkBookmark();
      preloadAround(best);
      if (best >= st.pages.length - 2) maybePrefetch();
    }
  }

  // Paged-mode zoom: double-tap / double-click toggles 1×↔2.5× centred on the tap,
  // pinch scales, and drag pans when zoomed. Swipe/tap-nav is suppressed while
  // zoomed; zoom resets on every page turn. Sets `zoomReset` for external resets.
  function attachPagedZoom(stage, track) {
    let scale = 1, tx = 0, ty = 0;
    const pointers = new Map();
    let pinchDist = 0, pinchScale = 1, panLast = null;
    let lastTapT = 0, lastTapX = 0, lastTapY = 0;

    const curImg = () => {
      const slide = track.children[st.currentPage];
      return slide ? slide.querySelector('img') : null;
    };
    const apply = () => {
      const img = curImg();
      if (img) img.style.transform = scale > 1.01 ? `translate(${tx}px, ${ty}px) scale(${scale})` : '';
      stage.classList.toggle('zoomed', scale > 1.01);
      track.style.overflowX = scale > 1.01 ? 'hidden' : '';
    };
    const clampPan = () => {
      const img = curImg();
      if (!img) return;
      const maxX = Math.max(0, (img.clientWidth * scale - stage.clientWidth) / 2);
      const maxY = Math.max(0, (img.clientHeight * scale - stage.clientHeight) / 2);
      tx = Math.max(-maxX, Math.min(maxX, tx));
      ty = Math.max(-maxY, Math.min(maxY, ty));
    };
    const reset = () => {
      scale = 1; tx = 0; ty = 0; panLast = null; pinchDist = 0;
      track.querySelectorAll('img').forEach((i) => { i.style.transform = ''; });
      stage.classList.remove('zoomed', 'panning');
      track.style.overflowX = '';
    };
    zoomReset = reset;

    const zoomTo = (s, clientX, clientY) => {
      if (s <= 1.01) { reset(); return; }
      const img = curImg();
      if (!img) return;
      const r = img.getBoundingClientRect();
      const dx = clientX - (r.left + r.width / 2);
      const dy = clientY - (r.top + r.height / 2);
      scale = s;
      tx = -dx * (s - 1);
      ty = -dy * (s - 1);
      clampPan();
      apply();
    };

    // Mouse: dblclick toggles zoom, but not over a nav zone (side clicks navigate).
    stage.addEventListener('dblclick', (e) => {
      if (e.target && e.target.classList && e.target.classList.contains('reader-zone')) return;
      e.preventDefault(); e.stopPropagation();
      zoomTo(scale > 1.01 ? 1 : 2.5, e.clientX, e.clientY);
    });

    stage.addEventListener('pointerdown', (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        pinchScale = scale;
        panLast = null;
        return;
      }
      // Touch/pen: detect double-tap (mouse uses the dblclick handler above).
      if (e.pointerType !== 'mouse') {
        const now = Date.now();
        if (now - lastTapT < 300 && Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 32) {
          zoomTo(scale > 1.01 ? 1 : 2.5, e.clientX, e.clientY);
          lastTapT = 0;
        } else {
          lastTapT = now; lastTapX = e.clientX; lastTapY = e.clientY;
        }
      }
      if (scale > 1.01) {
        panLast = { x: e.clientX, y: e.clientY };
        stage.classList.add('panning');
        try { stage.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      }
    });

    stage.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size >= 2 && pinchDist > 0) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        scale = Math.max(1, Math.min(4, pinchScale * (d / pinchDist)));
        stage.classList.add('panning');
        clampPan();
        apply();
      } else if (pointers.size === 1 && panLast && scale > 1.01) {
        tx += e.clientX - panLast.x;
        ty += e.clientY - panLast.y;
        panLast = { x: e.clientX, y: e.clientY };
        clampPan();
        apply();
      }
    });

    const onUp = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDist = 0;
      if (pointers.size === 0) {
        panLast = null;
        stage.classList.remove('panning');
        if (scale <= 1.01) reset();
      }
    };
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('pointercancel', onUp);
  }

  function openChapterList() {
    if (!st.chapters.length) { toast('No chapters available.'); return; }
    const list = el('ul', { class: 'chapter-list' });
    let closeFn = () => {};
    st.chapters.forEach((c, i) => {
      const isCurrent = i === st.index;
      const isRead = i < st.index;
      const row = el('li', {
        class: isRead ? 'read' : '',
        role: 'button', tabindex: '0',
        style: isCurrent ? { background: 'var(--surface2)', borderColor: 'var(--accent)', color: 'var(--text)' } : null,
      },
        el('span', { class: 'ch-meta', style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: '0' } },
          isCurrent ? icon('play') : null,
          el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, fmt.chapterTitle(c, i)),
        ),
        c.uploadDate ? el('span', { class: 'ch-meta', style: { color: 'var(--text-faint)', flex: '0 0 auto' } }, fmt.date(c.uploadDate)) : null,
      );
      row.addEventListener('click', () => {
        closeFn();
        if (i !== st.index) transitionChapter(i);
      });
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); }
      });
      list.appendChild(row);
    });

    closeFn = modal({
      title: 'Chapters',
      body: el('div', { style: { maxHeight: '62vh', overflowY: 'auto' } }, list),
      actions: [{ label: 'Close', primary: true }],
    });

    requestAnimationFrame(() => {
      const cur = list.children[st.index];
      if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'center' });
    });
  }

  function openSettings() {
    const live = { ...st.grade };
    function applyLive() {
      st.grade = { ...live };
      const f = filterStr();
      $$('.reader-page', view).forEach((img) => { img.style.filter = f; });
    }
    const modeSeg = segmented(
      [{ label: 'Standard', value: 'PAGED' }, { label: 'RTL', value: 'PAGED_RTL' }, { label: 'Webtoon', value: 'WEBTOON' }],
      mode, (v) => setMode(v),
    );
    const fitSeg = segmented(
      [{ label: 'Width', value: 'WIDTH' }, { label: 'Height', value: 'HEIGHT' }],
      fit, (v) => { if (v !== fit) toggleFit(); },
    );
    
    const widthVal = el('span', { class: 'counter' }, `${webtoonWidth}%`);
    const widthSlider = el('input', {
      type: 'range', min: '30', max: '100', step: '5',
      value: String(webtoonWidth),
      style: { width: '100%', accentColor: 'var(--accent)' }
    });
    widthSlider.addEventListener('input', () => {
      const val = Number(widthSlider.value);
      widthVal.textContent = `${val}%`;
      setWebtoonWidth(val);
    });
    m3Range(widthSlider);

    const prefetchInput = el('input', { type: 'checkbox' });
    prefetchInput.checked = prefetch;
    prefetchInput.addEventListener('change', () => setPrefetch(prefetchInput.checked));
    const prefetchSwitch = el('label', { class: 'switch' }, prefetchInput, el('span', { class: 'slider' }));

    const speedVal = el('span', { class: 'counter' }, `${autoLevel}/10`);
    const speedSlider = el('input', {
      type: 'range', class: 'reader-autospeed', min: '1', max: '10', step: '1',
      value: String(autoLevel),
      style: { width: '100%', accentColor: 'var(--accent)' },
    });
    speedSlider.addEventListener('input', () => {
      const val = clampLevel(speedSlider.value);
      speedVal.textContent = `${val}/10`;
      if (val !== autoLevel) bumpSpeed(val - autoLevel, true);
    });
    m3Range(speedSlider);

    const layoutSection = el('div', { class: 'settings-section' },
      el('h2', null, 'Layout'),
      inlineRow('Mode', modeSeg),
      inlineRow('Fit', fitSeg),
      mode === 'WEBTOON' ? el('div', { class: 'field' }, el('div', { class: 'row', style: { justifyContent: 'space-between' } }, el('label', null, 'Webtoon width'), widthVal), widthSlider) : null,
      el('div', { class: 'field' }, el('div', { class: 'row', style: { justifyContent: 'space-between' } }, el('label', null, 'Auto-scroll speed'), speedVal), speedSlider),
      inlineRow('Prefetch next chapter', prefetchSwitch)
    );

    const tlInput = el('input', { type: 'checkbox' });
    tlInput.checked = translate;
    tlInput.addEventListener('change', () => setTranslate(tlInput.checked));
    const tlSwitch = el('label', { class: 'switch' }, tlInput, el('span', { class: 'slider' }));
    const tlLangSelect = menuSelect(TL_LANGS, translateTo, (v) => setTranslateTo(v));
    const tlFromSelect = menuSelect(TL_SOURCES, translateFrom, (v) => setTranslateFrom(v));
    const tlSection = el('div', { class: 'settings-section' },
      el('h2', null, 'Translate'),
      inlineRow('Translate pages (beta)', tlSwitch),
      inlineRow('Translate from', tlFromSelect),
      inlineRow('Translate to', tlLangSelect),
      el('div', { style: { fontSize: '12px', color: 'var(--text-dim)', lineHeight: '1.5' } },
        'Runs entirely in your browser — AI models download on first use and are '
        + 'cached (Japanese ~123 MB; Chinese/English ~32 MB; Korean ~24 MB).'),
    );

    const colorSection = el('div', { class: 'settings-section' }, el('h2', null, 'Colour'));
    // AI colorize toggle — the top-bar droplet only appears while colorize is
    // on, so this is how you enable it from inside the reader. Requires the
    // model to be downloaded first (Settings → Experimental → Colorization);
    // without that gate this switch would kick off a silent 62 MB fetch.
    if (experimental && colorReady) {
      const czInput = el('input', { type: 'checkbox' });
      czInput.checked = colorize;
      czInput.addEventListener('change', () => setColorize(czInput.checked));
      colorSection.appendChild(inlineRow('AI colorize (beta)',
        el('label', { class: 'switch' }, czInput, el('span', { class: 'slider' }))));
    }
    function gradeSlider(label, key, min, max, step, fmtVal) {
      const valOut = el('span', { class: 'counter' }, fmtVal(live[key]));
      const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(live[key]), style: { width: '100%', accentColor: 'var(--accent)' } });
      input.addEventListener('input', () => { live[key] = Number(input.value); valOut.textContent = fmtVal(live[key]); applyLive(); });
      m3Range(input);
      colorSection.__sliders = colorSection.__sliders || {};
      colorSection.__sliders[key] = { input, valOut, fmtVal };
      return el('div', { class: 'field', style: { marginBottom: '12px' } }, el('div', { class: 'row', style: { justifyContent: 'space-between' } }, el('label', null, label), valOut), input);
    }
    colorSection.appendChild(gradeSlider('Brightness', 'brightness', -1, 1, 0.05, (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`));
    colorSection.appendChild(gradeSlider('Contrast', 'contrast', 0, 2, 0.05, (v) => `${v.toFixed(2)}×`));
    colorSection.appendChild(gradeSlider('Saturation', 'saturation', 0, 2, 0.05, (v) => `${v.toFixed(2)}×`));
    colorSection.appendChild(gradeSlider('Invert', 'invert', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`));
    const chips = el('div', { class: 'chips' });
    function renderChips() {
      chips.replaceChildren();
      PALETTES.forEach((pal) => {
        chips.appendChild(chip(PALETTE_LABEL(pal), {
          active: live.palette === pal,
          onClick: () => { live.palette = pal; renderChips(); applyLive(); },
        }));
      });
    }
    renderChips();
    colorSection.appendChild(el('div', { class: 'field', style: { marginBottom: '0' } }, el('label', null, 'Presets'), chips));
    // Translate settings only appear when experimental features are enabled.
    const body = el('div', null, layoutSection, experimental ? tlSection : null, colorSection);
    modal({
      title: 'Reader Settings',
      body,
      actions: [{
        label: 'Reset colour', variant: 'ghost', onClick: () => {
          const d = defaultGrade();
          Object.assign(live, d);
          st.grade = { ...d };
          savePrefs();
          const f = filterStr();
          $$('.reader-page', view).forEach((img) => { img.style.filter = f; });
          const sliders = colorSection.__sliders || {};
          Object.keys(sliders).forEach((k) => {
            const s = sliders[k];
            s.input.value = String(live[k]);
            s.valOut.textContent = s.fmtVal(live[k]);
            s.input.dispatchEvent(new Event('input')); // refresh the m3 fill
          });
          renderChips();
          return false;
        }
      }, { label: 'Done', primary: true, onClick: () => { st.grade = { ...live }; savePrefs(); } }],
    });
  }

  // ── kick off ───────────────────────────────────────────────────────────────
  loadAll();
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function inlineRow(label, control) {
  return el('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '14px' } },
    el('div', { style: { fontWeight: '600', fontSize: '13px' } }, label),
    control,
  );
}

function loadingBlock(msg) {
  // A centred accent ring spinner + label.
  return el('div', { class: 'reader-loading' },
    el('div', { class: 'reader-loading-badge' },
      el('div', { class: 'reader-loading-ring', 'aria-hidden': 'true' }),
      el('span', { class: 'reader-loading-label' }, msg || 'Loading…'),
    ),
  );
}

export default { meta, render };
