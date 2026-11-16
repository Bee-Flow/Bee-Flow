// Which way the Agent Designer decides the integrations an agent may be given
// (integrationAvailability.ts): in the admin dashboard, for the organisation
// the agent belongs to (admin mode); anywhere else, for the person editing
// (user mode). System agents belong to no organisation: user mode, as before.

import { useOrgIntegrationAvailability } from '@/api/queries/orgIntegrationAvailability';
import { useAdminOrgChoice } from '@/components/admin/dashboard/useAdminOrg';
import type { AvailabilityMode } from './integrationAvailability';

export interface DesignerIntegrationAccess {
    how: AvailabilityMode;
    /** The admin dashboard decides for an organisation. */
    adminMode: boolean;
    /** Admin mode: the organisation's answer is still on its way. */
    pending: boolean;
    /** Admin mode: no definite answer (none, failed, or the plan could not be read). */
    unknown: boolean;
}

/** The legacy designer has always read a status that has not loaded as "nothing yet". */
export const USER_ACCESS: Readonly<DesignerIntegrationAccess> = {
    how: { mode: 'user', unloaded: 'none' },
    adminMode: false,
    pending: false,
    unknown: false,
};

/**
 * `agentOrgId`: the open agent's organisation (an agent row's `organization_id`);
 * a new agent belongs to the chosen organisation, or else the viewer's own.
 */
export function useDesignerIntegrationAccess({ systemMode, agentOrgId }: { systemMode: boolean; agentOrgId: string | null }): Readonly<DesignerIntegrationAccess> {
    const choice = useAdminOrgChoice();
    const adminMode = !!choice && !systemMode;
    const orgId = adminMode ? (agentOrgId || choice?.orgId || choice?.homeOrganization?.id || null) : null;
    const read = useOrgIntegrationAvailability(orgId, adminMode);
    if (!adminMode) return USER_ACCESS;
    const platformAdmin = !!choice?.isPlatformAdmin;
    return {
        how: { mode: 'admin', availability: read, platformAdmin },
        adminMode: true,
        pending: !!orgId && read.isLoading,
        unknown: !read.data || read.isError || !!read.data.degraded,
    };
}
