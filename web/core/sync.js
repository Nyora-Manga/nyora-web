// core/sync.js — browser-only Supabase sync for Nyora Web.
//
// No client secret is used here. Google sign-in uses the public web client ID
// to obtain an ID token in the browser; Supabase exchanges that ID token for a
// user-scoped session, then all data moves through the nyora-sync edge function.

import library from './library.js';
import { sourcePrefRows, applySourcePrefRows } from './parser-runtime.js';

export const SYNC_CONFIG = {
  supabaseUrl: globalThis.NYORA_SUPABASE_URL || 'https://fqguzcoytnbnjwaddakn.supabase.co',
  supabaseAnonKey: globalThis.NYORA_SUPABASE_ANON_KEY || 'sb_publishable_RZTcdZZlzb_UhYAxtB09AQ_URTEftE4',
  googleWebClientId: globalThis.NYORA_GOOGLE_WEB_CLIENT_ID || '181067068545-k123p818q8qp0b1ppiee7h6ud8h54ei6.apps.googleusercontent.com',
};

const SESSION_KEY = 'nyora.supabase.session.v1';
const INITIAL_SYNC = '1970-01-01T00:00:00Z';

let _gisPromise = null;

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function saveSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    access_token: session.access_token || '',
    refresh_token: session.refresh_token || '',
    user_id: session.user_id || parseJwtSub(session.access_token || ''),
    last_sync_timestamp: session.last_sync_timestamp || INITIAL_SYNC,
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
    isConfigured: !!(SYNC_CONFIG.supabaseUrl && SYNC_CONFIG.supabaseAnonKey && SYNC_CONFIG.googleWebClientId),
    isAuthenticated: !!(session.access_token && (session.user_id || parseJwtSub(session.access_token))),
    userId: session.user_id || parseJwtSub(session.access_token || ''),
    lastSyncTimestamp: session.last_sync_timestamp || INITIAL_SYNC,
    googleWebClientId: SYNC_CONFIG.googleWebClientId,
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

export async function signInWithGoogle() {
  await loadGoogleIdentityServices();
  const idToken = await requestGoogleIdToken();
  const session = await supabaseAuth('token?grant_type=id_token', {
    provider: 'google',
    id_token: idToken,
  });
  saveSession({
    ...session,
    user_id: parseJwtSub(session.access_token || ''),
    last_sync_timestamp: loadSession().last_sync_timestamp || INITIAL_SYNC,
  });
  return status();
}

export function signOut() {
  clearSession();
}

export async function syncNow() {
  const session = await ensureSession();
  const cutoff = session.last_sync_timestamp || INITIAL_SYNC;
  await pushAll(session);
  const merged = await pullAll(session, cutoff);
  session.last_sync_timestamp = new Date().toISOString();
  saveSession(session);
  return merged;
}

export async function restoreFromCloud() {
  const session = await ensureSession();
  const merged = await pullAll(session, INITIAL_SYNC);
  session.last_sync_timestamp = new Date().toISOString();
  saveSession(session);
  return merged;
}

async function ensureSession() {
  let session = loadSession();
  if (!session.access_token) throw new Error('Sign in first.');
  if (session.refresh_token) {
    try {
      const refreshed = await supabaseAuth('token?grant_type=refresh_token', {
        refresh_token: session.refresh_token,
      });
      session = {
        ...session,
        access_token: refreshed.access_token || session.access_token,
        refresh_token: refreshed.refresh_token || session.refresh_token,
        user_id: parseJwtSub(refreshed.access_token || session.access_token) || session.user_id,
      };
      saveSession(session);
    } catch {
      // If refresh fails, try the current token; the edge function will return
      // 401 if it has actually expired.
    }
  }
  return session;
}

