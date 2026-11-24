/**
 * Is a plan WIRED right? The check that knows the graph: pure and deterministic, read by the planner (its findings go
 * back to the model), by approval (a miswired plan cannot be approved, usecases/coworkPlanRefs.mts), by the try-out and
 * by the automatic resolver (../repairs/autoResolve.mts), which applies the fixes it proposes (./planWiringFix.mts).
 *
 * The runner walks a plan along its EDGES (core/automationRunner/runDag.js, runDagGraph.js): a step runs once the
 * edges into it are taken, so a step that reads another step's output but has no path of edges from it runs before it
 * or beside it, and reads nothing. For every `steps.<id>.output…` a step refers to (in any field: its inputs, an AI
 * prompt, a condition, the list it works through):
 *
 *   ref_unknown_step  <id> is no step of the plan. The fix: the ONE step whose known output has that path (the only
 *                     datetime step with `iso`); never a guess between two.
 *   ref_not_upstream  <id> is a step of the plan but not an ancestor along the edges. The fix: the edge <id> → step
 *                     (and the step's own edge from the trigger goes, now that it waits), unless that closes a cycle,
 *                     or <id> branches (a condition or a switch: which branch would it be?).
 *   ref_braced        a field the runner reads as a path (a date's input, the list a step works through) holds the
 *                     path inside {{ }}: the runner reads that as text. The fix: the bare path.
 *
 * And two about the flow of data:
 *
 *   read_unused       a step reads an app, and no later step uses what it read. Advice: it goes to the planner and
 *                     into a try-out's report, and never stops an approval on its own.
 *   ai_without_input  an AI step starts from the trigger and reads no step, while the plan reads apps. The fix: it
 *                     waits for the last steps of those reads and gets their output in its prompt.
 *
 * What a step's output holds is known for the built-in types here (a datetime step: `iso` and `value`) and, for the
 * rest, through `knowsPath` (usecases/coworkPlanRefs.mts hands in the builder's shapes: the curated tool schemas, a
 * set's fields, a list step's items). An output nobody described is never a reason for a finding.
 *
 * Every finding is a plain sentence made of step titles. Nothing here reads a value: only the plan.
 */

import { createRequire } from 'node:module';
import type { Definition, DefStep, PlanFinding, ToolLookups } from './planTypes.mts';
import { stepsOf, type WalkedStep } from './planWalk.mts';
import { planViewOf } from './planView.mts';

const nodeRequire = createRequire(import.meta.url);
type Token = { type?: string; key?: unknown };
const { findRefPaths } = nodeRequire('../../automationModel/refPaths.js') as { findRefPaths: (text: string, roots?: Iterable<string>) => Token[][] };

export type WiringCode = 'wiring.ref_unknown_step' | 'wiring.ref_not_upstream' | 'wiring.ref_braced' | 'wiring.read_unused' | 'wiring.ai_without_input';

/** The codes that stop an approval (read_unused is advice). */
export const WIRING_BLOCKING: ReadonlySet<string> = new Set(['wiring.ref_unknown_step', 'wiring.ref_not_upstream', 'wiring.ref_braced', 'wiring.ai_without_input']);
/** Every wiring code. */
export const WIRING_CODES: ReadonlySet<string> = new Set([...WIRING_BLOCKING, 'wiring.read_unused']);

/** A fix the resolver may apply: it changes references and edges only. */
export type WiringFix =
    | { kind: 'reread'; stepId: string; from: string; to: string }
    | { kind: 'wait'; stepId: string; after: string[]; addRefs: string[] }
    | { kind: 'unbrace'; stepId: string; field: string };

export interface WiringFinding extends PlanFinding {
    code: WiringCode;
    stepId: string;
    /** The step it reads, when there is one. */
    sourceId: string | null;
    fix: WiringFix | null;
}

/** Does this step's output have that path? true, false, or null when its output is not described. */
export type KnowsPath = (step: DefStep, keys: string[], definition: Definition) => boolean | null;

export interface WiringOptions {
    /** What the builder knows of an output, beyond the built-in types. */
    knowsPath?: KnowsPath;
    /** Also the advice (read_unused). */
    advice?: boolean;
}

/** One reference of a step to an earlier step's output. */
export interface StepRef { sourceId: string; keys: string[]; field: string; braced: boolean }

