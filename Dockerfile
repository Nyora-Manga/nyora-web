# syntax=docker/dockerfile:1.7

# ============================================================================
# Nyora Web — production Docker image.
#
# Runs the web SPA + the parser HELPER + (via docker-compose) FlareSolverr
# all LOCALLY. The only remote dependency is the sync backend, which stays at
# https://stream.hasanraza.tech (configured at runtime, never baked in).
#
# Topology inside the final container (all same-origin, no CORS):
#   Caddy :8080  ── serves /srv (the built SPA)
#                └─ handle_path /api/*  → reverse_proxy 127.0.0.1:8788 (helper)
#   Java helper :8788 (loopback only)  → talks to FlareSolverr over the network
#
# Three build stages:
#   1. helper — clone nyora-linux (+ nyora-shared submodule), build the fat jar
#   2. web    — npm ci + npm run build → /app/dist  (esbuild bundle)
#   3. runtime— eclipse-temurin:17-jre + caddy; copies jar + dist; non-root
# ============================================================================

# ----------------------------------------------------------------------------
# Stage 1: build the parser helper fat jar from source.
# Needs the FULL JDK + the Kotlin/Gradle toolchain (NOT a JRE/slim image).
# No Android SDK is required — :shared is a pure Kotlin/JVM (jvm() only) target.
# ----------------------------------------------------------------------------
FROM eclipse-temurin:17-jdk AS helper

# Which nyora-linux ref to build the helper from.
ARG NYORA_ENGINE_REF=main
ARG NYORA_ENGINE_REPO=https://github.com/Hasan72341/nyora-linux.git

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Clone the helper build repo AND its nyora-shared submodule (the submodule
# provides commonMain/jvmMain/macosMain + commonMain/sqldelight — required).
RUN git clone --depth 1 --recurse-submodules --shallow-submodules \
      --branch "${NYORA_ENGINE_REF}" "${NYORA_ENGINE_REPO}" nyora-linux

WORKDIR /build/nyora-linux

# Build ONLY :shared:helperJar — never `build` or `:desktopApp:*`, so the
# Compose Desktop / Skiko / KCEF Chromium artifacts are never fetched.
#
# BuildKit cache mounts keep Gradle's distribution + dependency cache warm
# across rebuilds (cold first build pulls Gradle 9.3.1 + deps incl. the
# jitpack kotatsu-parsers-redo — needs outbound network; do NOT use --offline).
RUN --mount=type=cache,target=/root/.gradle \
    chmod +x ./gradlew \
    && ./gradlew :shared:helperJar --no-daemon --console=plain \
    && cp shared/build/libs/nyora-helper.jar /nyora-helper.jar \
    && test -s /nyora-helper.jar

# ----------------------------------------------------------------------------
# Stage 2: build the static SPA (dist/) with esbuild.
# ----------------------------------------------------------------------------
FROM node:22-alpine AS web

WORKDIR /app

# Reproducible install: package-lock.json is committed, so `npm ci` is valid.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

# Only the build inputs the .dockerignore didn't strip.
COPY build.mjs ./
COPY web ./web

# node build.mjs: rm -rf dist, cp web/→dist/ (incl env.js/sw.js), esbuild bundle.
RUN npm run build && test -f dist/index.html && test -f dist/env.js

# ----------------------------------------------------------------------------
# Stage 3: lean runtime — JRE + Caddy. No JDK, no build toolchain.
# ----------------------------------------------------------------------------
FROM eclipse-temurin:17-jre AS runtime

# caddy (static web + reverse proxy), curl (healthcheck), tini (PID1 reaper).
# Caddy is pulled from its official apt repo, pinned by key, then repo lists
# are dropped to keep the layer small.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        curl ca-certificates tini debian-keyring debian-archive-keyring apt-transport-https gnupg; \
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg; \
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
        | tee /etc/apt/sources.list.d/caddy-stable.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends caddy; \
    apt-get purge -y --auto-remove gnupg apt-transport-https; \
    rm -rf /var/lib/apt/lists/*

# Non-root runtime user + writable dirs.
#   /srv        — the served SPA
#   /data       — helper SQLite DB + port file (XDG_DATA_HOME / XDG_CONFIG_HOME)
#   /config     — Caddy's own data/config (avoids /root writes)
RUN groupadd --system --gid 10001 nyora \
    && useradd --system --uid 10001 --gid nyora --home-dir /home/nyora --create-home nyora \
    && mkdir -p /srv /data /config /var/log/caddy \
    && chown -R nyora:nyora /srv /data /config /var/log/caddy

COPY --from=helper /nyora-helper.jar /opt/nyora/nyora-helper.jar
COPY --from=web    /app/dist         /srv
COPY Caddyfile            /etc/caddy/Caddyfile
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && chown -R nyora:nyora /srv /opt/nyora

# Runtime configuration (all overridable at `docker run` / compose time).
#   Sync stays REMOTE by default; helper is loopback-only behind the /api proxy.
ENV NYORA_SYNC_URL=https://stream.hasanraza.tech \
    FLARESOLVERR_URL=http://flaresolverr:8191/v1 \
    NYORA_HELPER_PORT=8788 \
    NYORA_HELPER_JAR=/opt/nyora/nyora-helper.jar \
    SRV_ROOT=/srv \
    XDG_DATA_HOME=/data \
    XDG_CONFIG_HOME=/data \
    XDG_CACHE_HOME=/data \
    HOME=/home/nyora \
    JAVA_OPTS="-Xmx320m -Xss512k -XX:MaxMetaspaceSize=128m -XX:ReservedCodeCacheSize=64m -XX:+UseSerialGC"

USER nyora
WORKDIR /opt/nyora

EXPOSE 8080
VOLUME ["/data"]

# Healthcheck goes through Caddy's /api strip → the helper's /health, i.e. it
# proves BOTH the proxy AND the helper are alive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=5 \
    CMD curl -fsS http://127.0.0.1:8080/api/health || exit 1

# tini as PID1 so the backgrounded helper + foreground caddy reap/forward
# signals cleanly; the entrypoint traps SIGTERM to stop the helper.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
