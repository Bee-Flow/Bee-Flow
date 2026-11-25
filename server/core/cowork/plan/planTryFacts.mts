/**
 * What a try-out of a plan showed, as FACTS (usecases/coworkPlanTryOut.mts runs it; the planner repairs from these,
 * the plan card shows the summary, the resolver takes a passing one as its proof).
 *
 * A fact says which step, what went wrong in code (an error class, a field the plan reads, the KIND of value that was
 * found) and which keys the earlier step's output has. Never a value, and never a step's error text: an error can
 * quote what an app returned, and what an app returns is not the planner's business. The titles are the plan's own.
 *
 *   step_failed   a step failed: its error class, and what it reads (from which step, which field)
 *   list_missing  a step that works through a list found none where the plan points (../runOutcome.mts)
 *   not_reached   the run ended before the step (only told when the run failed)
 *   wiring        what ./planWiring.mts says about the plan (a read nobody uses), as its sentence
 *
 * The summary of a try-out is counts: how many items each read step got, how many AI steps answered, how many steps
 * were held back because they would have changed or sent something.
 */

import { createRequire } from 'node:module';
import type { Definition, ToolLookups } from './planTypes.mts';
import type { RecordedStep } from '../replay/recordingOf.mts';
import { planViewOf } from './planView.mts';
import { stepRefsOf, wiringFindings, type WiringOptions } from './planWiring.mts';
import { stepsOf } from './planWalk.mts';
import { unresolvedOf } from '../runOutcome.mts';

const nodeRequire = createRequire(import.meta.url);
type Token = { key?: unknown };
const { findRefPaths } = nodeRequire('../../automationModel/refPaths.js') as { findRefPaths: (text: string, roots?: Iterable<string>) => Token[][] };

/** Where a failed step reads from: a step of the plan by its title, or the start of the run. */
export interface ReadFrom { from: string; field: string; keys: string[] }

export type TryFact =
    | { kind: 'step_failed'; stepId: string; step: string; errorClass: string; reads: ReadFrom[] }
    | { kind: 'list_missing'; stepId: string; step: string; from: string; field: string; found: string; keys: string[] }
    | { kind: 'not_reached'; stepId: string; step: string }
    | { kind: 'wiring'; stepId: string; code: string; message: string };

export interface TrySummary {
    /** The read steps that ran, each with how many items it got (null: not a list). */
    reads: Array<{ title: string; items: number | null }>;
    /** AI steps that answered. */
    ai: number;
    /** Steps held back: they would have changed or sent something. */
    held: number;
}

const START = 'the start of the run';
const MAX_KEYS = 12;
const SIMPLE_KEY = /^[A-Za-z_$][\w$]{0,40}$/;
const CLASS_KEY = /^[\w.-]{1,40}$/;

/** A made-up output (a held-back step) says nothing about what the real one returns. */
export const synthesised = (s: RecordedStep): boolean => !!s.output && typeof s.output === 'object' && (s.output as { _dryRunSynthesised?: unknown })._dryRunSynthesised === true;

/** The names of the fields an output has at its top: names that read as identifiers only (a key can be data). */
export function keysOf(output: unknown): string[] {
    if (!output || typeof output !== 'object' || Array.isArray(output)) return [];
    return Object.keys(output).filter((k) => SIMPLE_KEY.test(k) && !k.startsWith('_')).slice(0, MAX_KEYS);
}

const cleanClass = (v: unknown): string => (typeof v === 'string' && CLASS_KEY.test(v) ? v : 'error');

/** How many items a read got: the list it returned, or the first list at its top. */
export function itemsOf(output: unknown): number | null {
    if (Array.isArray(output)) return output.length;
    if (!output || typeof output !== 'object') return null;
    const list = Object.values(output).find(Array.isArray);
    return list ? list.length : null;
}

function readsOf(definition: Definition, stepId: string, steps: ReadonlyMap<string, RecordedStep>, titles: Map<string, string>): ReadFrom[] {
    const step = stepsOf(definition).find((w) => w.id === stepId)?.step;
    if (!step) return [];
    const out: ReadFrom[] = stepRefsOf(step).map((r) => {
        const rec = steps.get(r.sourceId);
        return { from: titles.get(r.sourceId) ?? r.sourceId, field: r.keys.join('.'), keys: rec?.status === 'success' && rec.usable && !synthesised(rec) ? keysOf(rec.output) : [] };
    });
    for (const tokens of findRefPaths(JSON.stringify({ ...step, body: undefined, branches: undefined }), ['trigger'])) {
        if (tokens[1]?.key === 'output') out.push({ from: START, field: tokens.slice(2).map((t) => String(t.key)).join('.'), keys: [] });
    }
    return out.slice(0, 6);
}

/** The facts of a finished try-out. `ended` is how the runner said it ended. */
export function factsOfTry(definition: Definition, steps: ReadonlyMap<string, RecordedStep>, ended: string, lookups: ToolLookups, opts: WiringOptions = {}): TryFact[] {
    const view = planViewOf(definition, lookups).steps;
    const titles = new Map(view.map((s) => [s.id, s.title]));
    const out: TryFact[] = [];
    for (const s of view) {
        const rec = steps.get(s.id);
        if (rec?.status === 'error') out.push({ kind: 'step_failed', stepId: s.id, step: s.title, errorClass: cleanClass((rec as { errorClass?: unknown }).errorClass), reads: readsOf(definition, s.id, steps, titles) });
    }
    const real = new Map([...steps].filter(([, s]) => !synthesised(s)));
    for (const u of unresolvedOf(definition, real, lookups)) {
        const prefix = `steps.${u.sourceStepId}.output.`;
        out.push({ kind: 'list_missing', stepId: u.stepId, step: u.stepTitle, from: u.sourceTitle, field: u.ref.startsWith(prefix) ? u.ref.slice(prefix.length) : u.ref, found: u.found, keys: keysOf(real.get(u.sourceStepId)?.output) });
    }
    if (ended !== 'success') {
        for (const s of view) if (s.depth === 0 && !steps.has(s.id)) out.push({ kind: 'not_reached', stepId: s.id, step: s.title });
    }
    for (const f of wiringFindings(definition, lookups, { ...opts, advice: true })) out.push({ kind: 'wiring', stepId: f.stepId, code: f.code, message: f.message });
    return out;
}

/** Facts that make a try-out fail; a wiring fact on its own is advice. */
export const failingFacts = (facts: readonly TryFact[]): TryFact[] => facts.filter((f) => f.kind !== 'wiring');

/** The summary of a try-out, in counts. */
export function trySummaryOf(definition: Definition, steps: ReadonlyMap<string, RecordedStep>, lookups: ToolLookups): TrySummary {
    const out: TrySummary = { reads: [], ai: 0, held: 0 };
    for (const s of planViewOf(definition, lookups).steps) {
        const rec = steps.get(s.id);
        if (!rec || rec.status !== 'success') continue;
        if (synthesised(rec)) out.held += 1;
        else if (s.kind === 'ai') out.ai += 1;
        else if (s.type === 'integration_action' && s.effect === 'reads' && s.depth === 0) out.reads.push({ title: s.title, items: itemsOf(rec.output) });
    }
    return out;
}

/** The facts as the report the planner reads: data, quoted as JSON, never instructions. */
export function tryReport(facts: readonly TryFact[]): string {
    return `[TRY-OUT REPORT - machine-generated] The plan was run once in test mode: reads ran for real, nothing was changed or sent. It did not work as it is. Each record names a step by its title; "keys" are the names of the fields the step it reads really returned. Fix every record (keep each step after the steps it reads), then stop:\n${JSON.stringify(facts)}`;
}
