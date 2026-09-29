#!/bin/sh
# Launcher for the tar.gz build of Bee Flow: run this, not `beeflow` directly.
#
# The .deb, .rpm and pacman packages make Chromium's sandbox work when they
# install: an AppArmor profile where the kernel restricts user namespaces
# (Ubuntu 23.10 and later), a root-owned setuid chrome-sandbox where it has no
# user namespaces at all. An unpacked tarball cannot do either, and there
# Electron aborts at start with "The SUID sandbox helper binary was found, but
# is not configured correctly".
#
# This does what the AppImage's own launcher does: use the sandbox whenever it
# can work, and only when it cannot, start without it — and say so, here and in
# Settings → About, rather than quietly.
set -eu

HERE="$(dirname "$(readlink -f "$0")")"
APP="$HERE/beeflow"
HELPER="$HERE/chrome-sandbox"

# A setuid-root helper works everywhere.
if [ -u "$HELPER" ] && [ "$(stat -c %u "$HELPER")" = "0" ]; then
    exec "$APP" "$@"
fi
# Unprivileged user namespaces work: Chromium's preferred sandbox.
if unshare -Ur true 2>/dev/null; then
    exec "$APP" "$@"
fi

echo "Bee Flow: this system restricts user namespaces and chrome-sandbox is not setuid root," >&2
echo "so Chromium's sandbox is OFF for this run. To turn it on, install the .deb/.rpm/pacman" >&2
echo "package instead, or run once:" >&2
echo "  sudo chown root:root '$HELPER' && sudo chmod 4755 '$HELPER'" >&2
exec "$APP" --no-sandbox "$@"
