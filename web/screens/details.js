// screens/details.js — the hero screen for a single manga.

import { api } from '../core/api.js';
import {
  el, $, $$, icon, spinner, proxyImage, applyImage, toast, btn, iconBtn, chip,
  emptyState, errorBox, modal, fmt, menuSelect, checkbox, contextMenu, openExternal,
} from '../core/ui.js';
import { router, store } from '../core/store.js';
import library from '../core/library.js';
import { downloads } from '../core/downloads.js';
import tracking from '../core/tracking.js';

export const meta = { title: 'Details', nav: false, icon: 'info', order: 99 };

function downloadsSupported() {
  return Promise.resolve(true); // Force enabled for prod-grade UI visibility
}

function clean(value) {
  if (value === null || value === undefined) return '';
  const s = String(value).trim();
  if (!s) return '';
  const low = s.toLowerCase();
  if (low === 'null' || low === 'undefined') return '';
  return s;
}

function plainText(html) {
  const raw = clean(html);
  if (!raw) return '';
  const text = raw.replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return clean(text);
}

function authorsText(manga) {
  if (Array.isArray(manga.authors)) {
    const parts = manga.authors.map(clean).filter(Boolean);
    if (parts.length) return parts.join(', ');
  }
  return clean(manga.author);
}

function mangaKey(manga, sid) {
  if (!manga) return '';
  if (manga.id !== undefined && manga.id !== null && manga.id !== '') {
    return String(manga.id);
  }
  return `${sid || ''}|${manga.url != null ? manga.url : ''}`;
}

function skeletonDetails() {
  return el('div', { class: 'd2-loading' },
    iconBtn('back', () => router.back(), 'Back'),
    el('div', { class: 'd2-loading-badge' },
      spinner(),
      el('div', { class: 'd2-loading-label' }, 'Loading…'),
    ),
  );
}

export function render(view, params) {
  const sid = params && params.sid;
  const url = params && params.url;

  view.replaceChildren();

  if (!sid || !url) {
    view.appendChild(errorBox('Missing manga reference.'));
    return;
  }

  const token = (render._token = (render._token || 0) + 1);

  const container = el('div', { class: 'details' });
  view.appendChild(container);
  container.replaceChildren(skeletonDetails());

  api.details(sid, url).then((data) => {
    if (token !== render._token) return;
    const manga = data && data.manga;
    const chapters = (data && data.chapters) || (manga && manga.chapters) || [];
    if (!manga) {
      container.replaceChildren(backOverlayBar(), errorBox('Manga not found.'));
      return;
    }
    container.replaceChildren(buildDetails(view, sid, url, manga, chapters, params));
  }).catch((err) => {
    if (token !== render._token) return;
    // For unsupported/missing source errors, show cached cover + title if available
    // so the user can at least see what manga this was.
    const errMsg = err && err.message ? err.message : 'Failed to load details.';
    const isSourceErr = errMsg.startsWith('Unsupported source');
    const hint = store.cachedManga(url) || {};
    const cachedTitle = clean(hint.title) || clean(params && params.title) || 'Unknown title';
    const cachedCover = proxyImage(hint.largeCoverUrl || hint.coverUrl || '');
    const friendlyMsg = isSourceErr
      ? `This source isn't available right now. Open it from Explore to read, or try again later.`
      : errMsg;
    const nodes = [backOverlayBar()];
    if (isSourceErr && cachedCover) {
      nodes.push(el('div', { class: 'center', style: { padding: '24px 0 8px' } },
        el('img', { src: cachedCover, alt: cachedTitle, style: { width: '90px', borderRadius: 'var(--radius-sm)' } }),
      ));
    }
    if (isSourceErr) {
      nodes.push(el('div', { class: 'center', style: { padding: '0 16px 8px', fontWeight: '600' } }, cachedTitle));
    }
    nodes.push(errorBox(friendlyMsg));
    nodes.push(el('div', { class: 'center' }, btn('Retry', { variant: 'ghost', icon: 'refresh', onClick: () => render(view, params) })));
    container.replaceChildren(...nodes);
  });
}

function backOverlayBar() {
  return el('div', { class: 'details-backbar' },
    iconBtn('back', () => router.back(), 'Back'));
}

// ── read marks (per-visitor overrides layered on the history-derived state) ──
const READ_KEY = 'nyora.read.marks.v1';
function loadReadMarks() { try { return JSON.parse(localStorage.getItem(READ_KEY)) || {}; } catch { return {}; } }
function saveReadMarks(m) { try { localStorage.setItem(READ_KEY, JSON.stringify(m)); } catch { /* private mode */ } }
function readOverrides(mangaId) {
  const e = (loadReadMarks()[mangaId]) || {};
  return { read: new Set(e.read || []), unread: new Set(e.unread || []) };
}
function saveOverrides(mangaId, ov) {
  const all = loadReadMarks();
  all[mangaId] = { read: [...ov.read], unread: [...ov.unread] };
  saveReadMarks(all);
}

