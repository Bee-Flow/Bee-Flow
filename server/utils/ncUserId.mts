/**
 * The Bee Flow user id of a Nextcloud account: `nc_<organisation>_<slug>`.
 *
 * The id is chosen once, when the user row is created; every later lookup
 * goes through the stored Nextcloud uid or the e-mail address, never through
 * this module. The sync, the sign-in and the pairing of an organisation's
 * Nextcloud admin all choose it here, through `resolveNcUserId`.
 *
 * The rule
 *   1. The plain id: every run of characters other than letters and digits
 *      becomes one dash and the result is cut to 40 characters
 *      (`plainNcUserId`). The admin form folds to lower case first and drops
 *      dashes at both ends.
 *   2. No user row has that id: it is the id.
 *   3. A row has it and is this account (same organisation, same stored
 *      Nextcloud uid): it is that user; nobody is created.
 *   4. A row has it and is another account, or no Nextcloud account at all:
 *      the id with a hash (`hashedNcUserId`): the plain slug cut to 31
 *      characters, a dash and the first 8 hex characters of the sha256 of the
 *      whole uid. Steps 2 and 3 are asked again for that id; a row of another
 *      account there is answered as `taken`, and the caller says so.
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

/**
 * `member`: the sync and the sign-in. `admin`: the pairing of an
 * organisation's Nextcloud admin (lower case, no dash at either end).
 */
export type NcUserIdForm = 'member' | 'admin';

function plainSlug(source: unknown, form: NcUserIdForm): string {
    if (form === 'admin') {
        return String(source || 'nc')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, NC_USER_SLUG_MAX) || 'nc';
    }
    return String(source || '').replace(/[^a-zA-Z0-9]+/g, '-').slice(0, NC_USER_SLUG_MAX) || 'user';
}

/** The plain id of a uid inside one organisation (step 1). */
export function plainNcUserId(orgId: unknown, source: unknown, form: NcUserIdForm = 'member'): string {
    return `nc_${String(orgId)}_${plainSlug(source, form)}`;
}

/** The id with a hash of the whole uid (step 4). */
export function hashedNcUserId(orgId: unknown, source: unknown, form: NcUserIdForm = 'member'): string {
    const hash = createHash('sha256').update(String(source ?? ''), 'utf8').digest('hex').slice(0, HASH_CHARS);
    const head = plainSlug(source, form).slice(0, HEAD_MAX).replace(/^-+|-+$/g, '');
    return `nc_${String(orgId)}_${head ? `${head}-${hash}` : hash}`;
}

/** What the resolver reads of a user row. */
export interface NcUserRow {
    organizationId?: unknown;
    nc_uid?: unknown;
    ncUid?: unknown;
}

export interface NcAccount {
    orgId: unknown;
    /** The Nextcloud uid of the account; empty when the sign-in carries none. */
    ncUid: unknown;
    /** What the id is built from when it is not the uid (a sign-in without one: the e-mail address). */
    source?: unknown;
    form?: NcUserIdForm;
}

export interface NcUserIdDeps<U extends NcUserRow> {
    /** The user row with this id, or null. */
    getUser: (id: string) => Promise<U | null | undefined>;
}

/**
 * `free`: no row has `id`, create the user under it. `own`: `user` has `id`
 * and is this account. `taken`: the plain id and the hashed id both belong to
 * other accounts; `user` holds the hashed one.
 */
export type NcUserIdResolution<U extends NcUserRow> =
    | { state: 'free'; id: string; user: null }
    | { state: 'own' | 'taken'; id: string; user: U };

function isAccount(row: NcUserRow, account: NcAccount): boolean {
    const uid = account.ncUid ? String(account.ncUid) : '';
    const stored = row.nc_uid ?? row.ncUid;
    return uid !== '' && stored === uid && String(row.organizationId ?? '') === String(account.orgId);
}

/** The id under which a Nextcloud account gets its user row (the rule in the header). */
export async function resolveNcUserId<U extends NcUserRow>(account: NcAccount, deps: NcUserIdDeps<U>): Promise<NcUserIdResolution<U>> {
    const source = account.source ?? account.ncUid;
    const form = account.form ?? 'member';
    const plain = plainNcUserId(account.orgId, source, form);
    const first = await deps.getUser(plain);
    if (!first) return { state: 'free', id: plain, user: null };
    if (isAccount(first, account)) return { state: 'own', id: plain, user: first };
    const hashed = hashedNcUserId(account.orgId, source, form);
    const second = await deps.getUser(hashed);
    if (!second) return { state: 'free', id: hashed, user: null };
    return { state: isAccount(second, account) ? 'own' : 'taken', id: hashed, user: second };
}
