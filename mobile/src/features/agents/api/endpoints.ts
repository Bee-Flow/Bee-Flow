/**
 * Agent endpoints.
 *
 * Paths are the FULL client-visible ones. The agents router is mounted at
 * `/agents` in server/index.js (line 449) — NOT `/api/agents`, and not under
 * `/ai`. Several comments inside server/routes/agents/** read as if the router
 * were mounted at the root; the mount line is the truth.
 *
 * Route-ordering note, because it changes what a path means: `meta`,
 * `conversations/all`, `published`, `favorites` and `wizard` are all mounted
 * BEFORE `/:id` (server/routes/agents/index.js), which is why
 * `/agents/conversations/all` is the cross-agent list and not "the agent whose
 * id is `conversations`".
 *
 * Every payload is read through the readers in readers.ts.
 */

import { api } from '@/core/api/client';
import { field, nullable } from '@/core/api/contract';
import { withId } from '@/shared/lib/withId';

import {
    readAgent,
    readAgentRows,
    readCategoryRows,
    readComponentRows,
    readConversation,
    readConversationAcrossAgentsRows,
    readConversationRows,
    readToolRows,
} from './readers';
import type {
    Agent,
    AgentCategory,
    AgentComponent,
    AgentConversation,
    AgentConversationAcrossAgents,
    AgentConversationSummary,
    AgentTool,
} from '../model/types';

// ── Agents ──────────────────────────────────────────────────────────

/**
 * Agents whose chat the user can actually open.
 *
 * Two sources, merged exactly as agent-hub's `refreshAgents` does:
 *   1. `/agents/published` — everything published into the user's org/groups.
 *   2. `/agents`           — the user's OWN agents, drafts included.
 *
 * (2) is not redundant: an agent set to "Personal" is unpublished, so it is
 * absent from (1) even for the only person who can use it. Published records
 * win on a collision because they carry the parsed `tool_params`.
 *
 * `owner_id` of `system` or `swarm` is filtered out here rather than on the
 * server: those back internal pipelines (memory extraction, title generation)
 * and have no user-facing chat surface, but `/agents` returns them to every
 * caller.
 */
export async function listAgents(signal?: AbortSignal): Promise<Agent[]> {
    const [published, own] = await Promise.all([
        api.get<unknown>('/agents/published', { signal }),
        api.get<unknown>('/agents', { signal }),
    ]);

    const byId = new Map<string, Agent>();
    for (const agent of withId(readAgentRows(own))) byId.set(agent.id, agent);
    for (const agent of withId(readAgentRows(published))) byId.set(agent.id, agent);

    return [...byId.values()].filter(isUserFacing);
}

function isUserFacing(agent: Agent): boolean {
    return agent.owner_id !== 'system' && agent.owner_id !== 'swarm';
}

/** Carries `can_edit`, `tools` and `tool_params`; 404s (not 403s) when out of reach. */
export async function getAgent(id: string, signal?: AbortSignal): Promise<Agent | null> {
    return nullable(readAgent)(await api.get<unknown>(`/agents/${encodeURIComponent(id)}`, { signal }));
}

export async function listAgentTools(id: string, signal?: AbortSignal): Promise<AgentTool[]> {
    return readToolRows(await api.get<unknown>(`/agents/${encodeURIComponent(id)}/tools`, { signal }));
}

/** The catalogue of tool components, used to turn a component id into a name. */
export async function listComponents(signal?: AbortSignal): Promise<AgentComponent[]> {
    return withId(readComponentRows(await api.get<unknown>('/agents/meta/components', { signal })));
}

export async function listCategories(signal?: AbortSignal): Promise<AgentCategory[]> {
    return withId(readCategoryRows(await api.get<unknown>('/agents/categories', { signal })));
}

/** Favourite agent ids. DB-backed per user — not device-local. */
export async function listFavorites(signal?: AbortSignal): Promise<string[]> {
    return field.strArray(await api.get<unknown>('/agents/favorites', { signal }));
}

/** Both directions are idempotent server-side, so a double-tap is harmless. */
export async function setFavorite(id: string, favorite: boolean): Promise<void> {
    const path = `/agents/${encodeURIComponent(id)}/favorite`;
    if (favorite) await api.put(path, {});
    else await api.delete(path);
}

export async function listAgentConversations(
    agentId: string,
    signal?: AbortSignal,
): Promise<AgentConversationSummary[]> {
    return withId(
        readConversationRows(
            await api.get<unknown>(`/agents/${encodeURIComponent(agentId)}/conversations`, {
                signal,
            }),
        ),
    );
}

/**
 * Recent conversations across every agent. Server-capped at 50 rows with no
 * cursor, so this is "recent", never "all" — do not build paging on it.
 */
export async function listAllConversations(
    signal?: AbortSignal,
): Promise<AgentConversationAcrossAgents[]> {
    return withId(
        readConversationAcrossAgentsRows(
            await api.get<unknown>('/agents/conversations/all', { signal }),
        ),
    );
}

export async function getAgentConversation(
    agentId: string,
    conversationId: string,
    signal?: AbortSignal,
): Promise<AgentConversation | null> {
    return nullable(readConversation)(
        await api.get<unknown>(
            `/agents/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(conversationId)}`,
            { signal },
        ),
    );
}

/** Rename / pin / relabel — all one PATCH, same as the direct-chat side. */
export async function updateAgentConversation(
    agentId: string,
    conversationId: string,
    patch: { title?: string; pinned?: boolean; labels?: string[] },
): Promise<void> {
    await api.patch(
        `/agents/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(conversationId)}`,
        patch,
    );
}

export async function deleteAgentConversation(
    agentId: string,
    conversationId: string,
): Promise<void> {
    await api.delete(
        `/agents/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(conversationId)}`,
    );
}
