/**
 * The state one flow conversion carries while the module mappers write
 * steps: where steps go (a graph with edges, or a linear body without), which
 * Windmill result lives where in Bee Flow, and the expression scope built from
 * that (PLAN B3).
 *
 * A "port" is a dangling outgoing edge: the next step is wired from every
 * open port. A linear sink (a loop body, a parallel branch) has no edges at
 * all; the runtime chains its steps in order.
 */

import type { WmBundle, WmFlow, WmInput } from './ir.mts';
import type { ReportBuilder } from './report.mts';
import type { Capabilities } from './capabilities.mts';
import type { TriggerResult } from './mapTrigger.mts';
import type { ExprScope, Resolved, Seg } from './mapExpr.mts';
import type { Reshape } from './plan.mts';
import { segText } from './mapExpr.mts';
import { nextcloudPayloadPath } from './payload.mts';
import { stepIdFor } from './util.mts';

export type Step = Record<string, unknown> & { id: string; type: string };
export interface Edge { from: string; to: string; label?: string }
export interface Port { from: string; label?: string }

export interface Sink {
    nested: boolean;
    steps: Step[];
    edges: Edge[];
}

/** Where the result of a Windmill module can be read in Bee Flow. */
export interface OutputInfo {
    base: string;
    /** 'same': the shape is the same; null: unknown, a reference into it is an AI item. */
    reshape: Reshape | 'same' | null;
    /** The graph (root '' or a layer key) the path is valid in. */
    graph: string;
    /** The loop bodies the path is valid in (outermost first). */
    loops: string[];
}

export interface LayerScope {
    key: string;
    /** Param name to the binding the call_layer passes. */
    params: Map<string, { kind: 'ref'; path: string }>;
}

export interface MapCtx {
    flow: WmFlow;
    bundle: WmBundle;
    report: ReportBuilder;
    caps: Capabilities;
    trigger: TriggerResult;
    /** Step ids in use per graph. */
    ids: Map<string, Set<string>>;
    outputs: Map<string, OutputInfo>;
    layers: Record<string, Record<string, unknown>>;
    /** Notes with sources, put in the root graph (a note never sits in a body). */
    rootNotes: Step[];
    sink: Sink;
    graph: string;
    loops: string[];
    iter: { value: string; index: string } | null;
    approval: { stepId: string; expiredToRejected: boolean } | null;
    layerScope: LayerScope | null;
    /** The last static tableId a Tables step named, for "edit a row" (Hub). */
    tableHint: WmInput | null;
    /** Subflow paths being converted, against recursion. */
    subflows: string[];
    /** Inside a layer: the graph and loops of the step that calls it, and its loop item. */
    parent: { graph: string; loops: string[]; iter: MapCtx['iter']; approval: MapCtx['approval'] } | null;
}

export function newId(ctx: MapCtx, wmId: string): string {
    let set = ctx.ids.get(ctx.graph);
    if (!set) { set = new Set(['trg']); ctx.ids.set(ctx.graph, set); }
    return stepIdFor(wmId, set);
}

/** Append a step, wire it from the open ports, and answer its own port. */
export function addStep(ctx: MapCtx, step: Step, ports: Port[]): Port[] {
    ctx.sink.steps.push(step);
    if (!ctx.sink.nested) {
        for (const p of ports) ctx.sink.edges.push(p.label ? { from: p.from, to: step.id, label: p.label } : { from: p.from, to: step.id });
    }
    return [{ from: step.id }];
}

export function register(ctx: MapCtx, wmId: string, base: string, reshape: OutputInfo['reshape']): void {
    ctx.outputs.set(wmId, { base, reshape, graph: ctx.graph, loops: [...ctx.loops] });
}

// ── The expression scope ─────────────────────────────────────────────────

export interface ScopeExtras {
    current?: string;
    previous?: string;
}

export function scopeFor(ctx: MapCtx, extras: ScopeExtras = {}): ExprScope {
    return {
        flowInput: (segs) => flowInputPath(ctx, segs),
        result: (id, segs) => resultPath(ctx, id, segs),
        resume: (name, segs) => (ctx.layerScope ? { unsupported: 'An approval result is not passed into a sub-flow.' } : resumePath(ctx, name, segs)),
        current: extras.current ? (segs) => ({ path: `${extras.current}${segText(segs)}` }) : undefined,
        previous: extras.previous ? (segs) => ({ path: `${extras.previous}${segText(segs)}` }) : undefined,
    };
}

/** A path of the calling graph, passed into the layer as a parameter. */
function fromParent(ctx: MapCtx, r: Resolved): Resolved {
    return ctx.layerScope && 'path' in r ? toLayerParam(ctx.layerScope, r) : r;
}

function flowInputPath(ctx: MapCtx, segs: Seg[]): Resolved {
    const head = segs[0];
    if (head && head.v === 'iter') {
        const own = ctx.iter;
        const iter = own ?? ctx.parent?.iter ?? null;
        if (!iter) return { unsupported: '"flow_input.iter" is only known inside a loop.' };
        const which = segs[1]?.v;
        let r: Resolved;
        if (which === 'value') r = { path: `${iter.value}${segText(segs.slice(2))}` };
        else if (which === 'index') r = { path: iter.index };
        else return { unsupported: 'Only flow_input.iter.value and .index are known.' };
        return own ? r : fromParent(ctx, r);
    }
    if (ctx.layerScope && ctx.layerScope.key.startsWith('subflow_')) return { path: `trigger.output${segText(segs)}` };
    const r = triggerPath(ctx, segs);
    return ctx.layerScope ? fromParent(ctx, r) : r;
}

