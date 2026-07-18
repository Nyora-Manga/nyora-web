// screens/downloads.js — download queue, settings, and offline reader.
//
// Backed by core/downloads.js (the real client-side download engine). The list
// live-updates via downloads.subscribe(); the settings card writes straight
// through to the manager. Completed chapters kept offline can be read in-app or
// saved to the device as CBZ/ZIP.

import { downloads } from '../core/downloads.js';
import { unzipImages } from '../core/zip.js';
import { router } from '../core/store.js';
import {
  el, $, spinner, emptyState, errorBox, sectionHeader, icon, btn, iconBtn,
  toast, confirmDialog, chip,
} from '../core/ui.js';

export const meta = {
  title: 'Downloads',
  nav: false,
  icon: 'download',
  order: 80,
};

const ACTIVE = new Set(['QUEUED', 'RUNNING']);

let _unsub = null;
let _readerUrls = [];

export function render(view, _params) {
  if (_unsub) { _unsub(); _unsub = null; }
  revokeReaderUrls();
  view.replaceChildren();

  // Download SETTINGS now live in Settings → Downloads; the gear jumps there.
  const gear = iconBtn('settings', () => router.navigate('settings', { s: 'downloads' }), 'Download settings');
  const header = sectionHeader('Downloads', gear);
  const storage = buildStorageStrip();
  const queueWrap = el('div', { class: 'downloads-host' });
  view.append(header, storage.node, queueWrap);

  const renderQueue = () => paintQueue(view, queueWrap);
  renderQueue();

  _unsub = downloads.subscribe(() => {
    if (!queueWrap.isConnected) { if (_unsub) { _unsub(); _unsub = null; } return; }
    renderQueue();
    storage.refresh();
  });

  // Deterministic cleanup when navigating away (app.js dispatch calls this).
  view.__downloadsTeardown = () => {
    if (_unsub) { _unsub(); _unsub = null; }
    revokeReaderUrls();
  };
}

// ── Offline-storage summary strip ────────────────────────────────────────────

function buildStorageStrip() {
  const sub = el('div', { class: 'dl-storage-sub' });
  const clearDone = btn('Clear finished', {
    variant: 'ghost', class: 'btn-sm', icon: 'trash',
    onClick: async () => {
      const res = await downloads.clearCompleted();
      toast(res.removed ? `Cleared ${res.removed}` : 'Nothing to clear');
    },
  });
  const clearAll = btn('Delete all', {
    variant: 'ghost', class: 'btn-sm btn-danger', icon: 'trash',
    onClick: async () => {
      if (!(await confirmDialog('Delete every download, including offline files?'))) return;
      const res = await downloads.clearAll();
      toast(res.removed ? `Deleted ${res.removed}` : 'Nothing to delete');
    },
  });
  const node = el('div', { class: 'dl-storage' },
    el('div', { class: 'dl-storage-main' },
      el('span', { class: 'dl-storage-icon' }, icon('download')),
      el('div', { class: 'dl-storage-text' },
        el('div', { class: 'dl-storage-title' }, 'Offline storage'),
        sub,
      ),
    ),
    el('div', { class: 'dl-storage-actions' }, clearDone, clearAll),
  );
  const refresh = () => {
    const c = downloads.counts();
    const parts = [];
    if (c.completed) parts.push(`${c.completed} chapter${c.completed === 1 ? '' : 's'}`);
    parts.push(fmtBytes(c.totalBytes));
    sub.textContent = `${parts.join(' · ')} stored offline`;
  };
  refresh();
  return { node, refresh };
}

// ── Queue list (grouped: In progress / Completed) ────────────────────────────

function paintQueue(view, host) {
  const rows = downloads.list();
  if (!rows.length) {
    host.replaceChildren(emptyState('No downloads yet — open a manga and tap Download.', 'download'));
    return;
  }
  const active = rows.filter((r) => ACTIVE.has(r.status));
  const finished = rows.filter((r) => !ACTIVE.has(r.status));
  const frag = document.createDocumentFragment();

  if (active.length) {
    const cancelAll = btn(`Cancel all (${active.length})`, {
      variant: 'ghost', class: 'btn-danger btn-sm', icon: 'close',
      onClick: () => { downloads.cancelAll(); toast('Cancelling downloads'); },
    });
    frag.appendChild(sectionHeader(`In progress (${active.length})`, cancelAll));
    const list = el('div', { class: 'list' });
    for (const job of active) list.appendChild(downloadRow(view, job));
    frag.appendChild(list);
  }

  if (finished.length) {
    const savable = finished.filter((r) => r.status === 'COMPLETED' && r.offline);
    const actions = [];
    if (savable.length > 1) {
      actions.push(btn('Save all', {
        variant: 'ghost', class: 'btn-sm', icon: 'download',
        onClick: async () => {
          toast('Bundling…');
          const res = await downloads.saveBundle(savable.map((r) => r.id), 'nyora-downloads');
          toast(res.ok ? `Saved ${res.count} chapters` : 'Nothing to save');
        },
      }));
    }
    frag.appendChild(sectionHeader(`Completed (${finished.length})`, ...actions));
    const list = el('div', { class: 'list' });
    for (const job of finished) list.appendChild(downloadRow(view, job));
    frag.appendChild(list);
  }

  host.replaceChildren(frag);
}

