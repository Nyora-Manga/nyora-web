# Cluster-node setup: Discover feed refresh

`dist/discover-feed.json` is the prerendered Discover feed. The deploy pipeline
bakes it on every deploy, so it is only as fresh as the last deploy. These files
keep it current *between* deploys by refreshing it on each node.

Run this on **every node** (`nyora`, `claw`) — each serves the file itself, so
refreshing one does not help the others.

## Install

```sh
# 1. Script (needs curl + jq)
sudo install -m 755 refresh-discover-feed.sh /usr/local/bin/refresh-discover-feed.sh

# 2. Verify it works BEFORE scheduling it
sudo /usr/local/bin/refresh-discover-feed.sh
#    → refresh-discover-feed: wrote /var/www/nyora-web/discover-feed.json (…)

# 3. Schedule it
sudo install -m 644 nyora-discover-feed.service /etc/systemd/system/
sudo install -m 644 nyora-discover-feed.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nyora-discover-feed.timer
```

Check it: `systemctl list-timers nyora-discover-feed` and
`journalctl -u nyora-discover-feed -n 20`.

### Plain cron instead of systemd

```
17 */3 * * * WEBROOT=/var/www/nyora-web /usr/local/bin/refresh-discover-feed.sh >/dev/null 2>&1
```

Offset the minute per node (`17`, `37`) so they don't hit AniList at the same
instant.

## Behaviour worth knowing

- **Fails closed.** Any failure — AniList down, rate-limited, malformed
  response, empty trending rail — leaves the existing file untouched and exits
  `0`. A stale feed is better than a blank Discover, and clients revalidate
  against AniList in the background anyway.
- **Atomic.** Writes a temp file in the same directory and `mv`s it into place,
  so Caddy never serves a half-written file.
- **SELinux.** Runs `restorecon` on the temp file before the move, so the label
  Caddy needs is preserved on the node where SELinux is enforcing.
- **Deploys win.** `rsync --delete` replaces this file on every deploy with the
  deploy-time snapshot. That is fine — it is fresh at that moment, and the timer
  takes over again afterwards.

## Keeping it in sync with the app

The GraphQL query and the per-rail trim are duplicated in three places:

- `web/core/discover-feed.js` — the browser (canonical)
- `scripts/prerender-discover.mjs` — deploy-time snapshot
- `deploy/refresh-discover-feed.sh` — this script

They must agree on the rail names and shape, or a node will publish a feed the
client silently drops. If you add or rename a rail, change all three. CI checks
that the rail lists match (`npm run check:rails`).
