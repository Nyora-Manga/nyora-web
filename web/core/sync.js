// core/sync.js — browser sync for Nyora Web against the self-hosted sync server.
//
// Auth is a standard OAuth2 password flow (email + password) against the FastAPI
// sync backend at NYORA_SYNC_URL: POST /auth/register creates the account, POST
// /auth/token (grant_type=password | refresh_token) mints JWTs. Access tokens
// live ~1h and are auto-refreshed on a 401 from the sync endpoint. All library
// data moves through POST /functions/v1/nyora-sync with a Bearer access token
// (no apikey/anon header). Google sign-in has been removed.

import { bareSourceName } from './api.js';
import library from './library.js';
import { sourcePrefRows, applySourcePrefRows } from './parser-runtime.js';

export const SYNC_CONFIG = {
  syncUrl: String(globalThis.NYORA_SYNC_URL || 'https://sync.nyora.xyz').replace(/\/+$/, ''),
};

const SESSION_KEY = 'nyora.sync.session.v1';
const INITIAL_SYNC = '1970-01-01T00:00:00Z';

// The pull cutoff is a SERVER-side filter (`updated_at >= since`) but it used to
// be stamped from the browser's clock, which is not the same clock. A device
// running even a few minutes fast would record a cutoff in the server's future,
// and every row written in that window was skipped — permanently, because the
// cutoff only ever moves forward. Two defences:
//
//   • every response carries a `Date` header, so the offset between the two
//     clocks is measurable; timestamps we store are stamped in SERVER time.
//   • the stored cutoff is then rewound by PULL_OVERLAP_MS, which also covers
//     the race where another device writes a row between our select and our
//     stamp. Re-pulling a few minutes of rows is free — the merge is idempotent.
const PULL_OVERLAP_MS = 5 * 60_000;
// Delta pushes upload only what changed, so a stale or lost server-side row
// would never be re-sent. A full push at least this often repairs that.
const FULL_PUSH_EVERY_MS = 24 * 60 * 60_000;
// The mirror of it, and the reason an incremental pull can never strand a
// device: the cutoff is only ever advanced, so ANY way it ends up too far
// forward — a server or proxy reporting a wrong `Date`, a clock that jumped
// mid-sync, a bug — would silently stop this device seeing new rows, for good.
// Ignoring it once a day and asking for everything costs one full pull and
// makes that unrecoverable state self-healing.
const FULL_PULL_EVERY_MS = 24 * 60 * 60_000;

let serverClockOffsetMs = 0;
function noteServerClock(res) {
  try {
    const stamp = Date.parse(res.headers.get('date') || '');
    if (Number.isFinite(stamp)) serverClockOffsetMs = stamp - Date.now();
  } catch { /* header unreadable — keep the last offset */ }
}
// A local instant expressed on the server's clock. Which clock a cutoff belongs
// to depends on whose rows it filters: the PULL cutoff is compared against
// server-stamped `updated_at`, so it is translated; the PUSH cutoff is compared
// against rows this device stamped from its own clock, so it must NOT be.
function toServerMs(localMs) { return localMs + serverClockOffsetMs; }
function cutoffIso(atMs) { return new Date(Math.max(0, atMs - PULL_OVERLAP_MS)).toISOString(); }

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

// NOTE: this is an explicit allow-list, not a spread — a field that is not
// named here does not survive a save. Add new session state to it.
function saveSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    access_token: session.access_token || '',
    refresh_token: session.refresh_token || '',
    user_id: session.user_id || parseJwtSub(session.access_token || ''),
    email: session.email || '',
    last_sync_timestamp: session.last_sync_timestamp || INITIAL_SYNC,
    last_push_timestamp: session.last_push_timestamp || '',
    last_full_push_at: session.last_full_push_at || '',
    last_full_pull_at: session.last_full_pull_at || '',
  }));
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function parseJwtSub(token) {
  try {
    const payload = token.split('.')[1] || '';
    const padded = payload + '='.repeat((4 - payload.length % 4) % 4);
    const json = JSON.parse(atob(padded.replace(/-/g, '+').replace(/_/g, '/')));
    return json.sub || '';
  } catch {
    return '';
  }
}

