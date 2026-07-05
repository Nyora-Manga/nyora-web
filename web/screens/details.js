// screens/details.js — the hero screen for a single manga.

import { api } from '../core/api.js';
import {
  el, $, proxyImage, applyImage, toast, btn, iconBtn, chip,
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
  const skLine = (h, w, mb) => el('div', { class: 'skeleton', style: { height: h, width: w, borderRadius: '6px', marginBottom: mb || '0' } });

  const summary = el('div', { class: 'details-summary' },
    el('div', { class: 'cover skeleton' }),
    skLine('26px', '80%', '12px'),
    skLine('13px', '50%', '18px'),
    el('div', { class: 'chips' },
      el('span', { class: 'skeleton', style: { height: '26px', width: '78px', borderRadius: '999px' } }),
      el('span', { class: 'skeleton', style: { height: '26px', width: '64px', borderRadius: '999px' } }),
    ),
    el('div', { class: 'details-actions', style: { marginTop: '16px' } },
      el('div', { class: 'skeleton', style: { height: '40px', width: '100%', borderRadius: '11px' } }),
    ),
  );

  const rows = el('ul', { class: 'chapter-list' });
  for (let i = 0; i < 9; i++) {
    rows.appendChild(el('li', { class: 'skeleton-row' },
      skLine('14px', (52 + (i % 4) * 9) + '%'),
      skLine('11px', '64px'),
    ));
  }
  const chaptersPane = el('div', { class: 'details-chapters' },
    el('div', { class: 'section-header' }, el('h2', null, 'Chapters')),
    rows,
  );

  return el('div', { class: 'details-hero' },
    el('div', { class: 'hero-bg' }),
    el('div', { class: 'details-head' }, summary, chaptersPane),
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

function buildDetails(view, sid, url, manga, chapters, params) {
  const mangaId = mangaKey(manga, sid);
  const hint = store.cachedManga(url) || {};
  const rawCover = manga.largeCoverUrl || manga.coverUrl || hint.largeCoverUrl || hint.coverUrl || '';
  const coverDomain = manga.source && manga.source.domain;
  const coverHeaders = coverDomain ? { Referer: `https://${coverDomain}/` } : undefined;
  const nsfw = manga.isNsfw === true || manga.contentRating === 'ADULT';
  const title = clean(manga.title) || 'Untitled';
  const readingOrder = chapters.slice().reverse();

  // ── Cover ─────────────────────────────────────────────────────────────
  const coverWrap = el('div', { class: 'cover' });
  if (rawCover) {
    const img = el('img', { loading: 'lazy', decoding: 'async', alt: clean(manga.title) });
    applyImage(img, rawCover, coverHeaders, () => { img.style.display = 'none'; });
    coverWrap.appendChild(img);
  }
  if (nsfw) coverWrap.appendChild(el('span', { class: 'badge nsfw' }, '18+'));

  const coverDownload = iconBtn('download', (e) => {
    e.stopPropagation();
    openDownloadDialog(sid, url, mangaId, title, chapters);
  }, 'Download chapters');
  coverDownload.classList.add('cover-download-btn');
  coverWrap.appendChild(coverDownload);

  // ── Meta chips ─────────────────────────────────────────────────────────
  const metaChips = [];
  const state = clean(manga.state);
  if (state) metaChips.push(chip(state.replace(/_/g, ' '), { active: true }));
  if (typeof manga.rating === 'number' && manga.rating > 0) metaChips.push(chip(fmt.rating(manga.rating)));
  const contentRating = clean(manga.contentRating);
  if (contentRating && contentRating !== 'SAFE') metaChips.push(chip(contentRating, { nsfw }));
  metaChips.push(chip(chapters.length + (chapters.length === 1 ? ' chapter' : ' chapters')));

  const authors = authorsText(manga);

  const tags = (Array.isArray(manga.tags) ? manga.tags : [])
    .map((t) => clean(t && (t.title || t.key)))
    .filter(Boolean)
    .slice(0, 20);
  const tagRow = tags.length
    ? el('div', { class: 'chips tag-chips' },
        ...tags.map((t) => chip(t, { onClick: () => router.navigate('search', { q: t }) })))
    : null;

  const descText = plainText(manga.description);
  let descNode;
  if (descText) {
    const p = el('p', { class: 'desc clamp' }, descText);
    const moreBtn = btn('Show more', {
      variant: 'ghost', class: 'btn-sm',
      onClick: () => {
        const clamped = p.classList.toggle('clamp');
        const lbl = $('span:not(.icon)', moreBtn);
        if (lbl) lbl.textContent = clamped ? 'Show more' : 'Show less';
      },
    });
    descNode = el('div', { class: 'desc-wrap' }, p, moreBtn);
  } else {
    descNode = el('p', { class: 'desc desc-empty' }, 'No description.');
  }

  const favBtn = btn('Favourite', { variant: 'ghost', icon: 'heart' });
  let favourited = library.isFavourite(mangaId);
  function paintFav() {
    favBtn.classList.toggle('btn-accent', favourited);
    favBtn.classList.toggle('btn-ghost', !favourited);
    const lbl = $('span:not(.icon)', favBtn);
    if (lbl) lbl.textContent = favourited ? 'Favourited' : 'Favourite';
  }
  favBtn.addEventListener('click', () => {
    try {
      const res = library.toggleFavourite(manga);
      favourited = !!(res && res.favourited);
      paintFav();
    } catch (e) { toast(e.message || 'Error'); }
  });
  paintFav();

  const cta = buildCTA(sid, url, mangaId, chapters);
  const publicUrl = clean(manga.publicUrl) || clean(manga.url);

  const downloadAllBtn = btn('Download', { variant: 'ghost', icon: 'download' });
  downloadAllBtn.addEventListener('click', () => openDownloadDialog(sid, url, mangaId, title, chapters));

  const actions = el('div', { class: 'details-actions' },
    cta,
    favBtn,
    downloadAllBtn,
    el('div', { class: 'details-actions-icons' },
      iconBtn('folder', () => openCategories(manga, mangaId), 'Add to category'),
      iconBtn('anilist', () => router.navigate('tracker', { title }), 'Track'),
      publicUrl ? iconBtn('external', () => window.open(publicUrl, '_blank'), 'Open site') : null,
    ),
  );

  const summary = el('div', { class: 'details-summary' },
    coverWrap,
    el('h1', { class: 'details-title' }, title),
    authors ? el('p', { class: 'details-authors' }, authors) : null,
    el('div', { class: 'details-meta' }, ...metaChips),
    actions,
    tagRow,
    descNode,
  );

  const chapterHost = el('ul', { class: 'chapter-list' });
  let newestFirst = true;

  function renderRows() {
    chapterHost.replaceChildren();
    if (!readingOrder.length) {
      chapterHost.appendChild(emptyState('No chapters yet.'));
      return;
    }
    const lastReadUrl = lastReadChapterUrl(mangaId, readingOrder);
    const lastReadIdx = readingOrder.findIndex((c) => c.url === lastReadUrl);
    // Order the displayed chapters by chapter NUMBER so the label always matches
    // the order — "Newest" = highest number first, "Oldest" = lowest first —
    // regardless of the order the source returned the array in.
    const asc = readingOrder.slice().sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));
    const ordered = newestFirst ? asc.reverse() : asc;
    for (const c of ordered) {
      const idx = readingOrder.indexOf(c);
      const isRead = lastReadIdx >= 0 && idx <= lastReadIdx;
      // Pass the oldest-first index so a title/number-less chapter's synthesized
      // "Chapter N" label matches the download dialog and the rest of the stack.
      chapterHost.appendChild(buildChapterRow(sid, url, c, readingOrder.length - 1 - idx, isRead, mangaId, title));
    }
  }

  const sortBtn = btn('Newest', {
    variant: 'ghost', icon: 'filter', class: 'btn-sm',
    onClick: () => {
      newestFirst = !newestFirst;
      const lbl = $('span:not(.icon)', sortBtn);
      if (lbl) lbl.textContent = newestFirst ? 'Newest' : 'Oldest';
      renderRows();
    },
  });

  const chaptersPane = el('div', { class: 'details-chapters' },
    el('div', { class: 'section-header' },
      el('h2', null, 'Chapters'),
      el('div', { class: 'section-actions' }, sortBtn),
    ),
    chapterHost,
  );

  renderRows();

  const hero = el('div', { class: 'details-hero' });
  if (rawCover) {
    const bg = el('div', { class: 'hero-bg' });
    bg.style.backgroundImage = `url("${proxyImage(rawCover, coverHeaders)}")`;
    hero.appendChild(bg);
  }
  hero.appendChild(iconBtn('back', () => router.back(), 'Back'));
  $('.icon-btn', hero).classList.add('details-back');
  hero.appendChild(el('div', { class: 'details-head' }, summary, chaptersPane));

  return hero;
}

