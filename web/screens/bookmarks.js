// screens/bookmarks.js — saved reader pages, grouped per-manga.
//
// library.bookmarks() returns rows (newest-first) that we group by manga into
// one curated section each. A row shows: the manga cover + manga title, the
// chapter title, a "Page N" badge and an optional note. Tapping a row (or the
// open button) RESUMES READING — it opens the reader straight at that
// manga/chapter/page when we have a source + url + chapterUrl, falling back to
// the manga's details, then to a global search for the title.
//
// Bookmark rows (core/library.js) carry {id, manga, sourceId, chapterUrl,
// chapterId, chapterTitle, page, note, createdAt} where `manga` is the FULL
// stored manga object (title/coverUrl/url). A pencil edits the note in place
// (addBookmark is INSERT-OR-REPLACE keyed on manga/chapter/page); the trash
// removes it via library.removeBookmark({id}).

import { api } from '../core/api.js';
import {
  el, $, proxyImage, applyImage, toast, emptyState, errorBox, sectionHeader,
  iconBtn, btn, chip, confirmDialog, promptDialog, fmt,
} from '../core/ui.js';
import { router } from '../core/store.js';

export const meta = {
  title: 'Bookmarks',
  nav: true,
  icon: 'bookmark',
  order: 30,
};

// Token guards stale async: a fresh load() bumps it so an in-flight reload from
// a removed/edited row can't paint over a newer state.
let loadToken = 0;

export function render(view, _params) {
  view.replaceChildren();

  const header = sectionHeader('Bookmarks');
  const body = el('div', { class: 'bookmarks-body' });
  view.append(header, body);

  load(body);
}

async function load(body) {
  const token = ++loadToken;
  body.replaceChildren(skeletonGroups());

  let rows;
  try {
    const res = await api.bookmarks();
    if (token !== loadToken) return;
    rows = (res && res.entries) || [];
  } catch (err) {
    if (token !== loadToken) return;
    body.replaceChildren(
      errorBox(`Couldn't load bookmarks: ${err.message || err}`),
      el('div', { class: 'center', style: { marginTop: '12px' } },
        btn('Retry', { variant: 'ghost', icon: 'refresh', onClick: () => load(body) }),
      ),
    );
    return;
  }

  if (!rows.length) {
    body.replaceChildren(
      emptyState('No bookmarks yet — tap the ribbon while reading to save a page.'),
    );
    return;
  }

  renderGroups(body, rows);
}

function renderGroups(body, rows) {
  body.replaceChildren();

  // Group by manga so each section reads as one curated card. Identity prefers
  // the stored manga id, then source+url, then the title — so two distinct
  // titles never merge even if their display names collide.
  const groups = new Map();
  for (const row of rows) {
    const key = groupKey(row);
    let g = groups.get(key);
    if (!g) {
      g = { manga: row.manga || {}, rows: [] };
      groups.set(key, g);
    }
    g.rows.push(row);
  }

  for (const { manga, rows: groupRows } of groups.values()) {
    // Newest saved first within a section.
    groupRows.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));

    const title = (manga.title && manga.title.trim()) || 'Unknown';
    const section = el('div', { class: 'bookmark-section', style: { marginBottom: '28px' } });
    const head = sectionHeader(title, chip(`${groupRows.length} saved`));

    const list = el('div', { class: 'list' });
    for (const row of groupRows) list.appendChild(rowItem(row, body));

    section.append(head, list);
    body.appendChild(section);
  }
}

function groupKey(row) {
  const m = row.manga || {};
  if (m.id != null && m.id !== '') return `id:${m.id}`;
  if (row.sourceId && m.url) return `su:${row.sourceId}|${m.url}`;
  if (m.url) return `u:${m.url}`;
  return `t:${(m.title || '').trim() || 'Unknown'}`;
}

function rowItem(row, body) {
  const item = el('div', { class: 'row-item' });

  const manga = row.manga || {};
  const mangaTitle = manga.title || '';
  const coverUrl = manga.coverUrl || manga.largeCoverUrl || '';
  if (coverUrl) {
    const img = el('img', { class: 'thumb', loading: 'lazy', decoding: 'async', alt: mangaTitle });
    applyImage(img, coverUrl, undefined, () => { img.style.display = 'none'; });
    item.appendChild(img);
  }

  const note = (row.note || '').trim();
  const chapterTitle = (row.chapterTitle && row.chapterTitle.trim()) || 'Chapter';
  const pageNo = (Number(row.page) || 0) + 1;
  const dateStr = fmt.date(row.createdAt);

  const main = el(
    'div',
    {
      class: 'row-main',
      role: 'button',
      tabindex: '0',
      'aria-label': `Resume ${chapterTitle}${mangaTitle ? ` — ${mangaTitle}` : ''}`,
    },
    el('div', { class: 'name', title: chapterTitle }, chapterTitle),
    el('div', { class: 'sub' },
      chip(`Page ${pageNo}`),
      dateStr ? el('span', { style: { marginLeft: '8px', color: 'var(--text-faint)' } }, dateStr) : null,
    ),
    note
      ? el('div', {
          class: 'sub',
          style: { color: 'var(--text)', marginTop: '4px', whiteSpace: 'normal' },
          title: note,
        }, note)
      : null,
  );
  main.style.cursor = 'pointer';

  const open = () => openBookmark(row);

  const actions = el(
    'div',
    { class: 'row-actions' },
    iconBtn('play', open, 'Resume reading here'),
    iconBtn('settings', () => editNote(row, body), note ? 'Edit note' : 'Add note'),
    iconBtn('trash', () => removeRow(row, body), 'Remove bookmark'),
  );

  // Clicking the row body (cover + main, not the action buttons) resumes.
  main.addEventListener('click', open);
  main.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });
  const thumb = $('.thumb', item);
  if (thumb) {
    thumb.style.cursor = 'pointer';
    thumb.addEventListener('click', open);
  }

  item.append(main, actions);
  return item;
}

