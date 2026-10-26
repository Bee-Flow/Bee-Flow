// Small reads shared across screens: the agents list of the Studio, the
// scheduled items that run as one agent, the connections a shared resource
// needs, the plans offered at signup and the platform directory.

import { useQuery } from '@tanstack/react-query';
import { API_BASE } from '../../utils/helpers';
import { fetchCoworkSchedules } from '../agentEditor';
import { fetchAgentList } from '../agentStudio';
import { getPublicPlans } from '../loginRequests';
import { readOrNull } from './refusableRead';

const sharedKeys = {
    agentList: (systemMode: boolean) => ['agent-studio', 'list', systemMode] as const,
    schedules: () => ['agent-editor', 'cowork-schedules'] as const,
    required: (resourceType: string, resourceId: string, providers: string) => ['connections', 'required', resourceType, resourceId, providers] as const,
    signupPlans: () => ['login', 'public-plans'] as const,
};

/** The Agent Studio's list (`/agents/system` or `/agents/all?usage=1`); a non-ok answer is an error with the HTTP status. */
export function useAgentListQuery<Row>(systemMode: boolean) {
    return useQuery<Row[], Error>({
        queryKey: sharedKeys.agentList(systemMode),
        queryFn: async ({ signal }) => {
            const res = await fetchAgentList(systemMode, signal);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data: unknown = await res.json();
            return Array.isArray(data) ? data as Row[] : [];
        },
        staleTime: 0,
        retry: false,
    });
}

/** The user's Cowork schedules (the schedules panel keeps the ones that run as a given agent); a non-ok answer reads as none. */
export function useCoworkSchedulesQuery<S>(enabled: boolean) {
    return useQuery<S[], Error>({
        queryKey: sharedKeys.schedules(),
        enabled,
        queryFn: async () => {
            const res = await fetchCoworkSchedules();
            if (!res.ok) return [];
            const data = await res.json();
            return Array.isArray(data?.schedules) ? data.schedules as S[] : [];
        },
        staleTime: 0,
        retry: false,
    });
}

const CONNECTIONS_BASE = `${API_BASE}/api/integrations/connections`;

/** Which of `providers` the running user must still connect for a shared resource; a refusal reads as none. */
export function useRequiredConnectionsQuery<C>(resourceType: string, resourceId: string | null | undefined, providers: string[]) {
    const joined = providers.join(',');
    return useQuery<C[], Error>({
        queryKey: sharedKeys.required(resourceType, resourceId ?? '', joined),
        enabled: !!resourceId && providers.length > 0,
        queryFn: async ({ signal }) => {
            const qs = new URLSearchParams({ resourceType, resourceId: resourceId as string, providers: joined });
            const data = await readOrNull<{ requiresConnection?: C[] }>(`${CONNECTIONS_BASE}/required?${qs.toString()}`, signal);
            return data?.requiresConnection || [];
        },
        staleTime: 0,
        retry: false,
    });
}

/** The plans offered at signup (public endpoint, so it works before an account exists); an unreadable answer is none. */
export function useSignupPlansQuery(enabled: boolean) {
    return useQuery<unknown[], Error>({
        queryKey: sharedKeys.signupPlans(),
        enabled,
        queryFn: async ({ signal }) => {
            const res = await getPublicPlans(signal);
            if (!res.ok) return [];
            const data: { plans?: unknown } = await res.json();
            return Array.isArray(data?.plans) ? data.plans : [];
        },
        retry: false,
    });
}
