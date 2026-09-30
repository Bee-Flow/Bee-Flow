/**
 * The meeting assistant: a throwaway direct-chat turn whose system prompt is
 * one transcript (features/recording MeetingChatSheet). It draws the answer
 * and nothing else, so it acts on the answer and the ways a turn ends; every
 * other frame is left alone and, on this surface, not reported.
 */

import type { FrameAdapter } from '../chatFrameReducer';
import { failed, replaceText, str } from '../handlers';
import type { TurnBase } from '../types';

export interface MeetingTurn extends TurnBase {
    text: string;
}

export function emptyMeetingTurn(): MeetingTurn {
    return { text: '', error: null, done: false };
}

/** A refusal ends this turn as an error: the sheet has no separate refusal UI. */
const refused = (turn: MeetingTurn) => {
    turn.error = 'That answer was stopped by your organisation’s privacy rules.';
};

export const MEETING_FRAMES: FrameAdapter<MeetingTurn> = {
    content: (turn, d) => {
        const chunk = str(d.text);
        if (!chunk) return false;
        turn.text += chunk;
    },
    // The privacy shield rewrites text already sent. It has to REPLACE, or the
    // unredacted version stays on screen underneath the corrected one.
    content_replace: replaceText,
    content_redact: replaceText,
    error: failed,
    dlp_blocked: refused,
    guardrail_blocked: refused,
    done: (turn) => {
        turn.done = true;
    },
};