async function supabaseAuth(path, body) {
  const res = await fetch(`${SYNC_CONFIG.supabaseUrl}/auth/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: SYNC_CONFIG.supabaseAnonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || {}),
  });
  const data = await parseJson(res);
  if (!res.ok || data.error) throw new Error(data.error_description || data.error || `Auth failed ${res.status}`);
  return data;
}

async function edge(session, body) {
  const res = await fetch(`${SYNC_CONFIG.supabaseUrl}/functions/v1/nyora-sync`, {
    method: 'POST',
    headers: {
      apikey: SYNC_CONFIG.supabaseAnonKey,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || {}),
  });
  const data = await parseJson(res);
  if (!res.ok || data.error) throw new Error(data.error || `Sync failed ${res.status}`);
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
  await upsert(session, 'nyora_manga', rows.manga);
  await upsert(session, 'nyora_category', rows.categories);
  await upsert(session, 'nyora_favourite', rows.favourites);
  await upsert(session, 'nyora_history', rows.history);
  await upsert(session, 'nyora_bookmark', rows.bookmarks);
  await upsert(session, 'nyora_manga_prefs', rows.prefs);
  await upsert(session, 'nyora_manga_category', rows.mangaCategories);
  await upsert(session, 'nyora_update', rows.updates);
  await upsert(session, 'nyora_source_prefs', sourcePrefRows(uid));
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
  const addManga = (m, sourceId, updatedAt) => {
    const row = mangaRow(m, uid, updatedAt || nowIso, sourceId);
    if (row && !manga.has(row.id)) manga.set(row.id, row);
    return row && row.id;
  };

  const favourites = [];
  for (const [mangaId, rec] of Object.entries(data.favourites || {})) {
    addManga(rec.manga, sourceIdFromManga(rec.manga), iso(rec.addedAt));
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
    addManga(h.manga, h.sourceId, iso(h.updatedAt));
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
    addManga(b.manga, b.sourceId, iso(b.createdAt));
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
  let value = String(sid || '').trim();
  if (value.includes('.MangaSourceRef.')) value = value.split('.MangaSourceRef.').pop();
  if (value === 'UNKNOWN' || !value) return 'UNKNOWN';
  if (value === 'LOCAL' || value === 'Local') return 'LOCAL';
  if (value.startsWith('JS_')) return `parser:${value.slice(3)}`;
  if (value.startsWith('parser:') || value.startsWith('script:')) return `parser:${value.slice(value.indexOf(':') + 1)}`;
  return value;
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

function mangaRow(m, uid, updatedAt, sourceId) {
  if (!m) return null;
  const id = m.id != null && m.id !== '' ? String(m.id) : (m.url || '');
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
  let name = sourceIdFromManga(manga);
  if (name.includes('.MangaSourceRef.')) name = name.split('.MangaSourceRef.').pop();
  if (name.startsWith('JS_')) return `parser:${name.slice(3)}`;
  if (name.startsWith('parser:') || name.startsWith('script:')) return `parser:${name.slice(name.indexOf(':') + 1)}`;
  return name;
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

function loadGoogleIdentityServices() {
  if (globalThis.google && globalThis.google.accounts && globalThis.google.accounts.id) return Promise.resolve();
  if (_gisPromise) return _gisPromise;
  _gisPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-nyora-google-identity]');
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Google Identity Services failed to load.')), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.dataset.nyoraGoogleIdentity = 'true';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Google Identity Services failed to load.'));
    document.head.appendChild(script);
  });
  return _gisPromise;
}

function requestGoogleIdToken() {
  return new Promise((resolve, reject) => {
    const google = globalThis.google;
    if (!google || !google.accounts || !google.accounts.id) {
      reject(new Error('Google Identity Services is unavailable.'));
      return;
    }
    let settled = false;
    let modal = null;
    const cleanup = () => { if (modal) { modal.remove(); modal = null; } };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('Google sign-in timed out.')), 120000);

    google.accounts.id.initialize({
      client_id: SYNC_CONFIG.googleWebClientId,
      callback: (response) => {
        if (response && response.credential) finish(resolve, response.credential);
        else finish(reject, new Error('Google did not return an ID token.'));
      },
      cancel_on_tap_outside: false,
      itp_support: true,
      use_fedcm_for_prompt: true,
    });

    // Robust fallback: One-Tap (prompt) is frequently suppressed — incognito,
    // blocked third-party cookies, cooldown, or no existing session — and then
    // returns a useless "unknown_reason". When that happens, render a real GIS
    // account-chooser BUTTON in a modal; clicking it opens the chooser popup and
    // returns the ID token via the same `callback`. This always works.
    const showButtonModal = () => {
      if (settled || modal) return;
      const host = document.createElement('div');
      host.className = 'gis-modal';
      const card = document.createElement('div');
      card.className = 'gis-modal-card';
      const title = document.createElement('div');
      title.className = 'gis-modal-title';
      title.textContent = 'Choose a Google account';
      const slot = document.createElement('div');
      slot.className = 'gis-btn-slot';
      const cancel = document.createElement('button');
      cancel.className = 'gis-modal-cancel';
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => finish(reject, new Error('Sign-in canceled')));
      host.addEventListener('click', (e) => { if (e.target === host) finish(reject, new Error('Sign-in canceled')); });
      card.append(title, slot, cancel);
      host.append(card);
      document.body.appendChild(host);
      modal = host;
      try {
        google.accounts.id.renderButton(slot, {
          theme: 'outline', size: 'large', shape: 'pill',
          text: 'signin_with', logo_alignment: 'center',
        });
      } catch (_) { /* GIS not ready — safety timer / cancel still apply */ }
    };

    // Fast path: try One-Tap; fall back to the button modal if it can't display.
    try {
      google.accounts.id.prompt((notification) => {
        if (!notification) return;
        const notShown =
          (notification.isNotDisplayed && notification.isNotDisplayed()) ||
          (notification.isSkippedMoment && notification.isSkippedMoment());
        if (notShown) showButtonModal();
      });
    } catch (_) {
      showButtonModal();
    }
    // Safety net: some browsers never invoke the prompt callback under FedCM —
    // show the button shortly after if nothing has resolved yet.
    setTimeout(() => { if (!settled && !modal) showButtonModal(); }, 1400);
  });
}

export default {
  status,
  hasLocalData,
  signInWithGoogle,
  signOut,
  syncNow,
  restoreFromCloud,
};
