// core/migrations.js — one-time repairs to locally stored data.
//
// These run in the background after boot and are strictly best-effort: a
// migration that fails, times out, or is interrupted must leave the data no
// worse than it found it, and must never block the UI.

import library from './library.js';
import { api } from './api.js';
import { store } from './store.js';

const DONE_KEY = 'nyora.migrations.done.v1';

function doneSet() {
  try { return new Set(JSON.parse(localStorage.getItem(DONE_KEY) || '[]')); }
  catch { return new Set(); }
}
function markDone(name) {
  try {
    const s = doneSet(); s.add(name);
    localStorage.setItem(DONE_KEY, JSON.stringify([...s]));
  } catch { /* private mode — it just runs again next time */ }
}

// A details response that came back without a title or cover used to overwrite
// the good values already stored, leaving rows rendering as "Untitled" with a
// letter placeholder. The write path is fixed, but entries damaged before that
// stay broken until the manga is opened again — the title is genuinely gone
// from the record, so there is nothing local to recover it from.
//
// This re-fetches metadata for those entries. Bounded deliberately: history can
// be hundreds of entries and each repair is a network call to a manga source,
// so it takes the most recent MAX, runs them a few at a time, and stops on the
// first sign the network isn't cooperating.
const MAX = 40;
const CONCURRENCY = 3;

async function repairHistoryMetadata() {
  let broken = library.brokenHistoryEntries();
  if (!broken.length) return { repaired: 0, attempted: 0 };

  // Free wins first: the in-memory card cache may already hold this manga.
  let repaired = 0;
  broken = broken.filter((e) => {
    const hint = e.manga && e.manga.url ? store.cachedManga(e.manga.url) : null;
    if (hint && (hint.title || hint.coverUrl)) {
      if (library.patchHistoryManga(e.id, hint)) repaired++;
      return false;
    }
    return true;
  });

  const queue = broken.slice(0, MAX);
  let attempted = 0;
  let consecutiveFailures = 0;

  async function worker() {
    for (;;) {
      const e = queue.shift();
      if (!e) return;
      // Bail out entirely if the network is clearly unavailable rather than
      // grinding through dozens of doomed requests.
      if (consecutiveFailures >= 5) return;
      const url = e.manga && e.manga.url;
      if (!url || e.sourceId == null) continue;
      attempted++;
      try {
        const details = await api.details(e.sourceId, url);
        const m = details && details.manga;
        if (m && (m.title || m.coverUrl || m.largeCoverUrl)) {
          if (library.patchHistoryManga(e.id, m)) repaired++;
          consecutiveFailures = 0;
        } else {
          consecutiveFailures++;
        }
      } catch { consecutiveFailures++; }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { repaired, attempted };
}

const MIGRATIONS = [
  ['history-metadata-v1', repairHistoryMetadata],
];

// Run pending migrations. Never throws; never blocks the caller.
export async function runMigrations() {
  const done = doneSet();
  for (const [name, fn] of MIGRATIONS) {
    if (done.has(name)) continue;
    try {
      const res = await fn();
      // Mark done whenever it completed, including "attempted but nothing was
      // recoverable" — those entries won't become recoverable on a retry, and
      // re-running would just re-issue the same failing requests every launch.
      // A thrown migration stays pending (see catch) so a genuine crash retries.
      markDone(name);
      if (res && res.repaired) {
        try { window.dispatchEvent(new CustomEvent('nyora:migrated', { detail: { name, ...res } })); }
        catch { /* ignore */ }
      }
    } catch { /* leave pending; retried next launch */ }
  }
}
