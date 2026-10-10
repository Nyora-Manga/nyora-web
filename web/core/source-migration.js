// Bounded local upgrade only. Live helper and cloud inputs must use source-identity.js.
import { sourceId } from './source-identity.js';
import { SOURCE_PREFERENCES_KEY } from './source-preferences.js';
const DONE_KEY = 'nyora.sources.migrated.v1';
const RENAMED = { asurascans_us: 'asurascans', manganelo_com: 'manganelo', webtoons_en: 'webtoons',
  mangafire_esla: 'mangafire_es_la', mangafire_ptbr: 'mangafire_pt_br', maid_id: 'maid-id',
  shiro_doujin: 'shiro-doujin', komikindo_info: 'mangasusuku', 'komikindo-info': 'mangasusuku', hmangabat: 'mangabat' };

export function migrateSourceId(raw, catalogue) {
  let value = raw;
  for (let i = 0; i < 5; i++) {
    if (value && typeof value === 'object') { value = value.name ?? value.id; continue; }
    if (typeof value === 'string' && value.startsWith('{')) {
      try { value = JSON.parse(value); continue; } catch { return ''; }
    }
    break;
  }
  if (typeof value !== 'string') return '';
  if (sourceId(value)) {
    const renamed = RENAMED[value.slice(5)];
    const successor = renamed && `data:${renamed}`;
    return successor && catalogue.some((e) => e.id === successor) ? successor : value;
  }
  value = value.trim();
  if (value.includes('.MangaSourceRef.')) value = value.split('.MangaSourceRef.').pop();
  for (let i = 0; i < 5; i++) {
    const next = value.replace(/^(?:parser:|script:|data:|DD_|JS_)/, '');
    if (next === value) break;
    value = next;
  }
  const bare = value.toLowerCase();
  const candidate = `data:${RENAMED[bare] || bare}`;
  return sourceId(candidate) && catalogue.some((e) => e.id === candidate) ? candidate : '';
}

export function migrateLibrarySources(original, catalogue) {
  const data = JSON.parse(JSON.stringify(original));
  const ids = new Map();
  const fix = (rec, key) => {
    const id = migrateSourceId(rec.sourceId || rec.manga?.source, catalogue);
    if (!id) return key;
    if (rec.sourceId != null) rec.sourceId = id;
    if (rec.manga) rec.manga.source = { name: id };
    if (key && rec.manga?.url && !rec.manga.id && key.includes('|')) {
      const next = `${id}|${rec.manga.url}`;
      ids.set(key, next);
      return next;
    }
    return key;
  };
  for (const bucket of ['favourites', 'history']) {
    const next = {};
    for (const [key, rec] of Object.entries(data[bucket] || {})) {
      const id = fix(rec, key);
      const prior = next[id];
      if (!prior || (rec.updatedAt || rec.addedAt || 0) >= (prior.updatedAt || prior.addedAt || 0)) next[id] = rec;
    }
    if (data[bucket]) data[bucket] = next;
  }
  for (const rec of data.bookmarks || []) {
    rec.mangaId = fix(rec, rec.mangaId);
    rec.mangaId = ids.get(rec.mangaId) || rec.mangaId;
  }
  for (const bucket of ['prefs', 'snapshots']) {
    if (!data[bucket]) continue;
    data[bucket] = Object.fromEntries(Object.entries(data[bucket]).map(([key, rec]) => {
      if (bucket === 'snapshots') fix(rec, key);
      return [ids.get(key) || key, rec];
    }));
  }
  for (const [category, members] of Object.entries(data.categoryMembers || {})) {
    data.categoryMembers[category] = Object.fromEntries(Object.entries(members).map(([key, value]) => [ids.get(key) || key, value]));
  }
  return data;
}

function read(key, fallback) {
  const raw = localStorage.getItem(key);
  if (raw == null) return fallback;
  return JSON.parse(raw); // Corrupt state must not be silently marked migrated.
}

export function sourceMigrationPending() {
  return !localStorage.getItem(DONE_KEY);
}

export function migrateWebSources(library, catalogue) {
  if (localStorage.getItem(DONE_KEY)) return;
  // Both old stores remain untouched, so a failed/quota-limited attempt is recoverable.
  if (!localStorage.getItem(SOURCE_PREFERENCES_KEY)) {
    const uiInstalled = read('nyora.sources.installed.v3', null);
    const uiPinned = read('nyora.sources.pinned.v1', []);
    const old = read('nyora.webParser.sources', {});
    const convert = (ids) => new Set((Array.isArray(ids) ? ids : []).map((id) => migrateSourceId(id, catalogue)).filter(Boolean));
    const installed = uiInstalled == null ? null : convert(uiInstalled);
    const pinned = convert(uiPinned);
    const overrides = {};
    // The visible UI store is authoritative. Old shim defaults were never the UI state.
    for (const id of new Set([...catalogue.map((s) => s.id), ...(installed || []), ...pinned])) {
      const enabled = installed == null || installed.has(id);
      if (installed != null || pinned.has(id)) overrides[id] = { enabled, pinned: enabled && pinned.has(id), updatedAt: Date.now() };
    }
    // If there was no visible UI selection, preserve explicitly synced preferences only.
    if (installed == null) for (const [raw, timestamp] of Object.entries(old.ts || {})) {
      const id = migrateSourceId(raw, catalogue);
      if (!id || overrides[id] || !Number.isFinite(timestamp) || timestamp <= 0) continue;
      const enabled = convert(old.installed).has(id);
      overrides[id] = { enabled, pinned: enabled && convert(old.pinned).has(id), updatedAt: timestamp };
    }
    localStorage.setItem(SOURCE_PREFERENCES_KEY, JSON.stringify({ defaultEnabled: installed == null, overrides }));
  }
  const original = library.exportData();
  const migrated = migrateLibrarySources(original, catalogue);
  if (JSON.stringify(original) !== JSON.stringify(migrated)) {
    library.persistSourceMigration(migrated);
  }
  // Force the next cloud push to include migrated source fields, irrespective of old cutoff.
  const session = read('nyora.sync.session.v1', null);
  if (session) {
    session.last_push_timestamp = '';
    session.last_full_push_at = '';
    localStorage.setItem('nyora.sync.session.v1', JSON.stringify(session));
  }
  localStorage.setItem(DONE_KEY, '1');
  if (JSON.stringify(original) !== JSON.stringify(migrated)) {
    queueMicrotask(() => {
      try { window.dispatchEvent(new CustomEvent('nyora:migrated', { detail: { name: 'data-driven-sources-v1' } })); } catch { /* no DOM */ }
    });
  }
}
