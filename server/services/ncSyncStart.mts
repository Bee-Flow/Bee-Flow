/**
 * When the user and group sync (./ncUserGroupSync.js) starts for an
 * organisation: once its sync mode is chosen.
 *
 * The onboarding wizard asks the organisation's administrator who gets an
 * account (everyone, certain groups, nobody). Until that answer is stored,
 * no user and no group is mirrored: not by the periodic full sync, not by
 * "Sync now", not by an event from the connector. The administrators who are
 * provisioned when the organisation is bound are not part of the sync.
 *
 * An organisation counts as having chosen when any of these holds:
 *   - its onboarding is completed;
 *   - a mode other than the column's own default is stored (`mirror_all` is
 *     what a new row holds before anyone chose, so that value says nothing);
 *   - it has synchronised since it was bound to its Nextcloud;
 *   - it has users that were mirrored from Nextcloud after the day it was bound.
 * The last two keep an organisation that already synchronises doing so. Both
 * are about the Nextcloud the organisation is bound to now (`nc_provisioned_at`
 * is written when it is bound): a sync or a user from an earlier binding says
 * nothing about this one, and removing a binding puts the mode back to the
 * column default (auth/ncBindingRoutes.js). An organisation without a stored
 * binding time counts every earlier sync and every mirrored user.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export const MANUAL_MODE = 'manual_mode';
export const NOT_CHOSEN = 'sync_mode_not_chosen';

/** What an event answers for an organisation whose sync mode is not chosen yet. */
export const SKIP_NOT_CHOSEN = Object.freeze({ action: 'skip', reason: NOT_CHOSEN });

export interface SyncStartOrg {
    id?: string;
    nc_sync_mode?: string | null;
    nc_onboarding_completed_at?: unknown;
    nc_last_sync_at?: unknown;
    nc_provisioned_at?: unknown;
    [key: string]: unknown;
}

/**
 * Does the organisation have users mirrored from Nextcloud, created after the
 * day `afterDay` (YYYY-MM-DD; none = ever)? (userStore.hasMirroredNcUsers)
 */
export type HasMirroredUsers = (orgId: string, afterDay?: string | null) => Promise<boolean>;

function storeLookup(): HasMirroredUsers {
    return (nodeRequire('../stores/userStore.js') as { hasMirroredNcUsers: HasMirroredUsers }).hasMirroredNcUsers;
}

/** A stored time in ms, or null when there is none (or it is not a time). */
function timeOf(value: unknown): number | null {
    if (!value) return null;
    const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
    return Number.isFinite(ms) ? ms : null;
}

/** Has the organisation synchronised since it was bound to its Nextcloud? */
function syncedSinceBound(org: SyncStartOrg): boolean {
    const synced = timeOf(org.nc_last_sync_at);
    if (synced === null) return false;
    const bound = timeOf(org.nc_provisioned_at);
    return bound === null || synced >= bound;
}

/** The day (UTC, YYYY-MM-DD) the organisation was bound to its Nextcloud, or null. */
export function boundDay(org: SyncStartOrg | null | undefined): string | null {
    const bound = timeOf(org?.nc_provisioned_at);
    return bound === null ? null : new Date(bound).toISOString().slice(0, 10);
}

/** What the organisation row alone says: chosen, or not to be told from the row. */
export function chosenByRow(org: SyncStartOrg | null | undefined): boolean {
    if (!org) return false;
    if (org.nc_onboarding_completed_at || syncedSinceBound(org)) return true;
    return !!org.nc_sync_mode && org.nc_sync_mode !== 'mirror_all';
}

/**
 * Has the organisation's sync mode been chosen? A lookup that fails counts as
 * not chosen: nothing is mirrored on doubt, and the next run asks again.
 */
export async function syncModeChosen(org: SyncStartOrg | null | undefined, hasMirroredUsers?: HasMirroredUsers): Promise<boolean> {
    if (!org?.id) return false;
    if (chosenByRow(org)) return true;
    try {
        return (await (hasMirroredUsers || storeLookup())(org.id, boundDay(org))) === true;
    } catch {
        return false;
    }
}

/**
 * Why a full sync does not run for this organisation, or null when it does:
 * the mode is `manual`, or no mode is chosen yet.
 */
export async function fullSyncHold(org: SyncStartOrg, hasMirroredUsers?: HasMirroredUsers): Promise<string | null> {
    if (org.nc_sync_mode === 'manual') return MANUAL_MODE;
    return (await syncModeChosen(org, hasMirroredUsers)) ? null : NOT_CHOSEN;
}
