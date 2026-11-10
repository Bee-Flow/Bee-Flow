/**
 * The Bee Flow user id of a Nextcloud account: `nc_<organisation>_<slug>`.
 *
 * The id is computed once, when the user row is created; every later lookup
 * goes through the stored Nextcloud uid or the e-mail address, never through
 * this function. The sync, the sign-in and the pairing of the first admin all
 * build it here.
 *
 * The slug
 *   - A uid of letters, digits and dashes, at most 40 characters long, is its
 *     own slug: `nc_<organisation>_<uid>`.
 *   - Any other uid (another character in it, or longer than 40) is cut to 31
 *     characters after every run of other characters became one dash, and
 *     gets a dash and the first 8 hex characters of the sha256 of the whole
 *     uid. Two uids that differ only in punctuation, or only past the cut,
 *     therefore get two ids.
 *   - A uid of letters, digits and dashes that itself ends the way such a slug
 *     ends (8 lower-case hex characters, alone or after a dash) gets a hash as
 *     well, so a uid is never the slug of another uid.
 * Either way the slug is at most 40 characters.
 *
 * Whoever creates a user first asks the store whether a user of the
 * organisation already holds the Nextcloud uid; the id alone does not say so.
 */

import { createHash } from 'node:crypto';

/** The longest slug. */
export const NC_USER_SLUG_MAX = 40;
const HASH_CHARS = 8;
const HEAD_MAX = NC_USER_SLUG_MAX - HASH_CHARS - 1;
/** How a slug with a hash ends: the hash alone, or a dash and the hash. */
const HASH_TAIL_RE = /(^|-)[0-9a-f]{8}$/;

export interface NcUserIdOptions {
    /** Fold the uid to lower case first (the pairing of the first admin does). */
    lowercase?: boolean;
    /** The slug of an empty uid. */
    fallback?: string;
}

/** The slug of a uid: the uid itself when it is plain, else a cut form with a hash of the whole uid. */
export function ncUserSlug(ncUid: unknown, opts: NcUserIdOptions = {}): string {
    const raw = String(ncUid ?? '');
    const source = opts.lowercase ? raw.toLowerCase() : raw;
    if (!source) return opts.fallback || 'user';
    const sanitised = source.replace(/[^a-zA-Z0-9]+/g, '-');
    if (sanitised === source && source.length <= NC_USER_SLUG_MAX && !HASH_TAIL_RE.test(source)) return source;
    const hash = createHash('sha256').update(source, 'utf8').digest('hex').slice(0, HASH_CHARS);
    const head = sanitised.slice(0, HEAD_MAX).replace(/^-+|-+$/g, '');
    return head ? `${head}-${hash}` : hash;
}

/** The Bee Flow user id for a Nextcloud uid inside one organisation. */
export function ncUserId(orgId: unknown, ncUid: unknown, opts: NcUserIdOptions = {}): string {
    return `nc_${String(orgId)}_${ncUserSlug(ncUid, opts)}`;
}
