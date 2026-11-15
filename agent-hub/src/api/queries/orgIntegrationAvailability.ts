// Which integrations are available to ONE organisation: the chosen org of the
// admin dashboard, never the viewer's own session. GET
// /auth/organizations/{orgId}/integration-availability answers it for an
// organisation admin of that org or a platform admin (server:
// usecases/integrations/orgIntegrationAvailability.mts): booleans and ids only.
//
// The pure reading of the answer (a family available or not, and what to do
// while it loads or fails) is in utils/integrationAvailability.ts.

import { useQuery } from '@tanstack/react-query';
import { apiJson } from '@/api/typedRequest';

export type IntegrationFamily =
    | 'google' | 'microsoft' | 'nextcloud' | 'github' | 'n8n' | 'maps' | 'mcp'
    | 'meetingNotes' | 'projects' | 'learningCenter' | 'automations' | 'imageGen';

export type UnavailableReason = 'not_configured' | 'not_in_plan' | 'not_granted_to_org' | 'module_off' | 'not_bound';

export interface FamilyAvailability {
    serverConfigured: boolean;
    inCeiling: boolean;
    available: boolean;
    reason?: UnavailableReason;
}

/**
 * One integration catalogue id's availability.
 * @public consumed by the admin rail from wave 2 of the admin dashboard round; drop this tag there.
 */
export interface IntegrationAvailability {
    serverConfigured: boolean;
    inCeiling: boolean;
    available: boolean;
    reason?: UnavailableReason;
}

/**
 * The answer. Typed here until the generated API types carry responses
 * (apiTypes.generated.ts describes requests only).
 */
export interface OrgIntegrationAvailability {
    orgId: string;
    /** The chosen organisation is the viewer's own. */
    homeOrg: boolean;
    /** The server could not read the organisation's plan: every ceiling reads closed. */
    degraded: boolean;
    families: Record<IntegrationFamily, FamilyAvailability>;
    nextcloud: { bound: boolean; instanceId?: string; apps: string[]; pairingAvailable: boolean };
    microsoft: { directoryConnected: boolean };
    github: { syncConfigured: boolean };
    signIn: { password: boolean; google: boolean; microsoft: boolean; ssoLicensed: boolean };
    /** Per catalogue integration id. */
    integrations: Record<string, IntegrationAvailability>;
}

/**
 * The query key; Access writes, SSO config, Nextcloud binding and Azure directory changes invalidate it.
 * @public consumed by the admin rail from wave 2 of the admin dashboard round; drop this tag there.
 */
export const orgIntegrationAvailabilityKey = (orgId: string | null | undefined) => ['org-integration-availability', orgId ?? null] as const;

/**
 * All availability reads (every organisation): the prefix to invalidate after a server-wide change.
 * @public consumed by the admin rail from wave 2 of the admin dashboard round; drop this tag there.
 */
export const ORG_INTEGRATION_AVAILABILITY_PREFIX = ['org-integration-availability'] as const;

/**
 * The integration availability of `orgId`. Off while `enabled` is false or
 * there is no organisation; a refusal or failure is the query's error (the
 * helpers in utils/integrationAvailability.ts decide what that means).
 */
export function useOrgIntegrationAvailability(orgId: string | null | undefined, enabled = true) {
    return useQuery<OrgIntegrationAvailability, Error>({
        queryKey: orgIntegrationAvailabilityKey(orgId),
        queryFn: () => apiJson<'GET /auth/organizations/{orgId}/integration-availability', OrgIntegrationAvailability>(
            'GET /auth/organizations/{orgId}/integration-availability',
            { params: { orgId: String(orgId) } },
        ),
        enabled: enabled && !!orgId,
        staleTime: 60_000,
        retry: false,
    });
}
