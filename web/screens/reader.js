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
// space; n/p = next/prev chapter; f = fit; Escape = back). Prefetch warms the
// next chapter's pages when near the end and prefetch is on.
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
  emptyState, errorBox, modal, segmented, fmt,
} from '../core/ui.js';
import { store, router } from '../core/store.js';
import library from '../core/library.js';

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

  if (view.__readerTeardown) {
    try { view.__readerTeardown(); } catch { /* ignore */ }
    view.__readerTeardown = null;
  }

  // Hide app-level UI
  document.body.classList.add('reader-active');

  view.replaceChildren(loadingBlock('Loading chapter…'));

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
  let webtoonWidth = gp.webtoonWidth || 880;

  let scrollListener = null;

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
      case ' ':
        if (mode === 'WEBTOON') return;
        e.preventDefault(); pageStep(1); break;
      case 'ArrowUp':
        if (mode === 'WEBTOON') return;
        e.preventDefault(); pageStep(-1); break;
      case 'n': case 'N': e.preventDefault(); goChapter(1); break;   // next chapter
      case 'p': case 'P': e.preventDefault(); goChapter(-1); break;  // previous chapter
      case 'f': case 'F': e.preventDefault(); toggleFit(); break;
      case 'Escape': e.preventDefault(); backToDetails(); break;
      default: break;
    }
  }

  document.addEventListener('keydown', onKey);
  function teardown() {
    st.destroyed = true;
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('reader-active');
    if (scrollListener) { window.removeEventListener('scroll', scrollListener); scrollListener = null; }
  }
  view.__readerTeardown = teardown;

  // ── navigation ─────────────────────────────────────────────────────────
  function backToDetails() {
    router.navigate('details', { sid: st.sid, url: st.mangaUrl });
  }

  function toggleControls() {
    st.controlsVisible = !st.controlsVisible;
    const rv = $('.reader-view', view);
    if (rv) rv.classList.toggle('controls-hidden', !st.controlsVisible);
  }

  function goChapter(direction) {
    if (st.index < 0 || !st.chapters.length) return;
    const target = st.index + direction;
    if (target < 0 || target >= st.chapters.length) {
      toast(direction > 0 ? 'No earlier chapter.' : 'No later chapter.');
      return;
    }
    st.chapterUrl = st.chapters[target].url;
    router.navigate('reader', { sid: st.sid, url: st.mangaUrl, chapterUrl: st.chapterUrl });
    loadPages(target);
  }

  function pageStep(delta) {
    if (!st.pages.length) return;
    const last = st.pages.length - 1;
    const target = st.currentPage + delta;
    // Chapters are oldest-first (index+1 = next). Reading forward past the last
    // page goes to the NEXT chapter; going back before the first → previous.
    if (target < 0) { goChapter(-1); return; }
    if (target > last) { goChapter(1); return; }
    setPage(target, true);
  }

  // ── data loading ─────────────────────────────────────────────────────────
  async function loadAll() {
    try {
      const details = await api.details(st.sid, st.mangaUrl);
      if (st.destroyed) return;
      st.manga = details.manga || { id: st.mangaUrl, title: 'Reading', url: st.mangaUrl };
      st.chapters = details.chapters || [];
      st.index = st.chapters.findIndex((c) => c.url === st.chapterUrl);
      if (st.index < 0) st.index = 0;
      loadPrefs();
      await loadPages(st.index);
    } catch (e) {
      if (st.destroyed) return;
      view.replaceChildren(bar('top', true), errorBox(readerError(e, 'Could not load this chapter')));
    }
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
        if (p.webtoonWidth) webtoonWidth = Number(p.webtoonWidth);
      }
    } catch { /* keep defaults */ }
  }

  async function loadPages(chapterIndex) {
    st.index = chapterIndex;
    if (st.index >= 0 && st.index < st.chapters.length) {
      st.chapterUrl = st.chapters[st.index].url;
    }
    st.currentPage = 0;
    if (scrollListener) { window.removeEventListener('scroll', scrollListener); scrollListener = null; }
    view.replaceChildren(bar('top', true), loadingBlock('Loading pages…'));
    try {
      const data = await api.pages(st.sid, st.chapterUrl);
      if (st.destroyed) return;
      st.pages = data.pages || [];
      renderReader();
      recordHistory(0);
      checkBookmark();
      maybePrefetch();
    } catch (e) {
      if (st.destroyed) return;
      view.replaceChildren(bar('top', true), errorBox(readerError(e, 'This chapter failed to load')));
    }
  }

  // ── history + bookmarks + grade persistence ──────────────────────────────
  let historyTimer = null;
  function recordHistory(page) {
    if (!st.manga) return;
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
      } catch { /* best-effort */ }
    }, 350);
  }

  function checkBookmark() {
    if (!st.manga) return;
    try {
      const r = library.checkBookmark({
        mangaId: st.manga.id, chapterId: st.chapterUrl, page: st.currentPage,
      });
      st.bookmarked = !!(r && r.bookmarked);
    } catch { st.bookmarked = false; }
    syncBookmarkButtons();
  }

  function toggleBookmark() {
    if (!st.manga) return;
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
    if (!st.manga) return;
    try {
      library.saveMangaPrefs({
        mangaId: st.manga.id,
        readerMode: mode,
        readerFit: fit,
        prefetch,
        webtoonWidth,
        brightness: st.grade.brightness,
        contrast: st.grade.contrast,
        saturation: st.grade.saturation,
        invert: st.grade.invert,
        palette: st.grade.palette,
      });
    } catch { /* best-effort */ }
  }

  function maybePrefetch() {
    if (!prefetch) return;
    const next = st.index - 1;
    if (next < 0 || next >= st.chapters.length) return;
    api.pages(st.sid, st.chapters[next].url).catch(() => {});
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
        if (img) img.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } else {
      goToSlide(st.currentPage, scrollIntoView);
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
    view.style.setProperty('--reader-width', `${webtoonWidth}px`);
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
    applyImage(img, p.url, headers, () => { img.replaceWith(brokenPage(i)); });
    const f = filterStr();
    if (f) img.style.filter = f;
    return img;
  }

  function brokenPage(i) {
    return el('div', {
      class: 'reader-page', 'data-page': String(i),
      style: {
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        minHeight: '220px', width: '100%', maxWidth: 'var(--reader-width, 880px)',
        color: 'var(--text-dim)', gap: '8px',
      },
    }, icon('close'), `Page ${i + 1} failed to load`);
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
        return el('div', { class: 'reader-bar top' }, back, titleWrap);
      }

      const bmBtn = iconBtn('bookmark', toggleBookmark, 'Bookmark');
      bmBtn.classList.add('reader-btn', 'reader-bm');
      if (st.bookmarked) bmBtn.classList.add('active');

      const listBtn = iconBtn('list', openChapterList, 'Chapters');
      listBtn.classList.add('reader-btn');

      const settingsBtn = iconBtn('settings', openSettings, 'Settings');
      settingsBtn.classList.add('reader-btn');

      return el('div', { class: 'reader-bar top' },
        back,
        titleWrap,
        el('div', { class: 'reader-actions' },
          bmBtn, listBtn, settingsBtn,
        ),
      );
    }

    // Oldest-first chapters: previous = a lower index, next = a higher index.
    const hasPrev = st.index > 0;
    const hasNext = st.index >= 0 && st.index < st.chapters.length - 1;

    const prevBtn = el('button', {
      class: 'reader-btn', type: 'button', disabled: !hasPrev ? true : null,
      onClick: (e) => { e.stopPropagation(); goChapter(-1); },
      title: 'Previous chapter (p)'
    }, icon('back'));

    const nextBtn = el('button', {
      class: 'reader-btn', type: 'button', disabled: !hasNext ? true : null,
      onClick: (e) => { e.stopPropagation(); goChapter(1); },
      title: 'Next chapter (n)'
    }, icon('chevron'));

    const counter = el('span', { class: 'reader-counter' },
      `${st.currentPage + 1} / ${st.pages.length || 0}`);

    let slider = null;
    if (mode !== 'WEBTOON' && st.pages.length > 1) {
      slider = el('input', {
        type: 'range', class: 'reader-slider', 'aria-label': 'Page',
        min: '1', max: String(st.pages.length), step: '1',
        value: String(st.currentPage + 1),
      });
      slider.addEventListener('input', () => setPage(Number(slider.value) - 1, true));
      slider.addEventListener('click', (e) => e.stopPropagation());
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

  // ── body renderers ─────────────────────────────────────────────────────────
  function renderReader() {
    if (scrollListener) { window.removeEventListener('scroll', scrollListener); scrollListener = null; }
    if (!st.pages.length) {
      view.replaceChildren(bar('top', true), emptyState('This chapter returned no pages.'));
      return;
    }
    
    applyReaderWidth();
    const readerView = el('div', { class: 'reader-view' + (st.controlsVisible ? '' : ' controls-hidden') });
    readerView.addEventListener('click', toggleControls);
    
    if (mode === 'WEBTOON') {
      const reader = el('div', { class: 'reader webtoon' + (fit === 'HEIGHT' ? ' fit-height' : '') });
      st.pages.forEach((p, i) => reader.appendChild(pageImg(p, i)));
      readerView.append(progressBar(), bar('top'), reader, bar('bottom'));
      view.replaceChildren(readerView);
      installScrollSpy();
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
      // Tap zones (desktop / non-swipe): left = prev, right = next (flipped for RTL).
      const left = el('div', { class: 'reader-zone left', title: rtl ? 'Next' : 'Previous' });
      const right = el('div', { class: 'reader-zone right', title: rtl ? 'Previous' : 'Next' });
      left.addEventListener('click', (e) => { e.stopPropagation(); pageStep(rtl ? 1 : -1); });
      right.addEventListener('click', (e) => { e.stopPropagation(); pageStep(rtl ? -1 : 1); });
      const stage = el('div', { class: 'reader-paged' }, track, left, right);
      // Update currentPage from whichever slide is snapped under the centre.
      let raf = null;
      track.addEventListener('scroll', () => {
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = null; updatePagedCurrent(track); });
      }, { passive: true });
      readerView.append(progressBar(), bar('top'), stage, bar('bottom'));
      view.replaceChildren(readerView);
      goToSlide(st.currentPage, false);
      preloadAround(st.currentPage);
    }
    syncPosition();
  }

  function progressBar() {
    return el('div', { class: 'reader-progress', style: { width: '0%' } });
  }

  function installScrollSpy() {
    let ticking = false;
    scrollListener = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const reader = $('.reader.webtoon', view);
        if (!reader) return;
        const mid = window.innerHeight / 2;
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
          if (best >= st.pages.length - 2) maybePrefetch();
        }
      });
    };
    window.addEventListener('scroll', scrollListener, { passive: true });
  }

  // Paged: scroll the given slide to centre (browser handles RTL). `smooth` for
  // user-driven page turns, instant for the initial paint / restore.
  function goToSlide(i, smooth) {
    const track = $('.reader-paged-track', view);
    if (!track) return;
    const slide = track.children[i];
    if (!slide) return;
    slide.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', inline: 'center', block: 'nearest' });
    preloadAround(i);
  }

  // Eager-load the current page + its neighbours so a swipe never lands on blank.
  function preloadAround(i) {
    const track = $('.reader-paged-track', view);
    if (!track) return;
    for (let j = i - 1; j <= i + 1; j++) {
      const img = track.children[j] && track.children[j].querySelector('img');
      if (img) img.loading = 'eager';
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
      syncPosition();
      recordHistory(best);
      checkBookmark();
      preloadAround(best);
      if (best >= st.pages.length - 2) maybePrefetch();
    }
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
        if (i !== st.index) {
          st.chapterUrl = c.url;
          router.navigate('reader', { sid: st.sid, url: st.mangaUrl, chapterUrl: st.chapterUrl });
          loadPages(i);
        }
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
    
    const widthVal = el('span', { class: 'counter' }, `${webtoonWidth}px`);
    const widthSlider = el('input', { 
      type: 'range', min: '400', max: '1200', step: '20', 
      value: String(webtoonWidth),
      style: { width: '100%', accentColor: 'var(--accent)' }
    });
    widthSlider.addEventListener('input', () => {
      const val = Number(widthSlider.value);
      widthVal.textContent = `${val}px`;
      setWebtoonWidth(val);
    });

    const prefetchInput = el('input', { type: 'checkbox' });
    prefetchInput.checked = prefetch;
    prefetchInput.addEventListener('change', () => setPrefetch(prefetchInput.checked));
    const prefetchSwitch = el('label', { class: 'switch' }, prefetchInput, el('span', { class: 'slider' }));
    
    const layoutSection = el('div', { class: 'settings-section' }, 
      el('h2', null, 'Layout'), 
      inlineRow('Mode', modeSeg), 
      inlineRow('Fit', fitSeg),
      mode === 'WEBTOON' ? el('div', { class: 'field' }, el('div', { class: 'row', style: { justifyContent: 'space-between' } }, el('label', null, 'Webtoon width'), widthVal), widthSlider) : null,
      inlineRow('Prefetch next chapter', prefetchSwitch)
    );
    
    const colorSection = el('div', { class: 'settings-section' }, el('h2', null, 'Colour'));
    function gradeSlider(label, key, min, max, step, fmtVal) {
      const valOut = el('span', { class: 'counter' }, fmtVal(live[key]));
      const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(live[key]), style: { width: '100%', accentColor: 'var(--accent)' } });
      input.addEventListener('input', () => { live[key] = Number(input.value); valOut.textContent = fmtVal(live[key]); applyLive(); });
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
        const c = el('span', { class: 'chip' + (live.palette === pal ? ' active' : ''), role: 'button', tabindex: '0' }, PALETTE_LABEL(pal));
        c.addEventListener('click', () => { live.palette = pal; renderChips(); applyLive(); });
        chips.appendChild(c);
      });
    }
    renderChips();
    colorSection.appendChild(el('div', { class: 'field', style: { marginBottom: '0' } }, el('label', null, 'Presets'), chips));
    const body = el('div', null, layoutSection, colorSection);
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
  // A page-shaped shimmer so it reads as "the page is loading", with an accent
  // ring spinner + label centred over it.
  return el('div', { class: 'reader-loading' },
    el('div', { class: 'reader-loading-page skeleton' }),
    el('div', { class: 'reader-loading-badge' },
      el('div', { class: 'reader-loading-ring', 'aria-hidden': 'true' }),
      el('span', { class: 'reader-loading-label' }, msg || 'Loading…'),
    ),
  );
}

export default { meta, render };
