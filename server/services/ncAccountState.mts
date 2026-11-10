/**
 * Who the user and group sync (./ncUserGroupSync.js) mirrors: what the
 * organisation's sync mode admits, and what Nextcloud says about one account
 * (is it enabled, is it a guest).
 *
 * Enabled or disabled
 *   Nextcloud tells only an administrator whether an account is enabled, so
 *   both reads here run as the organisation's stored Nextcloud admin:
 *     - `fetchDisabledUids`   every disabled account, once per full sync;
 *     - `fetchAccountState`   one account, for a user event.
 *   Each has three answers: enabled, disabled, or unknown. The sync changes a
 *   status only on a definite answer. A read that fails, an answer in another
 *   shape, an answer for another account, or a stored admin that is not in
 *   Nextcloud's `admin` group (a non-admin gets an empty or partial list) is
 *   unknown, and unknown changes nothing.
 *
 * Guests
 *   The guests app puts every guest in one group, `guest_app`, and serves them
 *   from a user backend named `Guests`. Either marker makes an account a
 *   guest. A guest gets no new Bee Flow account unless the organisation's
 *   list of groups to sync names the guests group.
 *
 * Every read goes through the caller's signed proxy call, which is bound to
 * one organisation; nothing here reads or writes Bee Flow users.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../telemetry/log.js') as { warn: (...a: unknown[]) => void };

/** The group the Nextcloud guests app puts every guest in. */
export const GUESTS_GROUP_ID = 'guest_app';
/** The name of the guests app's user backend, as the user record reports it. */
export const GUESTS_BACKEND = 'Guests';

export type AccountState = 'enabled' | 'disabled' | 'unknown';

/**
 * The health code of an organisation whose stored Nextcloud admin is not told
 * whether accounts are enabled (./ncStoredUid.mts opens it; a full sync that
 * reads the disabled accounts resolves it).
 */
export const ADMIN_RIGHTS_MISSING = 'connector.nc_admin_rights_missing';

export interface NcOrgRef {
    id?: string;
    nc_admin_uid?: string;
    ncAdminUid?: string;
    nc_sync_mode?: string;
    ncSyncGroups?: string[];
    ncSyncExcludedGroups?: string[];
    [key: string]: unknown;
}

type OcsBody = { ocs?: { data?: unknown } } | null | undefined;

/** The sync's signed call to Nextcloud through the connector (ncUserGroupSync.ncProxyFetch). */
export type NcProxyFetch = (org: NcOrgRef, ncPath: string, ncUid?: string) => Promise<OcsBody>;

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function adminUidOf(org: NcOrgRef): string {
    return String(org?.nc_admin_uid || org?.ncAdminUid || '');
}

/** A status that counts as active: 'active', or none (a row from before the column). */
export function isActiveStatus(status: unknown): boolean {
    return !status || status === 'active';
}

/** Are these the same groups, in any order? No list counts as no groups. */
export function sameGroups(current: unknown, expected: readonly string[]): boolean {
    return (Array.isArray(current) ? current.slice().sort() : []).join(',') === expected.slice().sort().join(',');
}

// ── Once per key ────────────────────────────────────────────────────────────

const SIGHTINGS_MAX = 20000;
const sightings = new Set<string>();

/**
 * True the first time a key is seen in this process, false after that. Used
 * to report one thing about one account once instead of on every sync run.
 * The memory is bounded: past SIGHTINGS_MAX keys it starts again.
 */
export function firstSighting(key: string): boolean {
    if (sightings.has(key)) return false;
    if (sightings.size >= SIGHTINGS_MAX) sightings.clear();
    sightings.add(key);
    return true;
}

/** Forget one key; true when it had been seen. */
export function forgetSighting(key: string): boolean {
    return sightings.delete(key);
}

/** Test hook: forget every key. */
export function resetSightings(): void { sightings.clear(); }

// ── Sync mode ───────────────────────────────────────────────────────────────

/** Does the organisation's sync mode, with its lists of groups, admit a user in these groups? */
export function shouldMirrorUser(org: NcOrgRef, userGroups: readonly string[]): boolean {
    const mode = org.nc_sync_mode || 'mirror_all';
    if (mode === 'manual') return false;
    const excluded = org.ncSyncExcludedGroups;
    if (excluded?.length && userGroups.some((g) => excluded.includes(g))) return false;
    if (mode === 'selective_groups') {
        const included = org.ncSyncGroups;
        if (!included?.length) return false;
        return userGroups.some((g) => included.includes(g));
    }
    return true; // mirror_all
}

// ── Guests ──────────────────────────────────────────────────────────────────

/** Is this Nextcloud account a guest (guests group, or served by the guests backend)? */
export function isGuestAccount(ncUser: { backend?: unknown } | null | undefined, groups: readonly string[] | null | undefined): boolean {
    if (Array.isArray(groups) && groups.includes(GUESTS_GROUP_ID)) return true;
    return ncUser?.backend === GUESTS_BACKEND;
}

/** Does the organisation's list of groups to sync name the guests group? */
export function guestsIncluded(org: NcOrgRef): boolean {
    return Array.isArray(org?.ncSyncGroups) && org.ncSyncGroups.includes(GUESTS_GROUP_ID);
}

/** A guest that gets no new account: a guest, in an organisation that does not name the guests group. */
export function skipsNewGuest(org: NcOrgRef, ncUser: { backend?: unknown } | null | undefined, groups: readonly string[] | null | undefined): boolean {
    return isGuestAccount(ncUser, groups) && !guestsIncluded(org);
}

// ── Enabled or disabled ─────────────────────────────────────────────────────

