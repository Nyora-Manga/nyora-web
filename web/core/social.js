// core/social.js — the "social" layer client: live presence + manga comments.
//
// Presence is deliberately ephemeral and anonymous: a random per-session uid
// (sessionStorage, so a new tab is a new visitor — matching how people think
// about "readers online right now") pinged every PING_EVERY_MS while the tab
// is visible. The server keeps ~5 minutes of heartbeats in memory; nothing is
// ever written to disk.
//
// Comments ride the sync server's existing OAuth session via authedFetch();
// reading a thread is anonymous.

import { SYNC_CONFIG, authedFetch, status as syncStatus } from './sync.js';

const BASE = SYNC_CONFIG.syncUrl;
const PING_EVERY_MS = 60_000;
const UID_KEY = 'nyora.presence.uid';

// ── presence ────────────────────────────────────────────────────────────────

function presenceUid() {
  try {
    let id = sessionStorage.getItem(UID_KEY);
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID())
        || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      sessionStorage.setItem(UID_KEY, id);
    }
    return id;
  } catch {
    // sessionStorage unavailable (private mode edge cases) — stable for the
    // lifetime of this module, which is the lifetime of the tab anyway.
    if (!presenceUid._id) {
      presenceUid._id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }
    return presenceUid._id;
  }
}

let currentMangaId = '';
let pingTimer = null;
let inFlight = false;
const countListeners = new Set();
let lastCounts = { count: 0, manga_count: 0, manga_id: '' };

function notifyCounts() {
  for (const fn of countListeners) {
    try { fn(lastCounts); } catch { /* a bad listener must not kill the loop */ }
  }
}

async function ping() {
  if (document.visibilityState === 'hidden' || inFlight) return;
  inFlight = true;
  const mangaId = currentMangaId;
  try {
    const res = await fetch(`${BASE}/presence/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: presenceUid(), manga_id: mangaId || undefined }),
    });
    if (res.ok) {
      const data = await res.json();
      lastCounts = {
        count: Number(data.count) || 0,
        manga_count: Number(data.manga_count) || 0,
        manga_id: mangaId,
      };
      notifyCounts();
    }
  } catch { /* offline / server down — presence is best-effort by design */ }
  inFlight = false;
}

/** Start the heartbeat loop. Idempotent; call once at boot. */
export function startPresence() {
  if (pingTimer) return;
  ping();
  pingTimer = setInterval(ping, PING_EVERY_MS);
  document.addEventListener('visibilitychange', () => {
    // Returning to the tab pings immediately so counts feel live; while hidden
    // the interval still fires but ping() no-ops, letting the server-side TTL
    // age this visitor out.
    if (document.visibilityState === 'visible') ping();
  });
}

/** Tell presence which manga this tab is looking at ('' / null to clear). */
export function setPresenceManga(mangaId) {
  const next = mangaId ? String(mangaId) : '';
  if (next === currentMangaId) return;
  currentMangaId = next;
  ping();
}

/**
 * Subscribe to live counts: fn({count, manga_count, manga_id}).
 * Fires immediately with the last known value; returns an unsubscribe fn.
 */
export function onCounts(fn) {
  countListeners.add(fn);
  try { fn(lastCounts); } catch { /* ignore */ }
  return () => countListeners.delete(fn);
}

// ── comments ────────────────────────────────────────────────────────────────

export function isSignedIn() {
  return syncStatus().isAuthenticated;
}

async function readError(res, fallback) {
  let detail = '';
  try {
    const data = await res.json();
    detail = typeof data.detail === 'string' ? data.detail : '';
  } catch { /* not JSON */ }
  const err = new Error(detail || fallback);
  err.statusCode = res.status;
  // The server answers exactly "username required" when the account has no
  // handle yet; the UI turns that into the choose-a-username prompt.
  err.needsUsername = detail === 'username required';
  err.retryAfter = Number(res.headers.get('Retry-After')) || 0;
  return err;
}

/** Anonymous read. Returns {comments, has_more, total}. */
export async function listComments(mangaId, { before = '', limit = 50 } = {}) {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (before) qs.set('before', before);
  // Send the token when we have one so the server can mark `mine`, but never
  // let a missing/expired session block anonymous reading.
  const headers = {};
  try {
    const raw = localStorage.getItem('nyora.sync.session.v1');
    const token = raw ? (JSON.parse(raw).access_token || '') : '';
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch { /* anonymous */ }
  const res = await fetch(`${BASE}/comments/${encodeURIComponent(mangaId)}?${qs}`, { headers });
  if (!res.ok) throw await readError(res, `Could not load comments (${res.status})`);
  return res.json();
}

export async function postComment(mangaId, body) {
  const res = await authedFetch(`/comments/${encodeURIComponent(mangaId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw await readError(res, `Could not post comment (${res.status})`);
  return res.json();
}

export async function deleteComment(commentId) {
  const res = await authedFetch(`/comments/${encodeURIComponent(commentId)}`, { method: 'DELETE' });
  if (!res.ok) throw await readError(res, `Could not delete comment (${res.status})`);
  return res.json();
}

export async function reportComment(commentId, reason = '') {
  const res = await authedFetch(`/comments/${encodeURIComponent(commentId)}/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) throw await readError(res, `Could not report comment (${res.status})`);
  return res.json();
}

export async function getUsername() {
  const res = await authedFetch('/auth/username');
  if (!res.ok) throw await readError(res, `Could not load profile (${res.status})`);
  const data = await res.json();
  return data.username || '';
}

export async function setUsername(username) {
  const res = await authedFetch('/auth/username', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  if (!res.ok) throw await readError(res, `Could not set username (${res.status})`);
  const data = await res.json();
  return data.username || username;
}

/** "2m ago" style relative timestamp for comment rows. */
export function timeAgo(iso) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

export default {
  startPresence, setPresenceManga, onCounts,
  isSignedIn, listComments, postComment, deleteComment, reportComment,
  getUsername, setUsername, timeAgo,
};