function triggerPath(ctx: MapCtx, segs: Seg[]): Resolved {
    const t = ctx.trigger;
    if (t.payload !== 'nextcloud' && segs[0]?.v === 'authentication') return { drop: 'The Nextcloud connection of the trigger: Bee Flow\'s connector signs in itself.' };
    if (t.payload === 'nextcloud') {
        const hit = t.event ? nextcloudPayloadPath(t.event, segs) : null;
        if (!hit) return { unsupported: `flow_input${segText(segs)} has no field in the Bee Flow trigger.` };
        if (!('field' in hit)) return { drop: 'The Nextcloud connection of the trigger: Bee Flow\'s connector signs in itself.' };
        return { path: `trigger.output.${hit.field}${segText(hit.rest)}`, ...(hit.medium ? { confidence: 'medium' as const } : {}) };
    }
    if (t.payload === 'schedule') {
        const name = segs[0]?.v;
        if (typeof name === 'string' && name in t.vars) return { path: `vars.${name}${segText(segs.slice(1))}` };
        return { unsupported: `flow_input${segText(segs)} is not one of the schedule's arguments.` };
    }
    return { path: `trigger.output${segText(segs)}` };
}

function resultPath(ctx: MapCtx, id: string, segs: Seg[]): Resolved {
    const info = ctx.outputs.get(id);
    if (!info) return { unsupported: `The step "${id}" is not known (it may sit inside a branch, a loop or a step that was not converted).` };
    if (info.graph === ctx.graph && isPrefix(info.loops, ctx.loops)) return shaped(info, id, segs);
    const parent = ctx.parent;
    if (ctx.layerScope && parent && info.graph === parent.graph && isPrefix(info.loops, parent.loops)) return fromParent(ctx, shaped(info, id, segs));
    return { unsupported: `The step "${id}" runs inside a loop or a sub-flow; its result is not visible here.` };
}

function shaped(info: OutputInfo, id: string, segs: Seg[]): Resolved {
    if (info.reshape === 'same') return { path: `${info.base}${segText(segs)}` };
    if (info.reshape === null) {
        if (segs.length === 0) return { path: info.base, confidence: 'medium' };
        return { unsupported: `The result of "${id}" has a different shape in Bee Flow; ${segText(segs).slice(1)} cannot be found in it.` };
    }
    const r = info.reshape(segs);
    if (!r) return { unsupported: `The result of "${id}" has a different shape in Bee Flow; ${segText(segs).slice(1) || 'it'} cannot be found in it.` };
    return { path: `${info.base}${segText(r.segs)}`, ...(r.medium ? { confidence: 'medium' as const } : {}) };
}

function isPrefix(a: string[], b: string[]): boolean {
    return a.length <= b.length && a.every((x, i) => x === b[i]);
}

function resumePath(ctx: MapCtx, name: string, segs: Seg[]): Resolved {
    if (!ctx.approval) return { unsupported: `"${name}" is only known after an approval step.` };
    const base = `steps.${ctx.approval.stepId}.output`;
    if (name === 'approvers') return { path: `${base}.by`, confidence: 'medium' };
    if (name !== 'resume') return { unsupported: `"${name}" (every resume payload) has no counterpart.` };
    if (segs.length === 1 && segs[0].v === 'error') return { dsl: `${base}.approved == false` };
    if (segs.length === 0) return { unsupported: 'The whole resume payload has no counterpart.' };
    return { path: `${base}.answers${segText(segs)}` };
}

/** A path from outside a layer, as a layer parameter (`trigger.output.<param>…`). */
function toLayerParam(layer: LayerScope, r: { path: string; confidence?: 'high' | 'medium' }): Resolved {
    const p = r.path;
    if (p.startsWith('vars.')) return r;
    const split = splitBase(p);
    if (!split) return { unsupported: `"${p}" cannot be passed into the sub-flow.` };
    if (split.base === 'trigger.output' && layer.key.startsWith('subflow_')) return r;
    layer.params.set(split.param, { kind: 'ref', path: split.base });
    return { path: `trigger.output.${split.param}${split.rest}`, ...(r.confidence ? { confidence: r.confidence } : {}) };
}

function splitBase(p: string): { base: string; param: string; rest: string } | null {
    if (p.startsWith('trigger.output')) return { base: 'trigger.output', param: 'p_trigger', rest: p.slice('trigger.output'.length) };
    if (p.startsWith('loop.')) {
        const end = firstBoundary(p, 'loop.'.length);
        const name = p.slice('loop.'.length, end);
        return { base: p.slice(0, end), param: name === '_index' ? 'p_index' : `p_${name}`, rest: p.slice(end) };
    }
    if (p.startsWith('steps.')) {
        const end = firstBoundary(p, 'steps.'.length);
        const id = p.slice('steps.'.length, end);
        const after = p.slice(end);
        if (!after.startsWith('.output')) return null;
        return { base: `steps.${id}.output`, param: `p_${id}`, rest: after.slice('.output'.length) };
    }
    return null;
}

function firstBoundary(p: string, from: number): number {
    let i = from;
    while (i < p.length && p[i] !== '.' && p[i] !== '[') i += 1;
    return i;
}
