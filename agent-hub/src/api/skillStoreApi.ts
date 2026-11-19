/**
 * The Skill store's calls (components/skills/store): the sort keys, a copy of
 * a skill, and attaching a skill to one of your own agents.
 *
 * "Add to agent" invents no right and no endpoint: it is the agent editor's own
 * save (`PUT /agents/:id`, `manage_agents` and the edit grade on the agent),
 * with the agent's draft config plus this skill id, and the `rev` the draft was
 * read at as `baseVersion`, so a save from another tab in between is a 409
 * instead of being overwritten.
 */
import { apiJson } from './typedRequest';

/** `GET /api/skills/store-stats`: how often a skill was used, and when YOU last used it. */
interface SkillStoreStat { uses: number; lastUsedByMeAt: string | null }
export type SkillStoreStats = Record<string, SkillStoreStat>;

export async function fetchSkillStoreStats(): Promise<SkillStoreStats> {
    const body = await apiJson<'GET /api/skills/store-stats', { stats?: SkillStoreStats } | null>('GET /api/skills/store-stats');
    return body?.stats || {};
}

/** `POST /api/skills/:id/copy`: your own private copy; the original is not touched. */
export function copySkill(id: string, name?: string): Promise<{ id: string; name?: string }> {
    return apiJson<'POST /api/skills/{id}/copy', { id: string; name?: string }>('POST /api/skills/{id}/copy', {
        params: { id },
        body: name ? { name } : {},
    });
}

/** An agent as `GET /agents` and `GET /agents/:id` answer it, in the fields read here. */
export interface StoreAgent {
    id: string;
    name?: string;
    owner_id?: string;
    can_edit?: boolean;
    rev?: number;
    published_version?: number | null;
    config?: { attachedSkillIds?: unknown; [key: string]: unknown } | null;
}

/** Your own agents (`GET /agents` also answers the system agents; those are left out). */
export async function listOwnAgents(userId: string): Promise<StoreAgent[]> {
    const rows = await apiJson<'GET /agents', StoreAgent[] | null>('GET /agents');
    return (Array.isArray(rows) ? rows : []).filter((a) => a && a.owner_id === userId);
}

export type AttachResult = 'attached' | 'already' | 'not_editable';

/**
 * Attach `skillId` to the agent's draft. `published` says the agent has a
 * published version: its users get the skill once the agent is published again.
 */
export async function attachSkillToAgent(agentId: string, skillId: string): Promise<{ result: AttachResult; published: boolean }> {
    const agent = await apiJson<'GET /agents/{id}', StoreAgent>('GET /agents/{id}', {
        params: { id: agentId },
        query: new URLSearchParams({ draft: '1' }),
    });
    const published = Number(agent?.published_version) > 0;
    if (!agent?.can_edit) return { result: 'not_editable', published };
    const config = agent.config && typeof agent.config === 'object' ? agent.config : {};
    const ids = Array.isArray(config.attachedSkillIds) ? config.attachedSkillIds.filter((x): x is string => typeof x === 'string') : [];
    if (ids.includes(skillId)) return { result: 'already', published };
    await apiJson('PUT /agents/{id}', {
        params: { id: agentId },
        body: {
            config: { ...config, attachedSkillIds: [...ids, skillId] },
            baseVersion: Number.isInteger(agent.rev) ? agent.rev : null,
        },
    });
    return { result: 'attached', published };
}