// The manga's current reading progress entry (for the in-progress bar).
function historyEntryFor(mangaId) {
  try {
    const entries = (library.history() || {}).entries || [];
    for (const h of entries) { if (mangaKey(h && h.manga, h && h.sourceId) === mangaId) return h; }
  } catch { /* ignore */ }
  return null;
}

function buildDetails(view, sid, url, manga, chapters, params) {
  const mangaId = mangaKey(manga, sid);
  const hint = store.cachedManga(url) || {};
  const rawCover = manga.largeCoverUrl || manga.coverUrl || hint.largeCoverUrl || hint.coverUrl || '';
  const coverDomain = manga.source && manga.source.domain;
  const coverHeaders = coverDomain ? { Referer: `https://${coverDomain}/` } : undefined;
  const nsfw = manga.isNsfw === true || manga.contentRating === 'ADULT';
  // The source `details` endpoint sometimes omits the title (like the cover);
  // fall back to the cached grid title / the nav param before "Untitled".
  const title = clean(manga.title) || clean(hint.title) || clean(params && params.title) || 'Untitled';
  const authors = authorsText(manga);
  const publicUrl = clean(manga.publicUrl) || clean(manga.url);

  // readingOrder: newest-first index space (kept for parity with download/reader).
  const readingOrder = chapters.slice().reverse();
  const ascByNumber = readingOrder.slice().sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));

  // ── read-state resolution (history-derived + explicit overrides) ──────────
  // Read-state follows CHAPTER NUMBER, never list position — the chapter list
  // can be sorted newest- or oldest-first, but "read" always means "this
  // chapter and everything before it". Sources that omit numbers fall back to
  // reading-order position as a last resort.
  const overrides = readOverrides(mangaId);
  function derivedRead() {
    const lastReadUrl = lastReadChapterUrl(mangaId, readingOrder);
    const last = readingOrder.find((c) => c.url === lastReadUrl);
    if (!last) return () => false;
    const lastNum = Number(last.number);
    if (Number.isFinite(lastNum)) {
      return (c) => {
        const n = Number(c.number);
        return Number.isFinite(n) ? n <= lastNum : false;
      };
    }
    // No usable numbers — fall back to position within reading order (oldest =
    // last element), marking the last-read chapter and everything older read.
    const lastIdx = readingOrder.indexOf(last);
    return (c) => readingOrder.indexOf(c) >= lastIdx;
  }
  let isDerived = derivedRead();
  function isRead(c) {
    if (overrides.unread.has(c.url)) return false;
    if (overrides.read.has(c.url)) return true;
    return isDerived(c);
  }
  function unreadCount() { return readingOrder.filter((c) => !isRead(c)).length; }
  function setRead(c, read) {
    if (read) { overrides.read.add(c.url); overrides.unread.delete(c.url); }
    else { overrides.unread.add(c.url); overrides.read.delete(c.url); }
    saveOverrides(mangaId, overrides);
  }
  function markPreviousRead(c) {
    const n = Number(c.number) || 0;
    for (const x of ascByNumber) {
      if ((Number(x.number) || 0) <= n) { overrides.read.add(x.url); overrides.unread.delete(x.url); }
    }
    saveOverrides(mangaId, overrides);
  }

  // ── LEFT: info panel ──────────────────────────────────────────────────────
  const coverWrap = el('div', { class: 'd2-cover' });
  // Try every cover we know (large → thumb, live → cached), each via direct load
  // then the /image proxy. If ALL fail (e.g. a hotlink-blocked large cover on a
  // cold reload), show a titled placeholder instead of a blank void.
  const covers = [...new Set(
    [manga.largeCoverUrl, manga.coverUrl, hint.largeCoverUrl, hint.coverUrl].map(clean).filter(Boolean),
  )];
  function mountCover(i) {
    const node = i < covers.length
      ? el('img', { class: 'd2-cover-media', loading: 'eager', decoding: 'async', alt: title })
      : el('div', { class: 'd2-cover-fallback' }, ((title || '?').trim()[0] || '?').toUpperCase());
    const cur = $('.d2-cover-media, .d2-cover-fallback', coverWrap);
    if (cur) cur.replaceWith(node); else coverWrap.insertBefore(node, coverWrap.firstChild);
    if (i < covers.length) applyImage(node, covers[i], coverHeaders, () => mountCover(i + 1));
  }
  mountCover(0);
  if (nsfw) coverWrap.appendChild(el('span', { class: 'badge nsfw' }, '18+'));

  const metaChips = [];
  const state = clean(manga.state);
  if (state) metaChips.push(chip(state.replace(/_/g, ' '), { active: true }));
  metaChips.push(chip(`${chapters.length} ${chapters.length === 1 ? 'chapter' : 'chapters'}`));
  if (typeof manga.rating === 'number' && manga.rating > 0) metaChips.push(chip(fmt.rating(manga.rating)));
  const cr = clean(manga.contentRating);
  if (cr && cr !== 'SAFE') metaChips.push(chip(cr, { nsfw }));

  const favBtn = btn('Favourite', { variant: 'ghost', icon: 'heart' });
  let favourited = library.isFavourite(mangaId);
  function paintFav() {
    favBtn.classList.toggle('btn-accent', favourited);
    favBtn.classList.toggle('btn-ghost', !favourited);
    const lbl = $('span:not(.icon)', favBtn);
    if (lbl) lbl.textContent = favourited ? 'In library' : 'Add to library';
  }
  favBtn.addEventListener('click', () => {
    // Persist BOTH cover sizes (falling back to the cached grid thumb) so the
    // library/history cards always have a cover to show — not a blank tile.
    const favManga = {
      ...manga,
      source: manga.source || sid || '',
      title: (title && title !== 'Untitled') ? title : (clean(manga.title) || clean(hint.title) || ''),
      coverUrl: clean(manga.coverUrl) || clean(hint.coverUrl) || clean(manga.largeCoverUrl) || '',
      largeCoverUrl: clean(manga.largeCoverUrl) || clean(hint.largeCoverUrl) || clean(manga.coverUrl) || '',
    };
    try { const res = library.toggleFavourite(favManga); favourited = !!(res && res.favourited); paintFav(); }
    catch (e) { toast(e.message || 'Error'); }
  });
  paintFav();

  const downloadAllBtn = btn('Download', { variant: 'ghost', icon: 'download' });
  downloadAllBtn.addEventListener('click', () => openDownloadDialog(sid, url, mangaId, title, chapters));

  const cta = buildCTA(sid, url, mangaId, chapters, ascByNumber, isRead);

  const descText = plainText(manga.description);
  let descNode;
  if (descText) {
    const p = el('p', { class: 'd2-desc clamp' }, descText);
    const moreBtn = btn('Show more', { variant: 'ghost', class: 'btn-sm', onClick: () => {
      const clamped = p.classList.toggle('clamp');
      const lbl = $('span:not(.icon)', moreBtn);
      if (lbl) lbl.textContent = clamped ? 'Show more' : 'Show less';
    } });
    descNode = el('div', { class: 'd2-desc-wrap' }, p, moreBtn);
  } else {
    descNode = el('p', { class: 'd2-desc d2-desc-empty' }, 'No description.');
  }

  const tags = (Array.isArray(manga.tags) ? manga.tags : [])
    .map((t) => clean(t && (t.title || t.key))).filter(Boolean).slice(0, 24);
  const genresNode = tags.length
    ? el('div', { class: 'd2-genres' }, ...tags.map((t) => chip(t, { onClick: () => router.navigate('search', { q: t }) })))
    : null;

  const info = el('div', { class: 'd2-info' },
    el('div', { class: 'd2-head' },
      coverWrap,
      el('div', { class: 'd2-titlebox' },
        el('h1', { class: 'd2-title', title }, title),
        authors ? el('p', { class: 'd2-authors' }, authors) : null,
        el('div', { class: 'd2-meta' }, ...metaChips),
      ),
    ),
    el('div', { class: 'd2-actions' }, cta, favBtn),
    el('div', { class: 'd2-actions d2-actions-sub' },
      downloadAllBtn,
      iconBtn('folder', () => openCategories(manga, mangaId), 'Add to category'),
      tracking.connectedTrackers().length
        ? iconBtn('bookmark', () => {
          const lu = lastReadChapterUrl(mangaId, readingOrder);
          const lc = readingOrder.find((c) => c.url === lu);
          const cur = lc && lc.number != null ? Math.floor(Number(lc.number)) : 0;
          openTracking(manga, mangaId, title, cur);
        }, 'Tracking')
        : null,
      publicUrl ? iconBtn('external', () => {
        if (!openExternal(publicUrl)) toast('That source link doesn’t look valid.');
      }, 'Open site') : null,
    ),
    descNode,
    genresNode,
  );

  // ── RIGHT: chapters ───────────────────────────────────────────────────────
  const state2 = { filter: 'all', sortKey: 'number', asc: false };
  const listHost = el('ul', { class: 'd2-chapter-list' });
  const countEl = el('span', { class: 'd2-count' });

  const ctx = {
    sid, url, mangaId, title,
    isRead, setRead, markPreviousRead,
    history: historyEntryFor(mangaId),
    rerender: () => renderRows(),
  };

  function sorted() {
    let list = ascByNumber.slice();
    if (state2.sortKey === 'date') {
      list.sort((a, b) => (Number(a.uploadDate) || 0) - (Number(b.uploadDate) || 0));
    }
    if (!state2.asc) list = list.reverse();
    return list;
  }

  function renderRows() {
    isDerived = derivedRead();
    listHost.replaceChildren();
    if (!readingOrder.length) { listHost.appendChild(emptyState('No chapters yet.')); countEl.textContent = ''; return; }
    let list = sorted();
    if (state2.filter === 'unread') list = list.filter((c) => !isRead(c));
    else if (state2.filter === 'downloaded') list = list.filter((c) => { const s = downloads.statusOf(sid, c.url); return s && s.status === 'COMPLETED'; });
    const unread = unreadCount();
    countEl.textContent = `${readingOrder.length} chapters · ${unread} unread`;
    if (!list.length) { listHost.appendChild(emptyState(state2.filter === 'unread' ? 'All caught up.' : 'Nothing here.')); return; }
    for (const c of list) {
      const oldestIdx = readingOrder.length - 1 - readingOrder.indexOf(c);
      listHost.appendChild(buildChapterRow(ctx, c, oldestIdx));
    }
  }

  // toolbar
  const filterBtn = iconBtn('filter', (e) => { const r = e.currentTarget.getBoundingClientRect(); contextMenu([
    { label: 'All chapters', icon: state2.filter === 'all' ? 'check' : null, onClick: () => { state2.filter = 'all'; renderRows(); } },
    { label: 'Unread only', icon: state2.filter === 'unread' ? 'check' : null, onClick: () => { state2.filter = 'unread'; renderRows(); } },
    { label: 'Downloaded only', icon: state2.filter === 'downloaded' ? 'check' : null, onClick: () => { state2.filter = 'downloaded'; renderRows(); } },
  ], r.left, r.bottom + 6); }, 'Filter');
  const sortBtn = iconBtn('sort', (e) => { const r = e.currentTarget.getBoundingClientRect(); contextMenu([
    { label: `By chapter number${state2.sortKey === 'number' ? (state2.asc ? ' ↑' : ' ↓') : ''}`, icon: state2.sortKey === 'number' ? 'check' : null,
      onClick: () => { if (state2.sortKey === 'number') state2.asc = !state2.asc; else { state2.sortKey = 'number'; state2.asc = false; } renderRows(); } },
    { label: `By upload date${state2.sortKey === 'date' ? (state2.asc ? ' ↑' : ' ↓') : ''}`, icon: state2.sortKey === 'date' ? 'check' : null,
      onClick: () => { if (state2.sortKey === 'date') state2.asc = !state2.asc; else { state2.sortKey = 'date'; state2.asc = false; } renderRows(); } },
  ], r.left, r.bottom + 6); }, 'Sort');
  const markAllBtn = iconBtn('check', (e) => { const r = e.currentTarget.getBoundingClientRect(); contextMenu([
    { label: 'Mark all as read', icon: 'check', onClick: () => { for (const c of readingOrder) setRead(c, true); renderRows(); toast('Marked all read'); } },
    { label: 'Mark all as unread', onClick: () => { for (const c of readingOrder) setRead(c, false); renderRows(); toast('Marked all unread'); } },
  ], r.left, r.bottom + 6); }, 'Mark');

  const chapters2 = el('div', { class: 'd2-chapters' },
    el('div', { class: 'd2-toolbar' },
      el('div', { class: 'd2-toolbar-l' }, el('h2', null, 'Chapters'), countEl),
      el('div', { class: 'd2-toolbar-r' }, markAllBtn, filterBtn, sortBtn),
    ),
    el('div', { class: 'd2-chapter-scroll' }, listHost),
  );

  renderRows();

  const root = el('div', { class: 'd2' },
    iconBtn('back', () => router.back(), 'Back'),
    info,
    chapters2,
  );
  $('.icon-btn', root).classList.add('d2-back');
  return root;
}