function buildCTA(sid, url, mangaId, chapters) {
  const readingOrder = chapters.slice().reverse();
  const lastUrl = lastReadChapterUrl(mangaId, readingOrder);
  const resume = readingOrder.find((c) => c.url === lastUrl);
  const target = resume || (readingOrder.length ? readingOrder[0] : null);

  if (!target) return null;
  return btn(resume ? 'Resume' : 'Read', {
    primary: true, icon: 'play', class: 'details-cta',
    onClick: () => router.navigate('reader', { sid, url, chapterUrl: target.url }),
  });
}

function buildChapterRow(sid, url, chapter, index, isRead, mangaId, mangaTitle) {
  const title = fmt.chapterTitle(chapter, index);
  const dateStr = fmt.date(chapter.uploadDate);
  const scanlator = clean(chapter.scanlator);

  const open = () => router.navigate('reader', { sid, url, chapterUrl: chapter.url });

  const metaParts = [];
  if (dateStr) metaParts.push(dateStr);
  if (scanlator) metaParts.push(scanlator);

  const st = downloads.statusOf(sid, chapter.url);
  const downloaded = st && st.status === 'COMPLETED';
  const queued = st && (st.status === 'QUEUED' || st.status === 'RUNNING');

  const dlBtn = iconBtn(downloaded ? 'check' : 'download', (e) => {
    e.stopPropagation();
    const res = downloads.enqueue([downloadDesc(sid, url, mangaId, mangaTitle, chapter, index)]);
    if (res.added) toast('Queued ' + title);
    else if (res.requeued) toast('Re-queued ' + title);
    else if (downloaded) toast('Already downloaded — re-queue with the Download menu');
    else toast('Already in queue');
  }, downloaded ? 'Downloaded' : 'Download');
  if (downloaded) dlBtn.classList.add('dl-done');
  if (queued) dlBtn.classList.add('dl-queued');

  const li = el('li', { class: isRead ? 'read' : '', role: 'button', tabindex: '0' },
    el('span', { class: 'ch-name', title }, title),
    metaParts.length ? el('span', { class: 'ch-meta' }, metaParts.join(' · ')) : null,
    dlBtn,
  );
  li.addEventListener('click', open);
  li.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  return li;
}

// Build a download-manager chapter descriptor.
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
