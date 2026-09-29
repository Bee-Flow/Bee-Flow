/**
 * Thumbs on an assistant answer.
 *
 * The server has had `/api/feedback` and a `message_feedback` table since long
 * before this app existed, and the web client has had thumbs on every message
 * for just as long. The phone had neither — so every answer a mobile user
 * judged wrong was judged silently, and the operator dashboard's picture of
 * quality was a picture of desktop quality with a mobile-shaped hole in it.
 *
 * Two rules, both load-bearing:
 *
 *   1. **No `conversationSnapshot`, ever.** The POST body accepts one, and the
 *      web sends it when a user ticks "include the conversation". That field is
 *      the verbatim text of every message in the chat, stored unencrypted, on a
 *      zero-knowledge product. The phone never populates it. A rating plus the
 *      conversation id is enough for anyone reading the dashboard to find the
 *      conversation through the normal, access-controlled path; shipping the
 *      content along with the rating is a copy nobody asked for.
 *
 *   2. **The key mirrors the server's.** `saveFeedback` derives its primary key
 *      as `${conversationId||'none'}_${messageId||'none'}_${userId||'anon'}`
 *      and upserts on it, so re-rating the same message overwrites rather than
 *      appends. The local cache below is keyed the same way, minus the user
 *      (there is only one signed-in user per app), which is what makes the UI's
 *      idea of "you rated this" agree with the row that actually exists.
 *
 * The cache is in memory and NOT persisted. It exists so a rating survives a
 * FlatList unmounting the row when you scroll past it — not as a local record
 * of anything. The durable copy is the server's; a persisted one would go stale
 * the moment the same account rated the same message from a browser.
 */

import { useSyncExternalStore } from 'react';

import { api } from '../../api/client';

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

function keyFor(target: FeedbackTarget): string {
    return `${target.conversationId || 'none'}_${target.messageId}`;
}

const ratings = new Map<string, FeedbackRating>();
const listeners = new Set<() => void>();

function emit(): void {
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** The rating this session has recorded for a message, if any. */
export function useMessageRating(target: FeedbackTarget): FeedbackRating | null {
    const key = keyFor(target);
    // Returns a string or null — a primitive, so useSyncExternalStore's
    // identity check is meaningful. Returning the Map would re-render forever.
    const read = () => ratings.get(key) ?? null;
    return useSyncExternalStore(subscribe, read, read);
}

/**
 * Record a rating. Optimistic: the icon fills immediately and reverts if the
 * POST fails, because a thumbs-up that takes a network round trip to appear
 * reads as a button that did not work.
 *
 * Throws on failure so the caller can say so. Do not swallow it here — the web
 * client does (`catch { console.error }`), which is why a feedback outage there
 * looks exactly like a working one.
 */
export async function rateMessage(target: FeedbackTarget, rating: FeedbackRating): Promise<void> {
    const key = keyFor(target);
    const previous = ratings.get(key) ?? null;
    if (previous === rating) return;

    ratings.set(key, rating);
    emit();

    try {
        await api.post('/api/feedback', {
            conversationId: target.conversationId ?? null,
            messageId: target.messageId,
            agentId: target.agentId ?? null,
            agentName: target.agentName ?? null,
            rating,
            source: target.source,
            // `model` and `modelTier` are deliberately absent: the server
            // backfills both from the most recent assistant call on this
            // conversation, and it is better placed to know than we are — the
            // phone only ever sees the tier it asked for, not the model that
            // answered.
        });
    } catch (err) {
        if (previous) ratings.set(key, previous);
        else ratings.delete(key);
        emit();
        throw err;
    }
}

/** Test seam. Ratings are per app session; nothing here outlives a restart. */
export function _resetRatings(): void {
    ratings.clear();
    emit();
}
