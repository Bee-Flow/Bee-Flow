import { ruleChipsOf } from './MessageItem/answerChips';
import { confirmDecisionOf, type ConfirmBook } from './MessageItem/toolConfirmStatus';
import type { HeldAction, HeldActionRow, MissingRow, PhaseTrailEntry, QuestionRow, RuleRow, ToolConfirmCall, ToolEntry, ToolTimes, TraceMessage } from './answerTrace.types';

/** De fases die samen "de vraag is ingelezen" opleveren. */
const QUESTION_STAGES = Object.freeze(['processed_history', 'building_prompt']);

export function text(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
}

export function missing(id: string, reason: string): MissingRow {
    return { id, state: 'missing', reason, omitted: [] };
}

/**
 * The durations of a series of steps added together.
 *
 * Only to be used on steps that FOLLOW EACH OTHER. Phases that slide over each
 * other (guardrails around privacy_scan) would be counted twice by this. For that
 * there is `traceSpanMs`.
 */
export function sumDurations(steps: Array<{ durationMs?: number | null } | null | undefined>) {
    let total = null;
    for (const s of steps) {
        if (!s || !Number.isFinite(s.durationMs)) continue;
        total = (total || 0) + (s.durationMs as number);
    }
    return total;
}

/** The duration of a tool call, from its own clock ticks. */
export function toolDurationMs(tool: ToolEntry | null | undefined) {
    return Number.isFinite(tool?.endTime) && Number.isFinite(tool?.startTime)
        ? (tool as ToolTimes).endTime - (tool as ToolTimes).startTime
        : null;
}

/** 1: the question was read and turned into a prompt. Not: understood. */
export function questionRow(trail: PhaseTrailEntry[], hasTrail: boolean): QuestionRow | MissingRow {
    const steps = trail.filter((r: PhaseTrailEntry) => QUESTION_STAGES.includes(r.stage));
    if (steps.length === 0) return missing('question', hasTrail ? 'not_recorded' : 'no_trace');
    return {
        id: 'question',
        state: 'recorded',
        // The stages are listed so that the reader sees WHAT this rule rests on.
        stages: steps.map((s: PhaseTrailEntry) => s.stage),
        ms: sumDurations(steps),
        omitted: [],
    };
}

/** 3: which rule of the role this answer followed. JUDGED, not minutes. */
export function ruleRow(msg: TraceMessage | null | undefined): RuleRow | MissingRow {
    const rules = ruleChipsOf(msg);
    if (rules.length === 0) return missing('rule', 'no_attribution');
    return { id: 'rule', state: 'judged', rules, omitted: [] };
}

/** 4 — een actie die is aangeboden, en wat er daarna mee gebeurd is. */
export function heldActionRow(msg: TraceMessage | null | undefined, decided: ConfirmBook): HeldActionRow | MissingRow {
    const calls = Array.isArray(msg?.pendingToolCalls)
        ? msg.pendingToolCalls.filter((c: ToolConfirmCall | null) => c && typeof c === 'object')
        : [];
    // No `no_trace` here: held calls do not hang on the phase trail, so the absence
    // says the same whether or not there is a trail.
    if (calls.length === 0) return missing('held_action', 'not_recorded');

    const actions = calls.map((call: ToolConfirmCall, i: number): HeldAction => {
        const { status, by } = confirmDecisionOf(call, decided);
        return {
            key: text(call.argsKey) || text(call.callId) || `held-${i}`,
            toolName: text(call.toolName),
            effect: text(call.effect),
            status,
            by,
        };
    });
    return {
        id: 'held_action',
        state: 'recorded',
        actions,
        openCount: actions.filter((a: HeldAction) => a.status === 'pending').length,
        omitted: [],
    };
}
