/**
 * Is this definition a CHECK that may measure a goal? The rules, as one pure function, asked when the owner approves
 * the check and again before every measurement (./goalMeasure.mts), so the two cannot disagree.
 *
 * A check is a small plan that ends with two numbers: how many of the things the goal is about met it (`met`), of how
 * many (`total`). It is run after the cowork's own runs, on the owner's data, while nobody watches, so what it may do
 * is the least a plan can do:
 *
 *   PLAN     everything a plan must be (../plan/planChecks.mts): Cowork's step list, no sub-flows, outside text that
 *            informs and never instructs;
 *   FIXED    every step is done the same way every time: no model, no question to a person, no result delivered to
 *            anyone (../plan/coworkStepList.mts kinds);
 *   READS    every step only reads: nothing is changed and nothing is sent, by the step's own type and by its tool;
 *   START    it starts when it is asked to (a manual trigger): a run of its cowork asks;
 *   COUNT    the one step it ends on is a `set` step that writes `met` and `total`.
 *
 * "The check cannot change anything" is therefore a fact of its shape, not a promise of the run that executes it.
 * The numbers themselves are read from the run's last output by `countOf`.
 */

import type { Definition, DefStep, PlanFinding, ToolLookups } from '../plan/planTypes.mts';
import { checkPlan } from '../plan/planChecks.mts';
import { isAnnotation } from '../plan/coworkStepList.mts';
import { planViewOf } from '../plan/planView.mts';
import { stepsOf } from '../plan/planWalk.mts';

const finding = (code: string, stepId: string | null, message: string): PlanFinding => ({ code, stepId, message });

/** The operations of a table step that only read (core/automationRunner/execDatatable.js). */
const TABLE_READS: ReadonlySet<string> = new Set(['find_rows', 'count_rows']);

const NOT_FIXED: Readonly<Record<string, string>> = Object.freeze({
    ai: 'is an AI step',
    ask: 'waits for a decision',
    deliver: 'delivers a result',
});

/** Every step done the same way every time, and only reading. */
function stepFindings(definition: Definition, lookups: ToolLookups): PlanFinding[] {
    const out: PlanFinding[] = [];
    const opOf = new Map(stepsOf(definition).map((s) => [s.id, s.step.op]));
    for (const step of planViewOf(definition, lookups).steps) {
        if (step.kind !== 'fixed') {
            out.push(finding('goal.not_fixed', step.id, `A goal's check only reads and counts, the same way every time: "${step.title}" ${NOT_FIXED[step.kind] ?? 'is not a fixed step'}.`));
            continue;
        }
        // The step's own effect, and its tool's as the registry knows it: the stronger of the two. A table step reads
        // only with an operation known to read: an operation nobody classified writes, as an unknown tool does.
        const byTool = step.type === 'integration_action' && step.tool ? lookups.effectOfTool(step.tool) : 'reads';
        const byOp = step.type === 'datatable' && !TABLE_READS.has(String(opOf.get(step.id) ?? '')) ? 'writes' : 'reads';
        const effect = step.effect !== 'reads' ? step.effect : byTool !== 'reads' ? byTool : byOp;
        if (effect !== 'reads') {
            out.push(finding('goal.not_read_only', step.id, `A goal's check cannot change or send anything: "${step.title}" ${effect === 'sends' ? 'sends' : 'changes'} something.`));
        }
    }
    return out;
}

function edgesOf(definition: Definition): Array<{ from: string; to: string }> {
    if (!Array.isArray(definition.edges)) return [];
    return definition.edges
        .filter((e): e is { from: string; to: string } => !!e && typeof e === 'object' && typeof (e as { from?: unknown }).from === 'string' && typeof (e as { to?: unknown }).to === 'string');
}

const fieldsOf = (step: DefStep): Record<string, unknown> => (step.fields && typeof step.fields === 'object' && !Array.isArray(step.fields) ? step.fields as Record<string, unknown> : {});

/** The one step the check ends on: a `set` step that writes `met` and `total`, once (not per row). */
function countFindings(definition: Definition): PlanFinding[] {
    const top = stepsOf(definition).filter((s) => s.depth === 0 && !isAnnotation(s.type));
    const ids = new Set(top.map((s) => s.id));
    const leaving = new Set(edgesOf(definition).filter((e) => ids.has(e.to)).map((e) => e.from));
    const ends = top.filter((s) => !leaving.has(s.id));
    const last = ends.length === 1 ? ends[0] : null;
    if (!last) return [finding('goal.no_count', null, 'A goal\'s check ends on one step that counts: a "set" step with met and total.')];
    if (last.type !== 'set' || last.step.arrayRef !== undefined) {
        return [finding('goal.no_count', last.id, 'A goal\'s check ends on a "set" step that writes two numbers once: met and total.')];
    }
    const fields = fieldsOf(last.step);
    const missing = ['met', 'total'].filter((name) => !(name in fields));
    return missing.length === 0 ? [] : [finding('goal.no_count', last.id, `The last step of a goal's check writes met and total; it has no ${missing.join(' and no ')}.`)];
}

/** Why this definition may not measure a goal; an empty list when it may. */
export function goalCheckFindings(definition: Definition | null | undefined, lookups: ToolLookups): PlanFinding[] {
    const plan = checkPlan(definition, lookups);
    if (!definition || plan.some((f) => f.code === 'plan.shape')) return plan;
    const start = definition.trigger?.kind === 'manual' ? [] : [finding('goal.trigger', null, 'A goal\'s check starts when a run of its cowork ends, not on a schedule or an event of its own.')];
    return [...plan, ...start, ...stepFindings(definition, lookups), ...countFindings(definition)];
}

/** The two numbers a check ended on, or why they are not a count. */
export type Count = { ok: true; met: number; total: number; period: string | null } | { ok: false; reason: string };

const PERIOD_MAX = 60;

/** A whole number, from a number or from its digits as text; null for anything else. */
function wholeOf(value: unknown): number | null {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return typeof n === 'number' && Number.isInteger(n) ? n : null;
}

/** A short label of what was counted ("this week"), or null. */
const periodOf = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim().slice(0, PERIOD_MAX) : null);

/** Read `met` and `total` (and an optional `period`, "this week") from the output of the check's last step. */
export function countOf(output: unknown): Count {
    const o = output && typeof output === 'object' && !Array.isArray(output) ? output as Record<string, unknown> : null;
    if (!o) return { ok: false, reason: 'The check ended without met and total.' };
    const met = wholeOf(o.met);
    const total = wholeOf(o.total);
    if (met === null || total === null) return { ok: false, reason: 'The check ended without two whole numbers for met and total.' };
    if (met < 0 || total < 0) return { ok: false, reason: 'The check counted below zero.' };
    if (met > total) return { ok: false, reason: `The check counted ${met} met of only ${total}.` };
    return { ok: true, met, total, period: periodOf(o.period) };
}
