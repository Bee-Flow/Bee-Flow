#!/bin/bash
# Bee Flow connector entrypoint — wraps the Node app with optional FRP client
# for HaRP integration.
#
# Mirrors nextcloud/HaRP's example_start.sh: when HP_SHARED_KEY is set,
# write /frpc.toml that exposes Bee Flow's Unix socket back through HaRP's
# FRP tunnel. Otherwise (manual-install daemon) skip frpc and run the
# connector on its TCP port directly.

set -e

# Decide the Nextcloud TLS posture before the connector makes any NC call.
# Runs in ALL deploy modes (manual-install, HaRP FRP-tunnel, HaRP exapp_direct)
# — Node's fetch (bootstrap.js / heartbeat.js / ncProxy.js) ignores the OS trust
# store, so a self-signed / internal-CA Nextcloud would otherwise fail every
# call and the app's top-bar icon would never register. ncTlsTrust.js does a
# strict handshake first and only flags a relaxed posture when the cert does NOT
# already verify; src/ncTls.js then applies it scoped to the Nextcloud origin
# only, so valid public certs and the Bee Flow server channel keep full
# verification. Never fatal: a failure here must not stop the connector booting.
node /app/src/ncTlsTrust.js || echo "[harp-start] nc-tls-trust skipped (non-fatal)" >&2
for _ncenv in "${APP_PERSISTENT_STORAGE:-/data}/nc-trust/env" /tmp/nc-trust/env; do
    if [ -f "$_ncenv" ]; then
        # Auto-export every KEY=VALUE the helper wrote (BEEFLOW_NC_TLS_INSECURE
        # or BEEFLOW_NC_CA_FILE) so src/ncTls.js sees them.
        set -a
        # shellcheck disable=SC1090
        . "$_ncenv"
        set +a
        echo "[harp-start] applied NC TLS posture from $_ncenv" >&2
        break
    fi
done

# Who the connector and frpc run as. The setup steps need root (the trust
# store, the frpc certificates HaRP mounts root-only); the processes do not.
RUN_AS="${BEEFLOW_RUN_AS:-node}"
DROP=''
if [ "$(id -u)" = 0 ] && [ "$RUN_AS" != root ] && command -v su-exec >/dev/null 2>&1; then DROP=1; fi

if [ -n "$HP_SHARED_KEY" ]; then
    # frpc reads the client certificate and key HaRP mounts at /certs/frp.
    # Unprivileged, it gets copies that only that user can read; when the copy
    # fails it stays on root, as before, so the tunnel still comes up.
    FRP_CERTS=/certs/frp
    FRPC=(frpc)
    if [ -n "$DROP" ]; then
        FRPC=(su-exec "$RUN_AS" frpc)
        if [ -d /certs/frp ]; then
            if mkdir -p /tmp/frp-certs \
                && cp /certs/frp/client.crt /certs/frp/client.key /certs/frp/ca.crt /tmp/frp-certs/ \
                && chown -R "$RUN_AS:$RUN_AS" /tmp/frp-certs && chmod 600 /tmp/frp-certs/*; then
                FRP_CERTS=/tmp/frp-certs
            else
                echo "[harp-start] could not hand the frpc certificates to $RUN_AS; frpc runs as root" >&2
                FRPC=(frpc)
            fi
        fi
    fi
    if [ -d "/certs/frp" ]; then
        cat > /tmp/frpc.toml <<EOF
serverAddr = "$HP_FRP_ADDRESS"
serverPort = $HP_FRP_PORT
loginFailExit = false

transport.tls.enable = true
transport.tls.certFile = "$FRP_CERTS/client.crt"
transport.tls.keyFile = "$FRP_CERTS/client.key"
transport.tls.trustedCaFile = "$FRP_CERTS/ca.crt"
transport.tls.serverName = "harp.nc"

metadatas.token = "$HP_SHARED_KEY"

[[proxies]]
remotePort = $APP_PORT
type = "tcp"
name = "$APP_ID"
[proxies.plugin]
type = "unix_domain_socket"
unixPath = "/tmp/exapp.sock"
EOF
    else
        cat > /tmp/frpc.toml <<EOF
serverAddr = "$HP_FRP_ADDRESS"
serverPort = $HP_FRP_PORT
loginFailExit = false

transport.tls.enable = false

metadatas.token = "$HP_SHARED_KEY"

[[proxies]]
remotePort = $APP_PORT
type = "tcp"
name = "$APP_ID"
[proxies.plugin]
type = "unix_domain_socket"
unixPath = "/tmp/exapp.sock"
EOF
    fi
    # The file holds the shared key: readable by the user frpc runs as only.
    chmod 600 /tmp/frpc.toml
    if [ "${FRPC[0]}" = su-exec ]; then chown "$RUN_AS:$RUN_AS" /tmp/frpc.toml; fi
    echo "[harp-start] launching frpc → ${HP_FRP_ADDRESS}:${HP_FRP_PORT} as $([ "${FRPC[0]}" = su-exec ] && echo "$RUN_AS" || echo root)"
    # Supervise frpc: if it crashes, the Node app stays up and the container
    # still reports "healthy" (the healthcheck probes the local socket, not the
    # tunnel), but it would be unreachable through HaRP. Restart on exit so the
    # tunnel self-heals. loginFailExit=false already covers transient login
    # failures; this covers hard crashes. Operators: grep logs for "frpc exited".
    (
        while true; do
            "${FRPC[@]}" -c /tmp/frpc.toml
            echo "[harp-start] frpc exited ($?) — restarting in 2s" >&2
            sleep 2
        done
    ) &
fi

# The connector does not need root either: hand the persistent storage and the
# TLS helper's output to the unprivileged user and run the app as that user.
# frpc (above) relays to the app's unix socket as the same user.
if [ -n "$DROP" ]; then
    _storage="${APP_PERSISTENT_STORAGE:-/data}"
    mkdir -p "$_storage"
    chown -R "$RUN_AS:$RUN_AS" "$_storage"
    if [ -d /tmp/nc-trust ]; then chown -R "$RUN_AS:$RUN_AS" /tmp/nc-trust; fi
    rm -f /tmp/exapp.sock
    exec su-exec "$RUN_AS" "$@"
fi

exec "$@"
