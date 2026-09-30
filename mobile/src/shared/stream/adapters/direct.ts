/**
 * Direct chat: POST /ai/chat/direct/stream (server/routes/ai/directChat/
 * streamTurn.js). The richest surface — it is the only one with a swarm, a
 * `running` label and a `turn_busy` refusal. Everything an answer carries
 * besides that comes from the shared answer table (answer/frames.ts).
 */

import { ANSWER_FRAMES } from '../answer/frames';
import { IGNORE, type FrameAdapter } from '../chatFrameReducer';
import {
    blockedBy,
    conversationCreated,
    dlpBlocked,
    failed,
    GUARDRAIL_REASON,
    replaceText,
    replaceTextUnlessEmpty,
    str,
    titled,
} from '../handlers';
import { emptyAnswerParts, type AnswerParts, type DlpDecision, type SwarmProgress, type TurnBlock } from '../types';
import { SWARM_FRAMES } from './swarm';

/**
 * The live state of one direct-chat turn.
 *
 * Kept separate from the persisted message so the in-flight turn can update
 * many times a second without touching the message list — the whole list
 * would otherwise re-render on every token.
 */
export interface StreamingTurn extends AnswerParts {
    text: string;
    /** Set when the server refuses on DLP/guardrail grounds. */
    blocked: TurnBlock | null;
    /**
     * A data-loss-prevention decision the server is BLOCKED on, waiting for a
     * human answer. The stream does not advance until the app POSTs to
     * /api/chat/dlp-decision — a client that ignores this appears to hang
     * forever with no error, which is exactly what the first version did.
     */
    dlpDecision: DlpDecision | null;
    /** Live swarm progress; only ever populated on a `swarm` tier turn. */
    swarm: SwarmProgress | null;
    /** The server assigns this mid-stream via `conversation_created`. */
    conversationId: string | null;
    /** Auto-generated title, arriving on the `title` event. */
    title: string | null;
    error: string | null;
    done: boolean;
    /**
     * The server said `done`. Not the same as `done`, which the runner also
     * sets when the person stops or the socket closes first: a turn that
     * ended without this was cut off, whatever words it had by then.
     */
    completed: boolean;
}

export function emptyStreamingTurn(): StreamingTurn {
    return {
        ...emptyAnswerParts(),
        text: '',
        blocked: null,
        dlpDecision: null,
        swarm: null,
        conversationId: null,
        title: null,
        error: null,
        done: false,
        completed: false,
    };
}

export const DIRECT_FRAMES: FrameAdapter<StreamingTurn> = {
    ...ANSWER_FRAMES,
    content_replace: replaceText,
    content_redact: replaceTextUnlessEmpty,

    running: (turn, d) => {
        const label = str(d.label);
        if (!label) return false;
        turn.currentPhase = { stage: label, detail: null, startedAt: Date.now() };
    },
    conversation_created: conversationCreated,
    title: titled,
    title_generated: titled,

    // Announces which tool groups are available this turn. Useful on a
    // desktop side panel, noise on a phone.
    tools_loaded: IGNORE,

    ...SWARM_FRAMES,

    // Settles the review too: a question the server stopped waiting on is not one to leave up.
    dlp_blocked: dlpBlocked,
    guardrail_blocked: blockedBy(GUARDRAIL_REASON),
    guardrail_violation: blockedBy(GUARDRAIL_REASON),
    history_locked: (turn) => {
        turn.historyLocked = true;
        turn.blocked = { reason: 'This conversation is read-only for you.' };
    },

    done: (turn, d) => {
        turn.conversationId = str(d.conversationId) || turn.conversationId;
        turn.done = true;
        turn.completed = true;
        turn.thinkingActive = false;
        turn.currentPhase = null;
    },
    error: failed,
    turn_busy: (turn) => {
        turn.error = 'Another answer is already running in this conversation.';
        turn.done = true;
    },

    // The heartbeat, and the events whose whole purpose is to drive a
    // desktop-only surface. Listed so "we ignore this" is a decision.
    ping: IGNORE,
    tool_progress: IGNORE,
    token_savings: IGNORE,
    document_truncated: IGNORE,
    session_skills_bootstrap_started: IGNORE,
    session_skills_bootstrapped: IGNORE,
    session_skills_updated: IGNORE,
    session_skill_completed: IGNORE,
    stage_model_swapped: IGNORE,
};