export function status() {
  const session = loadSession();
  return {
    isConfigured: !!SYNC_CONFIG.syncUrl,
    isAuthenticated: !!(session.access_token && (session.user_id || parseJwtSub(session.access_token))),
    userId: session.user_id || parseJwtSub(session.access_token || ''),
    email: session.email || '',
    lastSyncTimestamp: session.last_sync_timestamp || INITIAL_SYNC,
  };
}

export function hasLocalData() {
  const data = library.exportData();
  return !!(
    Object.keys(data.favourites || {}).length ||
    Object.keys(data.history || {}).length ||
    (data.bookmarks || []).length ||
    Object.keys(data.categories || {}).length ||
    Object.keys(data.prefs || {}).length
  );
}

export async function register(email, password) {
  const res = await fetch(`${SYNC_CONFIG.syncUrl}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: String(email || '').trim(), password: password || '' }),
  });
  const data = await parseJson(res);
  if (!res.ok) throw new Error(authError(data, res.status));
  // The server returns the created user; a token still has to be minted.
  return signIn(email, password);
}

export async function signIn(email, password) {
  const cleanEmail = String(email || '').trim();
  const token = await authToken({
    grant_type: 'password',
    username: cleanEmail,
    password: password || '',
  });
  saveSession({
    ...token,
    email: cleanEmail,
    user_id: token.user_id || parseJwtSub(token.access_token || ''),
    last_sync_timestamp: loadSession().last_sync_timestamp || INITIAL_SYNC,
  });
  return status();
}

export function signOut() {
  clearSession();
}

// --- account lifecycle (explicit guest → cloud semantics) ---------------
//
// Guests accumulate their library + preferences locally (per-visitor
// localStorage). Two ways to bind that to the cloud:
//
//   registerAndMigrate — CREATE a new account and MIGRATE this device's local
//     (guest) data UP into it. A fresh account is empty in the cloud, so the
//     push is a straight migration and the pull is a no-op.
//
//   signInAndFetch — sign into an EXISTING account and FETCH its library DOWN.
//     If the device also has local guest data, merge it up first (syncNow) so
//     nothing is lost; otherwise pull a clean copy from the cloud.
//
// Both are best-effort on the sync step: the auth itself must succeed, but a
// transient sync failure never blocks the user from getting in.

export async function registerAndMigrate(email, password) {
  const st = await register(email, password); // creates the account + signs in
  try { await syncNow(); } catch { /* account exists; migration is best-effort */ }
  return st && st.isAuthenticated ? status() : st;
}

export async function signInAndFetch(email, password) {
  const st = await signIn(email, password);
  try {
    if (hasLocalData()) await syncNow();      // merge local (guest) data up, then pull
    else await restoreFromCloud();            // clean fetch/replace from the cloud
  } catch { /* best-effort — proceed regardless */ }
  return st && st.isAuthenticated ? status() : st;
}

export async function syncNow() {
  const session = await ensureSession();
  const fullPull = isFullPullDue(session);
  const cutoff = fullPull ? INITIAL_SYNC : (session.last_sync_timestamp || INITIAL_SYNC);
  await pushAll(session);
  // Mark the instant the pull begins, but translate it AFTERWARDS: the offset
  // is only known once a request has come back, and a sync whose push had
  // nothing to send has made no requests yet at this point.
  const pullStartedAt = Date.now();
  const merged = await pullAll(session, cutoff);
  session.last_sync_timestamp = cutoffIso(toServerMs(pullStartedAt));
  if (fullPull) session.last_full_pull_at = new Date(pullStartedAt).toISOString();
  saveSession(session);
  return merged;
}

export async function restoreFromCloud() {
  const session = await ensureSession();
  const pullStartedAt = Date.now();
  const merged = await pullAll(session, INITIAL_SYNC);
  session.last_sync_timestamp = cutoffIso(toServerMs(pullStartedAt));
  session.last_full_pull_at = new Date(pullStartedAt).toISOString();
  saveSession(session);
  return merged;
}

function isFullPullDue(session) {
  const last = Date.parse(session.last_full_pull_at || '');
  if (!Number.isFinite(last)) return true;          // never done one from here
  const age = Date.now() - last;
  // A negative age means the local clock moved backwards since the last full
  // pull; treat that as due rather than waiting out a bogus interval.
  return age < 0 || age >= FULL_PULL_EVERY_MS;
}

async function ensureSession() {
  const session = loadSession();
  if (!session.access_token) throw new Error('Sign in first.');
  // Access tokens live ~1h. Rather than proactively refreshing (and burning
  // refresh tokens) on every sync, the edge() wrapper below transparently
  // refreshes and retries once on a 401.
  return session;
}

// POST /auth/token — OAuth2 form flow (grant_type=password | refresh_token).
async function authToken(fields) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(fields || {})) {
    if (v !== null && v !== undefined) form.set(k, String(v));
  }
  const res = await fetch(`${SYNC_CONFIG.syncUrl}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  noteServerClock(res);
  const data = await parseJson(res);
  if (!res.ok || !data.access_token) {
    const error = new Error(authError(data, res.status));
    error.statusCode = res.status;   // lets refreshSession tell "no" from "couldn't ask"
    throw error;
  }
  return data;
}

// Refresh the access token in-place (mutates + persists the passed session so
// later edge() calls in the same push/pull batch reuse the fresh token).
async function refreshSession(session) {
  if (!session.refresh_token) return { session: null, rejected: true };
  try {
    const token = await authToken({
      grant_type: 'refresh_token',
      refresh_token: session.refresh_token,
    });
    session.access_token = token.access_token || session.access_token;
    session.refresh_token = token.refresh_token || session.refresh_token;
    session.user_id = token.user_id || parseJwtSub(session.access_token) || session.user_id;
    saveSession(session);
    return { session, rejected: false };
  } catch (error) {
    // Only a definitive "this refresh token is no good" may cost the user their
    // session. Being offline, or catching the auth server mid-restart, must
    // not: an access token expires in about an hour, so anyone returning after
    // a day always arrives needing a refresh, and treating a failed request as
    // a rejected credential signed people out for nothing more than bad Wi-Fi.
    return { session: null, rejected: isAuthRejection(error) };
  }
}

// authToken() throws with the HTTP status attached (see below). 400/401/403 are
// the server judging the credential; anything else — a network failure, a 5xx,
// a timeout — leaves the question unanswered, so we keep what we have.
function isAuthRejection(error) {
  const code = error && error.statusCode;
  return code === 400 || code === 401 || code === 403;
}

// Turn FastAPI / OAuth2 error payloads into a readable message.
function authError(data, statusCode) {
  const detail = data && data.detail;
  if (typeof detail === 'string' && detail) return detail;
  if (Array.isArray(detail) && detail.length) {
    return detail.map((e) => (e && e.msg) || String(e)).join(', ');
  }
  return (data && (data.error_description || data.error || data.message)) || `Auth failed ${statusCode}`;
}

async function edge(session, body, retried) {
  const res = await fetch(`${SYNC_CONFIG.syncUrl}/functions/v1/nyora-sync`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || {}),
  });
  noteServerClock(res);
  if (res.status === 401 && !retried) {
    const { session: refreshed, rejected } = await refreshSession(session);
    if (refreshed) return edge(refreshed, body, true);
    // Sign the user out only when the server actually refused the refresh
    // token. A transient failure keeps the session so the next sync — or the
    // next launch — can try again instead of demanding a fresh sign-in.
    if (rejected) {
      clearSession();
      throw new Error('Session expired. Please sign in again.');
    }
    throw new Error('Could not reach the sync service — still signed in, will retry.');
  }
  const data = await parseJson(res);
  if (!res.ok || data.error) {
    throw new Error((data && (data.error || data.detail)) || `Sync failed ${res.status}`);
  }
  return data;
}

