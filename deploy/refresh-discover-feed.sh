#!/usr/bin/env bash
# refresh-discover-feed.sh — regenerate /var/www/nyora-web/discover-feed.json on
# a cluster node, so the prerendered Discover feed stays current BETWEEN deploys.
#
# The deploy pipeline bakes this file at deploy time (scripts/prerender-discover.mjs).
# That snapshot is only as fresh as the last deploy, so this script — run from a
# systemd timer or cron — refreshes it in place on each node.
#
# Design notes:
#  - Self-contained: needs only curl + jq. The nodes serve static files through
#    Caddy and are not assumed to have Node installed.
#  - Atomic: writes a temp file in the SAME directory and mv's it into place, so
#    Caddy never serves a half-written file. A partial JSON would make Discover
#    fall back to AniList for everyone until the next run.
#  - Fails closed: on any error the EXISTING file is left untouched. A stale
#    feed is strictly better than no feed (clients revalidate anyway), and a bad
#    AniList minute must not blank Discover.
#
# The GraphQL query and the trim-to-20 must match web/core/discover-feed.js and
# scripts/prerender-discover.mjs. If you change the rails there, change them here.
set -euo pipefail

WEBROOT="${WEBROOT:-/var/www/nyora-web}"
OUT="$WEBROOT/discover-feed.json"
API='https://graphql.anilist.co'
PER_RAIL=20

for bin in curl jq; do
  command -v "$bin" >/dev/null 2>&1 || { echo "refresh-discover-feed: '$bin' is required" >&2; exit 1; }
done
[ -d "$WEBROOT" ] || { echo "refresh-discover-feed: $WEBROOT does not exist" >&2; exit 1; }

FIELDS='id title { romaji english native } coverImage { large extraLarge } bannerImage genres averageScore countryOfOrigin'
page() { printf '%s: Page(perPage: 30) { media(type: MANGA, isAdult: false, %ssort: %s) { %s } }' "$1" "$2" "$3" "$FIELDS"; }
QUERY="query {
  $(page trending '' TRENDING_DESC)
  $(page manhwa 'countryOfOrigin: KR, ' POPULARITY_DESC)
  $(page manhua 'countryOfOrigin: CN, ' POPULARITY_DESC)
  $(page manga 'countryOfOrigin: JP, ' POPULARITY_DESC)
  $(page action 'genre: "Action", ' TRENDING_DESC)
  $(page romance 'genre: "Romance", ' TRENDING_DESC)
  $(page fantasy 'genre: "Fantasy", ' TRENDING_DESC)
}"

body="$(jq -n --arg q "$QUERY" '{query:$q}')"

raw="$(curl -fsS --max-time 30 --retry 2 --retry-delay 3 \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -X POST --data "$body" "$API")" || {
  echo "refresh-discover-feed: AniList request failed — keeping existing feed" >&2
  exit 0
}

# Drop entries with no usable cover (the renderers require one), trim each rail,
# and stamp the generation time. Mirrors the client's mediaUsable().
out="$(jq -c --argjson n "$PER_RAIL" '
  def usable: select(.coverImage != null and ((.coverImage.extraLarge // .coverImage.large) != null));
  def rail(k): [ (.data[k].media // [])[] | usable ][:$n];
  { at: (now * 1000 | floor),
    feed: { trending: rail("trending"), manhwa: rail("manhwa"), manhua: rail("manhua"),
            manga: rail("manga"), action: rail("action"), romance: rail("romance"),
            fantasy: rail("fantasy") } }
' <<<"$raw")" || {
  echo "refresh-discover-feed: could not parse AniList response — keeping existing feed" >&2
  exit 0
}

# Refuse to publish an empty feed — that would blank Discover for new visitors.
if [ "$(jq -r '.feed.trending | length' <<<"$out")" -lt 1 ]; then
  echo "refresh-discover-feed: empty trending rail — keeping existing feed" >&2
  exit 0
fi

tmp="$(mktemp "$WEBROOT/.discover-feed.XXXXXX.json")"
trap 'rm -f "$tmp"' EXIT
printf '%s' "$out" > "$tmp"
chmod 644 "$tmp"
# Preserve the SELinux label Caddy needs (no-op where SELinux isn't enabled).
command -v restorecon >/dev/null 2>&1 && restorecon "$tmp" >/dev/null 2>&1 || true
mv -f "$tmp" "$OUT"
trap - EXIT

echo "refresh-discover-feed: wrote $OUT ($(wc -c <"$OUT") bytes, trending=$(jq -r '.feed.trending|length' <"$OUT"))"
