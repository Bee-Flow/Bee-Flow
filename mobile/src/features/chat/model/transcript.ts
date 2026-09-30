/**
 * The local half of a transcript: messages added this session, ahead of the
 * server's round-trip, and how they fold back into the persisted ones.
 *
 * Shared by direct chat and agent chat, which differ only in what "the turn
 * produced nothing" means and in what survives the server catching up — both
 * passed in by the caller.
 */

import type { AnswerParts } from '@/shared/stream';

import { answerFields, type TurnAnswer } from './answer';
import type { Attachment, ChatMessage } from './types';

/** The finished turn, as far as the transcript cares. */
export type FinishedTurn = TurnAnswer & Partial<Pick<AnswerParts, 'userPrivacy'>> & { error: string | null };

/**
 * The rendered transcript: whatever the server has, minus what an edit or a
 * retry cut away (`hidden`), plus anything added locally that the server has
 * not confirmed yet. Newest first, because the list is inverted.
 *
 * Replies inside a thread (`parentId`) are left out, as the web leaves them
 * out of every chat view (DirectChatView, AgentChatView).
 */
export function mergeTranscript(
    persisted: readonly ChatMessage[],
    local: readonly ChatMessage[],
    hidden: ReadonlySet<string> = new Set(),
): ChatMessage[] {
    return chronological(persisted, local, hidden).reverse();
}

/** The same list, oldest first — what "everything before this message" is read from. */
export function chronological(
    persisted: readonly ChatMessage[],
    local: readonly ChatMessage[],
    hidden: ReadonlySet<string> = new Set(),
): ChatMessage[] {
    const shown = persisted.filter((m) => !hidden.has(m.id) && !m.parentId);
    const seen = new Set(persisted.map((m) => m.id));
    return [...shown, ...local.filter((m) => !seen.has(m.id))];
}

/** What rides along as `history`: the user and assistant turns that have text. */
export function historyOf(messages: readonly ChatMessage[]): { role: 'user' | 'assistant'; content: string }[] {
    return messages
        .filter((m): m is ChatMessage & { role: 'user' | 'assistant' } =>
            (m.role === 'user' || m.role === 'assistant') && Boolean(m.content.trim()),
        )
        .map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Cutting a transcript at a message, for an edit or a retry: everything from
 * it onward goes, and the turn is sent again with what came before.
 *
 * `override` says the server must be TOLD about the cut: a saved message is
 * among the ones removed, and the server only truncates its copy when the
 * `history` it receives is shorter than what it has (finalizeTurn.js,
 * "Retry detected"). A cut that only removes local, unsaved messages — a
 * failed last turn — needs no such thing.
 */
export function cutAt(
    visible: readonly ChatMessage[],
    persistedIds: ReadonlySet<string>,
    fromId: string,
): { before: ChatMessage[]; removed: ChatMessage[]; override: boolean } {
    const at = visible.findIndex((m) => m.id === fromId);
    if (at < 0) return { before: [...visible], removed: [], override: false };
    const removed = visible.slice(at);
    return { before: visible.slice(0, at), removed, override: removed.some((m) => persistedIds.has(m.id)) };
}

export function userMessage(id: string, text: string, attachments: Attachment[]): ChatMessage {
    return { id, role: 'user', content: text, attachments, createdAt: new Date().toISOString() };
}

/** The last saved message of what a new question is asked after — its `sentAfter`. */
export function lastSavedOf(before: readonly ChatMessage[], persistedIds: ReadonlySet<string>): string | null {
    for (let i = before.length - 1; i >= 0; i -= 1) {
        const id = before[i]?.id;
        if (id && persistedIds.has(id)) return id;
    }
    return null;
}

export function assistantPlaceholder(id: string): ChatMessage {
    return { id, role: 'assistant', content: '', streaming: true };
}

/**
 * Write the finished turn into the streaming placeholder, and what the shield
 * did to the question onto the question. `interrupted` is the caller's verdict
 * on a turn that was cut off without an error — stopped by the user, or by the
 * phone leaving the network mid-answer. Whatever words arrived stay.
 */
export function settleStreaming(
    prev: readonly ChatMessage[],
    finished: FinishedTurn,
    interrupted: boolean,
): ChatMessage[] {
    const at = prev.findIndex((m) => m.streaming);
    return prev.map((m, i) => {
        if (i === at) {
            return {
                ...m,
                ...answerFields(finished),
                streaming: false,
                content: finished.text || m.content,
                error: finished.error ?? undefined,
                interrupted: interrupted ? true : undefined,
            };
        }
        if (i === at - 1 && m.role === 'user' && finished.userPrivacy) return { ...m, privacy: finished.userPrivacy };
        return m;
    });
}

/** An attachment that could not be encoded fails its own answer, not the screen. */
export function failPlaceholder(prev: readonly ChatMessage[], placeholderId: string, message: string): ChatMessage[] {
    return prev.map((m) => (m.id === placeholderId ? { ...m, streaming: false, error: message } : m));
}