/** Fields the runner reads as a PATH, not as a template: braces there are read as text. */
const BARE_FIELDS: ReadonlySet<string> = new Set(['input', 'input2', 'arrayRef', 'overRef', 'source', 'items', 'forEach.overRef']);
const CHILD_FIELDS: ReadonlySet<string> = new Set(['body', 'branches']);
/** Steps an edge from cannot be added to without choosing a branch. */
const BRANCHING: ReadonlySet<string> = new Set(['condition', 'switch']);
const MAX_SINKS = 3;
const MAX_DEPTH = 12;

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function refsInText(text: string, field: string, into: StepRef[], direct: boolean): void {
    const trimmed = text.trim();
    // Only a field that IS the path (a plain string there, not a binding inside it) can be unwrapped.
    const braced = direct && BARE_FIELDS.has(field) && trimmed.startsWith('{{') && trimmed.endsWith('}}');
    for (const tokens of findRefPaths(text, ['steps'])) {
        const id = tokens[1]?.key;
        // `steps.<id>.output…` only: prose that happens to say "steps." is no reference.
        if (typeof id !== 'string' || tokens[2]?.key !== 'output') continue;
        into.push({ sourceId: id, keys: tokens.slice(3).map((t) => String(t.key)), field, braced });
    }
}

function collect(value: unknown, field: string, into: StepRef[], depth: number, direct = false): void {
    if (typeof value === 'string') { refsInText(value, field, into, direct); return; }
    if (!value || typeof value !== 'object' || depth > MAX_DEPTH) return;
    // A binding `{ kind, path | value }` belongs to the field it sits in.
    for (const inner of Array.isArray(value) ? value : Object.values(value)) collect(inner, field, into, depth + 1);
}

/** Every reference a step makes to a step's output, in its own fields (its children are steps of their own). */
export function stepRefsOf(step: DefStep): StepRef[] {
    const out: StepRef[] = [];
    for (const [key, value] of Object.entries(step)) {
        if (CHILD_FIELDS.has(key) && Array.isArray(value)) continue;
        if (key === 'forEach' && isPlain(value)) {
            for (const [k, v] of Object.entries(value)) collect(v, k === 'overRef' ? 'forEach.overRef' : `forEach.${k}`, out, 1, true);
            continue;
        }
        collect(value, key, out, 0, true);
    }
    return out;
}

/** The plan as a graph: its nodes (the trigger and the top-level steps), the edges in and out, and who contains whom. */
export interface PlanGraph {
    triggerId: string | null;
    top: Map<string, WalkedStep>;
    all: Map<string, WalkedStep>;
    incoming: Map<string, string[]>;
    outgoing: Map<string, string[]>;
}

function edgesOf(definition: Definition | null | undefined): Array<{ from: string; to: string }> {
    const raw = Array.isArray(definition?.edges) ? definition.edges as unknown[] : [];
    return raw.filter(isPlain).filter((e) => typeof e.from === 'string' && typeof e.to === 'string').map((e) => ({ from: String(e.from), to: String(e.to) }));
}

export function graphOf(definition: Definition | null | undefined): PlanGraph {
    const walked = stepsOf(definition).filter((w) => w.type !== 'note' && w.type !== 'trigger');
    const triggerId = typeof definition?.trigger?.id === 'string' ? definition.trigger.id : null;
    const incoming = new Map<string, string[]>();
    const outgoing = new Map<string, string[]>();
    for (const e of edgesOf(definition)) {
        incoming.set(e.to, [...(incoming.get(e.to) ?? []), e.from]);
        outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e.to]);
    }
    return { triggerId, top: new Map(walked.filter((w) => w.parentId === null).map((w) => [w.id, w])), all: new Map(walked.map((w) => [w.id, w])), incoming, outgoing };
}

function reach(start: string, next: Map<string, string[]>): Set<string> {
    const seen = new Set<string>();
    const todo = [...(next.get(start) ?? [])];
    while (todo.length) {
        const n = todo.pop() as string;
        if (seen.has(n)) continue;
        seen.add(n);
        todo.push(...(next.get(n) ?? []));
    }
    return seen;
}

export const ancestorsOf = (g: PlanGraph, id: string): Set<string> => reach(id, g.incoming);
export const descendantsOf = (g: PlanGraph, id: string): Set<string> => reach(id, g.outgoing);

/** The top-level step a step sits in (itself at the top level). */
export function containerOf(g: PlanGraph, id: string): string {
    let at = g.all.get(id);
    for (let i = 0; at && at.parentId !== null && i < MAX_DEPTH; i++) at = g.all.get(at.parentId);
    return at?.id ?? id;
}

