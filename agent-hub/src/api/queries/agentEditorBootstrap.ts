// The agent editor's picker data in one read of six requests: skills, the
// integration status (user settings), categories, org groups, the chat tiers
// and the automations. The Studio's provider reads it once per session; the
// wizard landing outside the provider reads its own (the older endpoint set of
// fetchAgentEditorBootstrap). Each part says whether it could be read: an
// empty list is not the same as a list that failed.

import { useQuery } from '@tanstack/react-query';
import { isAbortError } from '../../utils/caughtError';
import { fetchAgentEditorBootstrap } from '../agentEditor';
import { apiFetch } from '../typedRequest';
import { READ_ONCE } from './readOnce';

type MaybeResponse = Response | { ok: false };

/** Each part of the answer; a list part is null when its request failed or its body was not a list. */
export interface AgentEditorBootstrapAnswer {
    skills: unknown;
    integrationStatus: unknown;
    categories: unknown[] | null;
    orgGroups: unknown;
    tiers: unknown;
    /** `failed`: no ok answer; `unrecognised`: an ok answer without an automations list (or unreadable). */
    automations: { state: 'ok'; list: unknown[] } | { state: 'unrecognised' } | { state: 'failed' };
}

async function automationsOf(res: MaybeResponse): Promise<AgentEditorBootstrapAnswer['automations']> {
    if (!res.ok) return { state: 'failed' };
    try {
        const data = await (res as Response).json();
        return Array.isArray(data?.automations) ? { state: 'ok', list: data.automations } : { state: 'unrecognised' };
    } catch (e) {
        console.warn('[AgentEditorBootstrap] automations parse failed', e);
        return { state: 'unrecognised' };
    }
}

async function answerOf(responses: [Response, Response, Response, Response, Response, MaybeResponse]): Promise<AgentEditorBootstrapAnswer> {
    const [skillsRes, statusRes, catsRes, groupsRes, tiersRes, autosRes] = responses;
    const skills = skillsRes.ok ? await skillsRes.json() : [];
    const integrationStatus = statusRes.ok ? await statusRes.json() : {};
    let categories: unknown[] | null = null;
    if (catsRes.ok) {
        const list = await catsRes.json();
        categories = Array.isArray(list) ? list : null;
    }
    const orgGroups = groupsRes.ok ? await groupsRes.json() : [];
    const tiers = tiersRes.ok ? await tiersRes.json() : {};
    return { skills, integrationStatus, categories, orgGroups, tiers, automations: await automationsOf(autosRes) };
}

/** The provider's read (`/api/automation`); a network failure of the other five is the query's error. */
export function useAgentEditorBootstrapQuery() {
    return useQuery<AgentEditorBootstrapAnswer, Error>({
        queryKey: ['agent-editor', 'bootstrap'],
        ...READ_ONCE,
        queryFn: async ({ signal }) => answerOf(await Promise.all([
            apiFetch('GET /api/skills', { init: { signal } }),
            apiFetch('GET /ai/user-settings', { init: { signal } }),
            apiFetch('GET /agents/categories', { init: { signal } }),
            apiFetch('GET /auth/groups', { init: { signal } }),
            apiFetch('GET /ai/config/tiers-for-user', { query: { taskType: 'direct_chat' }, init: { signal } }),
            apiFetch('GET /api/automation', { init: { signal } }).catch((e: unknown): { ok: false } => {
                if (!isAbortError(e)) console.warn('[AgentEditorBootstrap] automations fetch failed', e);
                return { ok: false };
            }),
        ])),
    });
}

/** The standalone editor's read, only while it is not under the provider. */
export function useStandaloneAgentEditorBootstrapQuery(enabled: boolean) {
    return useQuery<AgentEditorBootstrapAnswer, Error>({
        queryKey: ['agent-editor', 'bootstrap', 'standalone'],
        enabled,
        ...READ_ONCE,
        queryFn: async () => answerOf(await fetchAgentEditorBootstrap()),
    });
}