function downloadRow(view, job) {
  const status = job.status || 'QUEUED';
  const total = num(job.totalPages, 0);
  const done = num(job.completedPages, 0);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const main = el('div', { class: 'row-main' },
    el('div', { class: 'name', title: job.mangaTitle || '' }, job.mangaTitle || 'Untitled'),
    el('div', { class: 'sub', title: job.chapterTitle || '' }, job.chapterTitle || ''),
  );

  if (status === 'RUNNING' || status === 'QUEUED') {
    const determinate = status === 'RUNNING' && total > 0;
    main.appendChild(el('div', { class: determinate ? 'progress' : 'progress indeterminate' },
      el('span', determinate ? { style: { width: `${pct}%` } } : null)));
    main.appendChild(el('div', { class: 'sub dl-meta' },
      status === 'RUNNING'
        ? (total > 0 ? `${done} / ${total} pages · ${pct}%` : 'Fetching pages…')
        : 'Queued'));
  } else if (status === 'COMPLETED') {
    main.appendChild(el('div', { class: 'sub dl-meta' },
      `${num(job.completedPages)} pages · ${fmtBytes(job.bytes)}`
      + (job.offline ? ' · offline' : (job.savedToDevice ? ' · saved to device' : ''))));
    if (job.warning) {
      main.appendChild(el('div', { class: 'sub dl-warn' }, job.warning));
    }
  } else if (status === 'FAILED') {
    main.appendChild(el('div', { class: 'sub dl-err' }, job.error || 'Download failed'));
  } else if (status === 'CANCELLED') {
    main.appendChild(el('div', { class: 'sub dl-meta' }, 'Cancelled'));
  }

  const actions = el('div', { class: 'row-actions' }, statusChip(status, job));

  if (ACTIVE.has(status)) {
    actions.appendChild(iconBtn('close', () => { downloads.cancel(job.id); }, 'Cancel'));
  }
  if (status === 'COMPLETED' && job.offline) {
    actions.appendChild(iconBtn('eye', () => openOfflineReader(view, job), 'Read offline'));
    actions.appendChild(iconBtn('download', async () => {
      const res = await downloads.saveToDevice(job.id);
      toast(res.ok ? 'Saved to device' : 'No file to save');
    }, 'Save to device'));
  }
  if (status === 'FAILED' || status === 'CANCELLED' || (status === 'COMPLETED' && job.warning)) {
    actions.appendChild(iconBtn('refresh', () => { downloads.retry(job.id); toast('Retrying'); }, 'Retry'));
  }
  if (!ACTIVE.has(status)) {
    actions.appendChild(iconBtn('trash', () => { downloads.remove(job.id); }, 'Remove'));
  }

  return el('div', { class: 'row-item' }, main, actions);
}

// ── Offline reader ──────────────────────────────────────────────────────────

async function openOfflineReader(view, job) {
  revokeReaderUrls();
  view.replaceChildren(el('div', { class: 'center', style: { padding: '48px 0' } }, spinner()));

  let pages;
  try {
    const blob = await downloads.getBlob(job.id);
    if (!blob) throw new Error('Offline file not found');
    const entries = await unzipImages(blob);
    pages = entries.map((e) => trackUrl(URL.createObjectURL(new Blob([e.bytes]))));
  } catch (err) {
    view.replaceChildren(
      sectionHeader(job.chapterTitle || 'Chapter', iconBtn('back', () => render(view), 'Back')),
      errorBox(`Couldn't open this download: ${err.message || err}`),
    );
    return;
  }

  const back = iconBtn('back', () => render(view), 'Back to downloads');
  const header = sectionHeader(job.chapterTitle || 'Chapter', chip(`${pages.length} pages`), back);
  view.replaceChildren(header);

  if (!pages.length) { view.appendChild(emptyState('This download has no readable pages.')); return; }

  const reader = el('div', { class: 'reader webtoon', style: { paddingBottom: '48px' } });
  for (let i = 0; i < pages.length; i++) {
    const img = el('img', { class: 'reader-page', loading: 'lazy', decoding: 'async', alt: `Page ${i + 1}`, src: pages[i] });
    img.addEventListener('error', () => { img.style.display = 'none'; });
    reader.appendChild(img);
  }
  view.appendChild(reader);
}

function trackUrl(url) { _readerUrls.push(url); return url; }
function revokeReaderUrls() {
  for (const u of _readerUrls) { try { URL.revokeObjectURL(u); } catch { /* ignore */ } }
  _readerUrls = [];
}

// ── small helpers ───────────────────────────────────────────────────────────

function statusChip(status, job) {
  const map = { RUNNING: 'Running', QUEUED: 'Queued', COMPLETED: 'Done', FAILED: 'Failed', CANCELLED: 'Cancelled' };
  let key = (status || '').toLowerCase();
  let label = map[status] || status || 'Unknown';
  if (status === 'COMPLETED' && job && job.warning) { key = 'queued'; label = 'Partial'; }
  return chip(label, { class: `status-${key}` });
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(v) / Math.log(1024)));
  return `${(v / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export default { meta, render };
