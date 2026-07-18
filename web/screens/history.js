// screens/history.js — reading history, grouped into dated sections, resumable.
//
// library.history() returns HistoryEntry rows (newest-first) from the per-client
// store (core/library.js). We bucket them by `updatedAt` into Today / Yesterday /
// This week / Earlier sections, each a .list of .row-item rows: cover thumb +
// title + chapter + a .progress bar with a NN% label. Tapping the row body (or
// thumb) RESUMES in the reader at the stored chapter/page; a per-row remove
// (library.removeHistory) and a header "Clear all" (confirmDialog ->
// library.clearHistory) manage the list. A live search filter narrows by title
// or chapter. Skeleton rows show while the (synchronous) store warms up.
//
// HistoryEntry = {manga, sourceId, chapterUrl, chapterId, chapterTitle,
// chapterNumber, page, total, percent, updatedAt}. The FULL manga object is
// stored on each entry, so covers/titles render with no extra fetch. The web
// reader/details routes key on source + manga url + chapter url, so we resume
// with {sid:sourceId, url:manga.url, chapterUrl:entry.chapterUrl, page} and open
// details with {sid:sourceId, url:manga.url}; both screens validate and show a
// friendly error if a row can no longer be resolved.

import {
  el, $, proxyImage, applyImage, toast, emptyState, errorBox, sectionHeader,
  iconBtn, icon, btn, confirmDialog, fmt,
} from '../core/ui.js';
import { store, router } from '../core/store.js';
import library from '../core/library.js';

export const meta = {
  title: 'History',
  nav: false,
  icon: 'history',
  order: 20,
};

// In-screen UI state (search query). Kept module-local so a re-render of the
// body (after remove/clear) preserves what the user typed.
let _query = '';
// The single active 'nyora:library-restored' listener; replaced each render
// so navigating to History repeatedly cannot leak listeners/closures.
let _onRestored = null;

export function render(view, _params) {
  view.replaceChildren();
  _query = '';

  const clearBtn = btn('Clear all', {
    variant: 'ghost',
    icon: 'trash',
    class: 'btn-danger',
    title: 'Clear all reading history',
    onClick: () => clearAll(body, clearBtn, search),
  });
  clearBtn.style.display = 'none'; // shown once we know there are rows

  const header = sectionHeader('History', clearBtn);

  const search = el('div', { class: 'field', style: { marginBottom: '14px' } },
    el('input', {
      class: 'field',
      type: 'search',
      placeholder: 'Search history',
      'aria-label': 'Search reading history',
      value: _query,
      onInput: (e) => {
        _query = e.target.value;
        renderList();
      },
    }),
  );
  search.style.display = 'none'; // shown once we know there are rows

  const body = el('div', { class: 'history-body' });
  view.append(header, search, body);

  // Closure rerender so remove/clear/search all funnel through one path.
  const renderList = () => paint(body, clearBtn, search);

  // Skeleton first frame, then paint from the synchronous store.
  body.replaceChildren(skeletonList());
  // Defer one tick so the skeleton is visible even on instant stores.
  requestAnimationFrame(renderList);

  // Repaint when a cloud restore completes (fired by settings.js after restoreFromCloud).
  // Drop any listener from a previous History mount so visits don't leak
  // listeners/stale closures (the shared #view is reused, never detached).
  if (_onRestored) window.removeEventListener('nyora:library-restored', _onRestored);
  _onRestored = () => renderList();
  window.addEventListener('nyora:library-restored', _onRestored, { once: false });
}

// Pull from the synchronous store and (re)paint sections honouring the filter.
function paint(body, clearBtn, search) {
  let rows;
  try {
    const res = library.history();
    rows = (res && res.entries) || [];
  } catch (err) {
    if (clearBtn) clearBtn.style.display = 'none';
    if (search) search.style.display = 'none';
    body.replaceChildren(
      errorBox(`Couldn't load history: ${err.message || err}`),
      el('div', { class: 'center', style: { marginTop: '12px' } },
        btn('Retry', { variant: 'ghost', icon: 'refresh', onClick: () => paint(body, clearBtn, search) }),
      ),
    );
    return;
  }

  if (!rows.length) {
    if (clearBtn) clearBtn.style.display = 'none';
    if (search) search.style.display = 'none';
    body.replaceChildren(emptyState('No reading history yet — open a chapter and it shows up here.'));
    return;
  }

  // There is history: reveal the header action and the search box.
  if (clearBtn) clearBtn.style.display = '';
  if (search) search.style.display = '';

  // Newest-first (defensive; the store already orders by updatedAt desc).
  rows.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));

  // Apply the live filter (title + chapter).
  const q = _query.trim().toLowerCase();
  const filtered = q ? rows.filter((r) => matches(r, q)) : rows;

  if (!filtered.length) {
    body.replaceChildren(emptyState(`No history matches “${_query.trim()}”.`));
    return;
  }

  // Bucket by recency.
  const buckets = groupByRecency(filtered);
  const frag = document.createDocumentFragment();
  for (const { label, items } of buckets) {
    if (!items.length) continue;
    frag.appendChild(el('div', { class: 'section-header' }, el('h2', null, label)));
    const list = el('div', { class: 'list' });
    for (const row of items) list.appendChild(rowItem(row, body, clearBtn, search));
    frag.appendChild(list);
  }
  body.replaceChildren(frag);
}

