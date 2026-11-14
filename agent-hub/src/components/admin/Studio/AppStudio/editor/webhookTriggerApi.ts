// A webhook trigger of an app as its owner reads it (server: routes/studioApps/triggers.js, the
// three /webhook routes): the ONLY place that knows that wire contract.
//
//   const hook = useWebhookView(api, appId, triggerId, enabled);   // address, how to sign, last deliveries
//   const secret = useWebhookSecret(api, appId, triggerId);        // .mutate('reveal' | 'rotate'): the secret, once

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiJson } from '@/api/typedRequest';

export interface WebhookDelivery {
    id: string;
    /** accepted, bad_signature, stale_timestamp, replay, rate_limited, disarmed, busy, invalid_body, received */
    status: string;
    bodyBytes: number;
    bodyHash: string | null;
    runId: string | null;
    receivedAt: string | null;
}

interface WebhookEndpoint {
    url: string;
    path: string;
    /** The secret was not shown yet: it can be asked for once. */
    secretAvailable: boolean;
    createdAt: string | null;
    rotatedAt: string | null;
    previousValidUntil: string | null;
}

export interface WebhookSigning { signatureHeader: string; timestampHeader: string; nonceHeader: string; toleranceSeconds: number; maxBodyBytes: number }

export interface WebhookView { endpoint: WebhookEndpoint | null; signing: WebhookSigning; deliveries: WebhookDelivery[] }

interface WebhookSecret { secret: string; previousValidUntil: string | null }

export interface WebhookApi {
    view(appId: string, triggerId: string): Promise<WebhookView>;
    secret(appId: string, triggerId: string, how: 'reveal' | 'rotate'): Promise<WebhookSecret>;
}

export const webhookApi: WebhookApi = {
    async view(appId, triggerId) {
        return apiJson<'GET /api/studio-apps/{id}/triggers/{triggerId}/webhook', WebhookView>(
            'GET /api/studio-apps/{id}/triggers/{triggerId}/webhook', { params: { id: appId, triggerId } });
    },
    async secret(appId, triggerId, how) {
        const key = how === 'rotate'
            ? 'POST /api/studio-apps/{id}/triggers/{triggerId}/webhook/rotate' as const
            : 'POST /api/studio-apps/{id}/triggers/{triggerId}/webhook/secret' as const;
        return apiJson<typeof key, WebhookSecret>(key, { params: { id: appId, triggerId } });
    },
};

const key = (appId: string, triggerId: string) => ['studio-app-webhook', appId, triggerId];

export function useWebhookView(api: WebhookApi, appId: string, triggerId: string, enabled: boolean) {
    return useQuery({ queryKey: key(appId, triggerId), queryFn: () => api.view(appId, triggerId), enabled, staleTime: 15_000, retry: false });
}

/** The secret is the mutation's result and lives nowhere else: not in the query cache, not in the draft. */
export function useWebhookSecret(api: WebhookApi, appId: string, triggerId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (how: 'reveal' | 'rotate') => api.secret(appId, triggerId, how),
        gcTime: 0,
        onSettled: () => client.invalidateQueries({ queryKey: key(appId, triggerId) }),
    });
}
