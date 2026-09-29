/**
 * Chat endpoints.
 *
 * Paths are the FULL client-visible ones: the direct-chat router is mounted at
 * `/ai` in server/index.js, so a route declared as `/direct/conversations`
 * is reached at `/ai/direct/conversations`. Getting this wrong is the single
 * easiest mistake to make against this codebase, since the router files read
 * as if they were mounted at the root.
 *
 * Every payload is read through the allow-list in src/api/contract.ts: the
 * server's JSON arrives as `unknown` and leaves as the declared type, with a
 * missing or mistyped field degraded to a stated default.
 */

import { toKbSources } from './kbSources';
import type {
    ChatLabel,
    ChatMessage,
    Conversation,
    ConversationSummary,
    KbSource,
    SessionSkillsResponse,
} from './types';
import { api } from '../../api/client';
import { field, nullable, shapeListOf, shapeOf } from '../../api/contract';


export const chatKeys = {
    conversations: ['chat', 'conversations'] as const,
    conversation: (id: string) => ['chat', 'conversation', id] as const,
    labels: ['chat', 'labels'] as const,
    sessionSkills: (id: string) => ['chat', 'session-skills', id] as const,
};

// ── Readers ─────────────────────────────────────────────────────────

const readAttachment = shapeOf({
    id: field.optStr,
    name: field.str(''),
    mimeType: field.optStr,
    size: field.optNum,
    uri: field.optStr,
    dataUrl: field.optStr,
});

const readTool = shapeOf({
    id: field.str(''),
    name: field.str('Tool'),
    status: field.oneOf(['running', 'done', 'error'] as const, 'done'),
    detail: field.optStr,
});

const readImage = shapeOf({
    data: field.str(''),
    mimeType: field.str('image/png'),
});

function sources(value: unknown): KbSource[] | undefined {
    return Array.isArray(value) ? toKbSources(value) : undefined;
}

/**
 * One persisted message. `streaming` and `interrupted` are client-side state
 * and never arrive from the server, so they are not in the spec.
 */
export const readMessage: (raw: unknown) => ChatMessage = shapeOf({
    id: field.str(''),
    role: field.oneOf(['user', 'assistant', 'system', 'tool'] as const, 'assistant'),
    content: field.str(''),
    attachments: field.optList(readAttachment),
    createdAt: field.optStr,
    thinking: field.optStr,
    tools: field.optList(readTool),
    sources,
    images: field.optList(readImage),
    error: field.optStr,
});

const summarySpec = {
    id: field.str(''),
    title: field.strOrNull,
    model_tier: field.strOrNull,
    project_id: field.strOrNull,
    shared_scope: field.strOrNull,
    pinned: field.optBool,
    labels_json: field.strOrNull,
    created_at: field.str(''),
    updated_at: field.str(''),
};
const readSummaryRows: (raw: unknown) => ConversationSummary[] = shapeListOf(summarySpec);
const readConversation: (raw: unknown) => Conversation = shapeOf({
    ...summarySpec,
    messages: field.list(readMessage),
    workspace_content: field.strOrNull,
});

const labelSpec = {
    id: field.str(''),
    name: field.str('Label'),
    color: field.strOrNull,
};
const readLabel: (raw: unknown) => ChatLabel = shapeOf(labelSpec);
const readLabelRows: (raw: unknown) => ChatLabel[] = shapeListOf(labelSpec);

const readSessionSkills: (raw: unknown) => SessionSkillsResponse = shapeOf({
    skills: field.list(
        shapeOf({
            id: field.str(''),
            name: field.str('Skill'),
            description: field.optStr,
            instructions: field.optStr,
            workflow: field.optStr,
        }),
    ),
    activatedSkillIds: field.strArray,
    modelTier: field.str(''),
});

/** Rows without an id have no screen to open and no key to render under. */
function withId<T extends { id: string }>(rows: T[]): T[] {
    return rows.filter((row) => row.id !== '');
}

// ── Conversations ───────────────────────────────────────────────────