async function parseJson(res) {
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function upsert(session, table, rows) {
  if (!rows || !rows.length) return;
  await edge(session, { action: 'upsert', table, rows });
}

async function select(session, table, since) {
  const data = await edge(session, { action: 'select', table, since });
  return Array.isArray(data.data) ? data.data : [];
}

async function pushAll(session) {
  const uid = session.user_id || parseJwtSub(session.access_token);
  const now = new Date().toISOString();
  const snapshot = library.exportData();
  const rows = toRemoteRows(snapshot, uid, now);

  // Only send what changed. This used to upload the ENTIRE library on every
  // sync — and auto-sync fires on a 60s timer, on tab focus, and on every
  // chapter opened, so a few hundred favourites meant re-uploading the whole
  // collection every minute of a reading session. Rows already carry the
  // timestamp of the thing they describe, so the previous push's cutoff is all
  // the filter needs. A periodic full push repairs anything lost server-side.
  // (prefs and manga_category are stamped with `now` because the local model
  // keeps no change time for them, so those two always go — they are small
  // next to manga rows, which carry titles, covers and descriptions.)
  const pushedAt = Date.now();   // local clock: these rows were stamped by it
  const full = isFullPushDue(session);
  const sinceMs = full ? 0 : ms(session.last_push_timestamp || INITIAL_SYNC);
  const changed = (list) => (sinceMs ? (list || []).filter((r) => ms(r.updated_at) >= sinceMs) : (list || []));

  await upsert(session, 'nyora_manga', changed(rows.manga));
  await upsert(session, 'nyora_category', changed(rows.categories));
  await upsert(session, 'nyora_favourite', changed(rows.favourites));
  await upsert(session, 'nyora_history', changed(rows.history));
  await upsert(session, 'nyora_bookmark', changed(rows.bookmarks));
  await upsert(session, 'nyora_manga_prefs', changed(rows.prefs));
  await upsert(session, 'nyora_manga_category', changed(rows.mangaCategories));
  await upsert(session, 'nyora_update', changed(rows.updates));
  await upsert(session, 'nyora_source_prefs', sourcePrefRows(uid));

  // Advanced only now, with every table through. A push that threw partway
  // leaves the old cutoff in place so the next attempt resends the lot. The
  // same overlap rewind applies here, so a local edit made while the push was
  // in flight is included in the next one rather than waiting to change again.
  session.last_push_timestamp = cutoffIso(pushedAt);
  if (full) session.last_full_push_at = new Date(pushedAt).toISOString();
}

function isFullPushDue(session) {
  if (!session.last_push_timestamp) return true;      // never pushed from here
  const last = Date.parse(session.last_full_push_at || '');
  if (!Number.isFinite(last)) return true;
  return (Date.now() - last) >= FULL_PUSH_EVERY_MS;   // both ends are local time
}

async function pullAll(session, since) {
  const mangaRows = await select(session, 'nyora_manga', since);
  const categoryRows = await select(session, 'nyora_category', since);
  const favouriteRows = await select(session, 'nyora_favourite', since);
  const historyRows = await select(session, 'nyora_history', since);
  const bookmarkRows = await select(session, 'nyora_bookmark', since);
  const mangaCategoryRows = await select(session, 'nyora_manga_category', since);
  const prefRows = await select(session, 'nyora_manga_prefs', since);
  const updateRows = await select(session, 'nyora_update', since);

  const merged = fromRemoteRows({
    mangaRows, categoryRows, favouriteRows, historyRows,
    bookmarkRows, mangaCategoryRows, prefRows, updateRows,
  }, since !== INITIAL_SYNC ? library.exportData() : null);
  library.importData(merged);
  // Collapse any duplicate-title categories that arrived from legacy per-device seeds.
  try { library.dedupeCategories(); } catch { /* ignore */ }

  // The user's installed/pinned sources follow their account too.
  const sourcePrefsPulled = await select(session, 'nyora_source_prefs', since);
  if (applySourcePrefRows(sourcePrefsPulled)) {
    try { window.dispatchEvent(new CustomEvent('nyora:sources-synced')); } catch { /* no DOM */ }
  }
  return merged;
}

function toRemoteRows(data, uid, nowIso) {
  const manga = new Map();
  const addManga = (m, sourceId, updatedAt, forcedId) => {
    const row = mangaRow(m, uid, updatedAt || nowIso, sourceId, forcedId);
    if (row && !manga.has(row.id)) manga.set(row.id, row);
    return row && row.id;
  };

  const favourites = [];
  for (const [mangaId, rec] of Object.entries(data.favourites || {})) {
    addManga(rec.manga, sourceIdFromManga(rec.manga), iso(rec.addedAt), mangaId);
    favourites.push({
      user_id: uid,
      manga_id: String(mangaId),
      sort_key: 0,
      updated_at: iso(rec.addedAt || Date.now()),
      deleted_at: null,
    });
  }

  const history = [];
  for (const [mangaId, h] of Object.entries(data.history || {})) {
    addManga(h.manga, h.sourceId, iso(h.updatedAt), mangaId);
    history.push({
      user_id: uid,
      manga_id: String(mangaId),
      source_id: h.sourceId || openableSourceId(h.manga),
      chapter_id: String(h.chapterId || h.chapterUrl || ''),
      chapter_title: h.chapterTitle || '',
      page: Number(h.page) || 0,
      scroll: 0,
      percent: Number(h.percent) || 0,
      chapters_count: Number(h.total) || 0,
      updated_at: iso(h.updatedAt || Date.now()),
      deleted_at: null,
    });
  }

  const bookmarks = [];
  for (const b of data.bookmarks || []) {
    addManga(b.manga, b.sourceId, iso(b.createdAt), b.mangaId);
    bookmarks.push({
      user_id: uid,
      id: `${b.mangaId}:${b.chapterId}:${b.page}`,
      manga_id: String(b.mangaId || ''),
      chapter_id: String(b.chapterId || b.chapterUrl || ''),
      chapter_title: b.chapterTitle || '',
      page: Number(b.page) || 0,
      scroll: 0,
      note: b.note || '',
      image_url: '',
      percent: 0,
      created_at: iso(b.createdAt || Date.now()),
      updated_at: iso(b.createdAt || Date.now()),
      deleted_at: null,
    });
  }

  // Include soft-deleted categories so deletions (e.g. duplicate cleanup) propagate.
  const categories = Object.values(data.categories || {}).map((c, index) => ({
    user_id: uid,
    id: String(c.id),
    title: c.title || '',
    sort_key: index,
    updated_at: iso(c.createdAt || Date.now()),
    deleted_at: c.deletedAt ? iso(c.deletedAt) : null,
  }));

  const mangaCategories = [];
  for (const [categoryId, members] of Object.entries(data.categoryMembers || {})) {
    for (const mangaId of Object.keys(members || {})) {
      if (!members[mangaId]) continue;
      mangaCategories.push({
        user_id: uid,
        manga_id: String(mangaId),
        category_id: String(categoryId),
        updated_at: nowIso,
        deleted_at: null,
      });
    }
  }

  const prefs = Object.entries(data.prefs || {}).map(([mangaId, p]) => ({
    user_id: uid,
    manga_id: String(mangaId),
    reader_mode: p.mode || p.reader_mode || '',
    brightness: Number(p.brightness) || 0,
    contrast: Number(p.contrast) || 1,
    saturation: Number(p.saturation) || 1,
    hue: Number(p.hue) || 0,
    palette: p.palette || '',
    updated_at: nowIso,
  }));

  const updates = Object.entries(data.snapshots || {}).map(([mangaId, s]) => ({
    user_id: uid,
    manga_id: String(mangaId),
    source_id: s.sourceId || '',
    last_chapter_count: Number(s.chapterCount) || 0,
    new_chapters_count: Number(s.newChapters) || 0,
    latest_chapter_title: s.latestChapterTitle || '',
    last_synced_at: iso(s.lastSyncedAt || Date.now()),
    updated_at: iso(s.lastSyncedAt || Date.now()),
  }));

  return {
    manga: Array.from(manga.values()),
    favourites, history, bookmarks, categories, mangaCategories, prefs, updates,
  };
}

function cleanSourceId(sid) {
  // `bareSourceName` also unwraps the shapes that used to be stored verbatim and
  // then failed to open: a serialised MangaSourceRef, and the `DD_` ids the
  // data-driven clients sync. Exact casing is settled later against the
  // catalogue (see `helperSourceId`), since the helper compares ids exactly.
  const bare = bareSourceName(sid);
  if (!bare) return 'UNKNOWN';
  if (bare === 'LOCAL') return 'LOCAL';
  return `parser:${bare}`;
}

function fromRemoteRows(rows, baseData) {
  const data = baseData || emptyLibraryData();
  const mangaById = new Map();
  for (const row of rows.mangaRows || []) {
    const m = mangaFromRow(row);
    mangaById.set(m.id, m);
  }

  for (const row of rows.categoryRows || []) {
    if (row.deleted_at) {
      // Soft-delete: keep the record (stamped) so the deletion re-propagates and
      // dedupeCategories below can still see/skip it. Members are left in place.
      const existing = data.categories[row.id];
      data.categories[row.id] = {
        id: String(row.id),
        title: (existing && existing.title) || row.title || '',
        createdAt: (existing && existing.createdAt) || ms(row.updated_at),
        deletedAt: ms(row.deleted_at),
      };
    } else {
      data.categories[row.id] = {
        id: String(row.id),
        title: row.title || '',
        createdAt: ms(row.updated_at),
      };
      if (!data.categoryMembers[row.id]) data.categoryMembers[row.id] = {};
    }
  }

  for (const row of rows.favouriteRows || []) {
    if (row.deleted_at) {
      delete data.favourites[row.manga_id];
    } else {
      data.favourites[row.manga_id] = {
        manga: mangaById.get(row.manga_id) || fallbackManga(row.manga_id),
        addedAt: ms(row.updated_at),
      };
    }
  }

  for (const row of rows.historyRows || []) {
    if (row.deleted_at) {
      delete data.history[row.manga_id];
    } else {
      const manga = mangaById.get(row.manga_id) || fallbackManga(row.manga_id);
      data.history[row.manga_id] = {
        manga,
        sourceId: cleanSourceId(row.source_id || openableSourceId(manga)),
        chapterUrl: row.chapter_id || '',
        chapterId: row.chapter_id || '',
        chapterTitle: row.chapter_title || '',
        chapterNumber: null,
        page: Number(row.page) || 0,
        total: Number(row.chapters_count) || 0,
        percent: Number(row.percent) || 0,
        updatedAt: ms(row.updated_at),
      };
    }
  }

  for (const row of rows.bookmarkRows || []) {
    const id = row.id || `${row.manga_id}:${row.chapter_id}:${row.page}`;
    data.bookmarks = (data.bookmarks || []).filter((b) => b.id !== id);
    if (!row.deleted_at) {
      const manga = mangaById.get(row.manga_id) || fallbackManga(row.manga_id);
      data.bookmarks.push({
        id,
        mangaId: row.manga_id,
        manga,
        sourceId: cleanSourceId(row.source_id || openableSourceId(manga)),
        chapterUrl: row.chapter_id || '',
        chapterId: row.chapter_id || '',
        chapterTitle: row.chapter_title || '',
        page: Number(row.page) || 0,
        note: row.note || '',
        createdAt: ms(row.created_at || row.updated_at),
      });
    }
  }

  for (const row of rows.mangaCategoryRows || []) {
    if (!data.categoryMembers[row.category_id]) data.categoryMembers[row.category_id] = {};
    if (row.deleted_at) delete data.categoryMembers[row.category_id][row.manga_id];
    else data.categoryMembers[row.category_id][row.manga_id] = true;
  }

  for (const row of rows.prefRows || []) {
    data.prefs[row.manga_id] = {
      reader_mode: row.reader_mode || '',
      brightness: Number(row.brightness) || 0,
      contrast: Number(row.contrast) || 1,
      saturation: Number(row.saturation) || 1,
      hue: Number(row.hue) || 0,
      palette: row.palette || '',
    };
  }

  for (const row of rows.updateRows || []) {
    data.snapshots[row.manga_id] = {
      sourceId: cleanSourceId(row.source_id),
      chapterCount: Number(row.last_chapter_count) || 0,
      newChapters: Number(row.new_chapters_count) || 0,
      latestChapterTitle: row.latest_chapter_title || '',
      lastSyncedAt: ms(row.last_synced_at || row.updated_at),
      seen: false,
      newChapterList: [],
    };
  }

  return data;
}

function mangaRow(m, uid, updatedAt, sourceId, forcedId) {
  if (!m) return null;
  // Prefer the caller's canonical library key so this manga row's id matches the
  // manga_id foreign key on the favourite/history/bookmark rows. For url-keyed
  // manga the library key is `sourceId|url`; falling back to bare m.url here
  // would make those rows reference a manga id that doesn't exist on pull.
  const id = forcedId != null && forcedId !== ''
    ? String(forcedId)
    : (m.id != null && m.id !== '' ? String(m.id) : (m.url || ''));
  if (!id) return null;
  return {
    user_id: uid,
    id,
    title: m.title || '',
    alt_titles: JSON.stringify(m.altTitles || []),
    url: m.url || '',
    public_url: m.publicUrl || m.url || '',
    rating: Number(m.rating) || -1,
    is_nsfw: m.isNsfw === true || m.contentRating === 'ADULT',
    content_rating: m.contentRating || null,
    cover_url: m.coverUrl || '',
    large_cover_url: m.largeCoverUrl || m.coverUrl || '',
    state: m.state || null,
    authors: JSON.stringify(m.authors || []),
    source_ref: encodeSourceRef(m, sourceId),
    description: m.description || '',
    tags: JSON.stringify(m.tags || []),
    updated_at: updatedAt || new Date().toISOString(),
  };
}

function mangaFromRow(row) {
  return {
    id: String(row.id || ''),
    title: row.title || '',
    altTitles: parseArray(row.alt_titles),
    url: row.url || '',
    publicUrl: row.public_url || row.url || '',
    rating: Number(row.rating) || -1,
    isNsfw: row.is_nsfw === true,
    contentRating: row.content_rating || null,
    coverUrl: row.cover_url || '',
    largeCoverUrl: row.large_cover_url || row.cover_url || '',
    state: row.state || null,
    authors: parseArray(row.authors),
    source: decodeSourceRef(row.source_ref),
    description: row.description || '',
    tags: parseArray(row.tags),
    chapters: [],
  };
}

function fallbackManga(id) {
  return { id: String(id || ''), title: String(id || 'Untitled'), url: '', source: { name: 'UNKNOWN' } };
}

function encodeSourceRef(manga, sourceId) {
  const name = sourceRefName(sourceId || sourceIdFromManga(manga));
  return JSON.stringify({ name: name || 'UNKNOWN' });
}

function decodeSourceRef(raw) {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    let name = value && (value.name || value.id || value.type || 'UNKNOWN');
    if (name.includes('.MangaSourceRef.')) name = name.split('.MangaSourceRef.').pop();
    return { name };
  } catch {
    let name = raw || 'UNKNOWN';
    if (name.includes('.MangaSourceRef.')) name = name.split('.MangaSourceRef.').pop();
    return { name };
  }
}

