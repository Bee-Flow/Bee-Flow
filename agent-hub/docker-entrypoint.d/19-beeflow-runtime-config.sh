#!/bin/sh
# Runtime settings the SPA reads at boot, written into the served directory.
#
# WHY THIS EXISTS
# Everything the telemetry beacon needed to decide "on or off" was baked in at
# `vite build` time (import.meta.env). That is fine for a build you own; it is
# wrong for an image other people run. A self-hosted operator who did not want
# an outbound RUM beacon had exactly one option: build their own frontend image.
# For a product whose selling point is that data stays put, "rebuild it
# yourself" is not a switch.
#
# So the image now writes one small file at container start and the SPA reads
# it before it decides anything. No rebuild, no new endpoint, no request to the
# API — just an env var on the container.
#
# CONTRACT
#   BEEFLOW_TELEMETRY_ENABLED       "true" turns the beacon on. ANYTHING else,
#                                   including unset, leaves it off. Opt-in on
#                                   purpose: the safe state must be the one you
#                                   get by doing nothing.
#   BEEFLOW_TELEMETRY_CLIENT_TOKEN  optional; overrides whatever token the build
#                                   carried, so a deployment can point the
#                                   beacon at its own collector.
#   BEEFLOW_TELEMETRY_SITE          optional; same idea for the host.
#   LEARN_MEDIA_BASE_URL            optional; where browsers load Learning
#                                   Center videos from (a CDN). Only an
#                                   absolute https:// URL is written; anything
#                                   else leaves the default, the server's own
#                                   /learn-media. See server/learning/learnMedia.js.
#
# `.sh` (not `.envsh`): this one writes a file, it does not need to export
# anything into the later entrypoint scripts. Numbered 19 so it lands after
# 18-beeflow-template-vars.envsh and before nginx starts.
#
# Runs under `set -e` in some entrypoint versions — every command must succeed.

set -e

bf_out="${BEEFLOW_RUNTIME_CONFIG_PATH:-/usr/share/nginx/html/beeflow-runtime.js}"

bf_log() {
    if [ -z "${NGINX_ENTRYPOINT_QUIET_LOGS:-}" ]; then
        echo "19-beeflow-runtime-config.sh: $*"
    fi
    return 0
}

# Only the exact string "true" enables. A typo, an empty value, "1", "yes" —
# all of those leave telemetry off. An operator who meant to enable it sees
# nothing happen and looks again; an operator who never touched it is never
# surprised by an outbound connection.
bf_enabled=false
if [ "${BEEFLOW_TELEMETRY_ENABLED:-}" = "true" ]; then
    bf_enabled=true
fi

# JSON string escaping for values that reach the file. Tokens are opaque and
# hosts are hostnames, but neither is ours to trust: a stray quote would break
# the whole file and take the SPA's boot with it.
bf_json_str() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

bf_token="$(bf_json_str "${BEEFLOW_TELEMETRY_CLIENT_TOKEN:-}")"
bf_site="$(bf_json_str "${BEEFLOW_TELEMETRY_SITE:-}")"

# Same "safe by default" rule for the media base: an https URL without
# whitespace or quotes, or nothing. The client re-checks it anyway.
bf_media=""
case "${LEARN_MEDIA_BASE_URL:-}" in
    https://*)
        case "${LEARN_MEDIA_BASE_URL}" in
            *[[:space:]\"\'\<\>]*) bf_log "LEARN_MEDIA_BASE_URL ignored: contains whitespace or quotes" ;;
            *) bf_media="$(bf_json_str "${LEARN_MEDIA_BASE_URL}")" ;;
        esac
        ;;
    "") ;;
    *) bf_log "LEARN_MEDIA_BASE_URL ignored: must start with https://" ;;
esac

if [ ! -d "$(dirname "$bf_out")" ]; then
    bf_log "$(dirname "$bf_out") does not exist — skipping runtime config"
    exit 0
fi

cat > "$bf_out" <<EOF
/* Written at container start by 19-beeflow-runtime-config.sh. Do not edit:
   every restart overwrites it. See the telemetry docs for the variables. */
window.__BEEFLOW_RUNTIME__ = Object.freeze({
  telemetry: Object.freeze({
    enabled: $bf_enabled,
    clientToken: "$bf_token",
    site: "$bf_site"
  }),
  learnMedia: Object.freeze({
    baseUrl: "$bf_media"
  })
});
EOF

if [ "$bf_enabled" = "true" ]; then
    bf_log "telemetry ENABLED by BEEFLOW_TELEMETRY_ENABLED"
else
    bf_log "telemetry off (set BEEFLOW_TELEMETRY_ENABLED=true to enable)"
fi

unset bf_out bf_enabled bf_token bf_site bf_media
unset -f bf_log bf_json_str 2>/dev/null || true