function buildCTA(sid, url, mangaId, chapters, ascByNumber, isRead) {
  if (!ascByNumber.length) return btn('Read', { primary: true, icon: 'play', class: 'd2-cta', disabled: true });
  const lastUrl = lastReadChapterUrl(mangaId, ascByNumber);
  const firstUnread = ascByNumber.find((c) => !isRead(c));
  const started = !!lastUrl;
  // The chapter the button ACTUALLY opens: the next unread one, or — when
  // everything's read — restart at chapter 1. The label must match this exact
  // target (the old code showed the last chapter but opened the first).
  const openTarget = firstUnread || ascByNumber[0];
  const num = openTarget && openTarget.number != null && Number(openTarget.number) > 0
    ? (Number.isInteger(Number(openTarget.number)) ? Number(openTarget.number) : Number(openTarget.number).toFixed(1)) : null;
  const label = !firstUnread ? 'Read again' : (started ? 'Continue' : 'Start reading');
  return btn(num != null ? `${label} · Ch ${num}` : label, {
    primary: true, icon: 'play', class: 'd2-cta',
    onClick: () => router.navigate('reader', { sid, url, chapterUrl: openTarget.url }),
  });
}

function buildChapterRow(ctx, chapter, index) {
  const { sid, url, mangaId, title: mangaTitle } = ctx;
  const title = fmt.chapterTitle(chapter, index);
  const dateStr = fmt.date(chapter.uploadDate);
  const scanlator = clean(chapter.scanlator);
  const read = ctx.isRead(chapter);

  const st = downloads.statusOf(sid, chapter.url);
  const downloaded = st && st.status === 'COMPLETED';
  const queued = st && (st.status === 'QUEUED' || st.status === 'RUNNING');

  // in-progress bar: the currently-resumed chapter with 0<percent<100
  const h = ctx.history;
  const inProgress = h && !read && (h.chapterUrl === chapter.url || h.chapterId === chapter.url)
    && Number(h.percent) > 0 && Number(h.percent) < 100 ? Number(h.percent) : 0;

  const open = () => router.navigate('reader', { sid, url, chapterUrl: chapter.url });

  const metaParts = [];
  if (dateStr) metaParts.push(dateStr);
  if (scanlator) metaParts.push(scanlator);

  const dlBtn = iconBtn(downloaded ? 'check' : 'download', (e) => {
    e.stopPropagation();
    const res = downloads.enqueue([downloadDesc(sid, url, mangaId, mangaTitle, chapter, index)]);
    if (res.added) toast('Queued ' + title);
    else if (res.requeued) toast('Re-queued ' + title);
    else if (downloaded) toast('Already downloaded');
    else toast('Already in queue');
  }, downloaded ? 'Downloaded' : 'Download');
  dlBtn.classList.add('d2-dl');
  if (downloaded) dlBtn.classList.add('dl-done');
  if (queued) dlBtn.classList.add('dl-queued');

  const menuBtn = iconBtn('more', (e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    contextMenu([
      { label: read ? 'Mark as unread' : 'Mark as read', icon: read ? 'close' : 'check',
        onClick: () => { ctx.setRead(chapter, !read); ctx.rerender(); } },
      { label: 'Mark previous as read', icon: 'check',
        onClick: () => { ctx.markPreviousRead(chapter); ctx.rerender(); } },
      { label: downloaded ? 'Downloaded' : 'Download', icon: 'download',
        onClick: () => { downloads.enqueue([downloadDesc(sid, url, mangaId, mangaTitle, chapter, index)]); toast('Queued ' + title); } },
    ], r.left, r.bottom + 6);
  }, 'More');
  menuBtn.classList.add('d2-more');

  const main = el('div', { class: 'd2-ch-main' },
    el('div', { class: 'd2-ch-name', title }, title),
    metaParts.length ? el('div', { class: 'd2-ch-meta' }, metaParts.join(' · ')) : null,
    inProgress ? el('div', { class: 'd2-ch-progress' }, el('span', { style: { width: `${inProgress}%` } })) : null,
  );

  const li = el('li', { class: 'd2-ch' + (read ? ' read' : '') + (inProgress ? ' inprogress' : ''), role: 'button', tabindex: '0' },
    el('span', { class: 'd2-ch-rail' }),
    main,
    dlBtn,
    menuBtn,
  );
  li.addEventListener('click', open);
  li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  return li;
}

