// What the AI of an app can reach on this installation, as its owner reads it
// (server: routes/studioApps/aiCapabilities.js, appStudio/aiCapabilities.mts): the ONLY place
// that knows that wire contract.

import { useQuery } from '@tanstack/react-query';
import { apiJson } from '@/api/typedRequest';

export interface AiCapabilities {
    webSearch: { integrationAllowed: boolean; providerAvailable: boolean };
    browsing: { integrationAllowed: boolean; backendAvailable: boolean };
}

export interface AiCapabilitiesApi {
    get(appId: string): Promise<AiCapabilities>;
}

export const aiCapabilitiesApi: AiCapabilitiesApi = {
    async get(appId) {
        return apiJson<'GET /api/studio-apps/{id}/ai-capabilities', AiCapabilities>('GET /api/studio-apps/{id}/ai-capabilities', { params: { id: appId } });
    },
};

export function useAiCapabilities(api: AiCapabilitiesApi, appId: string | null) {
    return useQuery({
        queryKey: ['studio-app-ai-capabilities', appId],
        queryFn: () => api.get(appId as string),
        enabled: !!appId,
        staleTime: 60_000,
        retry: false,
    });
}