/** What a built-in step type outputs, as its keys; null when that is not known here. */
function builtInKeys(step: DefStep): string[] | null {
    if (step.type !== 'datetime') return null;
    if (typeof step.arrayRef === 'string') return ['items', 'count', 'warning', 'skipped'];
    if (step.op === 'diff') return ['value', 'unit'];
    if (step.op === 'extract') return ['value', 'part'];
    return ['iso', 'value'];
}

/** Does this step's output have this path, as far as anything knows? */
export function hasPath(step: DefStep, keys: string[], definition: Definition, opts: WiringOptions): boolean | null {
    const own = builtInKeys(step);
    if (own) return keys.length > 0 && own.includes(keys[0] as string);
    return opts.knowsPath ? opts.knowsPath(step, keys, definition) : null;
}

/** What a finding needs besides the definition. */
interface Ctx { definition: Definition; g: PlanGraph; titles: Map<string, string>; opts: WiringOptions; lookups: ToolLookups }

const titleIn = (c: Ctx, id: string): string => c.titles.get(id) ?? id;

function finding(code: WiringCode, stepId: string, sourceId: string | null, message: string, fix: WiringFix | null): WiringFinding {
    return { code, stepId, sourceId, message, fix };
}

/** May an edge from → to be added without closing a cycle or choosing a branch? */
function mayWait(c: Ctx, from: string, to: string): boolean {
    const src = c.g.top.get(from);
    if (!src || from === to || BRANCHING.has(src.type)) return false;
    // from → to closes a cycle when `from` already comes after `to`.
    return !descendantsOf(c.g, to).has(from);
}

/** The one step (an ancestor first) whose known output has these keys, other than the step itself. */
function onlyStepWith(c: Ctx, keys: string[], stepId: string): string | null {
    if (keys.length === 0) return null;
    const own = containerOf(c.g, stepId);
    const fits = [...c.g.top.values()].filter((w) => w.id !== own && hasPath(w.step, keys, c.definition, c.opts) === true).map((w) => w.id);
    const ancestors = ancestorsOf(c.g, own);
    const upstream = fits.filter((id) => ancestors.has(id));
    if (upstream.length === 1) return upstream[0] as string;
    return fits.length === 1 && mayWait(c, fits[0] as string, own) ? fits[0] as string : null;
}

function unknownStep(c: Ctx, w: WalkedStep, r: StepRef): WiringFinding {
    const to = onlyStepWith(c, r.keys, w.id);
    const base = `'${titleIn(c, w.id)}' reads from a step that is not among the steps.`;
    return finding('wiring.ref_unknown_step', w.id, null, to ? `${base} It should read from '${titleIn(c, to)}'.` : base, to ? { kind: 'reread', stepId: w.id, from: r.sourceId, to } : null);
}

function notUpstream(c: Ctx, w: WalkedStep, r: StepRef): WiringFinding {
    const own = containerOf(c.g, w.id);
    const source = containerOf(c.g, r.sourceId);
    const ok = mayWait(c, source, own);
    const base = `'${titleIn(c, w.id)}' reads from '${titleIn(c, r.sourceId)}', but does not wait for it: it would run before it or at the same time and read nothing.`;
    const why = ok ? ` Let it wait for '${titleIn(c, source)}'.` : ` '${titleIn(c, source)}' cannot come before it.`;
    return finding('wiring.ref_not_upstream', w.id, r.sourceId, base + why, ok ? { kind: 'wait', stepId: own, after: [source], addRefs: [] } : null);
}

function braced(c: Ctx, w: WalkedStep, r: StepRef): WiringFinding {
    return finding('wiring.ref_braced', w.id, r.sourceId, `'${titleIn(c, w.id)}' reads '${titleIn(c, r.sourceId)}' in a field that takes a path, but writes it inside {{ }}: the run reads that as text, not as the value.`, { kind: 'unbrace', stepId: w.id, field: r.field });
}

