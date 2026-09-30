/**
 * Who may open which integration setting, on the server's terms (the web
 * gates the same rows, OrganisationSection.jsx and OrgSettings.jsx):
 *
 * - the hub, n8n, Nextcloud, templates, system knowledge bases: an org admin
 *   (every write is requireOrgAdmin or its n8n/NC variants);
 * - GitHub Sync: also `manage_agents` (every route requirePermission);
 * - pairing codes: an NC-bound org, or the platform operator;
 * - the meeting-notes settings and templates: the `meeting_notes` licence;
 * - Azure: self-hosted, and the STRICT org admin (orgRole org_admin — the
 *   route refuses the legacy 'admin' variant) or the platform operator.
 */

import { hasLicenseFeature, holds, useAccess } from '@/core/access';
import { useAuth } from '@/core/auth/AuthProvider';
import { useOrgContext } from '@/features/org';

export interface IntegrationAccess {
    orgId: string | null;
    /** An org admin of an organisation: the default gate. */
    admin: boolean;
    isNcOrg: boolean;
    isSelfHosted: boolean;
    isSuperAdmin: boolean;
    manageAgents: boolean;
    meetingNotes: boolean;
    azure: boolean;
    /** The org's integration allow-list; undefined is all of them. */
    enabledIntegrations: string[] | undefined;
}

export function useIntegrationAccess(): IntegrationAccess {
    const { user } = useAuth();
    const { orgId, isOrgAdmin, isSelfHosted, isNcOrg } = useOrgContext();
    const access = useAccess();
    const admin = isOrgAdmin && Boolean(orgId);
    const isSuperAdmin = Boolean(access.isSuperAdmin);
    return {
        orgId,
        admin,
        isNcOrg,
        isSelfHosted,
        isSuperAdmin,
        manageAgents: admin && holds(access, 'manage_agents'),
        meetingNotes: admin && hasLicenseFeature(access, 'meeting_notes'),
        azure: isSelfHosted && Boolean(orgId) && (isSuperAdmin || access.orgRole === 'org_admin'),
        enabledIntegrations: user?.enabledIntegrations,
    };
}
