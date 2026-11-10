#!/usr/bin/env bash
# Entry point of the installer image: checks that this container can do what
# beeflow-install.sh is about to ask of it, then runs that script.
#
# The stack is started by the HOST's Docker, and the compose file mounts files
# from the install directory by path. So that directory has to exist on the
# host under the same path as in this container, or Docker would mount empty
# directories into the stack.
set -euo pipefail

SCRIPT=/bundle/beeflow-install.sh
RUN_LINE='docker run --rm -it --network host -v /var/run/docker.sock:/var/run/docker.sock -v /opt/beeflow:/opt/beeflow ghcr.io/bee-flow/installer'

die() { printf 'Bee Flow installer: %s\n' "$*" >&2; exit 1; }

# --help and no-Docker questions need none of the checks.
for arg in "$@"; do
    case "$arg" in -h|--help) exec bash "$SCRIPT" --help ;; esac
done

# The install directory: --dir / --dir=… when given, else BEEFLOW_DIR.
dir="$BEEFLOW_DIR"
prev=""
for arg in "$@"; do
    case "$arg" in --dir=*) dir="${arg#--dir=}" ;; esac
    if [ "$prev" = "--dir" ]; then dir="$arg"; fi
    prev="$arg"
done
case "$dir" in
    /*) ;;
    *) die "the install directory must be an absolute path inside this container (got '$dir')." ;;
esac

if ! docker info >/dev/null 2>&1; then
    die "Docker is not reachable from this container. Start it with the Docker socket:
  $RUN_LINE"
fi

# This container's id: Docker mounts /etc/hostname from
# <docker root>/containers/<id>/hostname. (The host name is no help: with
# --network host it is the host's.)
own_id=""
while read -r line; do
    case "$line" in
        *"/containers/"*"/hostname "*)
            own_id="${line#*/containers/}"
            own_id="${own_id%%/*}"
            break ;;
    esac
done < /proc/self/mountinfo

# The host path mounted at the install directory, as Docker knows it.
source_path=""
if [ -n "$own_id" ]; then
    while IFS='=' read -r destination source; do
        if [ "$destination" = "$dir" ]; then source_path="$source"; fi
    done < <(docker inspect "$own_id" --format '{{range .Mounts}}{{.Destination}}={{.Source}}{{"\n"}}{{end}}' 2>/dev/null || true)
fi

if [ "${BEEFLOW_SKIP_MOUNT_CHECK:-0}" != "1" ]; then
    if [ -z "$own_id" ]; then
        die "could not work out which container this is, so the mount of $dir cannot be checked.
Run it as documented:
  $RUN_LINE"
    fi
    if [ -z "$source_path" ]; then
        die "$dir is not mounted from the host. Mount the install directory under the same path:
  -v $dir:$dir"
    fi
    if [ "$source_path" != "$dir" ]; then
        die "$dir in this container is $source_path on the host. The two paths must be the same:
  -v $source_path:$source_path   (and --dir $source_path)"
    fi
fi

export BEEFLOW_DIR="$dir"
export BEEFLOW_SELF_COMMAND="docker run --rm -it --network host -v /var/run/docker.sock:/var/run/docker.sock -v $dir:$dir ghcr.io/bee-flow/installer"
exec bash "$SCRIPT" "$@"
