// The apps a Privacy Shield per-app exception can be made for, for ONE
// organisation: GET /api/org-privacy-shield/{orgId}/app-exemption-apps
// (server: routes/orgPrivacyShield.js). Organisation admins only; the
// registry's apps minus those the organisation does not have, each with the
// tool classes its tools fall in.

import { useQuery } from '@tanstack/react-query';
import { apiJson } from '@/api/typedRequest';

export interface ExemptionApp {
    id: string;
    label: string;
    classes: Array<'external' | 'internal'>;
}

interface ExemptionAppsAnswer {
    apps?: ExemptionApp[];
}

export const shieldExemptionAppsKey = (orgId: string | null | undefined) => ['shield-exemption-apps', orgId ?? null] as const;

/** Disabled without an organisation, or when the caller cannot edit (`enabled: false`). */
export function useShieldExemptionAppsQuery(orgId: string | null | undefined, enabled = true) {
    return useQuery<ExemptionApp[], Error>({
        queryKey: shieldExemptionAppsKey(orgId),
        queryFn: async ({ signal }) => {
            const body: ExemptionAppsAnswer = await apiJson('GET /api/org-privacy-shield/{orgId}/app-exemption-apps', {
                params: { orgId: String(orgId) }, init: { signal },
            });
            return Array.isArray(body?.apps) ? body.apps : [];
        },
        enabled: !!orgId && enabled,
        staleTime: 60_000,
        retry: false,
    });
}
