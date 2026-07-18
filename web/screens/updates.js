// screens/updates.js — new-chapter feed across your favourites + history.
//
// Data comes straight from the synchronous per-browser library store
// (core/library.js). library.updates() returns one row per manga that has
// gained chapters since it was last synced. The header "Refresh" runs
// library.refreshUpdates() — genuinely async, it re-scans favourites/history
// against their sources — and "Mark all seen" clears every badge.
//
// Each row is a library UpdateEntry: {mangaId, manga, mangaTitle,
// mangaCoverUrl, sourceId, newChapters, totalChapters, latestChapterTitle,
// lastSyncedAt, newChapterList}. There is NO chapterUrl, so a row cannot
// deep-link into the reader; tapping it routes to the manga's details (where
// the newest chapter is one tap away) and marks that manga's update seen on the
// way out — matching the desktop "open details from the update card" flow.

import {
  el, proxyImage, applyImage, toast, spinner, emptyState, errorBox, sectionHeader,
  btn, iconBtn, chip, fmt, skeletonCard,
} from '../core/ui.js';
import { router } from '../core/store.js';
import library from '../core/library.js';

export const meta = {
  title: 'Updates',
  nav: true,
  icon: 'bell',
  order: 40,
};

export function render(view, _params) {
  view.replaceChildren();

  const body = el('div', { class: 'updates-body' });

  // Header: title + Refresh (always) + Mark-all-seen (only once rows exist).
  const refreshBtn = btn('Refresh', {
    variant: 'ghost',
    icon: 'refresh',
    title: 'Scan your favourites & history for new chapters',
    onClick: () => refresh(body, refreshBtn, markAllBtn),
  });
  const markAllBtn = btn('Mark all seen', {
    variant: 'ghost',
    icon: 'check',
    title: 'Clear all update badges',
    onClick: () => markAll(body, markAllBtn),
  });
  markAllBtn.style.display = 'none';

  view.append(sectionHeader('Updates', markAllBtn, refreshBtn), body);

  load(body, markAllBtn);
}

// Synchronous read from the library store — but we still paint a skeleton first
// so the screen never flashes blank, matching every other screen.
function load(body, markAllBtn) {
  body.replaceChildren(skeletonList());
  if (markAllBtn) markAllBtn.style.display = 'none';

  let rows;
  try {
    const res = library.updates();
    rows = (res && res.entries) || [];
  } catch (err) {
    body.replaceChildren(
      errorBox(`Couldn't load updates: ${err.message || err}`),
      el('div', { class: 'center', style: { marginTop: '12px' } },
        btn('Retry', { variant: 'ghost', icon: 'refresh', onClick: () => load(body, markAllBtn) })),
    );
    return;
  }

  if (!rows.length) {
    body.replaceChildren(
      emptyState("You're all caught up — tap Refresh to scan your favourites and history for new chapters.", 'inbox'),
    );
    return;
  }

  // Most new chapters first, then most recently synced.
  rows.sort((a, b) =>
    (Number(b.newChapters) || 0) - (Number(a.newChapters) || 0) ||
    (Number(b.lastSyncedAt) || 0) - (Number(a.lastSyncedAt) || 0));

  const list = el('div', { class: 'list' });
  for (const row of rows) list.appendChild(rowItem(row, body, markAllBtn));

  const note = el('div', { class: 'sub', style: { margin: '0 0 12px 2px' } },
    'New chapters across your favourites and history.');

  body.replaceChildren(note, list);
  if (markAllBtn) markAllBtn.style.display = '';
}

