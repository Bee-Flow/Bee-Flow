/**
 * Contract readers for every agent response: the server's JSON arrives as
 * `unknown` and leaves as the declared type, through the allow-list in
 * src/core/api/contract.ts, with a missing or mistyped field degraded to a
 * stated default.
 */

import { field, shapeListOf, shapeOf } from '@/core/api/contract';
import { readMessage, type ChatMessage } from '@/features/chat';

import type {
    Agent,
    AgentCategory,
    AgentComponent,
    AgentConfig,
    AgentConversation,
    AgentConversationAcrossAgents,
    AgentConversationSummary,
    AgentTool,
} from '../model/types';

/** `starter_prompts` is a JSON string on most routes and a parsed array on
 *  one; both are kept as they arrive for parseStarterPrompts. */
function starterPrompts(value: unknown): string | string[] | null {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
    return null;
}

export const agentSpec = {
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
export const readAgent: (raw: unknown) => Agent = shapeOf(agentSpec);
export const readAgentRows: (raw: unknown) => Agent[] = shapeListOf(agentSpec);

export const readToolRows: (raw: unknown) => AgentTool[] = shapeListOf({
    componentId: field.str(''),
    params: field.recordOrNull,
});

export const readComponentRows: (raw: unknown) => AgentComponent[] = shapeListOf({
    id: field.str(''),
    name: field.str(''),
    description: field.str(''),
    category: field.str(''),
});

export const readCategoryRows: (raw: unknown) => AgentCategory[] = shapeListOf({
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
export const readConversationRows: (raw: unknown) => AgentConversationSummary[] = shapeListOf(conversationSpec);
export const readConversationAcrossAgentsRows: (raw: unknown) => AgentConversationAcrossAgents[] = shapeListOf({
    ...conversationSpec,
    agent_name: field.strOrNull,
    agent_avatar: field.strOrNull,
});

/**
 * Messages are chat's own shape, read by chat's reader. Called per value, not
 * bound at load: chat and agents import each other's public surface, and a
 * reader captured while chat is still loading would be `undefined`.
 */
function messages(value: unknown): ChatMessage[] {
    return Array.isArray(value) ? value.map((raw) => readMessage(raw)) : [];
}

export const readConversation: (raw: unknown) => AgentConversation = shapeOf({
    ...conversationSpec,
    messages,
    workspace_content: field.strOrNull,
});