/** The findings about the references of one step. */
function refFindingsOf(c: Ctx, w: WalkedStep): WiringFinding[] {
    const out: WiringFinding[] = [];
    const seen = new Set<string>();
    const own = containerOf(c.g, w.id);
    const ancestors = ancestorsOf(c.g, own);
    for (const r of stepRefsOf(w.step)) {
        const key = `${r.sourceId}|${r.field}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!c.g.all.has(r.sourceId)) { out.push(unknownStep(c, w, r)); continue; }
        // A step inside the same loop body reads what that body made: the body's own order, not the plan's edges.
        if (containerOf(c.g, r.sourceId) === own) continue;
        if (!ancestors.has(containerOf(c.g, r.sourceId))) out.push(notUpstream(c, w, r));
        else if (r.braced) out.push(braced(c, w, r));
    }
    return out;
}

/** Steps that read an app, at the top level. */
function readStepsOf(c: Ctx): string[] {
    return planViewOf(c.definition, c.lookups).steps.filter((s) => s.depth === 0 && s.type === 'integration_action' && s.effect === 'reads').map((s) => s.id);
}

/** Who reads each step's output (by the step that holds the reference, counted at its top-level container). */
function readersOf(c: Ctx): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const w of c.g.all.values()) {
        for (const r of stepRefsOf(w.step)) out.set(r.sourceId, new Set([...(out.get(r.sourceId) ?? []), containerOf(c.g, w.id)]));
    }
    return out;
}

function unusedReads(c: Ctx, reads: string[]): WiringFinding[] {
    const readers = readersOf(c);
    return reads.filter((id) => ![...(readers.get(id) ?? [])].some((r) => r !== id))
        .map((id) => finding('wiring.read_unused', id, null, `'${titleIn(c, id)}' reads data that no later step uses.`, null));
}

/** Does an AI step read nothing of the run: no step, and of the trigger at most when the last good run was? */
function readsNothing(step: DefStep): boolean {
    if (stepRefsOf(step).length > 0) return false;
    const text = JSON.stringify({ ...step, body: undefined, branches: undefined });
    return !findRefPaths(text, ['trigger', 'loop']).some((t) => t[0]?.key === 'loop' || (t[1]?.key === 'output' && t[2]?.key !== 'since'));
}

/** The last steps of the data a plan reads: reads and what works on them, with nothing of that kind after them. */
function dataSinks(c: Ctx, reads: string[], aiId: string): string[] {
    const view = new Map(planViewOf(c.definition, c.lookups).steps.map((s) => [s.id, s]));
    const later = descendantsOf(c.g, aiId);
    const isData = (id: string): boolean => {
        const s = view.get(id);
        return !!s && s.depth === 0 && s.kind === 'fixed' && s.effect === 'reads' && id !== aiId && !later.has(id) && !BRANCHING.has(s.type);
    };
    const data = new Set<string>();
    for (const r of reads) for (const id of [r, ...descendantsOf(c.g, r)]) if (isData(id)) data.add(id);
    return [...data].filter((id) => !(c.g.outgoing.get(id) ?? []).some((n) => data.has(n)));
}

function aiWithoutInput(c: Ctx, reads: string[]): WiringFinding[] {
    const out: WiringFinding[] = [];
    for (const w of c.g.top.values()) {
        if (w.type !== 'ai_step' || !readsNothing(w.step)) continue;
        const ancestors = ancestorsOf(c.g, w.id);
        if (reads.length === 0 || reads.some((r) => ancestors.has(r))) continue;
        const sinks = dataSinks(c, reads, w.id);
        const ok = sinks.length > 0 && sinks.length <= MAX_SINKS && sinks.every((s) => mayWait(c, s, w.id));
        const names = sinks.map((s) => `'${titleIn(c, s)}'`).join(' and ');
        const base = `'${titleIn(c, w.id)}' starts right away and reads none of the steps that fetch the data it should work on.`;
        out.push(finding('wiring.ai_without_input', w.id, null, ok ? `${base} Let it wait for ${names} and read ${sinks.length === 1 ? 'its' : 'their'} output.` : base, ok ? { kind: 'wait', stepId: w.id, after: sinks, addRefs: sinks } : null));
    }
    return out;
}

/** How the plan is wired, as findings; empty when every reference reads a step that runs before it. */
export function wiringFindings(definition: Definition | null | undefined, lookups: ToolLookups, opts: WiringOptions = {}): WiringFinding[] {
    if (!definition || !Array.isArray(definition.steps)) return [];
    const c: Ctx = { definition, g: graphOf(definition), titles: new Map(planViewOf(definition, lookups).steps.map((s) => [s.id, s.title])), opts, lookups };
    const out = [...c.g.all.values()].flatMap((w) => refFindingsOf(c, w));
    const reads = readStepsOf(c);
    out.push(...aiWithoutInput(c, reads));
    if (opts.advice) out.push(...unusedReads(c, reads));
    return out;
}
