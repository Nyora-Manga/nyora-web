#!/usr/bin/env bash
# ============================================================================
# Nyora Web container entrypoint.
#
#   1. Render /srv/env.js from container env (same-origin helper, remote sync).
#   2. Start the Java parser helper on 127.0.0.1:8788 (background).
#   3. Wait for the helper /health to come up (fail loudly if it never does).
#   4. exec Caddy in the foreground (PID1-friendly under tini).
#
# Clean shutdown: a SIGTERM trap stops the background helper before exit.
# ============================================================================
set -euo pipefail

SRV_ROOT="${SRV_ROOT:-/srv}"
HELPER_PORT="${NYORA_HELPER_PORT:-8788}"
HELPER_JAR="${NYORA_HELPER_JAR:-/opt/nyora/nyora-helper.jar}"
SYNC_URL="${NYORA_SYNC_URL:-https://stream.hasanraza.tech}"
FLARE_URL="${FLARESOLVERR_URL:-http://flaresolverr:8191/v1}"
JAVA_OPTS="${JAVA_OPTS:--Xmx320m -Xss512k -XX:MaxMetaspaceSize=128m -XX:ReservedCodeCacheSize=64m -XX:+UseSerialGC}"

log() { printf '[entrypoint] %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# 1. Render env.js.
#
# NYORA_HELPER_URL is computed IN THE BROWSER as `location.origin + '/api'`
# so the helper is always same-origin (no CORS, no mixed content, no hardcoded
# host — works whether you reach the container on localhost, a LAN IP, or
# behind an HTTPS reverse proxy). helperBase() only trims a trailing slash and
# string-concatenates, so an absolute origin+'/api' resolves cleanly to
# /api/sources/catalog, /api/image?u=..., etc. — which Caddy strips to the
# helper's root routes.
#
# NYORA_SYNC_URL is an absolute remote URL, injected verbatim from container env.
#
# NOTE on the service worker: sw.js precaches '/env.js', so a RETURNING PWA
# install could serve a previously cached env.js on first paint and only pick
# up a changed URL on the next load (stale-while-revalidate). For a fresh local
# deploy (empty caches) this is a non-issue. If you RECONFIGURE a running
# deployment, hard-reload once (or bump the SW VERSION) to flush it.
# ---------------------------------------------------------------------------
render_env_js() {
    local dest="${SRV_ROOT}/env.js"
    # Escape single quotes / backslashes in the sync URL for safe JS embedding.
    local safe_sync="${SYNC_URL//\\/\\\\}"
    safe_sync="${safe_sync//\'/\\\'}"

    cat > "${dest}" <<EOF
// Generated at container start by docker-entrypoint.sh — do not edit.
// Sync stays REMOTE; the parser helper is served SAME-ORIGIN under /api.
globalThis.NYORA_SYNC_URL = '${safe_sync}';
globalThis.NYORA_HELPER_URL = (globalThis.location ? globalThis.location.origin : '') + '/api';
EOF
    log "rendered ${dest}: sync=${SYNC_URL} helper=<origin>/api"
}

# ---------------------------------------------------------------------------
# 2. Start the parser helper (background), pointed at the network FlareSolverr.
#    XDG_* (set in the image) point the helper's SQLite DB + port file at the
#    writable /data volume.
# ---------------------------------------------------------------------------
HELPER_PID=""
start_helper() {
    log "starting helper on 127.0.0.1:${HELPER_PORT} (flaresolverr=${FLARE_URL})"
    NYORA_HELPER_PORT="${HELPER_PORT}" \
    FLARESOLVERR_URL="${FLARE_URL}" \
        java ${JAVA_OPTS} -jar "${HELPER_JAR}" &
    HELPER_PID=$!
    log "helper pid=${HELPER_PID}"
}

# ---------------------------------------------------------------------------
# 3. Poll the helper /health (up to ~90s). Fail loudly if it never comes up.
# ---------------------------------------------------------------------------
wait_for_helper() {
    local url="http://127.0.0.1:${HELPER_PORT}/health"
    local i
    for i in $(seq 1 90); do
        if ! kill -0 "${HELPER_PID}" 2>/dev/null; then
            log "FATAL: helper process exited during startup"
            exit 1
        fi
        if curl -fsS "${url}" >/dev/null 2>&1; then
            log "helper healthy after ${i}s"
            return 0
        fi
        sleep 1
    done
    log "FATAL: helper did not become healthy within 90s"
    exit 1
}

# ---------------------------------------------------------------------------
# 4. Signal handling — stop the helper on SIGTERM/SIGINT, then exit.
# ---------------------------------------------------------------------------
CADDY_PID=""
shutdown() {
    log "signal received — shutting down"
    if [ -n "${CADDY_PID}" ] && kill -0 "${CADDY_PID}" 2>/dev/null; then
        kill -TERM "${CADDY_PID}" 2>/dev/null || true
    fi
    if [ -n "${HELPER_PID}" ] && kill -0 "${HELPER_PID}" 2>/dev/null; then
        kill -TERM "${HELPER_PID}" 2>/dev/null || true
        wait "${HELPER_PID}" 2>/dev/null || true
    fi
    exit 0
}
trap shutdown TERM INT

render_env_js
start_helper
wait_for_helper

# ---------------------------------------------------------------------------
# 5. Run Caddy and `wait` on it (rather than `exec`) so THIS shell stays alive
#    to service the SIGTERM trap and stop the background helper gracefully.
#    tini is PID1 and forwards signals to this script.
# ---------------------------------------------------------------------------
log "starting caddy on :8080"
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
CADDY_PID=$!

# Wait on Caddy; if it exits, tear down the helper too. `|| true` so a non-zero
# Caddy exit under `set -e` doesn't abort before the helper teardown below (and
# a SIGTERM to this script still hands control to the trap regardless).
wait "${CADDY_PID}" || true
CADDY_RC=$?
log "caddy exited (rc=${CADDY_RC}) — stopping helper"
if [ -n "${HELPER_PID}" ] && kill -0 "${HELPER_PID}" 2>/dev/null; then
    kill -TERM "${HELPER_PID}" 2>/dev/null || true
fi
exit "${CADDY_RC}"