function sourceIdFromManga(manga) {
  const s = manga && manga.source;
  if (!s) return '';
  if (typeof s === 'string') return s;
  return s.name || s.id || s.type || '';
}

function sourceRefName(raw) {
  let value = String(raw || '').trim();
  if (value.includes('.MangaSourceRef.')) value = value.split('.MangaSourceRef.').pop();
  if (!value || value === 'UNKNOWN') return 'UNKNOWN';
  if (value === 'Local' || value === 'LOCAL') return 'LOCAL';
  if (value.startsWith('JS_')) return value;
  if (value.startsWith('parser:') || value.startsWith('script:')) return `JS_${value.slice(value.indexOf(':') + 1)}`;
  return value;
}

function openableSourceId(manga) {
  const bare = bareSourceName(sourceIdFromManga(manga));
  if (!bare) return '';
  if (bare === 'LOCAL') return 'LOCAL';
  return `parser:${bare}`;
}

function parseArray(raw) {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function emptyLibraryData() {
  return {
    favourites: {},
    history: {},
    bookmarks: [],
    categories: {},
    categoryMembers: {},
    prefs: {},
    snapshots: {},
    seq: 1,
  };
}

function iso(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return new Date(n).toISOString();
  if (typeof value === 'string' && value) return value;
  return new Date().toISOString();
}

function ms(value) {
  const n = Date.parse(value || '');
  return Number.isFinite(n) ? n : Date.now();
}

export default {
  status,
  hasLocalData,
  signIn,
  register,
  registerAndMigrate,
  signInAndFetch,
  signOut,
  syncNow,
  restoreFromCloud,
};