function downloadDesc(sid, url, mangaId, mangaTitle, chapter, index) {
  return {
    sourceId: sid,
    mangaId,
    mangaUrl: url,
    mangaTitle,
    chapterUrl: chapter.url,
    chapterId: chapter.id || chapter.url,
    chapterTitle: fmt.chapterTitle(chapter, index),
    chapterNumber: chapter.number != null ? chapter.number : null,
  };
}

// Range / multi-select download dialog. `chapters` is oldest-first.
function openDownloadDialog(sid, url, mangaId, title, chapters) {
  if (!chapters || !chapters.length) { toast('No chapters to download'); return; }

  const readingOrder = chapters.slice().reverse(); // newest first (matches the list)
  const selected = new Set();
  const cbs = new Map(); // chapterUrl -> checkbox
  let close = () => {};

  const lastUrl = lastReadChapterUrl(mangaId, readingOrder);
  const lastReadEntry = chapters.find((c) => c.url === lastUrl);
  const lastReadNum = lastReadEntry ? Number(lastReadEntry.number) : NaN;
  const lastReadOldIdx = chapters.findIndex((c) => c.url === lastUrl);
  // A chapter is "unread" if its number is above the last-read number (or, when
  // numbers are missing, if it comes after the last-read chapter in the source
  // order) — never a raw list-position assumption.
  const isUnreadChapter = (c, i) => {
    if (Number.isFinite(lastReadNum)) {
      const n = Number(c.number);
      return Number.isFinite(n) ? n > lastReadNum : (lastReadOldIdx < 0 || i > lastReadOldIdx);
    }
    return lastReadOldIdx < 0 || i > lastReadOldIdx;
  };

  function updateFooter() {
    countText.textContent = `${selected.size} of ${chapters.length} selected`;
    goBtn.disabled = selected.size === 0;
    const lbl = $('span:not(.icon)', goBtn);
    if (lbl) lbl.textContent = selected.size ? `Download ${selected.size}` : 'Download';
  }
  function refreshChecks() {
    for (const [u, cb] of cbs) cb.checked = selected.has(u);
    updateFooter();
  }
  function selectAll() { selected.clear(); chapters.forEach((c) => selected.add(c.url)); refreshChecks(); }
  function selectNone() { selected.clear(); refreshChecks(); }
  function selectUnread() {
    selected.clear();
    chapters.forEach((c, i) => { if (isUnreadChapter(c, i)) selected.add(c.url); });
    refreshChecks();
  }
  function selectUndownloaded() {
    selected.clear();
    chapters.forEach((c) => {
      const s = downloads.statusOf(sid, c.url);
      if (!s || s.status !== 'COMPLETED') selected.add(c.url);
    });
    refreshChecks();
  }

  // ── range row ──
  const options = readingOrder.map((c) => [c.url, fmt.chapterTitle(c, chapters.indexOf(c))]);
  let fromValue = options[0][0];
  let toValue = options.at(-1)[0];
  const fromSel = menuSelect(options, fromValue, (v) => { fromValue = v; });
  const toSel = menuSelect(options, toValue, (v) => { toValue = v; });
  function selectRange() {
    const a = chapters.findIndex((c) => c.url === fromValue);
    const b = chapters.findIndex((c) => c.url === toValue);
    if (a < 0 || b < 0) return;
    const lo = Math.min(a, b); const hi = Math.max(a, b);
    selected.clear();
    for (let i = lo; i <= hi; i++) selected.add(chapters[i].url);
    refreshChecks();
  }
  const rangeRow = el('div', { class: 'dl-range' },
    el('span', { class: 'dl-range-label' }, 'Range'),
    fromSel,
    el('span', { class: 'dl-range-sep' }, '→'),
    toSel,
    btn('Select', { variant: 'ghost', class: 'btn-sm', onClick: selectRange }),
  );

  // ── quick filters ──
  const quick = el('div', { class: 'dl-quick' },
    chip('All', { onClick: selectAll }),
    chip('None', { onClick: selectNone }),
    chip('Unread', { onClick: selectUnread }),
    chip('Not downloaded', { onClick: selectUndownloaded }),
  );

  // ── chapter checklist ──
  const listHost = el('div', { class: 'dl-picklist' });
  for (const c of readingOrder) {
    const oi = chapters.indexOf(c);
    const check = checkbox({ checked: selected.has(c.url), onChange: (on) => {
      if (on) selected.add(c.url); else selected.delete(c.url);
      updateFooter();
    } });
    const input = check.querySelector('input');
    cbs.set(c.url, input);
    const st = downloads.statusOf(sid, c.url);
    // Not a <label>: checkbox() already returns its own <label class="m3-check">,
    // so nesting would be an invalid label-in-label. The inner label toggles the
    // input natively; clicking the rest of the row (name/badge) toggles it here.
    const row = el('div', { class: 'dl-pick' },
      check,
      el('span', { class: 'dl-pick-name', title: fmt.chapterTitle(c, oi) }, fmt.chapterTitle(c, oi)),
      st ? statusBadge(st.status, st.warning) : null,
    );
    row.addEventListener('click', (e) => {
      if (check.contains(e.target)) return; // native <label class="m3-check"> already handled it
      input.click();
    });
    listHost.appendChild(row);
  }

  // ── footer ──
  const countText = el('span', { class: 'dl-count' });
  const goBtn = btn('Download', { variant: 'accent', icon: 'download' });
  goBtn.addEventListener('click', () => {
    if (!selected.size) { toast('Select at least one chapter'); return; }
    const descs = [];
    chapters.forEach((c, i) => { if (selected.has(c.url)) descs.push(downloadDesc(sid, url, mangaId, title, c, i)); });
    const res = downloads.enqueue(descs);
    const msgs = [];
    if (res.added) msgs.push(`${res.added} queued`);
    if (res.requeued) msgs.push(`${res.requeued} re-queued`);
    if (res.skipped) msgs.push(`${res.skipped} skipped`);
    toast(msgs.join(' · ') || 'Nothing to do');
    close();
    router.navigate('downloads');
  });
  const footer = el('div', { class: 'dl-footer' }, countText, goBtn);
  updateFooter();

  const body = el('div', { class: 'dl-dialog' }, quick, rangeRow, listHost, footer);
  close = modal({ title: 'Download chapters', body, actions: [{ label: 'Close', variant: 'ghost' }] });
}

