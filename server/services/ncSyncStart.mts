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
 *   - it has synchronised before;
 *   - it has users that were mirrored from Nextcloud.
 * The last two keep an organisation that already synchronises doing so.
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
    [key: string]: unknown;
}

/** Does the organisation have users mirrored from Nextcloud? (userStore.hasMirroredNcUsers) */
export type HasMirroredUsers = (orgId: string) => Promise<boolean>;

function storeLookup(): HasMirroredUsers {
    return (nodeRequire('../stores/userStore.js') as { hasMirroredNcUsers: HasMirroredUsers }).hasMirroredNcUsers;
}

/** What the organisation row alone says: chosen, or not to be told from the row. */
export function chosenByRow(org: SyncStartOrg | null | undefined): boolean {
    if (!org) return false;
    if (org.nc_onboarding_completed_at || org.nc_last_sync_at) return true;
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
        return (await (hasMirroredUsers || storeLookup())(org.id)) === true;
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
