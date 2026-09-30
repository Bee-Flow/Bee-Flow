/**
 * The answer to a data-loss-prevention question, for any chat runtime.
 *
 * The decision endpoint is shared by every runtime — mounted at
 * /api/chat/dlp-decision (server/index.js) and keyed by decisionId, not by
 * which stream raised it — so direct chat and agents answer the same way.
 */

import { ApiError } from '@/core/api/client';
import { translate } from '@/core/i18n';
import type { DlpDecision } from '@/shared/stream';

import { postDlpDecision } from '../api/endpoints';

export type DlpChoice = 'allow' | 'redact' | 'block';

/** The slice of a turn stream this needs: read the pending question, clear it. */
interface DlpStream {
    current: () => { dlpDecision: DlpDecision | null };
    update: (change: (turn: { dlpDecision: DlpDecision | null }) => void) => void;
}

/** A span the person marked in the review, which the server redacts exactly. */
export interface DlpMark {
    offset: number;
    length: number;
}

/**
 * The server no longer holds the question. decisionQueue.js keeps one for
 * about 60 seconds and treats silence as a block (fail-closed), so by the
 * time this is thrown nothing was sent — whatever the person chose.
 */
export class DlpQuestionExpired extends Error {
    constructor() {
        super(
            translate(
                'mobile.chat.dlp_expired',
                'This privacy check had already expired, so nothing was sent. Send your message again to be asked anew.',
            ),
        );
        this.name = 'DlpQuestionExpired';
    }
}

/**
 * Answer the pending question; resolves once the server has it. Throws
 * DlpQuestionExpired (the question is gone from the turn by then) when the
 * server no longer knows it, and the request's own error for anything else.
 */
export type DlpResolver = (choice: DlpChoice, rememberForConversation?: boolean, marks?: readonly DlpMark[]) => Promise<void>;

export function dlpResolverFor(stream: DlpStream): DlpResolver {
    return async (choice, rememberForConversation = false, marks = []) => {
        const pending = stream.current().dlpDecision;
        if (!pending) return;
        const drop = () =>
            stream.update((turn) => {
                if (turn.dlpDecision?.decisionId === pending.decisionId) turn.dlpDecision = null;
            });
        try {
            // Posted BEFORE the question is cleared, as the web does: a decision
            // the server refused for a passing reason (offline, a 5xx) must leave
            // the review up with its error, so the person can answer again.
            await postDlpDecision(pending.decisionId, choice, rememberForConversation, marks);
        } catch (err) {
            // A 404 is final ("not found, expired, or not owned"): no answer will
            // ever be accepted, so the review goes rather than trapping them.
            if (!(err instanceof ApiError && err.status === 404)) throw err;
            drop();
            throw new DlpQuestionExpired();
        }
        drop();
    };
}