function statusBadge(status, warning) {
  const map = { QUEUED: 'Queued', RUNNING: 'Running', COMPLETED: 'Done', FAILED: 'Failed', CANCELLED: 'Cancelled' };
  let key = (status || '').toLowerCase();
  let label = map[status] || status;
  if (status === 'COMPLETED' && warning) { key = 'queued'; label = 'Partial'; }
  return el('span', { class: `chip status-${key} dl-badge` }, label);
}

function lastReadChapterUrl(mangaId, readingOrder) {
  try {
    const hist = library.history();
    const entries = (hist && hist.entries) || [];
    for (const h of entries) {
      const key = mangaKey(h && h.manga, h && h.sourceId);
      if (key && key === mangaId) {
        const u = h.chapterUrl || h.chapterId || '';
        if (u && readingOrder.some((c) => c && c.url === u)) return u;
        return u || '';
      }
    }
  } catch { /* ignore */ }
  return '';
}

function openCategories(manga, mangaId) {
  const body = el('div', { class: 'list' });
  modal({
    title: 'Add to category',
    body,
    actions: [{ label: 'Done', primary: true }],
  });

  if (!library.isFavourite(mangaId)) {
    library.toggleFavourite(manga);
  }

  function refresh() {
    let cats, assigned;
    try {
      cats = library.categories();
      assigned = library.categoriesForManga(mangaId);
    } catch (e) {
      body.replaceChildren(errorBox(e && e.message ? e.message : 'Failed to load categories.'));
      return;
    }
    const list = (cats && cats.categories) || [];
    const assignedIds = new Set(((assigned && assigned.categories) || []).map((c) => c.id));

    const rows = el('div', { class: 'list' });
    if (!list.length) {
      rows.appendChild(emptyState('No categories yet. Create one below.'));
    } else {
      for (const cat of list) {
        const isOn = assignedIds.has(cat.id);
        const toggle = chip(isOn ? 'In list' : 'Add', { active: isOn });
        toggle.addEventListener('click', () => {
          try {
            if (assignedIds.has(cat.id)) {
              library.removeFromCategory({ mangaId, categoryId: cat.id });
            } else {
              library.addToCategory({ mangaId, categoryId: cat.id });
            }
            refresh();
          } catch (e) {
            toast(e && e.message ? e.message : 'Update failed');
          }
        });
        rows.appendChild(el('div', { class: 'row-item' },
          el('div', { class: 'row-main' }, el('div', { class: 'name' }, clean(cat.title) || 'Untitled')),
          el('div', { class: 'row-actions' }, toggle),
        ));
      }
    }

    const input = el('input', { class: 'field', type: 'text', placeholder: 'New category name' });
    const createBtn = btn('Create', {
      variant: 'accent', icon: 'plus',
      onClick: () => {
        const name = input.value.trim();
        if (!name) { toast('Enter a category name'); return; }
        try {
          const res = library.createCategory(name);
          if (res && res.id) library.addToCategory({ mangaId, categoryId: res.id });
          input.value = '';
          refresh();
        } catch (e) {
          toast(e && e.message ? e.message : 'Create failed');
        }
      },
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); createBtn.click(); }
    });

    body.replaceChildren(rows, el('div', { class: 'row' }, input, createBtn));
  }

  refresh();
}