// Resume reading at the saved page. When the stored manga carries a
// source-relative url + sourceId AND we know the chapter url, open the reader
// straight there (passing `page` through for forward-compat resume). Otherwise
// fall back to the manga's details, then to a global search for the title.
function openBookmark(row) {
  const manga = row.manga || {};
  const title = (manga.title && manga.title.trim()) || '';
  const sid = row.sourceId
    || (manga.source && (manga.source.name || manga.source.id))
    || '';
  const url = manga.url || '';
  const chapterUrl = row.chapterUrl || row.chapterId || '';
  const page = Number(row.page) || 0;

  if (sid && url && chapterUrl) {
    toast(`Resuming "${title || 'title'}" at page ${page + 1}`);
    router.navigate('reader', { sid, url, chapterUrl, page });
    return;
  }
  if (sid && url) {
    toast(`Opening "${title || 'title'}" — saved at page ${page + 1}`);
    router.navigate('details', { sid, url });
    return;
  }
  if (!title) {
    toast('This bookmark has no title to resume from.');
    return;
  }
  toast(`Searching for "${title}" — saved at page ${page + 1}`);
  router.navigate('search', { q: title });
}

async function editNote(row, body) {
  const next = await promptDialog('Bookmark note', row.note || '');
  if (next === null) return; // cancelled
  const note = next.trim();
  try {
    // addBookmark is INSERT-OR-REPLACE on (mangaId, chapterId, page): re-adding
    // the same coordinates updates the note in place. Passing the full stored
    // manga + sourceId reproduces the same identity key.
    await api.addBookmark({
      manga: row.manga || null,
      sourceId: row.sourceId,
      chapterUrl: row.chapterUrl,
      chapterId: row.chapterId,
      chapterTitle: row.chapterTitle || '',
      page: Number(row.page) || 0,
      note,
    });
    toast(note ? 'Note saved' : 'Note cleared');
    load(body);
  } catch (err) {
    toast(`Couldn't save note: ${err.message || err}`);
  }
}

async function removeRow(row, body) {
  const ok = await confirmDialog('Remove this bookmark?');
  if (!ok) return;
  try {
    // Every stored Bookmark carries a unique id, so prefer it. (The coordinate
    // fallback would need the resolved mangaId, which only library.js computes.)
    if (row.id != null) {
      await api.removeBookmark({ id: row.id });
    } else {
      await api.removeBookmark({
        manga: row.manga || null,
        sourceId: row.sourceId,
        chapterId: row.chapterId,
        page: Number(row.page) || 0,
      });
    }
    toast('Bookmark removed');
    load(body);
  } catch (err) {
    toast(`Couldn't remove bookmark: ${err.message || err}`);
  }
}

// Skeleton: a couple of grouped sections with row-shaped placeholders so the
// screen never flashes blank while bookmarks load.
function skeletonGroups() {
  const frag = document.createDocumentFragment();
  for (let s = 0; s < 2; s++) {
    const section = el('div', { class: 'bookmark-section', style: { marginBottom: '28px' } });
    const head = el('div', { class: 'section-header' },
      el('div', { class: 'skeleton', style: { height: '17px', width: '40%', borderRadius: 'var(--radius-sm)' } }));
    const list = el('div', { class: 'list' });
    for (let i = 0; i < 3; i++) list.appendChild(skeletonRow());
    section.append(head, list);
    frag.appendChild(section);
  }
  return frag;
}

function skeletonRow() {
  return el('div', { class: 'row-item' },
    el('div', { class: 'skeleton thumb' }),
    el('div', { class: 'row-main' },
      el('div', { class: 'skeleton', style: { height: '14px', width: '55%', borderRadius: 'var(--radius-sm)' } }),
      el('div', { class: 'skeleton', style: { height: '12px', width: '35%', borderRadius: 'var(--radius-sm)', marginTop: '8px' } }),
    ),
  );
}
