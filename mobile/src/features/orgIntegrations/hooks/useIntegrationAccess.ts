/**
 * Who may open which integration setting, on the server's terms (the web
 * gates the same rows, OrganisationSection.jsx and OrgSettings.jsx):
 *
 * - the hub, n8n, Nextcloud, templates, system knowledge bases: an org admin
 *   (every write is requireOrgAdmin or its n8n/NC variants);
 * - GitHub Sync: also `manage_agents` (every route requirePermission);
 * - pairing codes: an NC-bound org, or the platform operator;
 * - the meeting-notes settings and templates: the `meeting_notes` licence;
 * - Azure: self-hosted, and the platform admin. GET/PUT
 *   /api/org-azure-config/:orgId read and write the instance-wide Azure setup
 *   and refuse everyone else (403 platform_managed) in every deployment mode;
 * - the Google Maps key: the platform admin (POST /ai/config is platform-only;
 *   the key is instance-wide).
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
    /** May set the instance-wide Google Maps key: the platform admin. */
    maps: boolean;
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
        azure: isSelfHosted && Boolean(orgId) && isSuperAdmin,
        maps: isSuperAdmin,
        enabledIntegrations: user?.enabledIntegrations,
    };
}