// ── Tracking sheet ───────────────────────────────────────────────────────────
// Mirrors the android/Aidoku model: per connected service, either search + link
// this manga, or show + edit its status / progress / score, or unlink.
function openTracking(manga, mangaId, title, currentChapter = 0) {
  const body = el('div', { class: 'list' });
  modal({ title: 'Tracking', body, actions: [{ label: 'Done', primary: true }] });

  const STATUSES = ['reading', 'planning', 'completed', 'paused', 'dropped', 'rereading'];
  const statusLabel = (s) => ({
    reading: 'Reading', planning: 'Planning', completed: 'Completed',
    paused: 'On hold', dropped: 'Dropped', rereading: 'Re-reading',
  }[s] || s);
  const busy = () => el('div', { class: 'row', style: { justifyContent: 'center', padding: '16px' } }, spinner());

  async function refresh() {
    body.replaceChildren(busy());
    const connected = tracking.connectedTrackers();
    if (!connected.length) {
      body.replaceChildren(emptyState(
        'No trackers connected — Connect AniList, MyAnimeList, MangaBaka or Kitsu in Settings → Tracking to sync your progress.',
        'bookmark'));
      return;
    }
    const rows = el('div', { class: 'list' });
    for (const t of connected) rows.appendChild(await trackerRow(t));
    body.replaceChildren(rows);
  }

  async function trackerRow(t) {
    const mediaId = tracking.linkedMediaId(t.slug, mangaId);
    if (mediaId == null) {
      const trackBtn = btn('Track', { variant: 'accent', icon: 'plus', onClick: () => linkFlow(t) });
      return el('div', { class: 'row-item' },
        el('div', { class: 'row-main' }, el('div', { class: 'name' }, t.name), el('div', { class: 'sub' }, 'Not tracked')),
        el('div', { class: 'row-actions' }, trackBtn));
    }
    let st = null;
    try { st = await tracking.getState(t.slug, mediaId); } catch { /* ignore */ }
    const status = (st && st.status) || 'reading';
    let progress = (st && st.progress) || 0;
    // Bring the tracker up to your current Nyora progress (never regress it) —
    // this backfills a freshly-linked service that starts at 0 (e.g. MangaBaka).
    // Only advance the SHOWN progress if the tracker actually accepted the write
    // (setState resolves false on a rejected write), so we never display a sync
    // that didn't land on the tracker's side.
    if (currentChapter > progress) {
      const ok = await tracking.setState(t.slug, mediaId, { status, progress: currentChapter }).catch(() => false);
      if (ok) progress = currentChapter;
    }
    const score10 = st && st.score != null ? Math.round(st.score * 10) : 0;

    const statusSel = menuSelect(
      STATUSES.map((s) => ({ value: s, label: statusLabel(s) })), status,
      (v) => tracking.setState(t.slug, mediaId, { status: v }).then((ok) => toast(ok ? `${t.name} updated` : 'Update failed')),
      { label: `${t.name} status` });
    const scoreSel = menuSelect(
      Array.from({ length: 11 }, (_, i) => ({ value: String(i), label: i === 0 ? 'Score' : String(i) })), String(score10),
      (v) => tracking.setState(t.slug, mediaId, { score: Number(v) / 10 }).then((ok) => toast(ok ? 'Score set' : 'Update failed')),
      { label: `${t.name} score` });
    const unlinkBtn = iconBtn('trash', () => { tracking.unlink(t.slug, mangaId); toast(`${t.name} unlinked`); refresh(); }, 'Unlink');

    return el('div', { class: 'row-item' },
      el('div', { class: 'row-main' },
        el('div', { class: 'name' }, t.name),
        el('div', { class: 'sub' }, `Chapter ${progress}${score10 ? ` · score ${score10}` : ''}`)),
      el('div', { class: 'row-actions', style: { gap: '6px', flexWrap: 'wrap' } }, statusSel, scoreSel, unlinkBtn));
  }

  async function linkFlow(t) {
    body.replaceChildren(busy());
    let results = [];
    try { results = await tracking.search(t.slug, title); } catch { /* ignore */ }
    const picker = el('div', { class: 'list' });
    picker.appendChild(btn('Back', { variant: 'ghost', icon: 'back', onClick: () => refresh() }));
    if (!results.length) {
      picker.appendChild(emptyState(`No matches — nothing on ${t.name} matched “${title}”.`, 'search'));
    } else {
      for (const r of results.slice(0, 10)) {
        const pick = el('div', { class: 'row-item', style: { cursor: 'pointer' } },
          el('div', { class: 'row-main' },
            el('div', { class: 'name' }, r.title || 'Untitled'),
            r.altTitle ? el('div', { class: 'sub' }, r.altTitle) : null));
        pick.addEventListener('click', async () => {
          tracking.link(t.slug, mangaId, r.id);
          try { await tracking.setState(t.slug, r.id, { status: 'reading' }); } catch { /* ignore */ }
          toast(`Tracked on ${t.name}`);
          refresh();
        });
        picker.appendChild(pick);
      }
    }
    body.replaceChildren(picker);
  }

  refresh();
}

export default { meta, render };
