#!/usr/bin/env bash
# Build + register nc_login_mini in the local NC sandbox.
# Strictly local: image is built on this host, pushed to a local Docker
# registry container, and pulled from there by AppAPI. Nothing leaves the
# machine.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ID="nc_login_mini"
NC_CONTAINER="${NC_CONTAINER:-bf-appstore-test-nc}"
NC_NETWORK="${NC_NETWORK:-bf-appstore-test}"
DEPLOY_DAEMON="${DEPLOY_DAEMON:-docker_local}"
REGISTRY_CONTAINER="nc-login-mini-registry"
REGISTRY_HOST_PORT="5500"

# AppAPI looks at <registry>ghcr.io</registry> in info.xml and asks the
# daemon to pull from there. We rewrite that with a daemon-level mapping
# so it actually pulls from our local registry inside the NC network.
INFO_REGISTRY="ghcr.io"
INFO_IMAGE="bee-flow/nc-login-mini"
INFO_TAG="dev"

# Inside the NC container we reach the registry container by its DNS name
# on the shared docker network. From the host we use 127.0.0.1:port.
LOCAL_REGISTRY_INTERNAL="${REGISTRY_CONTAINER}:5000"
LOCAL_REGISTRY_HOST="127.0.0.1:${REGISTRY_HOST_PORT}"

LOCAL_IMAGE_REF="${LOCAL_REGISTRY_HOST}/${INFO_IMAGE}:${INFO_TAG}"

cd "$SCRIPT_DIR"

# ── Step 1: ensure local Docker registry is up ────────────────────
if ! docker inspect "$REGISTRY_CONTAINER" >/dev/null 2>&1; then
    echo "▶ Starting local Docker registry container ($REGISTRY_CONTAINER)…"
    docker run -d --name "$REGISTRY_CONTAINER" \
        --restart unless-stopped \
        --network "$NC_NETWORK" \
        -p "${REGISTRY_HOST_PORT}:5000" \
        registry:2 >/dev/null
    sleep 2
elif [ "$(docker inspect -f '{{.State.Running}}' "$REGISTRY_CONTAINER")" != "true" ]; then
    echo "▶ Starting existing registry container…"
    docker start "$REGISTRY_CONTAINER" >/dev/null
    sleep 2
fi

# ── Step 2: build + push image ────────────────────────────────────
echo "▶ Building $LOCAL_IMAGE_REF…"
docker build -q -t "$LOCAL_IMAGE_REF" . | sed 's/^/  /'

echo "▶ Pushing to local registry…"
docker push -q "$LOCAL_IMAGE_REF" | sed 's/^/  /'

# ── Step 3: register registry mapping so AppAPI's pull of ghcr.io
# rewrites to the local registry. Safe to re-run — duplicate mapping
# errors are silenced. ──────────────────────────────────────────────
echo "▶ Mapping AppAPI ${INFO_REGISTRY} → ${LOCAL_REGISTRY_INTERNAL} (inside NC network)…"
docker exec --user www-data "$NC_CONTAINER" \
    php occ app_api:daemon:registry:add "$DEPLOY_DAEMON" \
        --registry-from "$INFO_REGISTRY" \
        --registry-to "$LOCAL_REGISTRY_INTERNAL" 2>&1 \
    | grep -vE "already|exists" | sed 's/^/  /' || true

# Tell the NC container's Docker daemon (via docker-install proxy) that
# the local registry is insecure (http-only). The docker-install daemon
# reads the daemon.json of the host Docker, so this is a host-side change.
# Already-set entries are idempotent.
# NB: we DON'T touch the host's daemon.json — registry:2 served on the
# bridge network is reachable over the network namespace without TLS for
# the docker-install daemon because AppAPI's pull goes via the Docker API
# socket, not directly. Pull is forwarded by Docker which inherits the
# host daemon config. If pull fails with "http: server gave HTTP response
# to HTTPS client", we'll need to add an `insecure-registries` entry.

# ── Step 4: register the ExApp ─────────────────────────────────────
TMP_INFO="$(mktemp --suffix=.xml)"
trap 'rm -f "$TMP_INFO"' EXIT
sed -E \
    -e "s#<image-tag>[^<]*</image-tag>#<image-tag>${INFO_TAG}</image-tag>#" \
    appinfo/info.xml > "$TMP_INFO"

docker cp "$TMP_INFO" "$NC_CONTAINER:/tmp/${APP_ID}-info.xml"
docker exec "$NC_CONTAINER" chown www-data:www-data "/tmp/${APP_ID}-info.xml"
docker exec "$NC_CONTAINER" chmod 644 "/tmp/${APP_ID}-info.xml"

echo "▶ Unregistering any prior install…"
docker exec --user www-data "$NC_CONTAINER" \
    php occ app_api:app:unregister "$APP_ID" 2>&1 \
    | grep -vE "^$|not.*registered" | sed 's/^/  /' || true

echo "▶ Registering $APP_ID via AppAPI daemon=$DEPLOY_DAEMON…"
docker exec --user www-data "$NC_CONTAINER" \
    php occ app_api:app:register "$APP_ID" "$DEPLOY_DAEMON" \
        --info-xml "/tmp/${APP_ID}-info.xml" --wait-finish 2>&1 \
    | sed 's/^/  /'

echo
echo "✔ Installed. Open http://localhost:18080 and click 'NC Login Mini' in the top bar."
echo "  Container logs: docker logs -f nc_app_${APP_ID}"
