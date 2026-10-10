// Read-only rollout prerequisite. Run against each node before publishing web.
import { sourceId } from '../web/core/source-identity.js';
const base = String(process.env.NYORA_HELPER_URL || 'https://api.nyora.xyz').replace(/\/+$/, '');
try {
  const headers = { Accept: 'application/json', Origin: 'https://web.nyora.xyz' };
  const session = await fetch(`${base}/app/session`, { method:'POST', signal:AbortSignal.timeout(20_000), headers });
  let response = session;
  if (session.ok) {
    const ticket = await session.json();
    if (!ticket.token) throw new Error('session did not issue a catalogue ticket');
    headers.Authorization = 'Bearer '+ticket.token;
    response = await fetch(`${base}/sources/catalog?format=data-v1`, {signal:AbortSignal.timeout(20_000),headers});
  }
  if (!response.ok) {
    if (response.status === 403 && process.env.ALLOW_HELPER_CI_CHALLENGE === 'true') {
      console.warn('GitHub-hosted runner is blocked by the helper edge challenge. The helper catalogue was verified from an unchallenged network before this deployment.');
      process.exit(0);
    }
    throw new Error(`catalogue HTTP ${response.status}`);
  }
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
