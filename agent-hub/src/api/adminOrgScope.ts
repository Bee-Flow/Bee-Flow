// The organisation the organisation-admin requests below a provider act on.
//
// The admin dashboard's Organisation tab provides it: the organisation a
// platform admin chose there. The requests on the caller's primary-organisation
// routes (/ai/learning/org-overview, /ai/learning/training-rules,
// /ai/learning/admin/*, /api/mcp-library/org*, /api/org/mcp-access,
// /auth/invitations, /auth/org-roles, /ai/n8n/*, /api/integrations/github-sync/*,
// /ai/config/org-custom-chat-models) then carry it as ?orgId= (the custom-tier
// save in its body), which the server accepts from a platform admin for any
// organisation and from anyone else for their own only. The Users screen of
// Admin > Security provides it for its organisation tabs too. Without a
// provider (Settings, or anyone who is not a platform admin) the value is null
// and no orgId is sent: the server answers for the caller's own organisation.

import { createContext, useContext } from 'react';

const AdminOrgScopeContext = createContext<string | null>(null);

/** Provide the organisation the requests below act on; null sends none. */
export const AdminOrgScopeProvider = AdminOrgScopeContext.Provider;

/** The organisation the requests below a provider act on, or null (the caller's own). */
export function useAdminOrgScope(): string | null {
    return useContext(AdminOrgScopeContext);
}

/** The path with ?orgId= (or &orgId=) added when an organisation is named. */
export function withOrgIdParam(path: string, orgId: string | null): string {
    if (!orgId) return path;
    return `${path}${path.includes('?') ? '&' : '?'}orgId=${encodeURIComponent(orgId)}`;
}
