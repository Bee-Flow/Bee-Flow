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
elif [[ "$service" == connector ]]; then
    docker run --rm --network none --read-only --entrypoint /bin/sh "$image" -ec '
        test -z "$(command -v npm || true)"
        node -e '\''require("assert/strict").equal(process.version,"v22.23.2")'\''
        frpc --version | grep -qx 0.61.1
    '
fi
echo "Container runtime prerequisites verified: $service"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "verified=true" >> "$GITHUB_OUTPUT"; fi
