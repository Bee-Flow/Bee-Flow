/**
 * What a message needs from its neighbours, derived once for the list: a
 * cell renders one message and cannot look along the transcript.
 *
 *   A QUESTION the shield changed gets its turn's token map, which lands on
 *   the ANSWER — that is what lets its privacy line name the placeholders
 *   (the web's findTurnTokenMap look-ahead in MessageItem).
 *
 *   An ANSWER with privacy details gets the words of its question, which
 *   its privacy sheet shows as "Original message".
 *
 * Every other message keeps its identity, so the memoised cells of a long
 * transcript do not re-render because one question changed.
 */

import { hasPrivacyInfo } from './answer';
import { findTurnTokenMap } from './privacyLine';
import type { ChatMessage } from './types';

/** How many values the shield replaced in a question — DLP and the older PII path, whichever is larger. */
export function privacyCount(message: ChatMessage): number {
    const privacy = message.privacy;
    return privacy ? Math.max(privacy.tokenizedCount || 0, privacy.dlpRedactedCount || 0) : 0;
}

function questionBefore(chronological: readonly ChatMessage[], at: number): string | undefined {
    for (let i = at - 1; i >= 0; i -= 1) {
        const m = chronological[i];
        if (m?.role === 'user') return m.content;
    }
    return undefined;
}

/** `newestFirst` in, newest first out, with the context added where it is used. */
export function withTurnContext(newestFirst: readonly ChatMessage[]): ChatMessage[] {
    const chronological = [...newestFirst].reverse();
    return chronological
        .map((m, i) => {
            if (m.role === 'user' && privacyCount(m) > 0) {
                return { ...m, turnTokenMap: findTurnTokenMap(chronological, i) };
            }
            if (m.role === 'assistant' && !m.streaming && hasPrivacyInfo(m)) {
                return { ...m, questionText: questionBefore(chronological, i) ?? '' };
            }
            return m;
        })
        .reverse();
}
