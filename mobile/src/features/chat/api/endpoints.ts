/**
 * Chat endpoints: one function per server call, returning validated data.
 *
 * Paths are the FULL client-visible ones: the direct-chat router is mounted at
 * `/ai` in server/index.js, so a route declared as `/direct/conversations`
 * is reached at `/ai/direct/conversations`. Getting this wrong is the single
 * easiest mistake to make against this codebase, since the router files read
 * as if they were mounted at the root.
 */

import { api } from '@/core/api/client';
import { field, nullable, pick } from '@/core/api/contract';
import { withId } from '@/shared/lib/withId';

import {
    readConversation,
    readLabel,
    readLabelRows,
    readSessionSkills,
    readSummaryRows,
    readTierMap,
} from './readers';
import type { FeedbackRating, FeedbackTarget } from '../model/feedback';
import type { TierMap } from '../model/tiers';
import type { ChatLabel, Conversation, ConversationSummary, SessionSkillsResponse } from '../model/types';

// ── Conversations ───────────────────────────────────────────────────

export async function listConversations(signal?: AbortSignal): Promise<ConversationSummary[]> {
    return withId(readSummaryRows(await api.get<unknown>('/ai/direct/conversations', { signal })));
}

export async function getConversation(id: string, signal?: AbortSignal): Promise<Conversation | null> {
    return nullable(readConversation)(
        await api.get<unknown>(`/ai/direct/conversations/${encodeURIComponent(id)}`, { signal }),
    );
}

/**
 * Rename, pin, relabel, attach knowledge bases — all one PATCH.
 *
 * Exactly the keys `ConversationPatch` accepts
 * (routes/ai/directChat/conversationRoutes.js). That schema is `.strict()`, so
 * any other key — `project_id` used to be allowed here — is a 400, not a no-op.
 */
export async function updateConversation(
    id: string,
    patch: { title?: string; pinned?: boolean; labels?: string[]; knowledgeBaseIds?: string[] },
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

/** `LabelPatch` (same file) is strict too: a name, a colour, nothing else. */
export async function updateLabel(id: string, patch: { name?: string; color?: string }): Promise<void> {
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

// ── Tiers and the DLP side channel ──────────────────────────────────

/** The tiers this user may pick for a task, from /ai/config/tiers-for-user. */
export async function fetchTiers(taskType = 'direct_chat', signal?: AbortSignal): Promise<TierMap> {
    return readTierMap(await api.get<unknown>('/ai/config/tiers-for-user', { query: { taskType }, signal }));
}

/**
 * Answer a data-loss-prevention question. Shared by every chat runtime and
 * keyed by decisionId; the answer arrives back on the still-open stream.
 */
export async function postDlpDecision(
    decisionId: string,
    choice: 'allow' | 'redact' | 'block',
    rememberForConversation: boolean,
    manualAdditions: readonly { offset: number; length: number }[] = [],
): Promise<void> {
    await api.post(
        '/api/chat/dlp-decision',
        {
            decisionId,
            choice,
            rememberForConversation,
            // Marks the person added in the review — the server redacts
            // exactly these, and only on `redact`.
            ...(choice === 'redact' && manualAdditions.length
                ? { manualAdditions: manualAdditions.map(({ offset, length }) => ({ offset, length })) }
                : {}),
        },
        { retry: false },
    );
}

// ── Feedback ────────────────────────────────────────────────────────

/** One message as the feedback snapshot carries it (the web's shape). */
export interface SnapshotMessage {
    id: string | null;
    role: string;
    content: string;
    timestamp?: string;
    /** The model that answered, so an admin sees a switch mid-conversation. */
    model: string | null;
}

/**
 * File a thumbs up or down (hooks/ratings.ts calls this optimistically), and
 * the follow-up with a comment.
 *
 * `conversationSnapshot` is sent ONLY when the person ticked "Include
 * conversation" on that follow-up, as on the web: it is the verbatim text of
 * every message, stored with the feedback outside the conversation's
 * encryption, so it never rides along on a bare thumb.
 */
export async function postFeedback(
    target: FeedbackTarget,
    rating: FeedbackRating,
    extra: { comment?: string; conversationSnapshot?: SnapshotMessage[] } = {},
): Promise<void> {
    await api.post('/api/feedback', {
        conversationId: target.conversationId ?? null,
        messageId: target.messageId,
        agentId: target.agentId ?? null,
        agentName: target.agentName ?? null,
        rating,
        source: target.source,
        ...(extra.comment ? { comment: extra.comment } : {}),
        ...(extra.conversationSnapshot?.length ? { conversationSnapshot: extra.conversationSnapshot } : {}),
        // `model` and `modelTier` are deliberately absent: the server
        // backfills both from the most recent assistant call on this
        // conversation, and it is better placed to know than we are.
    });
}

// ── Knowledge bases on a conversation ───────────────────────────────

/**
 * Attach exactly `ids` (the web's saveAttachedKnowledgeBases). The server
 * answers with what it STORED — deduplicated and re-authorised — and that is
 * what the composer shows; a 400 names the ids it refused (`invalid`).
 */
export async function saveConversationKnowledgeBases(id: string, ids: readonly string[]): Promise<string[]> {
    const res = await api.patch<unknown>(`/ai/direct/conversations/${encodeURIComponent(id)}`, { knowledgeBaseIds: [...ids] });
    return field.strArray(pick(res, 'knowledgeBaseIds'));
}

// ── Sharing into a project thread ───────────────────────────────────

/**
 * Share a conversation into the project it is filed in — or stop. This
 * RE-ENCRYPTS the messages to a project key, so only the owner can do it
 * (routes/projects.js: 403 not the owner, 503 no project key).
 */
export async function shareToProject(projectId: string, conversationId: string): Promise<void> {
    await api.post(`/api/projects/${encodeURIComponent(projectId)}/threads`, { conversationId, type: 'direct' }, { retry: false });
}

export async function unshareFromProject(projectId: string, conversationId: string): Promise<void> {
    await api.delete(`/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(conversationId)}`, {
        query: { type: 'direct' },
    });
}
