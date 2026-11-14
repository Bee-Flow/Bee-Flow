// The server triggers of an app as its owner reads them (server: routes/studioApps/triggers.js):
// the ONLY place that knows that wire contract.
//
//   const state = useTriggerState(api, appId);        // which trigger is armed, its next and last fire
//   const flip = useTriggerSwitch(api, appId);        // switch an armed trigger off or on again

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiJson } from '@/api/typedRequest';

export interface TriggerView {
    id: string;
    kind: string;
    actionId: string;
    armed: boolean;
    state: 'armed' | 'paused' | 'none';
    pausedCode: string | null;
    pausedReason: string | null;
    /** The armed trigger is what the draft holds; false: the change goes live with the next publish. */
    live: boolean | null;
    nextFireAt: string | null;
    lastFiredAt: string | null;
    lastRunId: string | null;
    lastStatus: string | null;
    lastError: string | null;
    consecutiveFailures: number;
}

export interface TriggerState { published: boolean; triggers: TriggerView[] }

export interface TriggersApi {
    list(appId: string): Promise<TriggerState>;
    setEnabled(appId: string, triggerId: string, enabled: boolean): Promise<{ trigger: TriggerView }>;
}

export const triggersApi: TriggersApi = {
    async list(appId) {
        return apiJson<'GET /api/studio-apps/{id}/triggers', TriggerState>('GET /api/studio-apps/{id}/triggers', { params: { id: appId } });
    },
    async setEnabled(appId, triggerId, enabled) {
        return apiJson<'PUT /api/studio-apps/{id}/triggers/{triggerId}', { trigger: TriggerView }>(
            'PUT /api/studio-apps/{id}/triggers/{triggerId}', { params: { id: appId, triggerId }, body: { enabled } });
    },
};

const key = (appId: string) => ['studio-app-triggers', appId];

export function useTriggerState(api: TriggersApi, appId: string, enabled: boolean) {
    return useQuery({ queryKey: key(appId), queryFn: () => api.list(appId), enabled, staleTime: 15_000, retry: false });
}

export function useTriggerSwitch(api: TriggersApi, appId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (v: { triggerId: string; enabled: boolean }) => api.setEnabled(appId, v.triggerId, v.enabled),
        onSettled: () => client.invalidateQueries({ queryKey: key(appId) }),
    });
}
