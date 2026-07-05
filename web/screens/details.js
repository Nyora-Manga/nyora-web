// screens/details.js — the hero screen for a single manga.

import { api } from '../core/api.js';
import {
  el, $, $$, icon, spinner, proxyImage, applyImage, toast, btn, iconBtn, chip,
  emptyState, errorBox, modal, fmt,
} from '../core/ui.js';
import { router, store } from '../core/store.js';
import library from '../core/library.js';
import { downloads } from '../core/downloads.js';

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
    spinner(),
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
        el('img', { src: cachedCover, alt: cachedTitle, style: { width: '90px', borderRadius: '10px' } }),
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

// ── lightweight anchored dropdown menu ───────────────────────────────────────
function openMenu(anchor, items) {
  const menu = el('div', { class: 'row-menu' },
    ...items.filter(Boolean).map((it) => el('button', {
      class: 'row-menu-item' + (it.danger ? ' danger' : ''), type: 'button',
      onClick: (e) => { e.stopPropagation(); close(); it.onClick(); },
    }, it.icon ? icon(it.icon) : null, el('span', null, it.label))));
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const top = Math.min(r.bottom + 6, window.innerHeight - menu.offsetHeight - 10);
  const left = Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 10);
  menu.style.top = `${Math.max(10, top)}px`;
  menu.style.left = `${Math.max(10, left)}px`;
  const close = () => { menu.remove(); document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onKey, true); };
  const onDoc = (e) => { if (!menu.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  setTimeout(() => { document.addEventListener('mousedown', onDoc, true); document.addEventListener('keydown', onKey, true); }, 0);
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
  const title = clean(manga.title) || 'Untitled';
  const authors = authorsText(manga);
  const publicUrl = clean(manga.publicUrl) || clean(manga.url);

  // readingOrder: newest-first index space (kept for parity with download/reader).
  const readingOrder = chapters.slice().reverse();
  const ascByNumber = readingOrder.slice().sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));

  // ── read-state resolution (history-derived + explicit overrides) ──────────
  const overrides = readOverrides(mangaId);
  function derivedRead() {
    const lastReadUrl = lastReadChapterUrl(mangaId, readingOrder);
    const lastReadIdx = readingOrder.findIndex((c) => c.url === lastReadUrl);
    return (c) => lastReadIdx >= 0 && readingOrder.indexOf(c) <= lastReadIdx;
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
  if (rawCover) {
    const img = el('img', { loading: 'lazy', decoding: 'async', alt: title });
    applyImage(img, rawCover, coverHeaders, () => { img.style.display = 'none'; });
    coverWrap.appendChild(img);
  }
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
    try { const res = library.toggleFavourite(manga); favourited = !!(res && res.favourited); paintFav(); }
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
      iconBtn('anilist', () => router.navigate('tracker', { title }), 'Track'),
      publicUrl ? iconBtn('external', () => window.open(publicUrl, '_blank'), 'Open site') : null,
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
  const filterBtn = iconBtn('filter', (e) => openMenu(e.currentTarget, [
    { label: 'All chapters', icon: state2.filter === 'all' ? 'check' : null, onClick: () => { state2.filter = 'all'; renderRows(); } },
    { label: 'Unread only', icon: state2.filter === 'unread' ? 'check' : null, onClick: () => { state2.filter = 'unread'; renderRows(); } },
    { label: 'Downloaded only', icon: state2.filter === 'downloaded' ? 'check' : null, onClick: () => { state2.filter = 'downloaded'; renderRows(); } },
  ]), 'Filter');
  const sortBtn = iconBtn('sort', (e) => openMenu(e.currentTarget, [
    { label: `By chapter number${state2.sortKey === 'number' ? (state2.asc ? ' ↑' : ' ↓') : ''}`, icon: state2.sortKey === 'number' ? 'check' : null,
      onClick: () => { if (state2.sortKey === 'number') state2.asc = !state2.asc; else { state2.sortKey = 'number'; state2.asc = false; } renderRows(); } },
    { label: `By upload date${state2.sortKey === 'date' ? (state2.asc ? ' ↑' : ' ↓') : ''}`, icon: state2.sortKey === 'date' ? 'check' : null,
      onClick: () => { if (state2.sortKey === 'date') state2.asc = !state2.asc; else { state2.sortKey = 'date'; state2.asc = false; } renderRows(); } },
  ]), 'Sort');
  const markAllBtn = iconBtn('check', (e) => openMenu(e.currentTarget, [
    { label: 'Mark all as read', icon: 'check', onClick: () => { for (const c of readingOrder) setRead(c, true); renderRows(); toast('Marked all read'); } },
    { label: 'Mark all as unread', onClick: () => { for (const c of readingOrder) setRead(c, false); renderRows(); toast('Marked all unread'); } },
  ]), 'Mark');

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
  if (!ascByNumber.length) return btn('Read', { primary: true, icon: 'play', class: 'd2-cta', onClick: () => {} });
  const lastUrl = lastReadChapterUrl(mangaId, ascByNumber);
  const firstUnread = ascByNumber.find((c) => !isRead(c));
  const target = firstUnread || ascByNumber[ascByNumber.length - 1];
  const started = !!lastUrl;
  const num = target && target.number != null && Number(target.number) > 0
    ? (Number.isInteger(Number(target.number)) ? Number(target.number) : Number(target.number).toFixed(1)) : null;
  const label = !firstUnread ? 'Read again' : (started ? 'Continue' : 'Start reading');
  return btn(num != null ? `${label} · Ch ${num}` : label, {
    primary: true, icon: 'play', class: 'd2-cta',
    onClick: () => router.navigate('reader', { sid, url, chapterUrl: (firstUnread || ascByNumber[0]).url }),
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
    openMenu(e.currentTarget, [
      { label: read ? 'Mark as unread' : 'Mark as read', icon: read ? 'close' : 'check',
        onClick: () => { ctx.setRead(chapter, !read); ctx.rerender(); } },
      { label: 'Mark previous as read', icon: 'check',
        onClick: () => { ctx.markPreviousRead(chapter); ctx.rerender(); } },
      { label: downloaded ? 'Downloaded' : 'Download', icon: 'download',
        onClick: () => { downloads.enqueue([downloadDesc(sid, url, mangaId, mangaTitle, chapter, index)]); toast('Queued ' + title); } },
    ]);
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
  const lastReadOldIdx = chapters.findIndex((c) => c.url === lastUrl);

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
    chapters.forEach((c, i) => { if (lastReadOldIdx < 0 || i > lastReadOldIdx) selected.add(c.url); });
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
  const mkOptions = () => readingOrder.map((c) => el('option', { value: c.url }, fmt.chapterTitle(c, chapters.indexOf(c))));
  const fromSel = el('select', { class: 'field' }, ...mkOptions());
  const toSel = el('select', { class: 'field' }, ...mkOptions());
  fromSel.selectedIndex = 0;
  toSel.selectedIndex = toSel.options.length - 1;
  function selectRange() {
    const a = chapters.findIndex((c) => c.url === fromSel.value);
    const b = chapters.findIndex((c) => c.url === toSel.value);
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
    const cb = el('input', { type: 'checkbox' });
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(c.url); else selected.delete(c.url);
      updateFooter();
    });
    cbs.set(c.url, cb);
    const st = downloads.statusOf(sid, c.url);
    listHost.appendChild(el('label', { class: 'dl-pick' },
      cb,
      el('span', { class: 'dl-pick-name', title: fmt.chapterTitle(c, oi) }, fmt.chapterTitle(c, oi)),
      st ? statusBadge(st.status, st.warning) : null,
    ));
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
        const toggle = chip(isOn ? '✓ In list' : 'Add', { active: isOn });
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

export default { meta, render };
