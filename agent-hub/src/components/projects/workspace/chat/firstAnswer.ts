// What the AI said about the FIRST message of a new team chat. The create call
// answers it, but the form that made the call navigates away and unmounts; the
// chat it opens picks the answer up here, once, so the "limit reached" or
// "could not answer" notice and the "answering…" line are not lost.

import type { TeamChatAiResult } from '../../../../api/queries/projectChatTypes';
import { mentions } from './mentions';

export interface FirstAnswer { ai: TeamChatAiResult; askedAi: boolean }

/** A chat is opened within moments of being created; anything older is not for it. */
const TTL_MS = 30_000;

const held = new Map<string, FirstAnswer & { at: number }>();

export function rememberFirstAnswer(chatId: string, ai: TeamChatAiResult | null | undefined, message: string | undefined, now = Date.now()): void {
    if (!ai) return;
    held.set(chatId, { ai, askedAi: mentions(message || '', 'ai'), at: now });
}

/** The answer kept for this chat, removed on the way out. */
export function takeFirstAnswer(chatId: string, now = Date.now()): FirstAnswer | null {
    const hit = held.get(chatId);
    held.delete(chatId);
    return hit && now - hit.at <= TTL_MS ? { ai: hit.ai, askedAi: hit.askedAi } : null;
}
