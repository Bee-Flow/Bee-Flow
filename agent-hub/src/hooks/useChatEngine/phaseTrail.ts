/**
 * The TRAIL of the phase events of one turn (A4 part C).
 *
 * ── WHY THIS DID NOT ALREADY EXIST ──────────────────────────────────────────
 *
 * During every turn the server sends `phase` events: `{ stage, status:
 * 'start'|'end', detail?, durationMs? }` (server/core/agentRuntime/phaseEvents.js).
 * Until now the client did exactly one thing with them: it put them on
 * `msg.currentPhase`, the one rotating line above the typing dots
 * (`ActivityIndicator`). Every phase therefore overwrote the previous one, and the
 * first letter of the answer wiped the whole line (`contentFlusher`).
 *
 * As a result there was no place where, afterwards, one could see what had happened.
 * This file makes that trail: the same events, added up in the order in which they
 * arrived, kept on the message.
 *
 * ── THE TRAIL INVENTS NOTHING ──────────────────────────────────────────────
 *
 * Two rules, and both are more important than they look:
 *
 *  1. AN 'end' WITHOUT A 'start' MAKES NO ROW. A closing that belongs to nothing is
 *     not a step that happened. Making a row of it would put a step on the screen
 *     whose beginning we never saw.
 *  2. A REPEATED 'start' OF THE SAME OPEN PHASE IS THE SAME STEP.
 *     `startPrivacyScanPhase` sends a `start` per scanned window, with
 *     `detail: '3/6'`, so that the live line moves along. Stacking those naively
 *     leaves one privacy scan as six steps in the trail: a trail that shows more
 *     work than was done, and that is precisely the reassurance this panel should
 *     combat.
 *
 * ── PHASES SLIDE OVER EACH OTHER ───────────────────────────────────────────
 *
 * `guardrails` runs on the agent path AROUND `privacy_scan` (guardrailsRunner runs
 * inside the guardrails phase). The trail is therefore not a list of blocks that
 * follow each other, and the durations may NOT be added up to "this is how long the
 * turn took", because that counts the scan twice. Whoever wants a total takes the
 * SPAN (first start to last end). See `answerTrace.js`.
 *
 * Pure: no React, no DOM, no time except what comes in. So that "what is in the
 * trail" can be tested with plain objects.
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/hooks/useChatEngine/phaseTrail.test.js
 */

/**
 * How many steps one turn may leave behind in the trail.
 *
 * The agent path has nine stages, and repeated starts of the same phase are folded
 * together. So this is not a limit that bites in practice, but an upper bound for a
 * stream that does not stop. Above the limit no new steps are added. Running steps
 * may still be closed, otherwise a trail full of forever-open steps would remain.
 */
export const MAX_TRAIL_STEPS = 40;

/** A pre-LLM progress step (KB search, attachment OCR, guardrails, …). */
export interface PhaseEvent {
    stage?: string;
    status?: string;
    detail?: string | null;
    durationMs?: number;
}

/** One entry of the durable phase trail kept on a message. */
export interface PhaseTrailEntry {
    stage: string;
    detail: string | null;
    startedAt: number;
    endedAt?: number | null;
    durationMs?: number | null;
    [key: string]: unknown;
}

/** A non-empty trimmed string, or null. */
function text(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
}

/** Closes the last still-running row of this stage. No start means no row. */
function closeStep(
    rows: PhaseTrailEntry[],
    stage: string,
    data: PhaseEvent,
    now: number,
): PhaseTrailEntry[] | null {
    let at = -1;
    // Search backwards: a phase that ran twice should get its own end, not that of the
    // previous time.
    for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i] && rows[i].stage === stage && rows[i].endedAt == null) { at = i; break; }
    }
    if (at < 0) return null; // regel 1: geen start ⇒ geen rij
    const row = rows[at];
    const next = rows.slice();
    next[at] = {
        ...row,
        endedAt: now,
        // The server measures its own duration. That is more accurate than the difference
        // of two clock ticks here. Without that measurement it falls back to ours. Both
        // are real measurements, not estimates.
        durationMs: Number.isFinite(data.durationMs)
            ? data.durationMs
            : (Number.isFinite(row.startedAt) ? now - row.startedAt : null),
    };
    return next;
}

/** Open a step, or update the detail of the same step that is still running. */
function openStep(
    rows: PhaseTrailEntry[],
    stage: string,
    detail: string | null,
    now: number,
): PhaseTrailEntry[] | null {
    const last = rows.length > 0 ? rows[rows.length - 1] : null;
    // Regel 2: dezelfde fase die nog loopt is dezelfde stap.
    if (last && last.stage === stage && last.endedAt == null) {
        if (last.detail === detail) return null;
        const next = rows.slice();
        next[next.length - 1] = { ...last, detail };
        return next;
    }
    if (rows.length >= MAX_TRAIL_STEPS) return null;
    return [...rows, { stage, detail, startedAt: now, endedAt: null, durationMs: null }];
}

/**
 * Process one `phase` event in the trail.
 *
 * Returns the same array reference if there was nothing to do, so that the caller
 * can skip a superfluous copy of the message.
 *
 * `now` is injectable so that a test does not have to wait on the real clock.
 */
export function appendPhase(
    trail: PhaseTrailEntry[] | undefined,
    data: PhaseEvent,
    now: number = Date.now(),
): PhaseTrailEntry[] | undefined {
    const rows = Array.isArray(trail) ? trail : [];
    const stage = text(data && data.stage);
    if (!stage) return trail;
    const next = data.status === 'end'
        ? closeStep(rows, stage, data, now)
        : openStep(rows, stage, text(data.detail), now);
    return next || trail;
}