function rowItem(row, body, markAllBtn) {
  const item = el('div', { class: 'row-item' });

  // Cover thumbnail (proxied; hide on broken image).
  const manga = row.manga || {};
  const coverUrl = row.mangaCoverUrl || manga.coverUrl || manga.largeCoverUrl || '';
  const mangaTitle = (row.mangaTitle || manga.title || '').trim() || 'Untitled';
  if (coverUrl) {
    const img = el('img', { class: 'thumb', loading: 'lazy', decoding: 'async', alt: mangaTitle });
    applyImage(img, coverUrl, undefined, () => { img.style.display = 'none'; });
    item.appendChild(img);
  }

  const count = Number(row.newChapters) || 0;
  const total = Number(row.totalChapters) || 0;
  const synced = fmt.date(row.lastSyncedAt);
  const latest = (row.latestChapterTitle || '').trim();

  const subParts = [
    total ? `${total} chapters` : null,
    synced ? `synced ${synced}` : null,
  ].filter(Boolean);

  const main = el(
    'div',
    { class: 'row-main', role: 'button', tabindex: '0', 'aria-label': `Open ${mangaTitle}` },
    el('div', { class: 'name', title: mangaTitle }, mangaTitle),
    latest
      ? el('div', { class: 'sub', title: latest, style: { color: 'var(--text)' } },
        `Latest: ${latest}`)
      : null,
    subParts.length ? el('div', { class: 'sub' }, subParts.join(' · ')) : null,
  );

  const open = () => openManga(row);
  main.style.cursor = 'pointer';
  main.addEventListener('click', open);
  main.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });

  const actions = el(
    'div',
    { class: 'row-actions' },
    chip(`${count} new`, { active: true }),
    btn('Read', { variant: 'accent', class: 'btn-sm', icon: 'play', title: 'Open details', onClick: open }),
    iconBtn('check', () => markSeen(row, body, markAllBtn), 'Mark seen'),
  );

  item.append(main, actions);
  return item;
}

// Open the manga: route to its details (newest chapter is one tap away) and mark
// this update seen so the badge clears. Updates rows carry no chapterUrl, so we
// cannot jump straight into the reader.
function openManga(row) {
  const manga = row.manga || {};
  const sid = row.sourceId || (manga.source && (manga.source.name || manga.source.id)) || '';
  const url = manga.url || row.mangaId;
  if (!sid || !url) {
    toast('This update is missing its source — try Refresh.');
    return;
  }
  // Fire-and-forget: clearing the badge shouldn't block navigation.
  try { library.markUpdatesSeen({ mangaId: row.mangaId }); } catch (_) { /* ignore */ }
  router.navigate('details', { sid, url });
}

function markSeen(row, body, markAllBtn) {
  try {
    library.markUpdatesSeen({ mangaId: row.mangaId });
    toast('Marked seen');
    load(body, markAllBtn);
  } catch (err) {
    toast(`Couldn't mark seen: ${err.message || err}`);
  }
}

function markAll(body, markAllBtn) {
  try {
    // Blank/missing mangaId marks ALL updates seen.
    library.markUpdatesSeen({});
    toast('All updates marked seen');
    load(body, markAllBtn);
  } catch (err) {
    toast(`Couldn't mark all seen: ${err.message || err}`);
  }
}

async function refresh(body, refreshBtn, markAllBtn) {
  if (refreshBtn.disabled) return;
  const original = refreshBtn.innerHTML;
  refreshBtn.disabled = true;
  refreshBtn.replaceChildren(spinner(), el('span', null, 'Refreshing…'));
  try {
    const res = await library.refreshUpdates();
    const checked = (res && Number(res.checked)) || 0;
    const withNew = (res && Number(res.withNew)) || 0;
    toast(withNew
      ? `Found new chapters for ${withNew} of ${checked} title${checked === 1 ? '' : 's'}`
      : `Checked ${checked} title${checked === 1 ? '' : 's'} — no new chapters`);
  } catch (err) {
    toast(`Refresh failed: ${err.message || err}`);
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.innerHTML = original;
  }
  // Reload regardless so freshly-recorded rows show up.
  load(body, markAllBtn);
}

function skeletonList() {
  const list = el('div', { class: 'list' });
  for (let i = 0; i < 6; i++) {
    list.appendChild(el(
      'div',
      { class: 'row-item skeleton' },
      el('div', { class: 'thumb skeleton' }),
      el('div', { class: 'row-main' },
        el('div', { class: 'name skeleton', style: { height: '14px', width: '60%' } }),
        el('div', { class: 'sub skeleton', style: { height: '11px', width: '40%', marginTop: '6px' } })),
    ));
  }
  return list;
}
