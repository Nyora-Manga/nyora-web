// core/auto-sync.js — keep the browser library continuously in sync with the
// cloud, the way the mac / Android clients already do.
//
// Web historically synced ONLY on sign-in or a manual Settings → "Sync Now".
// So chapters read on web never reached the cloud, and other devices' reads
// never came back — the histories on web vs mac/Android drifted into completely
// disjoint sets. (The manga_id key IS identical across platforms — a 64-bit
// nyoraId hash — so nothing but the missing trigger was keeping them apart.)
//
// This module closes that gap with three triggers, mirroring the desktop app:
//   • startup  — pull other devices' changes down (and push local ones up)
//   • on change — a debounced push after any local mutation (coalesces a whole
//                 reading session into one push once the user pauses)
//   • on focus  — an opportunistic resync when the tab regains visibility, plus
//                 a best-effort flush when it's hidden
//
// syncNow() is push-then-pull with last-write-wins on the server, so running it
// often is safe and idempotent.

import sync from './sync.js';
import library from './library.js';

const QUIET_MS = 12_000;          // push this long after the last local change
const MAX_DEFER_MS = 5 * 60_000;  // ...but never defer a dirty push beyond this
const FOCUS_IDLE_MS = 90_000;     // on tab focus, resync if it's been this long

let timer = null;
let firstDirtyAt = 0;
let lastSyncAt = 0;
let running = false;
let dirty = false;
let started = false;

function authed() {
  try { return sync.status().isAuthenticated; } catch { return false; }
}

async function runSync(reason) {
  if (running || !authed()) return;
  running = true;
  if (timer) { clearTimeout(timer); timer = null; }
  const wasDirty = dirty;
  dirty = false; firstDirtyAt = 0;
  try {
    await sync.syncNow();
    lastSyncAt = Date.now();
    // A pull may have merged in remote history/favourites/bookmarks — let the
    // current screen refresh so they appear without a manual reload.
    try { window.dispatchEvent(new CustomEvent('nyora:synced', { detail: { reason } })); } catch { /* no DOM */ }
  } catch {
    // Network / auth hiccup — keep the dirty flag so the next trigger retries.
    if (wasDirty) dirty = true;
  } finally {
    running = false;
    if (dirty) schedule(); // changes landed while we were syncing
  }
}

function schedule() {
  if (!authed()) return;
  if (!firstDirtyAt) firstDirtyAt = Date.now();
  if (timer) clearTimeout(timer);
  const waited = Date.now() - firstDirtyAt;
  const delay = Math.max(0, Math.min(QUIET_MS, MAX_DEFER_MS - waited));
  timer = setTimeout(() => { timer = null; runSync('debounced'); }, delay);
}

function onLibraryChange() {
  dirty = true;
  if (!running) schedule(); // if a sync is in flight, it reschedules on finish
}

export function initAutoSync() {
  if (started) return;
  started = true;

  library.onChange(onLibraryChange);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (authed() && Date.now() - lastSyncAt > FOCUS_IDLE_MS) runSync('focus');
    } else if (dirty && authed()) {
      runSync('hide'); // best-effort flush on the way out
    }
  });

  // Startup pull+push (deferred so it never competes with first paint). Signing
  // in mid-session already merges via signInAndFetch; onChange keeps it flowing.
  if (authed()) setTimeout(() => runSync('startup'), 2500);
}

export default { initAutoSync };
