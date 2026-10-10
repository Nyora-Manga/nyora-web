// Public runtime/wire identity. Legacy decoding belongs only in source-migration.js.
export function sourceId(raw) {
  if (raw && typeof raw === 'object') raw = raw.name ?? raw.id;
  return typeof raw === 'string' && /^data:[a-z0-9][a-z0-9._-]*$/.test(raw) ? raw : '';
}

export function requireSourceId(raw) {
  const id = sourceId(raw);
  if (!id) throw new Error('This source is unavailable. Refresh the source catalogue.');
  return id;
}