function matches(row, q) {
  const manga = (row && row.manga) || {};
  const title = (manga.title || '').toLowerCase();
  const chapter = (row.chapterTitle || '').toLowerCase();
  return title.includes(q) || chapter.includes(q);
}

// ── dated grouping ────────────────────────────────────────────────────────
// Today / Yesterday / This week / Earlier, keyed on calendar day boundaries so
// "Today" means same calendar date, not "within 24h".
function groupByRecency(rows) {
  const today = startOfDay(Date.now());
  const yesterday = today - 86_400_000;
  const weekAgo = today - 6 * 86_400_000; // last 7 calendar days incl. today

  const buckets = [
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'This week', items: [] },
    { label: 'Earlier', items: [] },
  ];

  for (const row of rows) {
    const ms = Number(row.updatedAt);
    const day = Number.isFinite(ms) && ms > 0 ? startOfDay(ms) : 0;
    if (day >= today) buckets[0].items.push(row);
    else if (day >= yesterday) buckets[1].items.push(row);
    else if (day >= weekAgo) buckets[2].items.push(row);
    else buckets[3].items.push(row);
  }
  return buckets;
}

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ── row ───────────────────────────────────────────────────────────────────
function rowItem(row, body, clearBtn, search) {
  const item = el('div', { class: 'row-item' });

  const manga = (row && row.manga) || {};
  const title = (manga.title && manga.title.trim()) || 'Untitled';

  // Some sources return no cover in chapter details, so the recorded entry has
  // none — but the card grid cached one when the manga was browsed. Backfill.
  if (!manga.coverUrl && !manga.largeCoverUrl && manga.url) {
    const hint = store.cachedManga(manga.url);
    if (hint && (hint.coverUrl || hint.largeCoverUrl)) {
      manga.coverUrl = hint.coverUrl || '';
      manga.largeCoverUrl = hint.largeCoverUrl || '';
    }
  }

  // Cover thumbnail (direct-first; proxy fallback). Missing/broken covers show
  // a monogram tile instead of collapsing — rows stay aligned.
  const fallbackThumb = () => el('div', { class: 'thumb thumb-fallback', 'aria-hidden': 'true' }, (title[0] || '?').toUpperCase());
  const cover = manga.coverUrl || manga.largeCoverUrl || '';
  if (cover) {
    const img = el('img', { class: 'thumb', loading: 'lazy', decoding: 'async', alt: manga.title || '' });
    applyImage(img, cover, undefined, () => { img.replaceWith(fallbackThumb()); });
    item.appendChild(img);
  } else {
    item.appendChild(fallbackThumb());
  }
  const chapter = (row.chapterTitle && row.chapterTitle.trim()) || 'Chapter';
  const pct = Math.round(clampPercent(row.percent) * 100);

  // Sub line: chapter · page · relative time.
  const subParts = [
    chapter,
    `Page ${(Number(row.page) || 0) + 1}`,
    relativeTime(row.updatedAt),
  ].filter(Boolean);

  // Progress bar with an inline percent label.
  const progress = el('div', { class: 'progress', title: `${pct}% read` },
    el('span', { style: { width: `${pct}%` } }),
  );

  const main = el(
    'div',
    { class: 'row-main', role: 'button', tabindex: '0', 'aria-label': `Resume ${title}` },
    el('div', { class: 'name', title }, title),
    el('div', { class: 'sub', title: chapter }, `${subParts.join(' · ')} · ${pct}%`),
    progress,
  );
  main.style.cursor = 'pointer';

  // row-main is the SINGLE resume target. The cover img is swapped out for a
  // fallback tile when it errors (applyImage -> replaceWith), so a handler on
  // the img would be lost on broken covers; bind click + keyboard here instead.
  const resume = () => resumeReading(row);
  main.addEventListener('click', resume);
  main.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      resume();
    }
  });

  const actions = el(
    'div',
    { class: 'row-actions' },
    iconBtn('info', () => openDetails(row), 'Open details'),
    iconBtn('trash', () => removeRow(row, body, clearBtn, search), 'Remove from history'),
  );

  item.append(main, actions);
  return item;
}

