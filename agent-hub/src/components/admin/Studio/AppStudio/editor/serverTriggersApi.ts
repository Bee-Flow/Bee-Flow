// The server triggers of an app as its owner reads them (server: routes/studioApps/triggers.js):
// the ONLY place that knows that wire contract.
//
//   const state = useTriggerState(api, appId);        // which trigger is armed, its next and last fire
//   const flip = useTriggerSwitch(api, appId);        // switch an armed trigger off or on again

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE, request } from '@/api/mutate';

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

const base = (appId: string) => `${API_BASE}/api/studio-apps/${encodeURIComponent(appId)}/triggers`;

export const triggersApi: TriggersApi = {
    async list(appId) {
        return (await (await request(base(appId))).json()) as TriggerState;
    },
    async setEnabled(appId, triggerId, enabled) {
        const res = await request(`${base(appId)}/${encodeURIComponent(triggerId)}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
        });
        return (await res.json()) as { trigger: TriggerView };
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
