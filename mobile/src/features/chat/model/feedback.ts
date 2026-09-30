/**
 * Thumbs on an assistant answer: what a rating is filed against, and the key
 * it is remembered under.
 *
 * The server has had `/api/feedback` and a `message_feedback` table since long
 * before this app existed, and the web client has had thumbs on every message
 * for just as long. The phone had neither, so the operator dashboard's picture
 * of quality was a picture of desktop quality with a mobile-shaped hole in it.
 *
 * The POST is api/endpoints.ts (postFeedback, which sends the conversation
 * only when the person ticks "Include conversation"); the session's ratings
 * are hooks/ratings.ts.
 */

import type { ChatMessage } from './types';

export type FeedbackRating = 'up' | 'down';

export interface FeedbackTarget {
    /** Null for a surface with no persisted conversation (the server allows it). */
    conversationId?: string | null;
    messageId: string;
    agentId?: string | null;
    agentName?: string | null;
    /**
     * Where the answer came from. The web sends 'direct' or 'agent' and the
     * dashboard groups on it, so those are the two strings to use; the server
     * defaults to 'agent' when it is missing, which would quietly file every
     * direct chat under the agents tab.
     */
    source: 'direct' | 'agent';
}

/**
 * The key mirrors the server's. `saveFeedback` derives its primary key as
 * `${conversationId||'none'}_${messageId||'none'}_${userId||'anon'}` and
 * upserts on it, so re-rating overwrites. This is the same key minus the user
 * (one signed-in user per app), which is what makes the UI's idea of "you
 * rated this" agree with the row that actually exists.
 */
export function feedbackKey(target: FeedbackTarget): string {
    return `${target.conversationId || 'none'}_${target.messageId}`;
}

/**
 * The conversation as "Include conversation" sends it with a rating (the
 * web's conversationSnapshot): what was said, by whom, when, and which model
 * answered. Opt-in per rating, and only to this workspace's own server.
 */
export function conversationSnapshot(messages: readonly ChatMessage[]): {
    id: string | null;
    role: string;
    content: string;
    timestamp?: string;
    model: string | null;
}[] {
    return messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ id: m.id || null, role: m.role, content: m.content, timestamp: m.createdAt, model: m.modelId ?? null }));
}
