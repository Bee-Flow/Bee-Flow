/**
 * Agent shapes, taken from the server's own row definitions rather than guessed:
 *   server/stores/agent/initSchema.js        the `agents` / `agent_conversations` columns
 *   server/stores/agent/agentCrud.js         parseConfig() — what is parsed and what is NOT
 *   server/stores/agent/agentConversations.js listConversations / listAllConversations
 *   server/routes/agents/crud.js             the `can_edit` verdict added on read
 *
 * The one trap worth stating up front: `parseConfig` parses `config` and
 * `shared_groups` for you, and deliberately does NOT parse `starter_prompts`.
 * That column arrives as the raw JSON *string* on every endpoint except
 * `/agents/:id/embed`, which parses it inline. Hence `string | string[]` here
 * and `parseStarterPrompts` in api.ts — reading it as an array is a silent
 * "this agent has no starters" bug rather than a crash.
 */

import type { ChatMessage } from '../chat/types';

/**
 * Everything the agent editor stores under the `config` JSON column.
 *
 * Open-ended on purpose (`[key: string]: unknown`): the web editor adds flags
 * here regularly and a closed type would make an unknown flag a type error in
 * a client that only ever reads a handful of them.
 */
export interface AgentConfig {
    /** Knowledge bases this agent retrieves from. Snake_case — the runtime reads `config.knowledge_base_ids` (server/core/agentRuntime/knowledgeSearch.js). */
    knowledge_base_ids?: string[];
    /** Skills attached in the designer. */
    attachedSkillIds?: string[];
    /**
     * The apps this agent may use, as a LIST of app ids.
     *
     * An array, not a map. Every reader on the server treats it as one —
     * `Array.isArray(agent?.config?.enabledIntegrations)` in
     * server/core/aiTaskRunner.js, and `[...apps, WEB_SEARCH_APP_ID]` in
     * server/core/agentRuntime/personaPrompt.js — and the same field is
     * already `string[]` in src/features/skills/types.ts. The
     * `Record<string, boolean>` this used to say was never a shape the server
     * writes; nothing on the phone read it, so it broke nobody, but it is the
     * kind of promise the first reader builds a screen on.
     *
     * null/undefined means "the org default", which is not the same as `[]`
     * ("this agent may use no apps") — keep the two distinguishable.
     *
     * This is the APP-level on/off list only. Which individual ACTIONS of an
     * enabled app are granted is a different field, `config.tools`
     * (server/core/agentRuntime/toolPolicy.js), and the two are read
     * separately: an app switched on here still runs only the actions listed
     * there.
     */
    enabledIntegrations?: string[] | null;
    enableGuardrails?: boolean;
    llamaGuardEnabled?: boolean;
    webSearchGuardEnabled?: boolean;
    /** Answer only from the knowledge bases, never from the model's own knowledge. */
    strictKnowledge?: boolean;
    includeSourceReferences?: boolean;
    disableExternalTools?: boolean;
    memoryEnabled?: boolean;
    /** Legacy home for the picture, before the dedicated `avatar` column. */
    avatar?: string;
    regexGuardrails?: {
        enabled?: boolean;
        collectionIds?: string[];
        scope?: string;
        action?: string;
    };
    [key: string]: unknown;
}

export interface Agent {
    id: string;
    name: string;
    description: string | null;
    /** Emoji, data: URI, absolute URL, or a server-relative upload path. See avatar.ts. */
    avatar: string | null;
    /** A raw model id, or `tier:<key>`. Null means "the org default". */
    model: string | null;
    owner_id: string;
    is_published: boolean;
    /** JSON string on the wire — see the file header. */
    starter_prompts: string | string[] | null;
    threads_enabled?: boolean;
    copy_enabled?: boolean;
    workspace_enabled?: boolean;
    embed_enabled?: boolean;
    config: AgentConfig;
    organization_id: string | null;
    /** Already parsed to an array by parseConfig. */
    shared_groups: string[];
    category_id?: string | null;
    /**
     * Optimistic-concurrency token. A PUT without `baseVersion: rev` is
     * last-write-wins and silently clobbers a concurrent edit
     * (server/routes/agents/crud.js).
     */
    rev?: number;
    created_at?: string;
    updated_at?: string;
    /**
     * The server's own edit verdict, added on GET /:id and /published. Render
     * read-only affordances from THIS, not from a local owner_id heuristic —
     * org admins and agent editors can edit agents they do not own.
     */
    can_edit?: boolean;
    /** Component ids only. The params live in `tool_params` / GET /:id/tools. */
    tools?: string[];
    tool_params?: Record<string, Record<string, { value: unknown; fixed: boolean }>>;
}

/** A row from GET /agents/:id/tools — the fixed params often hold credentials. */
export interface AgentTool {
    componentId: string;
    params?: Record<string, unknown> | null;
}

/** A component from GET /agents/meta/components, used to name a tool id. */
export interface AgentComponent {
    id: string;
    name: string;
    description: string;
    category: string;
}

export interface AgentCategory {
    id: string;
    name: string;
    icon?: string | null;
    organization_id?: string | null;
}

/** A row from GET /agents/:id/conversations. */
export interface AgentConversationSummary {
    id: string;
    agent_id: string;
    user_id: string;
    /** Decrypted server-side; still null for a conversation that never got one. */
    title: string | null;
    project_id?: string | null;
    shared_scope?: string | null;
    pinned?: boolean;
    /** JSON string of label ids — the column is `labels_json`. */
    labels_json?: string | null;
    created_at: string;
    updated_at: string;
}

/**
 * A row from GET /agents/conversations/all — the same shape plus the joined
 * agent, and capped at 50 by the server. There is no pagination cursor, so
 * "recent" is literally all this endpoint can offer.
 */
export interface AgentConversationAcrossAgents extends AgentConversationSummary {
    agent_name: string | null;
    agent_avatar: string | null;
}

export interface AgentConversation extends AgentConversationSummary {
    messages: ChatMessage[];
    workspace_content?: string | null;
}

/**
 * What POST /agents/:id/chat/stream accepts.
 *
 * Mirrors the agent branch of agent-hub/src/hooks/useChatEngine.js — the field
 * names are the contract, and they are NOT identical to the direct-chat body:
 * `agentId` and `stream` are sent, and `modelTier` is omitted unless the user
 * deliberately overrides the model the agent was built with.
 */
export interface AgentTurnPayload {
    message: string;
    agentId: string;
    conversationId?: string;
    /** Inline base64 data URLs; there is no upload endpoint for chat attachments. */
    attachments: { name: string; type: string; size: number; content: string }[];
    stream: true;
    memoryWriteEnabled: boolean;
    webSearchEnabled: boolean;
    /** IANA zone — the server dates relative expressions with it. */
    timezone: string;
    /** Only for a brand-new conversation, or an edit/retry. */
    history?: { role: 'user' | 'assistant'; content: string }[];
    /** Overrides the agent's own configured model. Omit to use the agent's. */
    modelTier?: string;
    reasoningEffort?: string;
    projectId?: string;
}
