/**
 * Trying a failed turn again.
 *
 * Two small decisions, kept out of the chat screen so they can be tested
 * without rendering it:
 *
 *   - which words to send again: the user message the failed answer replied to;
 *   - which local messages outlive the refetch that follows every turn.
 *
 * The second is why "Try again" was never wired. The screen drops its local
 * copies as soon as the server's transcript lands, because those copies can
 * never be matched by id. But a turn that FAILED is usually not in that
 * transcript — the server saves a turn once, at the end — so the error and
 * the button under it disappeared a moment after they appeared.
 */

import type { ChatMessage } from './types';

/** The user message `failedId` answered, searching back from it in a chronological transcript. */
export function promptFor(transcript: readonly ChatMessage[], failedId: string): ChatMessage | null {
    const at = transcript.findIndex((m) => m.id === failedId);
    for (let i = at - 1; i >= 0; i -= 1) {
        const message = transcript[i];
        if (message?.role === 'user') return message;
    }
    return null;
}

/**
 * The local messages to keep once the server's transcript has arrived: a
 * failed or cut-off LAST turn, and nothing else.
 *
 * A failed turn: the user's half is dropped when the saved transcript ends
 * with this very turn. The server does save a turn that died after a
 * side-effecting tool had run (routes/ai/directChat/interruptedTurn.js),
 * always as the same words followed by an assistant row marked
 * `interrupted`, and showing that message twice would be a bug of its own.
 * Matching the words alone is not enough: "continue" asked twice would find
 * the first, answered one.
 *
 * A cut-off turn (Stop, or a socket closed before `done`): the question and
 * whatever words arrived stay, marked stopped, until the server's copy has the
 * question. Most providers save nothing for a stopped turn; some finish the
 * answer anyway and save all of it later — and then the saved copy, the whole
 * answer, replaces the local half.
 *
 * A cut-off edit or retry of SAVED messages is the exception: it goes. The
 * server truncates its copy only when it finishes the turn, so the messages
 * the edit meant to replace are still saved, and they come back — the edit
 * kept after them would be out of place, and its retry an ordinary new turn.
 */
export function unsavedFailure(
    local: readonly ChatMessage[],
    persisted: readonly ChatMessage[],
): ChatMessage[] {
    const failed = local[local.length - 1];
    if (!failed?.error && !failed?.interrupted) return [];
    const prompt = local[local.length - 2];
    if (prompt?.role !== 'user') return [failed];
    if (!failed.error) return stoppedTurnGoes(persisted, prompt) ? [] : [prompt, failed];
    const savedAnswer = persisted[persisted.length - 1];
    const savedPrompt = persisted[persisted.length - 2];
    const saved =
        savedAnswer?.role === 'assistant' &&
        savedAnswer.interrupted === true &&
        savedPrompt?.role === 'user' &&
        savedPrompt.content === prompt.content;
    return saved ? [failed] : [prompt, failed];
}

/** Whether a cut-off turn goes: it replaced saved messages, or the server has it now. */
function stoppedTurnGoes(persisted: readonly ChatMessage[], prompt: ChatMessage): boolean {
    return Boolean(prompt.replaces) || savedSince(persisted, prompt);
}

/**
 * Whether the saved transcript has this question: the same words, asked after
 * the saved message the question itself was asked after (`sentAfter`), so an
 * earlier "yes" is not mistaken for this one.
 */
function savedSince(persisted: readonly ChatMessage[], prompt: ChatMessage): boolean {
    const anchor = prompt.sentAfter ? persisted.findIndex((m) => m.id === prompt.sentAfter) : -1;
    const words = prompt.content.trim();
    return persisted.slice(anchor + 1).some((m) => m.role === 'user' && !m.parentId && m.content.trim() === words);
}

/**
 * The tiers "Retry with model" offers, in the web's order (RETRY_KEYS in
 * MessageActionsRow.jsx): Auto always, the others only when configured with
 * a model — a retry on an empty tier would fail the turn.
 */
export const RETRY_TIER_KEYS = ['auto', 'fast', 'thinking', 'writer', 'pro'] as const;

export function retryTiers(map: Readonly<Record<string, { modelId?: string }>>): string[] {
    return RETRY_TIER_KEYS.filter((key) => key === 'auto' || Boolean(map[key]?.modelId));
}
