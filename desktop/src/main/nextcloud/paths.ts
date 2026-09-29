/**
 * Mapping a file on this computer onto a file on a Nextcloud server.
 *
 * This is the piece that makes the integration worth having. Without it, a
 * file dragged out of the Nextcloud folder into a Bee Flow conversation is
 * just bytes: the client uploads a second copy, the server stores it, and the
 * copy immediately starts diverging from the file the user will keep editing
 * in Nextcloud. With it, the same drag produces a *reference* — server, DAV
 * path, web URL — and the Bee Flow server reads the original through the
 * integration it already has, with the user's own app password.
 *
 * Three details decide whether this is correct or merely usually correct:
 *
 *   1. **Prefix matching has to respect boundaries.** `~/Nextcloud2/x` is not
 *      inside `~/Nextcloud`, however much the string suggests it is.
 *   2. **Case sensitivity is the filesystem's, not the language's.** Linux is
 *      case-sensitive, macOS and Windows are (by default) not, and a Dutch
 *      user with `~/nextcloud` on a Mac has to work.
 *   3. **Nested sync folders resolve to the most specific one.** The folder
 *      list arrives longest-first from clientConfig.ts, so first match wins.
 */

import * as path from 'node:path';

import type { NextcloudAccount, NextcloudFileRef, NextcloudSyncFolder } from '../../shared/types.ts';
import { normaliseRemotePath } from './clientConfig.ts';
import { webdavUrl, webUrl } from './links.ts';

/** POSIX separators throughout, so one comparison works on all platforms. */
export function toPosix(value: string): string {
    return String(value ?? '').replace(/\\/g, '/').replace(/\/{2,}/g, '/');
}

/** Filesystems that compare names without regard to case, by default. */
export function isCaseInsensitive(platform: NodeJS.Platform): boolean {
    return platform === 'win32' || platform === 'darwin';
}

function comparable(value: string, platform: NodeJS.Platform): string {
    // `.` and `..` are resolved before anything is compared. Compared as text,
    // `~/Nextcloud/../.config/autostart` starts with `~/Nextcloud/` — and the
    // path.join that then builds the destination DOES resolve them, so "save
    // into the sync folder" wrote into the user's autostart directory. A path
    // that still climbs above where it started after resolving is refused.
    const raw = toPosix(value);
    const posix = raw ? path.posix.normalize(raw) : raw;
    if (posix.split('/').includes('..')) return '';
    const stripped = posix.replace(/\/+$/, '');
    // Stripping the trailing separator off "/" would leave nothing, and an
    // empty parent means "no opinion" below. A filesystem root keeps its slash.
    const normalised = stripped === '' && posix.startsWith('/') ? '/' : stripped;
    return isCaseInsensitive(platform) ? normalised.toLowerCase() : normalised;
}

/**
 * Is `child` the same as, or inside, `parent`?
 *
 * The boundary check is the whole function: a plain `startsWith` reports that
 * `/home/tom/Nextcloud-old/secret.txt` lives in `/home/tom/Nextcloud`, and a
 * bridge that believes it would hand a Bee Flow server a WebDAV path for a
 * file the server cannot see — or, worse, for a file in a DIFFERENT account.
 */
export function isInside(parent: string, child: string, platform: NodeJS.Platform = process.platform): boolean {
    const p = comparable(parent, platform);
    const c = comparable(child, platform);
    if (!p || !c) return false;
    if (c === p) return true;
    // A root ("/" or "C:/") keeps its separator, so the boundary is already there.
    const boundary = p.endsWith('/') ? p : `${p}/`;
    return c.startsWith(boundary);
}

/** Which sync folder, if any, contains this path. Longest match wins. */
export function folderFor(
    localPath: string,
    accounts: readonly NextcloudAccount[],
    platform: NodeJS.Platform = process.platform,
): { account: NextcloudAccount; folder: NextcloudSyncFolder } | null {
    let best: { account: NextcloudAccount; folder: NextcloudSyncFolder } | null = null;
    for (const account of accounts) {
        for (const folder of account.folders) {
            if (!isInside(folder.localPath, localPath, platform)) continue;
            if (!best || folder.localPath.length > best.folder.localPath.length) {
                best = { account, folder };
            }
        }
    }
    return best;
}

