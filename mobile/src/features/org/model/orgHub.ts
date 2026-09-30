/**
 * The organisation index's shape: the sections this session is offered, filed
 * under ORG_HUB_GROUPS, and when the licence deserves more than one row.
 */

import type { LicenseStatus } from '@/features/usage';

import { expiringSoon } from './licence';
import { ORG_HUB_GROUPS, type OrgHubGroup, type OrgSection } from './sections';
import type { LicenseHealth } from './types';

export interface HubGroup {
    group: OrgHubGroup;
    sections: OrgSection[];
}

/** The groups in their order, each with its visible sections; empty groups drop out. */
export function hubGroups(visible: readonly OrgSection[]): HubGroup[] {
    const byId = new Map(visible.map((s) => [s.id, s]));
    return ORG_HUB_GROUPS.map((group) => ({
        group,
        sections: group.sections.flatMap((id) => {
            const section = byId.get(id);
            return section ? [section] : [];
        }),
    })).filter((g) => g.sections.length > 0);
}

/** Accounts past due or suspended: a problem an admin has to see, not look for. */
export function healthProblem(health: LicenseHealth | null | undefined): boolean {
    if (!health) return false;
    return health.dunning.past_due_count > 0 || health.dunning.suspended_count > 0;
}

/** The licence runs out soon, failed its last refresh, or has dunning trouble. */
export function licenceNeedsAttention(
    license: LicenseStatus | null | undefined,
    health: LicenseHealth | null | undefined,
    now = Date.now(),
): boolean {
    const summary = license?.license;
    if (summary?.expiresAt && expiringSoon(summary.expiresAt, now)) return true;
    if (summary?.refreshStatus && summary.refreshStatus !== 'ok') return true;
    return healthProblem(health);
}

/**
 * Whether the index shows the whole licence group. An admin normally reads the
 * tier off the License & Usage row; the group is for self-hosted (no such row)
 * and for a health problem, which a row value cannot explain.
 */
export function showLicenceGroup(
    isOrgAdmin: boolean,
    hasLicenceRow: boolean,
    health: LicenseHealth | null | undefined,
): boolean {
    return isOrgAdmin && (!hasLicenceRow || healthProblem(health));
}
