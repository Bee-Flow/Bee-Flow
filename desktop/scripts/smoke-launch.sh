#!/bin/sh
# Start a packaged Bee Flow the way a user would and check it really started.
#
#   scripts/smoke-launch.sh <executable> [arguments…]
#
# For the formats CI cannot drive with Playwright — an rpm installed in a Fedora
# container, a pacman package in an Arch one, the tar.gz launcher. The app runs
# for 25 s in a throwaway profile on a virtual display; then its own log must
# show that it started and that its first page got the desktop bridge, and
# must not show a preload failure or a start-up that did not finish.
set -eu

[ "$#" -ge 1 ] || { echo "usage: $0 <executable> [arguments…]" >&2; exit 2; }

PROFILE="$(mktemp -d)"
export BEEFLOW_USER_DATA_DIR="$PROFILE"
LOG="$PROFILE/logs/beeflow-desktop.log"

status=0
timeout 25 xvfb-run -a "$@" >"$PROFILE/stdout.log" 2>&1 || status=$?
# 124: still running when the timeout stopped it — which is what "started" means.
if [ "$status" -ne 124 ]; then
    echo "::error::Bee Flow exited on its own with status $status:"
    cat "$PROFILE/stdout.log"
    [ -f "$LOG" ] && cat "$LOG"
    exit 1
fi
if [ ! -f "$LOG" ]; then
    echo "::error::Bee Flow wrote no log at $LOG"
    cat "$PROFILE/stdout.log"
    exit 1
fi
cat "$LOG"
grep -q '\[App\] starting' "$LOG" || { echo "::error::no start-up line in the log"; exit 1; }
grep -q '\[App\] bridge ready' "$LOG" || { echo "::error::the first page never got window.beeflow"; exit 1; }
if grep -E '\[Preload\]|uncaught exception|start-up did not finish|has no window\.beeflow' "$LOG"; then
    echo "::error::the log shows a failure (above)"
    exit 1
fi
echo "Bee Flow started, and its first page has the bridge."