/**
 * The server-side path for a local file inside a sync folder.
 *
 * `targetPath` is where the folder is mounted on the server, which is `/` for
 * the common single-folder setup and something like `/Projecten/Bee Flow` for
 * anyone who syncs a subfolder.
 */
export function remotePathFor(folder: NextcloudSyncFolder, localPath: string): string {
    const root = toPosix(folder.localPath).replace(/\/+$/, '');
    const full = toPosix(localPath).replace(/\/+$/, '');
    const relative = full.length > root.length ? full.slice(root.length) : '';
    return normaliseRemotePath(`${folder.targetPath === '/' ? '' : folder.targetPath}${relative}`);
}

export interface ResolveOptions {
    platform?: NodeJS.Platform;
    /** Whether the path is a directory. Supplied by the caller, which stat'd it. */
    isDirectory?: boolean;
}

/**
 * Resolve one local path into a full reference, or null when it is not
 * anywhere the Nextcloud client syncs.
 *
 * Returning null rather than a partial answer is deliberate: "this file is not
 * in Nextcloud" is a normal, frequent case (a download, a screenshot, anything
 * under /tmp) and the caller's correct response is to upload it the ordinary
 * way, not to guess at a remote path that does not exist.
 */
export function resolveLocalPath(
    localPath: string,
    accounts: readonly NextcloudAccount[],
    options: ResolveOptions = {},
): NextcloudFileRef | null {
    const platform = options.platform ?? process.platform;
    const match = folderFor(localPath, accounts, platform);
    if (!match) return null;

    const remotePath = remotePathFor(match.folder, localPath);
    const isDirectory = options.isDirectory ?? false;

    return {
        localPath: toPosix(localPath).replace(/\/+$/, '') || localPath,
        accountId: match.account.id,
        serverUrl: match.account.url,
        remotePath,
        webdavUrl: webdavUrl(match.account, remotePath),
        webUrl: webUrl(match.account, remotePath, isDirectory),
        isDirectory,
    };
}

/**
 * Resolve a batch, dropping what does not belong to Nextcloud.
 *
 * Used by the drag-and-drop handler, which gets a mixed list: two files from
 * the sync folder and one from the Downloads folder is the ordinary case, and
 * the ordinary answer is to reference the first two and upload the third.
 */
export interface ResolveManyOptions extends Omit<ResolveOptions, 'isDirectory'> {
    /** Asked per path, because only the caller has stat'd them. */
    isDirectory?: (path: string) => boolean;
}

export function resolveMany(
    paths: readonly string[],
    accounts: readonly NextcloudAccount[],
    options: ResolveManyOptions = {},
): { resolved: NextcloudFileRef[]; unresolved: string[] } {
    const resolved: NextcloudFileRef[] = [];
    const unresolved: string[] = [];
    for (const path of paths) {
        const reference = resolveLocalPath(path, accounts, {
            platform: options.platform ?? process.platform,
            isDirectory: options.isDirectory?.(path) ?? false,
        });
        if (reference) resolved.push(reference);
        else unresolved.push(path);
    }
    return { resolved, unresolved };
}

/**
 * Where "Save to Nextcloud" should drop a file when the user has not chosen.
 *
 * The first folder of the first account, which for the overwhelmingly common
 * single-account single-folder install is simply "the Nextcloud folder".
 */
export function defaultSaveFolder(accounts: readonly NextcloudAccount[]): string | null {
    for (const account of accounts) {
        for (const folder of account.folders) {
            if (!folder.virtualFiles) return folder.localPath;
        }
    }
    // Every folder is in virtual-files mode: writing there still works, the
    // placeholder is simply hydrated on demand.
    return accounts[0]?.folders[0]?.localPath ?? null;
}
