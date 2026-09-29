/**
 * Whether this copy of the app should update itself — and if not, what to say.
 *
 * The answer depends entirely on how it was installed, and getting it wrong is
 * user-hostile in both directions. An AppImage or a Windows installer has no
 * package manager behind it, so if the app does not update itself nothing
 * will. A .deb, .rpm or .pkg.tar.zst is the opposite: `apt upgrade` owns that
 * file, the app cannot write to /opt without root, and an in-app updater there
 * produces a download that fails at the last step, or worse, a binary the
 * package manager now disagrees with.
 *
 * Flatpak and Snap are the same case again, with their own updaters.
 *
 * So: detect the packaging, decide from that, and say which it is on the
 * settings page rather than leaving "check for updates" greyed out with no
 * explanation.
 */

import type { AppDiagnostics } from '../shared/types.ts';

export type Packaging = AppDiagnostics['packaging'];

export interface PackagingSignals {
    platform: NodeJS.Platform;
    /** process.execPath of the running binary. */
    execPath: string;
    env: NodeJS.ProcessEnv;
    /** app.isPackaged — false during development. */
    packaged: boolean;
    /** process.windowsStore, set by Electron for an APPX/MSIX install. */
    windowsStore?: boolean;
    /** Contents of /etc/os-release style hints, when the caller has them. */
    resourcePath?: string;
}

/**
 * Work out how this copy was installed.
 *
 * Every signal here is one the packaging itself sets:
 *   - electron-builder's AppImage runtime exports APPIMAGE;
 *   - Flatpak exports FLATPAK_ID and mounts the app at /app;
 *   - Snap exports SNAP and installs under /snap/<name>/;
 *   - a Windows portable build exports PORTABLE_EXECUTABLE_DIR;
 *   - everything else is told apart by where the binary sits.
 */
export function detectPackaging(signals: PackagingSignals): Packaging {
    if (!signals.packaged) return 'dev';

    const env = signals.env;
    const execPath = signals.execPath.replace(/\\/g, '/');

    if (env.APPIMAGE) return 'appimage';
    if (env.FLATPAK_ID || execPath.startsWith('/app/')) return 'flatpak';
    if (env.SNAP || execPath.startsWith('/snap/')) return 'snap';

    if (signals.platform === 'win32') {
        if (signals.windowsStore) return 'msi';
        if (env.PORTABLE_EXECUTABLE_DIR) return 'portable';
        return 'nsis';
    }

    if (signals.platform === 'darwin') return 'dmg';

    // A Linux install from a package manager lands in /opt or /usr. Which of
    // the three managers put it there is not knowable from the binary alone,
    // and does not need to be: all three mean "not ours to update".
    if (execPath.startsWith('/opt/') || execPath.startsWith('/usr/')) return 'deb';

    return 'unknown';
}

export interface UpdateCapability {
    /** May the app download and install an update itself? */
    canSelfUpdate: boolean;
    /** Shown on the settings page. Empty when self-update is available. */
    reason: string;
}

/**
 * Facts about the build itself, stamped by the release workflow into
 * package.json (`-c.extraMetadata.…`), because the running app cannot cheaply
 * tell them from the outside.
 */
export interface BuildInfo {
    /** A macOS build without a Developer ID signature (a dev or PR build). */
    unsignedMac?: boolean;
}

/** Read BuildInfo from the packaged package.json's fields. Unknown means "signed". */
export function buildInfoFrom(packageJson: unknown): BuildInfo {
    const value = (packageJson as { beeflowUnsignedMac?: unknown } | null)?.beeflowUnsignedMac;
    return { unsignedMac: value === true || value === 'true' };
}

export function updateCapability(packaging: Packaging, build: BuildInfo = {}): UpdateCapability {
    switch (packaging) {
        case 'dmg':
            // Squirrel.Mac, which electron-updater uses on macOS, only lets an
            // app replace itself with one signed by the same Developer ID. An
            // unsigned build would download the update and then fail to apply it.
            if (build.unsignedMac) {
                return {
                    canSelfUpdate: false,
                    reason: 'This is an unsigned build, and macOS only lets a signed app replace itself. Download the new version from the release page.',
                };
            }
            return { canSelfUpdate: true, reason: '' };
        case 'appimage':
        case 'nsis':
            return { canSelfUpdate: true, reason: '' };
        case 'deb':
        case 'rpm':
        case 'pacman':
            return {
                canSelfUpdate: false,
                reason: 'This copy was installed by your package manager, which is where updates come from. Run your usual system update.',
            };
        case 'flatpak':
            return { canSelfUpdate: false, reason: 'Flatpak handles updates for this copy: run `flatpak update`, or let your software centre do it.' };
        case 'snap':
            return { canSelfUpdate: false, reason: 'Snap updates this copy automatically. Run `snap refresh bee-flow` to do it now.' };
        case 'msi':
            return { canSelfUpdate: false, reason: 'This copy came from the Microsoft Store, which updates it.' };
        case 'portable':
            return {
                canSelfUpdate: false,
                reason: 'This is the portable build. Download a newer one when you want it — nothing is installed to update.',
            };
        case 'dev':
            return { canSelfUpdate: false, reason: 'Running from source. Updates come from git.' };
        default:
            return { canSelfUpdate: false, reason: 'Bee Flow could not tell how it was installed, so it will not try to update itself.' };
    }
}

/** electron-updater's channel name for a settings choice. */
export function channelFor(choice: 'stable' | 'beta'): string {
    return choice === 'beta' ? 'beta' : 'latest';
}

/**
 * Where to look for updates.
 *
 * The default is the project's GitHub releases. A self-hoster who would rather
 * their fleet did not talk to github.com — a perfectly ordinary requirement in
 * the kind of organisation that self-hosts this product — points
 * BEEFLOW_UPDATE_FEED_URL at their own static file host, and gets the generic
 * provider instead.
 */
export function feedFromEnv(env: NodeJS.ProcessEnv): { provider: 'generic'; url: string } | null {
    const url = (env.BEEFLOW_UPDATE_FEED_URL ?? '').trim();
    if (!url) return null;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
        return { provider: 'generic', url: url.replace(/\/+$/, '') };
    } catch {
        return null;
    }
}
