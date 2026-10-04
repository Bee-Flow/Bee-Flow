// Unsent message text, kept in memory per user and chat (or thread) so that
// leaving the chat to look at a tagged document, or opening another thread,
// does not throw away what somebody was writing. Memory only, never stored:
// a reload or a sign-out forgets it, and another user of the same tab never
// sees it (the key carries the user id).

import type { MentionCandidate } from './mentions';

export interface Draft { text: string; picked: MentionCandidate[] }

const MAX_DRAFTS = 50;
const held = new Map<string, Draft>();

export const draftKey = (userId: string | null | undefined, chatId: string, threadId?: string | null): string =>
    `${userId || ''}|${chatId}|${threadId || ''}`;

export function readDraft(key: string | undefined): Draft | null {
    return (key && held.get(key)) || null;
}

/** An empty text removes the draft. */
export function writeDraft(key: string | undefined, draft: Draft): void {
    if (!key) return;
    held.delete(key);
    if (!draft.text.trim()) return;
    held.set(key, draft);
    // Oldest first: a Map iterates in insertion order.
    while (held.size > MAX_DRAFTS) held.delete(held.keys().next().value as string);
}

export function clearDrafts(): void {
    held.clear();
}
