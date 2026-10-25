// Reads for the agent editor (concept facts, knowledge-base picker list).
// authFetch stays inside queryFn on purpose: the editor tests mock authFetch.
// The READ states (components/) are mapped by the callers; these hooks only
// carry plain data so api/ never imports from components/.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';

export interface ConceptFactsAnswer {
    /** true: the read failed (non-ok, network); persona and changes are then null. */
    failed: boolean;
    persona: ({ language?: string | null; [key: string]: unknown }) | null;
    unpublishedChanges: number | null;
}

export function useAgentConceptFactsQuery(agentId: string | null) {
    return useQuery<ConceptFactsAnswer, Error>({
        queryKey: ['agentWizard', 'conceptFacts', agentId],
        enabled: !!agentId,
        queryFn: async ({ signal }) => {
            const failed: ConceptFactsAnswer = { failed: true, persona: null, unpublishedChanges: null };
            try {
                const res = await authFetch(`${API_BASE}/agents/${encodeURIComponent(agentId as string)}?draft=1`, { signal });
                if (!res.ok) return failed;
                const body = await res.json();
                const changes = Number(body?.unpublishedChanges);
                const persona = (body && typeof body.persona === 'object' && body.persona) ? body.persona : null;
                return { failed: false, persona, unpublishedChanges: Number.isFinite(changes) ? changes : null };
            } catch (_) {
                return failed;
            }
        },
        staleTime: 0,
        retry: false,
    });
}

/** The knowledge bases an agent may link (`?context=agent`); throws on a refused or malformed answer. */
export function useAgentKnowledgeBaseList<T>() {
    return useQuery<T[], Error>({
        queryKey: ['agentWizard', 'knowledgeBases'],
        queryFn: async () => {
            const res = await authFetch(`${API_BASE}/api/kb?context=agent`);
            if (!res.ok) throw new Error(`kb ${res.status}`);
            const body = await res.json();
            if (!Array.isArray(body)) throw new Error('kb list is not a list');
            return body;
        },
        staleTime: 0,
        retry: false,
    });
}

/** `GET /api/datatables`: `valid` false when the answer carried no list (the caller shows an error state). */
export function useAgentDatatableNames(active: boolean, grantCount: number) {
    return useQuery<{ rows: Array<{ id?: string; name?: string }>; valid: boolean }, Error>({
        queryKey: ['agentWizard', 'datatableNames', grantCount],
        enabled: active,
        queryFn: async ({ signal }) => {
            const res = await authFetch(`${API_BASE}/api/datatables`, { signal });
            if (!res.ok) throw new Error(`datatables ${res.status}`);
            const body = await res.json();
            const valid = Array.isArray(body?.datatables);
            return { rows: valid ? body.datatables : [], valid };
        },
        staleTime: 0,
        retry: false,
    });
}

/** `GET /api/skills/usage-summary`; null when the answer carried no summary object. */
export function useSkillUsageSummary(active: boolean, skillKey: string) {
    return useQuery<Record<string, { agents?: number | null }> | null, Error>({
        queryKey: ['agentWizard', 'skillUsageSummary', skillKey],
        enabled: active,
        queryFn: async ({ signal }) => {
            const res = await authFetch(`${API_BASE}/api/skills/usage-summary`, { signal });
            if (!res.ok) throw new Error(`usage-summary ${res.status}`);
            const body = await res.json();
            return body && typeof body.summary === 'object' && body.summary ? body.summary : null;
        },
        staleTime: 0,
        retry: false,
    });
}

/** `GET /agents/tool-catalog` narrowed to what the Tools card reads. */
export function useToolCatalogQuery<TApp>(enabled: boolean) {
    return useQuery<{ apps: TApp[]; degraded: boolean; providersKnown: boolean; lendingEnabled: boolean }, Error>({
        queryKey: ['agentWizard', 'toolCatalog'],
        enabled,
        queryFn: async ({ signal }) => {
            const res = await authFetch(`${API_BASE}/agents/tool-catalog`, { signal });
            if (!res.ok) throw new Error(`tool-catalog ${res.status}`);
            const body = await res.json();
            if (!Array.isArray(body?.apps)) throw new Error('tool-catalog: no apps');
            return {
                apps: body.apps,
                // The server itself says whether it could calculate the availability.
                degraded: body.degraded === true,
                providersKnown: body.providersKnown !== false,
                lendingEnabled: body.lendingEnabled === true,
            };
        },
        staleTime: 0,
        retry: false,
    });
}

/** `GET /agents/:id/tool-lending`: the apps whose owner connection may be lent, and whether the runtime curates. */
export function useToolLendingQuery(enabled: boolean, agentId: string | number | null) {
    return useQuery<{ apps: string[]; runtimeCurated: boolean | null }, Error>({
        queryKey: ['agentWizard', 'toolLending', agentId == null ? null : String(agentId)],
        enabled: enabled && !!agentId,
        queryFn: async ({ signal }) => {
            const url = `${API_BASE}/agents/${encodeURIComponent(String(agentId))}/tool-lending`;
            const res = await authFetch(url, { signal });
            if (!res.ok) throw new Error(`tool-lending ${res.status}`);
            const body = await res.json();
            // `readable: false` is the narrow answer of the server: not an empty list, not a list at all.
            if (body?.readable !== true) throw new Error('tool-lending: not readable');
            if (!Array.isArray(body?.apps)) throw new Error('tool-lending: no list');
            return {
                apps: body.apps.filter((id: unknown): id is string => typeof id === 'string' && !!id),
                runtimeCurated: typeof body.runtimeCurated === 'boolean' ? body.runtimeCurated : null,
            };
        },
        staleTime: 0,
        retry: false,
    });
}
