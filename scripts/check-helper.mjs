// Read-only rollout prerequisite. Run against each node before publishing web.
import { sourceId } from '../web/core/source-identity.js';
const base = String(process.env.NYORA_HELPER_URL || 'https://api.nyora.xyz').replace(/\/+$/, '');
try {
  const response = await fetch(`${base}/sources/catalog?format=data-v1`, { signal: AbortSignal.timeout(20_000), headers: { Accept: 'application/json', Origin: 'https://web.nyora.xyz' } });
  if (!response.ok) throw new Error(`catalogue HTTP ${response.status}`);
  const data = await response.json();
  const rows = Array.isArray(data) ? data : data.entries || data.sources;
  if (!Array.isArray(rows) || !rows.length) throw new Error('empty or malformed catalogue');
  if (rows.some((row) => typeof row?.id !== 'string' || !sourceId(row.id))) throw new Error('helper must supply lowercase data:<catalogue-id> identities');
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error('duplicate catalogue identities');
  console.log(`Data-driven catalogue verified: ${rows.length} sources at ${base}`);
} catch (error) {
  console.error(`Helper verification failed: ${error.message}`);
  process.exitCode = 1;
}
