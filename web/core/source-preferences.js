// One per-browser store for catalogue UI, onboarding, and cloud preferences.
import { requireSourceId, sourceId } from './source-identity.js';

export const SOURCE_PREFERENCES_KEY = 'nyora.sources.v1';
let memory = { overrides: {} };
function load() {
  try {
    const raw = localStorage.getItem(SOURCE_PREFERENCES_KEY);
    memory = raw ? JSON.parse(raw) : { overrides: {} };
    if (!memory?.overrides || typeof memory.overrides !== 'object' || Array.isArray(memory.overrides)) memory = { overrides: {} };
  } catch { /* storage disabled: retain session state */ }
  return memory;
}
function save(state) {
  memory = state;
  // Explicit mutations must report a persistence error instead of claiming success.
  localStorage.setItem(SOURCE_PREFERENCES_KEY, JSON.stringify(state));
}
export function sourcePreference(id) {
  requireSourceId(id);
  const state = load();
  return state.overrides[id] || { enabled: state.defaultEnabled !== false, pinned: false, updatedAt: 0 };
}
function notifyChange() {
  try { window.dispatchEvent(new CustomEvent('nyora:source-preferences-changed')); } catch { /* no DOM */ }
}
export function setSourcePreference(id, change, at = Date.now()) {
  requireSourceId(id);
  const state = load();
  const prior = state.overrides[id] || { enabled: state.defaultEnabled !== false, pinned: false, updatedAt: 0 };
  const next = { ...prior, ...change, updatedAt: Math.max(at, prior.updatedAt + 1) };
  delete next.deferredNsfw; // An explicit install/remove/pin supersedes setup's content filter.
  if (!next.enabled) next.pinned = false;
  state.overrides[id] = next;
  save(state);
  notifyChange();
}
export function setInstalledSources(ids, catalogue, deferredNsfwIds = []) {
  const deferred = new Set(deferredNsfwIds.map(requireSourceId));
  const selected = new Set(ids.map(requireSourceId));
  const state = load();
  const all = new Set([...catalogue.map((s) => requireSourceId(s.id)), ...Object.keys(state.overrides), ...selected]);
  for (const id of all) {
    if (!sourceId(id)) continue;
    const prior = state.overrides[id] || { enabled: state.defaultEnabled !== false, pinned: false, updatedAt: 0 };
    const enabled = selected.has(id);
    state.overrides[id] = { enabled, pinned: enabled && prior.pinned, updatedAt: Math.max(Date.now(), prior.updatedAt + 1),
      ...(!enabled && deferred.has(id) ? { deferredNsfw: true } : {}) };
  }
  state.defaultEnabled = false;
  save(state);
  notifyChange();
}
export function enableSources(ids, onlyDeferred = false) {
  const state = load();
  let count = 0;
  for (const raw of ids) {
    const id = requireSourceId(raw);
    const prior = state.overrides[id] || { enabled: state.defaultEnabled !== false, pinned: false, updatedAt: 0 };
    if ((onlyDeferred && !prior.deferredNsfw) || prior.enabled) continue;
    state.overrides[id] = { enabled: true, pinned: !!prior.pinned, updatedAt: Math.max(Date.now(), prior.updatedAt + 1) };
    count++;
  }
  if (count) { save(state); notifyChange(); }
  return count;
}
export function sourcePrefRows(userId) {
  return Object.entries(load().overrides).filter(([id, p]) => sourceId(id) && !p.deferredNsfw && Number.isFinite(p.updatedAt) && p.updatedAt > 0)
    .map(([id, p]) => ({ user_id: userId, source_id: id, is_enabled: p.enabled !== false,
      is_pinned: p.enabled !== false && !!p.pinned, updated_at: new Date(p.updatedAt).toISOString() }));
}
export function applySourcePrefRows(rows) {
  const state = load();
  let changed = false;
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = sourceId(row?.source_id);
    const at = Date.parse(row?.updated_at);
    if (!id || !Number.isFinite(at) || at <= 0) continue;
    const prior = state.overrides[id];
    const enabled = row.is_enabled !== false;
    const next = { enabled, pinned: enabled && !!row.is_pinned, updatedAt: at };
    // Ties are deterministic (disabled/unpinned wins), independent of pull order.
    if (prior && (at < prior.updatedAt || (at === prior.updatedAt &&
      `${+next.enabled}${+next.pinned}` >= `${+prior.enabled}${+prior.pinned}`))) continue;
    state.overrides[id] = next;
    changed = true; // Persist a newer clock even if flags did not change.
  }
  if (changed) save(state);
  return changed;
}
