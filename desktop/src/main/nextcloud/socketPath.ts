/**
 * Finding the Nextcloud desktop client's local socket.
 *
 * The client exposes a small line protocol on a Unix socket (or a Windows
 * named pipe) so that file-manager extensions — Nautilus, Dolphin, Finder,
 * Explorer — can ask it for sync state and share links. This app is a fourth
 * such consumer, which is exactly what the interface is for.
 *
 * **This module is honest about being best-effort.** The socket's location is
 * derived from Qt's runtime directory plus the application short name, and it
 * therefore moves between a distro package, a Flatpak and a Snap, and has
 * changed shape across releases. So: a documented, ordered candidate list, an
 * explicit override in settings, and — most importantly — a bridge that still
 * works without any of them. Everything that matters most (which accounts
 * exist, which folders sync where, what a file's WebDAV URL is) comes from the
 * config file and needs no socket at all. The socket adds live sync state and
 * the client's own share dialog; losing it costs those two features, not the
 * integration.
 */

/** Ordered best guesses for the socket, most likely first. */
export function socketCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string[] {
    const candidates: string[] = [];
    const push = (value: string) => {
        if (value && !candidates.includes(value)) candidates.push(value);
    };

    if (platform === 'win32') {
        // A named pipe, not a file. The client has spelled this differently
        // across its history and its ownCloud ancestry, hence the list.
        push('\\\\.\\pipe\\Nextcloud\\socket');
        push('\\\\.\\pipe\\nextcloud\\socket');
        push('\\\\.\\pipe\\Nextcloud');
        push('\\\\.\\pipe\\ocdesktopsocket');
        const user = env.USERNAME;
        if (user) push(`\\\\.\\pipe\\Nextcloud-${user}`);
        return candidates;
    }

    if (platform === 'darwin') {
        // Qt reports the temp directory as the runtime location on macOS, and
        // TMPDIR there is a per-user path under /var/folders.
        const tmp = (env.TMPDIR || '/tmp').replace(/\/+$/, '');
        push(`${tmp}/Nextcloud/socket`);
        push(`${home}/Library/Caches/Nextcloud/socket`);
        push(`${home}/Library/Application Support/Nextcloud/socket`);
        push('/tmp/Nextcloud/socket');
        return candidates;
    }

    // Linux and the other Unixes.
    const runtime = (env.XDG_RUNTIME_DIR || '').replace(/\/+$/, '');
    if (runtime) {
        push(`${runtime}/Nextcloud/socket`);
        // Flatpak gives the sandboxed app its own runtime subdirectory, which
        // the host can still read — the socket is simply one level deeper.
        push(`${runtime}/app/com.nextcloud.desktopclient.nextcloud/Nextcloud/socket`);
        push(`${runtime}/ownCloud/socket`);
    }
    // Qt's fallback when XDG_RUNTIME_DIR is unset (a bare TTY login, some
    // container setups): /tmp/runtime-<user>.
    const user = env.USER || env.LOGNAME;
    if (user) push(`/tmp/runtime-${user}/Nextcloud/socket`);
    push(`${home}/.cache/Nextcloud/socket`);
    // Snap confines the client to its own directory tree.
    push(`${home}/snap/nextcloud-desktop-client/current/Nextcloud/socket`);
    return candidates;
}

/**
 * A Windows named pipe is addressed by name, not by a file that exists, so the
 * "does this path exist" probe used on Unix would reject every candidate.
 */
export function isNamedPipe(candidate: string): boolean {
    return candidate.startsWith('\\\\.\\pipe\\') || candidate.startsWith('//./pipe/');
}
