/**
 * The cache folder for files that belong to one signed-in session: a meeting's
 * recording, for one. Such a file was fetched under that session's access
 * check, and a reused copy never asks the server again, so it must not
 * outlive the session: signing out, losing the session to a 401, and
 * switching or forgetting the server all wipe the folder.
 */

import { Directory, Paths } from 'expo-file-system';

const SESSION_CACHE = 'session';

/** The folder, created on first use. */
export function sessionCacheDir(): Directory {
    const dir = new Directory(Paths.cache, SESSION_CACHE);
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    return dir;
}

/** Delete every session file. Never throws: a sign-out must not fail on a cache. */
export function clearSessionCache(): void {
    try {
        const dir = new Directory(Paths.cache, SESSION_CACHE);
        if (dir.exists) dir.delete();
    } catch {
        // Nothing more to do: the OS reclaims the cache in the end.
    }
}