export async function listConversations(signal?: AbortSignal): Promise<ConversationSummary[]> {
    return withId(readSummaryRows(await api.get<unknown>('/ai/direct/conversations', { signal })));
}

export async function getConversation(id: string, signal?: AbortSignal): Promise<Conversation | null> {
    return nullable(readConversation)(
        await api.get<unknown>(`/ai/direct/conversations/${encodeURIComponent(id)}`, { signal }),
    );
}

/** Rename, pin, relabel, move to a project — all one PATCH. */
export async function updateConversation(
    id: string,
    patch: Partial<Pick<ConversationSummary, 'title' | 'pinned' | 'project_id'>> & {
        labels?: string[];
    },
): Promise<void> {
    await api.patch(`/ai/direct/conversations/${encodeURIComponent(id)}`, patch);
}

export async function deleteConversation(id: string): Promise<void> {
    await api.delete(`/ai/direct/conversations/${encodeURIComponent(id)}`);
}

// ── Labels ──────────────────────────────────────────────────────────

export async function listLabels(signal?: AbortSignal): Promise<ChatLabel[]> {
    return withId(readLabelRows(await api.get<unknown>('/ai/labels', { signal })));
}

export async function createLabel(name: string, color?: string): Promise<ChatLabel | null> {
    return nullable(readLabel)(await api.post<unknown>('/ai/labels', { name, color }));
}

export async function updateLabel(id: string, patch: Partial<ChatLabel>): Promise<void> {
    await api.patch(`/ai/labels/${encodeURIComponent(id)}`, patch);
}

export async function deleteLabel(id: string): Promise<void> {
    await api.delete(`/ai/labels/${encodeURIComponent(id)}`);
}

// ── Projects ────────────────────────────────────────────────────────
// Moving a chat into a project is NOT part of the conversation PATCH — that
// route does not read `project_id`, and sending it looks like it worked.
// Filing goes through the projects router instead.

/**
 * File this conversation into a project.
 *
 * `type` distinguishes the two conversation tables; a direct chat is
 * 'direct'. The route requires `editor` on the target project, so a 403 here
 * is a permission answer worth showing verbatim rather than a bug.
 */
export async function assignToProject(projectId: string, conversationId: string): Promise<void> {
    await api.put(`/api/projects/${encodeURIComponent(projectId)}/conversations`, {
        assign: [{ id: conversationId, type: 'direct' }],
    });
}

/**
 * Take it back out. Deliberately NOT the unassign half of the route above:
 * this one is scoped to the caller's own conversations and needs no project
 * role, so someone removed from a project can still unfile their own chat.
 */
export async function detachFromProject(conversationId: string): Promise<void> {
    await api.delete(`/api/projects/conversations/${encodeURIComponent(conversationId)}`, {
        query: { type: 'direct' },
    });
}

// ── Session skills (server/core/tools/sessionSkillRuntime.js) ───────

export async function getSessionSkills(
    id: string,
    signal?: AbortSignal,
): Promise<SessionSkillsResponse | null> {
    return nullable(readSessionSkills)(
        await api.get<unknown>(`/ai/direct/conversations/${encodeURIComponent(id)}/session-skills`, {
            signal,
        }),
    );
}

export async function regenerateSessionSkills(id: string): Promise<void> {
    await api.post(
        `/ai/direct/conversations/${encodeURIComponent(id)}/session-skills/regenerate`,
        { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        // Regeneration runs a model call; the default 30s deadline is not
        // enough and a retry would run it twice.
        { timeoutMs: 90_000, retry: false },
    );
}

export async function removeSessionSkill(id: string, skillId: string): Promise<void> {
    await api.delete(
        `/ai/direct/conversations/${encodeURIComponent(id)}/session-skills/${encodeURIComponent(skillId)}`,
    );
}

/**
 * Parse the `labels_json` column, which is a JSON string on the wire.
 * Returns an empty array for null, malformed JSON or a non-array — a bad
 * label blob must not take a conversation row out of the list.
 */
export function parseLabels(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
        return [];
    }
}
