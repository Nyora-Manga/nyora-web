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
import { decorrelatedJitter, jitteredPeriod } from './net.js';

const QUIET_MS = 5_000;           // push this long after the last local change
const MAX_DEFER_MS = 5 * 60_000;  // ...but never defer a dirty push beyond this
const FOCUS_IDLE_MS = 90_000;     // on tab focus, resync if it's been this long
const PERIODIC_MS = 60_000;       // safety-net: pull+push at least this often
const MIN_GAP_MS = 45_000;        // don't let the periodic tick pile onto a recent sync

// Every synced client in the world talks to ONE small VM. A fixed 60s tick
// means the clients that booted together stay together forever, and — worse —
// a blip re-forms the herd out of everyone who failed at the same instant.
// Two defences, both about spreading load in TIME:
//   • the periodic tick is re-armed with a jittered delay, never a fixed one,
//     so phases drift apart instead of locking;
//   • a failed sync backs off with decorrelated jitter before the next attempt,
//     so a server coming back up is not met by all of its clients at once.
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 10 * 60_000;

let timer = null;
let periodicTimer = null;
let firstDirtyAt = 0;
let lastSyncAt = 0;
let running = false;
let dirty = false;
let started = false;
let failures = 0;
let backoffMs = 0;
let retryUntil = 0;

function authed() {
  try { return sync.status().isAuthenticated; } catch { return false; }
}

async function runSync(reason) {
  if (running || !authed()) return;
  // Inside a backoff window nothing but an explicit trigger gets through: the
  // point of backing off is lost if the 60s tick keeps knocking.
  if (Date.now() < retryUntil && reason !== 'manual') return;
  running = true;
  if (timer) { clearTimeout(timer); timer = null; }
  const wasDirty = dirty;
  dirty = false; firstDirtyAt = 0;
  try {
    await sync.syncNow();
    lastSyncAt = Date.now();
    failures = 0; backoffMs = 0; retryUntil = 0;
    // A pull may have merged in remote history/favourites/bookmarks — let the
    // current screen refresh so they appear without a manual reload.
    try { window.dispatchEvent(new CustomEvent('nyora:synced', { detail: { reason } })); } catch { /* no DOM */ }
  } catch {
    // Network / auth hiccup — keep the dirty flag so the next trigger retries.
    if (wasDirty) dirty = true;
    failures++;
    backoffMs = decorrelatedJitter(BACKOFF_BASE_MS, BACKOFF_CAP_MS, backoffMs || BACKOFF_BASE_MS);
    retryUntil = Date.now() + backoffMs;
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
  let delay = Math.max(0, Math.min(QUIET_MS, MAX_DEFER_MS - waited));
  // Don't schedule inside a backoff window — land just after it instead.
  const backoffLeft = retryUntil - Date.now();
  if (backoffLeft > 0) delay = Math.max(delay, backoffLeft);
  timer = setTimeout(() => { timer = null; runSync('debounced'); }, delay);
}

function onLibraryChange(detail) {
  dirty = true;
  // A new chapter read is a meaningful checkpoint — push it right away instead
  // of waiting out the debounce, so each chapter syncs the moment it's opened.
  if (detail && detail.type === 'history' && detail.chapterChanged) {
    if (running) return;            // in-flight sync will reschedule on finish
    runSync('chapter');
    return;
  }
  if (!running) schedule();         // progress-within-chapter: coalesce
}

// Safety-net loop. Even if no change event or focus change fires, this pulls
// (to pick up other devices' reads) and pushes (dirty local reads) on a fixed
// cadence while the tab is open — so "it only syncs when I click Sync Now" can
// never happen. Skipped when a sync ran very recently or the tab is hidden.
function periodicTick() {
  armPeriodic();   // re-arm FIRST, so an early return still keeps the loop alive
  if (!authed() || running) return;
  if (document.visibilityState !== 'visible') return;
  if (Date.now() - lastSyncAt < MIN_GAP_MS) return;
  runSync('periodic');
}

// setTimeout re-armed with fresh jitter each round, not setInterval: a fixed
// interval preserves whatever phase a client started on, so clients that opened
// together keep arriving together for as long as they stay open.
function armPeriodic() {
  if (periodicTimer) clearTimeout(periodicTimer);
  periodicTimer = setTimeout(periodicTick, jitteredPeriod(PERIODIC_MS, 0.4));
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

  armPeriodic();

  // Startup pull+push (deferred so it never competes with first paint), and
  // jittered as well: a deploy or an outage ending makes everyone reload at
  // once, and a fixed 2.5s delay would turn that into one synchronised wave.
  if (authed()) setTimeout(() => runSync('startup'), jitteredPeriod(2_500, 0.8));
}

export default { initAutoSync };
