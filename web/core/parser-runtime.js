// Local preference shim retained for callers of api.post()/del(). Parsing is
// exclusively performed by the data-driven helper.
import { setSourcePreference, sourcePreference } from './source-preferences.js';
import { requireSourceId } from './source-identity.js';
export { sourcePrefRows, applySourcePrefRows } from './source-preferences.js';

export async function handle(path, method = 'GET') {
  const url = new URL(path, 'https://nyora.invalid');
  if (method === 'GET') return null;
  if (!['/sources/install', '/sources/uninstall', '/sources/pin'].includes(url.pathname)) return null;
  const id = requireSourceId(url.searchParams.get('id'));
  if (url.pathname === '/sources/install') setSourcePreference(id, { enabled: true });
  if (url.pathname === '/sources/uninstall') setSourcePreference(id, { enabled: false, pinned: false });
  if (url.pathname === '/sources/pin') {
    const pinned = url.searchParams.has('pinned') ? url.searchParams.get('pinned') === 'true' : !sourcePreference(id).pinned;
    setSourcePreference(id, { pinned, ...(pinned ? { enabled: true } : {}) });
  }
  return { ok: true };
}
