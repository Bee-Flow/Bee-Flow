/**
 * The ratings this app session has recorded, and the one call that records one.
 *
 * In memory and NOT persisted. It exists so a rating survives a FlatList
 * unmounting the row when you scroll past it, not as a local record of
 * anything. The durable copy is the server's; a persisted one would go stale
 * the moment the same account rated the same message from a browser.
 */

import { useSyncExternalStore } from 'react';

import { postFeedback } from '../api/endpoints';
import { conversationSnapshot, feedbackKey, type FeedbackRating, type FeedbackTarget } from '../model/feedback';
import type { ChatMessage } from '../model/types';

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
    const key = feedbackKey(target);
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
    const key = feedbackKey(target);
    const previous = ratings.get(key) ?? null;
    if (previous === rating) return;

    ratings.set(key, rating);
    emit();

    try {
        await postFeedback(target, rating);
    } catch (err) {
        if (previous) ratings.set(key, previous);
        else ratings.delete(key);
        emit();
        throw err;
    }
}

/**
 * The follow-up to a rating: a comment and, when the person ticked it, the
 * conversation. Not optimistic — the thumb is already filled — so a failure
 * is simply reported to the caller.
 */
export async function sendFeedbackDetail(
    target: FeedbackTarget,
    rating: FeedbackRating,
    detail: { comment?: string; conversation?: readonly ChatMessage[] },
): Promise<void> {
    await postFeedback(target, rating, {
        comment: detail.comment?.trim() || undefined,
        conversationSnapshot: detail.conversation ? conversationSnapshot(detail.conversation) : undefined,
    });
}

/** Test seam. Ratings are per app session; nothing here outlives a restart. */
export function _resetRatings(): void {
    ratings.clear();
    emit();
}
