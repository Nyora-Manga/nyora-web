async function downloadControlMutation(operation) {try{return await operation();}catch(error){toast(error.message || 'Download action failed.');throw error;}}
// screens/downloads.js — download queue, settings, and offline reader.
//
// Backed by core/downloads.js (the real client-side download engine). The list
// live-updates via downloads.subscribe(); the settings card writes straight
// through to the manager. Completed chapters kept offline can be read in-app or
// saved to the device as CBZ/ZIP.

import { downloads } from '../core/downloads.js';
import { unzipImages } from '../core/zip.js';
import { router } from '../core/store.js';
import { createLocalReader } from '../core/local-reader.js';
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

export function render(view, _params) {
  if (_unsub) { _unsub(); _unsub = null; }
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
    el('details', { class: 'dl-storage-actions reading-download-actions' }, el('summary', null, 'Manage downloads'), el('div', {class:'reading-download-menu'}, clearDone, clearAll)),
  );
  const refresh = () => {
    const c = downloads.counts();
    node.hidden = !downloads.list().length;
    clearDone.hidden = !downloads.list().some(job => ['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status));
    const parts = [];
    if (c.completed) parts.push(`${c.completed} chapter${c.completed === 1 ? '' : 's'}`);
    parts.push(fmtBytes(c.totalBytes));
    sub.textContent = `${parts.join(' · ')} stored offline`;
  };
  refresh();
  return { node, refresh };
}

// ── Queue list (grouped: In progress / Completed) ────────────────────────────

const pendingDownloadControls = new Set();
function replaceDownloadQueue(host, fragment) {
  const focused = document.activeElement;
  const rowId = host.contains(focused) ? focused.closest('[data-download-id]')?.dataset.downloadId : null;
  const action = host.contains(focused) ? focused.dataset.downloadQueueAction : null;
  const label = focused?.getAttribute('aria-label') || focused?.getAttribute('title');
  host.replaceChildren(fragment);
  const target = action ? [...host.querySelectorAll('[data-download-queue-action]')].find(node => node.dataset.downloadQueueAction === action)
    : rowId ? [...host.querySelectorAll('[data-download-id]')].find(node => node.dataset.downloadId === rowId)?.querySelectorAll('button') : null;
  const button = target && typeof target.focus === 'function' ? target : target ? [...target].find(node => (node.getAttribute('aria-label') || node.getAttribute('title')) === label) : null;
  if(button && !button.disabled) button.focus({preventScroll:true});
}
function paintQueue(view, host) {
  const rows = downloads.list(), paused = downloads.queuePaused();
  const fragment = document.createDocumentFragment();
  const control = (label,key,operation,onSuccess) => {
    const button = btn(label,{variant:'ghost',class:'btn-sm',onClick:async()=>{
      if(pendingDownloadControls.has(key))return;
      pendingDownloadControls.add(key); paintQueue(view,host);
      try { const result = await downloadControlMutation(operation); onSuccess?.(result); }
      catch {} // The mutation wrapper displays the error.
      finally { pendingDownloadControls.delete(key); if(host.isConnected)paintQueue(view,host); }
    }});
    button.dataset.downloadQueueAction=key; button.disabled=pendingDownloadControls.has(key); return button;
  };
  const ordinaryFailed=rows.filter(job=>job.status==='FAILED' && job.errorCode!=='SOURCE_VERIFICATION_REQUIRED');
  const controls=el('div',{class:'download-queue-controls'},control(paused?'Resume queue':'Pause queue','pause',()=>paused?downloads.resume():downloads.pause()));
  if(ordinaryFailed.length)controls.append(control('Retry failed ('+ordinaryFailed.length+')','retry-failed',()=>downloads.retryFailed(),result=>toast(result.requeued?'Queued '+result.requeued+' failed chapters':'No failed chapters to retry')));
  if(rows.length)fragment.append(controls,el('p',{class:'download-queue-guidance',role:'status'},paused?'Queue paused. Current chapters finish; queued chapters wait until you resume.':'Pausing lets current chapters finish and holds queued chapters.'));
  if(!rows.length) {
    const browse = btn('Browse library', {variant:'accent', onClick:()=>router.navigate('library')});
    browse.dataset.downloadQueueAction = 'browse-library';
    fragment.append(el('section', {class:'reading-room-empty'},
      el('div', {class:'reading-room-empty-icon', 'aria-hidden':'true'}, '↓'),
      el('h2', null, 'Ready for offline reading'),
      el('p', null, 'Download chapters from a title in your library. They’ll be ready here when you need them.'),
      browse));
  }
  for(const [status,title] of [['RUNNING','Running'],['QUEUED',paused?'Queued · paused':'Queued'],['FAILED','Failed'],['COMPLETED','Completed'],['CANCELLED','Cancelled']]) {
    const group=rows.filter(job=>job.status===status);if(!group.length)continue;
    const actions=[];
    if(status==='RUNNING'||status==='QUEUED') {
      const active=rows.filter(job=>ACTIVE.has(job.status));
      if(status==='RUNNING'||!rows.some(job=>job.status==='RUNNING'))actions.push(control('Cancel all ('+active.length+')','cancel-all',()=>downloads.cancelAll(),()=>toast('Downloads cancelled')));
    }
    if(status==='COMPLETED' && group.filter(job=>job.offline).length>1)actions.push(control('Save all','save-all',()=>downloads.saveBundle(group.filter(job=>job.offline).map(job=>job.id)),result=>toast(result.status==='cancelled'?'Export cancelled':result.ok?'Saved '+result.count+' chapters':'Nothing to save')));
    fragment.append(sectionHeader(title+' ('+group.length+')',...actions));
    const list=el('div',{class:'list'});for(const job of group)list.append(downloadRow(view,job));fragment.append(list);
  }
  replaceDownloadQueue(host,fragment);
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
    const held = status === 'QUEUED' && downloads.queuePaused();
    main.appendChild(el('div', { class: held ? 'progress queue-held' : determinate ? 'progress' : 'progress indeterminate' },
      el('span', determinate ? { style: { width: `${pct}%` } } : null)));
    main.appendChild(el('div', { class: 'sub dl-meta' },
      status === 'RUNNING'
        ? (total > 0 ? `${done} / ${total} pages · ${pct}%` : 'Fetching pages…')
        : (downloads.queuePaused() ? 'Queued · paused' : 'Queued')));
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

  return el('div', { class: 'row-item', 'data-download-id': job.id }, main, actions);
}

// ── Offline reader ──────────────────────────────────────────────────────────

async function openOfflineReader(view, job) {
  const loading = el('div', { class: 'center', style: { padding: '48px 0' } }, spinner());
  view.replaceChildren(loading);

  let pages;
  try {
    const blob = await downloads.getBlob(job.id);
    if (!blob) throw new Error('Offline file not found');
    const entries = await unzipImages(blob);
    pages = entries.map((e) => new Blob([e.bytes]));
  } catch (err) {
    if (!loading.isConnected) return;
    view.replaceChildren(
      sectionHeader(job.chapterTitle || 'Chapter', iconBtn('back', () => render(view), 'Back')),
      errorBox(`Couldn't open this download: ${err.message || err}`),
    );
    return;
  }

  if (!loading.isConnected) return;
  if (!pages.length) {
    view.replaceChildren(sectionHeader(job.chapterTitle || 'Chapter',
      iconBtn('back', () => render(view), 'Back to downloads')), emptyState('This download has no readable pages.'));
    return;
  }
  router.navigate('reader', createLocalReader({
    title: job.mangaTitle || job.chapterTitle || 'Download',
    chapterTitle: job.chapterTitle || 'Chapter', pages, back: 'downloads',
  }));
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