// Open the title's details page. The manga url is the identifier the details
// route expects as `url`.
function openDetails(row) {
  try {
    const sid = row.sourceId;
    const url = row.manga && row.manga.url;
    if (!sid || !url) {
      toast('This entry can no longer be opened.');
      return;
    }
    router.navigate('details', { sid, url });
  } catch (err) {
    toast(`This source isn't available right now — open it from Explore to read.`);
  }
}

// Jump straight back into the reader at the last chapter/page. Falls back to
// details when there is no chapter coordinate to resume from.
function resumeReading(row) {
  try {
    const sid = row.sourceId;
    const url = row.manga && row.manga.url;
    const chapterUrl = row.chapterUrl || row.chapterId;
    if (!sid || !url || !chapterUrl) {
      openDetails(row);
      return;
    }
    const params = { sid, url, chapterUrl };
    const page = Number(row.page);
    if (Number.isFinite(page) && page > 0) params.page = page;
    router.navigate('reader', params);
  } catch (err) {
    toast(`This source isn't available right now — open it from Explore to read.`);
  }
}

function removeRow(row, body, clearBtn, search) {
  const mangaId = mangaIdOf(row);
  if (!mangaId) {
    toast('This entry has no id to remove.');
    return;
  }
  try {
    library.removeHistory({ mangaId });
    toast('Removed from history');
    paint(body, clearBtn, search);
  } catch (err) {
    toast(`Couldn't remove entry: ${err.message || err}`);
  }
}

async function clearAll(body, clearBtn, search) {
  const ok = await confirmDialog('Clear your entire reading history? This cannot be undone.');
  if (!ok) return;
  try {
    library.clearHistory();
    toast('History cleared');
    // paint() detects the now-empty store and shows the empty state, hiding the
    // header action and search box.
    paint(body, clearBtn, search);
  } catch (err) {
    toast(`Couldn't clear history: ${err.message || err}`);
  }
}

// Reconstruct the library's manga identity key for an entry so removeHistory
// targets the right row: manga.id, else `${sourceId}|${manga.url}` (mirrors
// keyOf() in core/library.js).
function mangaIdOf(row) {
  const manga = (row && row.manga) || {};
  if (manga.id !== undefined && manga.id !== null && manga.id !== '') {
    return String(manga.id);
  }
  const sid = row && row.sourceId != null ? row.sourceId : '';
  const url = manga.url != null ? manga.url : '';
  if (!url) return '';
  return `${sid}|${url}`;
}

// 0..1 progress, tolerating out-of-range / missing values.
function clampPercent(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

// Relative timestamp from epoch millis: "Just now", "5m ago", "3h ago",
// "2d ago", else an absolute short date.
function relativeTime(epochMs) {
  const ms = Number(epochMs);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const diff = Date.now() - ms;
  if (diff < 0) return 'Just now';
  const min = 60_000, hour = 3_600_000, day = 86_400_000;
  if (diff < min) return 'Just now';
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return fmt.date(ms);
}

// ── skeleton ────────────────────────────────────────────────────────────────
function skeletonRow() {
  return el('div', { class: 'row-item' },
    el('div', { class: 'thumb skeleton' }),
    el('div', { class: 'row-main' },
      el('div', { class: 'name skeleton', style: { height: '14px', width: '60%' } }),
      el('div', { class: 'sub skeleton', style: { height: '11px', width: '40%', marginTop: '8px' } }),
      el('div', { class: 'progress skeleton', style: { marginTop: '8px' } }),
    ),
  );
}

function skeletonList() {
  const frag = document.createDocumentFragment();
  frag.appendChild(el('div', { class: 'section-header' },
    el('h2', { class: 'skeleton', style: { height: '15px', width: '90px' } }, '')));
  const list = el('div', { class: 'list' });
  for (let i = 0; i < 5; i++) list.appendChild(skeletonRow());
  frag.appendChild(list);
  return frag;
}

export default { meta, render };
