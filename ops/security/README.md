# Hosted web security boundary

These modules are deployment components, not browser assets. Never place the
signing key, rate database or sync service environment in `web/` or `env.js`.

- `rate_store.py`: atomic SQLite counters shared by sync workers. Expired buckets
  are pruned; capacity/database failures fail closed. IPv6 identities group at /64.
- `sync_ratelimit.py`: replacement for the private sync service's `app/ratelimit.py`.
  Install `rate_store.py` alongside it. The existing auth dependencies remain intact.
  Default budgets: token/refresh 20 per 300 seconds; registration 10 per hour.
- `catalog_gateway.py`: loopback HTTP service on 8790. Issues five-minute HMAC
  tickets to the exact app Origin, limits issuance and catalogue reads, verifies
  signature/audience/expiry, and fetches the local helper's catalogue. It neither
  accepts account credentials nor exposes the signing key. Both nodes use the
  same server-side key so requests survive DNS rotation.
- `nyora-catalog.service`: hardened systemd service, with a private state directory.
- `harden_caddy.py`: targeted patch for both existing cluster Caddy layouts. Reads
  the Cloudflare CIDRs in `cloudflare-proxies.txt`; only those proxy peers may
  supply client identity. Caddy overwrites `X-Nyora-Client-IP`, and both upstream
  services bind to loopback. Never expose those ports publicly.

## Rollout order

1. Remove the seven debug documents from the web root (backups belong outside it).
2. Install the rate module and gateway, provisioning a random 32-byte-or-longer
   `NYORA_CATALOG_SIGNING_KEY` in `/etc/nyora-catalog.env`, mode 0600, on both nodes.
3. Run `harden_caddy.py existing-Caddyfile candidate-Caddyfile` for the staged
   Origin gate and session endpoint; validate using Caddy's existing EnvironmentFile.
   Install/reload only after validation. Restart sync with its new rate module.
4. Deploy the web bundle with `core/app-session.js` and verify catalogue loading.
5. Apply the same patch with `--enforce-catalog`, validate, and reload both nodes.
   `/sources` and unrecognized `/sources*` paths return 404; `/sources/catalog`
   requires exact app Origin plus a ticket. OPTIONS remains a CORS preflight.
6. Probe missing/wrong Origin, missing/expired/tampered tickets, valid failover,
   no-store cache policy, auth 429/Retry-After and real app browsing.

Caddy's exact CSP strings are asserted unchanged by the patch. API responses from
the gateway are private/no-store; tokens live only in client memory. An Origin
header can be imitated outside a browser, so these tickets are an abuse-control
boundary, not user authentication or an anti-scraping guarantee. Account access
continues to require the sync service's user JWTs.

The service has one rate store per API node (two node budgets in aggregate);
sync currently has one node with shared counters across all its workers. If sync
is scaled to more nodes, move its counters to a shared transactional store.
Cloudflare proxy ranges should be refreshed from https://www.cloudflare.com/ips/.

Run `python3 -m unittest discover -s ops/security -v` for ticket, HTTP, worker
concurrency, IP identity and Caddy patch regressions. Browser ticket refresh tests
run under `npm test`. No tests need real user credentials.

Rollback: retain Caddy and module backups outside the web root; restore a matched
web/gateway contract if reverting ticket enforcement. Keep debug files deleted
and the trusted-proxy identity fix in place.

References: [Caddy trusted proxies](https://caddyserver.com/docs/caddyfile/options#trusted-proxies),
[OWASP login throttling](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#login-throttling).
