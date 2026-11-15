/**
 * Writing helpers the module mappers share: input transforms to bindings
 * (with the report entries a connection, a removed secret or an untranslated
 * expression needs), the placeholder that stands where a module could not be
 * converted, and the source note next to it.
 *
 * A placeholder is a `stop_error` step (PLAN B3 convert.mts): the graph stays
 * valid, a dry run stops visibly at the right place, and a run that was
 * switched on by mistake does nothing it cannot take back.
 */

import type { WmInput, WmNode } from './ir.mts';
import type { Binding, InputResult } from './mapExpr.mts';
import type { MapCtx, Port, ScopeExtras } from './context.mts';
import { addStep, newId, register, scopeFor } from './context.mts';
import { translateInput } from './mapExpr.mts';
import { scrubSource, scrubValue } from './scrub.mts';
import type { Confidence, ModuleStatus } from './report.mts';

const NOTE_MAX = 4000;

export interface BoundInputs {
    bindings: Record<string, Binding>;
    /** Inputs whose expression has no Bee Flow counterpart. */
    untranslated: Array<{ name: string; reason: string; original: string }>;
    medium: boolean;
}

export function bindInputs(ctx: MapCtx, node: WmNode, inputs: Record<string, WmInput>, extras: ScopeExtras = {}): BoundInputs {
    const out: BoundInputs = { bindings: {}, untranslated: [], medium: false };
    const scope = scopeFor(ctx, extras);
    for (const [name, input] of Object.entries(inputs)) {
        const r = translateInput(input, scope);
        applyResult(ctx, node, name, r, out);
    }
    return out;
}

function applyResult(ctx: MapCtx, node: WmNode, name: string, r: InputResult, out: BoundInputs): void {
    switch (r.kind) {
        case 'binding':
            out.bindings[name] = r.binding;
            if (r.confidence === 'medium') out.medium = true;
            if (r.secretsRemoved) ctx.report.warn('secret_removed', `A value that looked like a secret was left out of "${name}"; fill it in through a connection.`, node.wmId);
            return;
        case 'connection':
            for (const ref of r.refs) {
                ctx.report.connection(ref.kind, ref.path, `${node.wmId}.${name}`);
                ctx.report.warn('connection_needed', `"${name}" used the Windmill ${ref.kind} ${ref.path}; connect the matching app in Bee Flow (its value is never imported).`, node.wmId);
            }
            return;
        case 'drop':
            return;
        case 'ai':
            out.untranslated.push({ name, reason: r.reason, original: scrubSource(r.original).text });
            return;
        default:
            return;
    }
}

/** What a module was in Windmill, for the report. */
export function sourceLabel(node: WmNode): string {
    if (node.kind === 'rawscript') return `rawscript:${node.language ?? 'unknown'}`;
    if (node.kind === 'script' || node.kind === 'flow') return `${node.kind}:${node.scriptPath ?? '?'}`;
    if (node.kind === 'unknown') return node.rawType ?? 'unknown';
    return node.kind;
}

/** What became of a module: status, confidence, reason and the step ids that hold it. */
export type Outcome = [ModuleStatus, Confidence, string, string[]];

export function reportModule(ctx: MapCtx, node: WmNode, [status, confidence, reason, stepIds]: Outcome): void {
    ctx.report.module({ wmId: node.wmId, ...(node.summary ? { summary: node.summary } : {}), source: sourceLabel(node), status, confidence, reason, stepIds });
}

export function labelOf(node: WmNode, fallback: string): string {
    return (node.summary || fallback).slice(0, 200);
}

/** The scrubbed source of a module, or undefined. Counts removed secrets in the report. */
export function cleanSource(ctx: MapCtx, node: WmNode): string | undefined {
    if (!node.source) return undefined;
    const r = scrubSource(node.source);
    if (r.removed) ctx.report.warn('secret_removed', `${r.removed} value(s) that looked like a secret were removed from the code of "${node.summary ?? node.wmId}".`, node.wmId);
    return r.text;
}

export interface PlaceholderOpts {
    status?: 'ai' | 'unsupported';
    title?: string;
    inputs?: Record<string, unknown>;
}

/** A stop_error placeholder, its AI checklist item and (for code) a note with the source. */
export function placeholder(ctx: MapCtx, node: WmNode, why: string, ports: Port[], opts: PlaceholderOpts = {}): Port[] {
    const id = newId(ctx, node.wmId);
    const label = `Windmill: ${labelOf(node, node.wmId)} (still to convert)`.slice(0, 200);
    const out = addStep(ctx, { id, type: 'stop_error', label, message: `This Windmill step has not been converted yet: ${why}`.slice(0, 1000) }, ports);
    register(ctx, node.wmId, `steps.${id}.output`, null);
    const source = cleanSource(ctx, node);
    if (source) addSourceNote(ctx, node, source);
    const status = opts.status ?? 'ai';
    ctx.report.ai({
        wmId: node.wmId, stepId: id, title: opts.title ?? `Convert "${labelOf(node, node.wmId)}"`, why,
        ...(node.language ? { language: node.language } : {}),
        ...(source ? { source } : {}),
        ...(opts.inputs ? { inputs: opts.inputs } : { inputs: describeInputs(node) }),
    });
    reportModule(ctx, node, [status, 'low', why, [id]]);
    return out;
}

/** The inputs of a module as text, for the checklist (secrets removed). */
export function describeInputs(node: WmNode): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node.inputs)) {
        if (v.type === 'javascript') out[k] = { expr: scrubSource(v.expr).text };
        else if (v.type === 'static') out[k] = { value: (scrubValue({ [k]: v.value }, { removed: 0 }) as Record<string, unknown>)[k] };
        else out[k] = { ai: true };
    }
    return out;
}

export function addSourceNote(ctx: MapCtx, node: WmNode, source: string): void {
    const head = `Windmill source of "${labelOf(node, node.wmId)}" (read-only):\n\n`;
    const room = NOTE_MAX - head.length - 20;
    const body = source.length > room ? `${source.slice(0, room)}\n… (shortened)` : source;
    const id = `note_${node.wmId}`.split('-').join('_');
    const set = ctx.ids.get('') ?? new Set<string>();
    let noteId = id;
    for (let n = 2; set.has(noteId); n += 1) noteId = `${id}_${n}`;
    set.add(noteId);
    ctx.ids.set('', set);
    ctx.rootNotes.push({ id: noteId, type: 'note', text: head + body });
}

/** Turn untranslated inputs into one checklist item for a step that WAS written. */
export function flagUntranslated(ctx: MapCtx, node: WmNode, stepId: string, bound: BoundInputs): void {
    if (!bound.untranslated.length) return;
    ctx.report.ai({
        wmId: node.wmId, stepId,
        title: `Fill in ${bound.untranslated.map((u) => `"${u.name}"`).join(', ')} of "${labelOf(node, node.wmId)}"`,
        why: bound.untranslated.map((u) => `${u.name}: ${u.reason}`).join(' '),
        inputs: Object.fromEntries(bound.untranslated.map((u) => [u.name, { expr: u.original }])),
    });
}
