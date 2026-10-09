#!/usr/bin/env bash
set -euo pipefail
service="${1:?service is required}"
image="${2:?immutable image is required}"
[[ "$image" =~ @sha256:[0-9a-f]{64}$ ]] || { echo 'An immutable container digest is required' >&2; exit 1; }
docker image inspect "$image" >/dev/null 2>&1 || docker pull "$image"
if [[ "$service" == server ]]; then
    [[ "$(docker image inspect --format '{{.Config.User}}' "$image")" == node ]]
    docker run --rm --network none --read-only --entrypoint /bin/sh "$image" -ec '
        test "$(id -u)" = 1000
        for binary in mount umount nsenter infocmp curl wget getfacl setfacl systemd-homed dockerd; do
            path="$(command -v "$binary" 2>/dev/null || true)"
            [ -z "$path" ] && continue
            # The one allowed wget: the localhost-only healthcheck stand-in (server/scripts/healthcheck-wget.js).
            if [ "$binary" = wget ] && [ "$path" = /usr/local/bin/wget ] && head -n 3 "$path" | grep -qx "// bee-flow-healthcheck-wget"; then continue; fi
            echo "Unexpected advisory entry point: $binary" >&2; exit 1
        done
        test -z "$(find /usr -xdev -type f \( -perm -4000 -o -perm -2000 \) -print)"
        test -z "$(find /usr -type f -path "*/Archive/Tar*" -print)"
        test ! -e /usr/lib/systemd/systemd-homed
        node -e '\''const a=require("assert/strict");a.equal(process.version,"v22.23.2");a.equal(require("/usr/local/lib/node_modules/npm/node_modules/brace-expansion/package.json").version,"5.0.11");a.equal(require("/usr/local/lib/node_modules/npm/node_modules/undici/package.json").version,"6.28.1");const vm=require("isolated-vm");const isolate=new vm.Isolate({memoryLimit:16});a.equal(isolate.createContextSync().evalSync("6*7"),42);isolate.dispose();'\''
        npm --version
        docker buildx version
    '
elif [[ "$service" == classify || "$service" == guard ]]; then
    # The Python services share the server's Debian base advisories, so they
    # carry the same hardening (see their Dockerfiles), checked the same way.
    [[ "$(docker image inspect --format '{{.Config.User}}' "$image")" == app ]]
    docker run --rm --network none --read-only --tmpfs /tmp -e SERVICE="$service" --entrypoint /bin/sh "$image" -ec '
        test "$(id -u)" = 1000
        for binary in mount umount nsenter infocmp getfacl setfacl systemd-homed gcc cc; do
            if command -v "$binary" >/dev/null 2>&1; then echo "Unexpected advisory entry point: $binary" >&2; exit 1; fi
        done
        test -z "$(find /usr -xdev -type f \( -perm -4000 -o -perm -2000 \) -print)"
        test -z "$(find /usr -type f -path "*/Archive/Tar*" -print)"
        test ! -e /usr/lib/systemd/systemd-homed
        # The libraries the service cannot start without, so a runtime
        # library lost to a purge fails here and not at a customer.
        if [ "$SERVICE" = guard ]; then python -c "import torch, onnxruntime, gliner"; else python -c "import torch, sklearn, gliclass"; fi
    '
elif [[ "$service" == pwt-runner ]]; then
    # npm is removed after the install (its bundled packages are the base's
    # advisories); the runner must still load Playwright and its test CLI.
    docker run --rm --network none --read-only --tmpfs /tmp --entrypoint /bin/sh "$image" -ec '
        test -z "$(command -v npm || true)"
        test -z "$(command -v npx || true)"
        test ! -e /usr/lib/node_modules/npm
        cd /runner && node -e '\''require("playwright"); require("@playwright/test")'\''
        node /runner/node_modules/@playwright/test/cli.js --version
    '
elif [[ "$service" == connector ]]; then
    docker run --rm --network none --read-only --entrypoint /bin/sh "$image" -ec '
        test -z "$(command -v npm || true)"
        node -e '\''require("assert/strict").equal(process.version,"v22.23.2")'\''
        frpc --version | grep -qx 0.61.1
    '
fi
echo "Container runtime prerequisites verified: $service"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "verified=true" >> "$GITHUB_OUTPUT"; fi
