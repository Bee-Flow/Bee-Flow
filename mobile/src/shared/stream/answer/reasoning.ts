/**
 * What an answer is doing before and between its words: the model's timed
 * thinking parts and the phases of the turn — the web's `thinking*` and
 * `phase` cases in agent-hub/src/hooks/useChatEngine/sseEvents.ts, folded
 * into the live turn instead of into a message list.
 */

import type { FrameHandler } from '../chatFrameReducer';
import { str } from '../handlers';
import { appendPhase } from '../phaseTrail';
import type { AnswerParts, ThinkingPart } from '../types';

type Reasoning = Pick<
    AnswerParts,
    'thinking' | 'thinkingActive' | 'thinkingParts' | 'thinkingStartedAt' | 'thinkingEndedAt'
>;

/** A part opens with its id; a second start for the same id changes nothing. */
export const thinkingPartStarted: FrameHandler<Reasoning> = (turn, d) => {
    turn.thinkingActive = true;
    const partId = str(d.partId);
    if (!partId || turn.thinkingParts.some((p) => p.id === partId)) return;
    const now = Date.now();
    turn.thinkingParts = [
        ...turn.thinkingParts,
        { id: partId, text: '', startedAt: now, endedAt: null, redacted: d.redacted === true },
    ];
    turn.thinkingStartedAt ??= now;
};

/**
 * A delta. It lands in its own part, else — with no part id — in the last
 * part that is still open, else in a new one (the web's rule). The flat
 * `thinking` text grows alongside for the surfaces that show one block.
 * Direct chat and agents send the delta as `text` or, on some paths, `thinking`.
 */
export const thinkingDelta: FrameHandler<Reasoning> = (turn, d) => {
    const delta = str(d.text) || str(d.thinking);
    if (!delta) return false;
    const now = Date.now();
    const partId = str(d.partId);
    const parts = turn.thinkingParts.slice();
    let at = partId ? parts.findIndex((p) => p.id === partId) : -1;
    if (at === -1) {
        const last = parts.length - 1;
        if (!partId && last >= 0 && !parts[last]?.endedAt) {
            at = last;
        } else {
            parts.push({ id: partId || `auto-${parts.length}`, text: '', startedAt: now, endedAt: null });
            at = parts.length - 1;
        }
    }
    const part = parts[at] as ThinkingPart;
    parts[at] = { ...part, text: part.text + delta };
    turn.thinkingParts = parts;
    turn.thinking += delta;
    turn.thinkingActive = true;
    turn.thinkingStartedAt ??= now;
};

/** A part closes, timed; a redaction learned at the end sticks. */
export const thinkingPartStopped: FrameHandler<Reasoning> = (turn, d) => {
    turn.thinkingActive = false;
    const partId = str(d.partId);
    if (!partId) return;
    const now = Date.now();
    turn.thinkingParts = turn.thinkingParts.map((p) =>
        p.id === partId ? { ...p, endedAt: now, redacted: p.redacted || d.redacted === true } : p,
    );
    turn.thinkingEndedAt = now;
};

type Phases = Pick<AnswerParts, 'currentPhase' | 'phaseTrail'>;

/**
 * `{ stage, status: 'start'|'end', detail?, durationMs? }` from both runtimes
 * (core/agentRuntime/phaseEvents.js). The live line shows the newest stage
 * and an `end` of a stage it is no longer showing does not clear it — stages
 * overlap — while the trail keeps every step with its duration.
 */
export const phaseTracked: FrameHandler<Phases> = (turn, d) => {
    const stage = str(d.stage);
    if (!stage) return false;
    const trail = appendPhase(turn.phaseTrail, d) ?? turn.phaseTrail;
    const ending = str(d.status) === 'end';
    if (ending && turn.currentPhase?.stage !== stage) {
        if (trail === turn.phaseTrail) return false;
        turn.phaseTrail = trail;
        return;
    }
    turn.phaseTrail = trail;
    turn.currentPhase =
        ending || stage === 'streaming_start' ? null : { stage, detail: str(d.detail) || null, startedAt: Date.now() };
};

/** The answer's words. The first of them settles the live phase line (the web's content flusher). */
export const answerText: FrameHandler<Phases & { text: string }> = (turn, d) => {
    const text = str(d.text);
    if (!text) return false;
    turn.text += text;
    if (turn.currentPhase) turn.currentPhase = null;
};