/** The `enabled` field of a user record: true, false, or null when it is absent or not a yes/no. */
export function readEnabled(data: unknown): boolean | null {
    if (!isRecord(data)) return null;
    const v = data.enabled;
    if (v === true || v === 'true') return true;
    if (v === false || v === 'false') return false;
    return null;
}

/**
 * One account, read as the stored admin. Unknown unless the answer is about
 * this very account and carries a yes or no.
 */
export async function fetchAccountState(org: NcOrgRef, ncUid: string, ncProxyFetch: NcProxyFetch): Promise<AccountState> {
    const adminUid = adminUidOf(org);
    if (!adminUid || !ncUid) return 'unknown';
    try {
        const body = await ncProxyFetch(org, `/ocs/v2.php/cloud/users/${encodeURIComponent(ncUid)}?format=json`, adminUid);
        const data = body?.ocs?.data;
        if (!isRecord(data) || String(data.id ?? '') !== ncUid) return 'unknown';
        const enabled = readEnabled(data);
        if (enabled === null) return 'unknown';
        return enabled ? 'enabled' : 'disabled';
    } catch (err) {
        log.warn(`[ncSync] account state read failed for org ${org?.id}: ${(err as Error)?.message}`);
        return 'unknown';
    }
}

/**
 * How many disabled accounts one request asks for
 * (NEXTCLOUD_SYNC_DISABLED_PAGE_SIZE, default 500). 0 asks for all of them in
 * one request.
 */
export function disabledPageSize(): number {
    const raw = Number.parseInt(String(process.env.NEXTCLOUD_SYNC_DISABLED_PAGE_SIZE ?? ''), 10);
    return Number.isFinite(raw) && raw >= 0 ? raw : 500;
}

/**
 * The uids on one page of the disabled-accounts answer, or null when the
 * answer is not that list. Nextcloud keys the list by uid; a list whose uids
 * happen to be 0, 1, 2, ... arrives as an array, and then each entry names its
 * own `id`.
 */
export function parseDisabledPage(body: OcsBody): string[] | null {
    const data = body?.ocs?.data;
    if (!isRecord(data)) return null;
    const users = data.users;
    if (Array.isArray(users)) {
        const ids: string[] = [];
        for (const entry of users) {
            if (!isRecord(entry) || (typeof entry.id !== 'string' && typeof entry.id !== 'number')) return null;
            ids.push(String(entry.id));
        }
        return ids;
    }
    if (isRecord(users)) return Object.keys(users);
    return null;
}

/**
 * Every disabled account of the organisation's Nextcloud, or null when that
 * cannot be said for certain. Null means: change nobody's status.
 */
export async function fetchDisabledUids(org: NcOrgRef, ncProxyFetch: NcProxyFetch): Promise<Set<string> | null> {
    const adminUid = adminUidOf(org);
    if (!adminUid) return null;
    try {
        // Only a member of the `admin` group gets the complete list.
        const own = await ncProxyFetch(org, `/ocs/v2.php/cloud/users/${encodeURIComponent(adminUid)}/groups?format=json`, adminUid);
        const ownData = own?.ocs?.data;
        const ownGroups = isRecord(ownData) ? ownData.groups : null;
        if (!Array.isArray(ownGroups) || !ownGroups.includes('admin')) {
            log.warn(`[ncSync] disabled accounts not read for org ${org?.id}: the stored Nextcloud admin is not in the admin group`);
            return null;
        }
        const size = disabledPageSize();
        const all = new Set<string>();
        for (let offset = 0; ; offset += size) {
            const paging = size > 0 ? `&limit=${size}&offset=${offset}` : '';
            const page = parseDisabledPage(await ncProxyFetch(org, `/ocs/v2.php/cloud/users/disabled?format=json${paging}`, adminUid));
            if (!page) {
                log.warn(`[ncSync] disabled accounts not read for org ${org?.id}: unexpected answer`);
                return null;
            }
            const before = all.size;
            for (const uid of page) all.add(uid);
            // The last page is a short one; a page that adds nobody ends the
            // walk too, so an answer that ignores the offset cannot loop.
            if (size <= 0 || page.length < size || all.size === before) break;
        }
        return all;
    } catch (err) {
        log.warn(`[ncSync] disabled accounts not read for org ${org?.id}: ${(err as Error)?.message}`);
        return null;
    }
}

/**
 * A user's groups after a sync: the groups Nextcloud says they are in, plus
 * every group they hold that did not come from Nextcloud.
 *
 * Where a membership came from is not recorded; where a GROUP came from is.
 * The sync only ever hands out ids of this organisation's mirrored groups
 * (`nc_<orgId>_<slug>`, the rows mirrorGroups creates with source
 * 'nextcloud'), so those are the ones it owns and may take away again when
 * Nextcloud stops listing them. Any other id (a group made and assigned in
 * Bee Flow, or one mirrored for another organisation) is left as it is. The
 * price of the rule: a membership of a MIRRORED group that an admin assigned
 * by hand in Bee Flow is Nextcloud's to decide, and goes at the next sync when
 * Nextcloud does not list it.
 */
export function groupsAfterSync(
    orgId: string,
    currentGroups: unknown,
    ncGroups: string[] | null | undefined,
    toBfId: (orgId: string, ncGroupName: string) => string,
): string[] {
    const mirrored = `nc_${orgId}_`;
    const local = (Array.isArray(currentGroups) ? currentGroups : []).filter((g): g is string => typeof g === 'string' && !g.startsWith(mirrored));
    // NC's `admin` group is not mirrored: it must not gate Bee Flow capabilities.
    const fromNc = (ncGroups || []).filter(g => g !== 'admin').map(g => toBfId(orgId, g));
    return [...new Set([...local, ...fromNc])];
}
