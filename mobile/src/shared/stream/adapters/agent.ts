/**
 * Agent chat: POST /agents/:id/chat/stream (server/core/agentRuntime/** —
 * chatStream.js, finalizeTurn.js, phaseEvents.js, guardrailsRunner.js — and
 * the shared emitters in core/dlp and core/privacy).
 *
 * The shared answer vocabulary (answer/frames.ts) minus what this runtime
 * never emits (no swarm, no `conversation_created`: the id arrives with
 * `done`), and one difference in the wire format: `content_replace` with an
 * empty payload keeps what is on screen.
 */

import { ANSWER_FRAMES } from '../answer/frames';
import { IGNORE, type FrameAdapter, type FrameData } from '../chatFrameReducer';
import {
    blockedBy,
    blockedWith,
    dlpBlocked,
    failed,
    GUARDRAIL_REASON,
    replaceTextUnlessEmpty,
    str,
    titled,
} from '../handlers';
import { emptyAnswerParts, type AnswerParts, type DlpDecision, type TurnBlock } from '../types';

export interface AgentTurn extends AnswerParts {
    text: string;
    /** Set when the server refuses on DLP/guardrail grounds. Not an error. */
    blocked: TurnBlock | null;
    dlpDecision: DlpDecision | null;
    /** Assigned by the server; arrives on `done`. */
    conversationId: string | null;
    title: string | null;
    error: string | null;
    /**
     * The server re-checked this user's access to this agent and refused.
     * Distinct from `error` because nothing the user does to the network will
     * fix it, and retrying is the wrong affordance to offer.
     */
    accessDenied: boolean;
    done: boolean;
}

export function emptyAgentTurn(): AgentTurn {
    return {
        ...emptyAnswerParts(),
        text: '',
        blocked: null,
        dlpDecision: null,
        conversationId: null,
        title: null,
        error: null,
        accessDenied: false,
        done: false,
    };
}

/**
 * A `phase` frame as one line of words — the webpage builder's status line,
 * which has no live phase panel. The runtime brackets each pre-LLM stage with
 * start/end frames; only the start is worth showing, and the end has to clear
 * the line or "Reading attachment…" stays up for the whole answer.
 */
export function phaseLabel(d: FrameData): string | null {
    if (str(d.status) === 'end') return null;
    const stage = str(d.stage);
    if (!stage) return null;
    const detail = str(d.detail);
    const pretty = stage.replace(/[-_]+/g, ' ');
    return detail ? `${pretty} — ${detail}` : pretty;
}

export const AGENT_FRAMES: FrameAdapter<AgentTurn> = {
    ...ANSWER_FRAMES,
    content_replace: replaceTextUnlessEmpty,
    content_redact: replaceTextUnlessEmpty,

    title: titled,
    title_generated: titled,

    // The runtime cut a tool that kept calling itself. The answer still
    // arrives; the user does not need to know how the sausage was made.
    tool_loop_broken: IGNORE,

    // Settles the review too: a question the server stopped waiting on is not one to leave up.
    dlp_blocked: dlpBlocked,
    guardrail_blocked: blockedBy(GUARDRAIL_REASON),
    guardrail_violation: blockedBy(GUARDRAIL_REASON),
    unicode_smuggling_detected: blockedWith({
        reason: 'Hidden characters were found in that message and it was not sent.',
    }),

    // finalizeStreamTurn's result: where an agent turn learns its id.
    done: (turn, d) => {
        turn.conversationId = str(d.conversationId) || turn.conversationId;
        turn.done = true;
        turn.thinkingActive = false;
        turn.currentPhase = null;
    },
    error: failed,

    // The heartbeat, the desktop-only surfaces (the workspace canvas) and the
    // runtime's own bookkeeping. Listed so ignoring is a decision.
    ping: IGNORE,
    workspace_update: IGNORE,
    // "A Studio document changed" (core/agentRuntime/toolRoundExecutor.js, after
    // create_presentation kept a deck): it refreshes an open document editor or
    // the Documents list on the web. The phone shows neither during a chat, and
    // the deck's link arrives in the answer itself.
    document_update: IGNORE,
    memory_extraction_failed: IGNORE,
    tools_loaded: IGNORE,
    tool_progress: IGNORE,
};
