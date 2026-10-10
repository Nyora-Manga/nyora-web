# Web and hosted API hardening — 2026-10-10

The audit found the seven debug documents still on both web servers. CI's rsync
exclusion preserved them. Both API nodes did not have the same access policy:
the secondary returned the full source catalogue to an unauthenticated client.
Sync already had in-memory limits, but each gunicorn worker counted separately
and the reverse proxy accepted arbitrary CF-Connecting-IP headers.

Changes:

- Delete the seven debug files from source and both live web roots; build excludes
  future underscore-prefixed HTML and CI no longer preserves them.
- Remove the SPA path fallback. Hash routes still use `/`; `/privacy` redirects to
  `https://nyora.xyz/privacy`; nonexistent `/dmca` and `/about` return 404. The
  service worker also stops returning the shell for these paths when offline.
- Use atomic SQLite auth budgets shared by all sync workers: 20 token/refresh
  requests per five minutes and 10 registrations per hour, per client identity.
  Caddy derives client IP only from trusted Cloudflare peers or the actual socket,
  overwrites the private identity header, and caps auth request bodies at 16 KiB.
- Require exact app Origin and a signed five-minute ticket for `/sources/catalog`
  on both API nodes. `/sources` and unused source-prefix routes return 404.
  Tickets are held in client memory; gateway responses are private/no-store.
  The server signing key stays in a root-readable environment file, outside git.
- Keep NSFW disabled by default and verify adult-source hiding in the browser test.
- Remove stuffed keyword metadata; generate sitemap lastmod from the release
  commit date. Keep the existing root canonical/title, CSP and hash navigation.

No SSR series catalogue is introduced in this security rollout. Series search
landing pages remain a separate content/product project, with real useful pages
needed before expanding the sitemap. The marketing site remains separate.

Verification includes concurrent shared-counter tests, signature/tamper/expiry
and HTTP Origin checks, app ticket reuse/refresh tests, build exclusion and sitemap
checks, browser UI/NSFW checks, and local/offline reader regression checks. Live
auth probes use missing credentials and invalid registration bodies; no user
accounts are created. Changing spoofed forwarding/IP headers still reaches the
same budget and returns 429 with Retry-After after the documented threshold.

Operational components, phased deployment order and rollback notes are in
[ops/security](../ops/security/README.md). Tickets limit catalogue access but do
not make public browser data impossible to scrape; Origin can be imitated by
non-browser clients. These are not replacements for user JWT authentication.
