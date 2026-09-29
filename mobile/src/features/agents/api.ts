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
 * Every payload is read through the allow-list in src/api/contract.ts: the
 * server's JSON arrives as `unknown` and leaves as the declared type, with a
 * missing or mistyped field degraded to a stated default.
 */

import type {
    Agent,
    AgentCategory,
    AgentComponent,
    AgentConfig,
    AgentConversation,
    AgentConversationAcrossAgents,
    AgentConversationSummary,
    AgentTool,
} from './types';
import { api } from '../../api/client';
import { field, nullable, shapeListOf, shapeOf } from '../../api/contract';
import { readMessage } from '../chat/api';


export const agentKeys = {
    /** The merged list of agents the signed-in user can actually open. */
    all: ['agents', 'list'] as const,
    detail: (id: string) => ['agents', 'detail', id] as const,
    tools: (id: string) => ['agents', 'tools', id] as const,
    components: ['agents', 'components'] as const,
    categories: ['agents', 'categories'] as const,
    favorites: ['agents', 'favorites'] as const,
    conversations: (agentId: string) => ['agents', 'conversations', agentId] as const,
    allConversations: ['agents', 'conversations', 'all'] as const,
    conversation: (agentId: string, conversationId: string) =>
        ['agents', 'conversation', agentId, conversationId] as const,
};

// ── Readers ─────────────────────────────────────────────────────────

/** `starter_prompts` is a JSON string on most routes and a parsed array on
 *  one; both are kept as they arrive for parseStarterPrompts below. */
function starterPrompts(value: unknown): string | string[] | null {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
    return null;
}

const agentSpec = {
    id: field.str(''),
    name: field.str('Untitled agent'),
    description: field.strOrNull,
    avatar: field.strOrNull,
    model: field.strOrNull,
    owner_id: field.str(''),
    is_published: field.bool(false),
    starter_prompts: starterPrompts,
    threads_enabled: field.optBool,
    copy_enabled: field.optBool,
    workspace_enabled: field.optBool,
    embed_enabled: field.optBool,
    config: field.record<AgentConfig>({}),
    organization_id: field.strOrNull,
    shared_groups: field.strArray,
    category_id: field.strOrNull,
    rev: field.optNum,
    created_at: field.optStr,
    updated_at: field.optStr,
    can_edit: field.optBool,
    tools: field.optStrArray,
    tool_params: field.optRecord<NonNullable<Agent['tool_params']>>,
};
const readAgent: (raw: unknown) => Agent = shapeOf(agentSpec);
const readAgentRows: (raw: unknown) => Agent[] = shapeListOf(agentSpec);

const readToolRows: (raw: unknown) => AgentTool[] = shapeListOf({
    componentId: field.str(''),
    params: field.recordOrNull,
});

const readComponentRows: (raw: unknown) => AgentComponent[] = shapeListOf({
    id: field.str(''),
    name: field.str(''),
    description: field.str(''),
    category: field.str(''),
});

const readCategoryRows: (raw: unknown) => AgentCategory[] = shapeListOf({
    id: field.str(''),
    name: field.str('Category'),
    icon: field.strOrNull,
    organization_id: field.strOrNull,
});

const conversationSpec = {
    id: field.str(''),
    agent_id: field.str(''),
    user_id: field.str(''),
    title: field.strOrNull,
    project_id: field.strOrNull,
    shared_scope: field.strOrNull,
    pinned: field.optBool,
    labels_json: field.strOrNull,
    created_at: field.str(''),
    updated_at: field.str(''),
};
const readConversationRows: (raw: unknown) => AgentConversationSummary[] =
    shapeListOf(conversationSpec);
const readConversationAcrossAgentsRows: (raw: unknown) => AgentConversationAcrossAgents[] =
    shapeListOf({
        ...conversationSpec,
        agent_name: field.strOrNull,
        agent_avatar: field.strOrNull,
    });
const readConversation: (raw: unknown) => AgentConversation = shapeOf({
    ...conversationSpec,
    messages: field.list(readMessage),
    workspace_content: field.strOrNull,
});

/** Rows without an id have no screen to open and no key to render under. */
function withId<T extends { id: string }>(rows: T[]): T[] {
    return rows.filter((row) => row.id !== '');
}

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

/**
 * `starter_prompts` is a TEXT column of JSON that `parseConfig` does not parse
 * (server/stores/agent/agentCrud.js) — only the public `/embed` endpoint does,
 * inline. So it arrives here as a string on every route this client uses.
 * Blank entries are dropped because the editor keeps empty rows around.
 */
export function parseStarterPrompts(raw: string | string[] | null | undefined): string[] {
    if (!raw) return [];
    const list: unknown = typeof raw === 'string' ? safeJson(raw) : raw;
    if (!Array.isArray(list)) return [];
    return list.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

function safeJson(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        // A malformed blob must cost this agent its starter prompts, not its row.
        return null;
    }
}

/**
 * Component ids are kebab-case slugs (`web-search`, `http-request`). When the
 * catalogue has not loaded — or the component was removed from the install —
 * a de-slugged id still reads better than the raw one.
 */
export function toolLabel(componentId: string, catalogue: AgentComponent[]): string {
    const match = catalogue.find((c) => c.id === componentId);
    if (match?.name) return match.name;
    return componentId
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
}
