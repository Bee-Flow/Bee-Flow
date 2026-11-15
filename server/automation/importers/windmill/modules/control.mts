/**
 * Control-flow modules (PLAN B3, research 06 §C.1):
 *
 *   branchone    -> condition (one branch + default) or switch ({name, expr} cases, default port);
 *                   right after an approval, `resume?.error` becomes the approval's on_rejected edge
 *   branchall    -> parallel (each branch a linear list; a branch that branches runs as a flowlet)
 *   forloopflow  -> a per-step forEach when the body is one forEach-capable step, else a loop
 *                   (a body that branches runs as one call_layer per item)
 *   whileloopflow-> AI (no Bee Flow loop repeats until a condition)
 *   flow         -> definition.layers.<key> + call_layer (an approval inside cannot be in a flowlet)
 *
 * The recursion into child modules is handed in (`Recurse`) so this module
 * does not import the sequence mapper back.
 */

import type { WmBranch, WmNode } from '../ir.mts';
import type { MapCtx, Port, Sink, Step } from '../context.mts';
import type { Binding } from '../mapExpr.mts';
import { addStep, newId, register, scopeFor } from '../context.mts';
import { bindInputs, flagUntranslated, labelOf, placeholder, reportModule } from '../emit.mts';
import { translateInput, translateRule } from '../mapExpr.mts';
import { resumeTest } from '../jsShapes.mts';
import { APPROVAL_EXPIRED_EDGE } from '../targetNames.mts';
import { asObject, entries, slug } from '../util.mts';

export type Recurse = (ctx: MapCtx, nodes: WmNode[], ports: Port[]) => Port[];

const FOREACH_TYPES = new Set(['integration_action', 'ai_step', 'code', 'notification', 'set', 'http_request', 'datatable', 'knowledge_write', 'data_extraction', 'slide', 'read_table', 'table']);
const MAX_LOOP = 1000;

/** True when the modules can be written as a linear list (a body without edges). */
export function canBeLinear(nodes: WmNode[]): boolean {
    return nodes.every((n) => {
        const o = n.options;
        if (o.skipIf || o.stopAfterIf || o.continueOnError || o.suspend) return false;
        if (n.kind === 'branchone') return false;
        return true;
    });
}

// ── branchone ────────────────────────────────────────────────────────────

export function mapBranchOne(ctx: MapCtx, node: WmNode, ports: Port[], recurse: Recurse): Port[] {
    const branches = node.branches ?? [];
    const fallback = node.defaultBranch ?? [];
    const approvalPorts = approvalOutcome(ctx, branches, fallback, ports);
    if (approvalPorts) {
        const exits = [...recurse(ctx, approvalPorts.rejected.nodes, approvalPorts.rejectedPorts), ...recurse(ctx, approvalPorts.approved, approvalPorts.approvedPorts)];
        reportModule(ctx, node, ['pattern', 'high', 'The branch on the approval outcome becomes the approval\'s "rejected" path.', []]);
        return exits;
    }
    if (branches.length === 0) return recurse(ctx, fallback, ports);
    const rules = branches.map((b) => translateRule(b.expr ?? 'false', scopeFor(ctx)));
    const failed = rules.filter((r) => r.kind === 'ai');
    let inPorts = ports;
    if (failed.length) {
        inPorts = placeholder(ctx, { ...node, wmId: `${node.wmId}_condition`, summary: `${labelOf(node, 'Branch')}: condition` }, 'A branch condition has no Bee Flow expression yet; the branches below are kept, behind a condition that is always false.', ports, {
            inputs: Object.fromEntries(branches.map((b, i) => [b.summary || `branch ${i + 1}`, { expr: b.expr ?? '' }])),
        });
    }
    const job: BranchJob = { node, exprs: rules.map((r) => (r.kind === 'rule' ? r.expr : 'false')), branches, fallback, failed: failed.length > 0 };
    return branches.length === 1 ? writeCondition(ctx, job, inPorts, recurse) : writeSwitch(ctx, job, inPorts, recurse);
}

interface BranchJob { node: WmNode; exprs: string[]; branches: WmBranch[]; fallback: WmNode[]; failed: boolean }

interface ApprovalPorts { rejected: WmBranch; rejectedPorts: Port[]; approved: WmNode[]; approvedPorts: Port[] }

function approvalOutcome(ctx: MapCtx, branches: WmBranch[], fallback: WmNode[], ports: Port[]): ApprovalPorts | null {
    const ap = ctx.approval;
    if (!ap || ports.length !== 1 || ports[0].from !== ap.stepId || ports[0].label || branches.length !== 1) return null;
    const test = resumeTest(branches[0].expr ?? '');
    if (test !== 'rejected') return null;
    const rejectedPorts: Port[] = [{ from: ap.stepId, label: 'on_rejected' }];
    if (ap.expiredToRejected) {
        if (ctx.caps.onExpiredEdge) rejectedPorts.push({ from: ap.stepId, label: APPROVAL_EXPIRED_EDGE });
        else ctx.report.warn('approval_expiry', 'When the approval runs out of time the run now ends; in Windmill it went on along the "rejected" branch.');
    }
    return { rejected: branches[0], rejectedPorts, approved: fallback, approvedPorts: [{ from: ap.stepId }] };
}

function writeCondition(ctx: MapCtx, job: BranchJob, ports: Port[], recurse: Recurse): Port[] {
    const { node, fallback, failed } = job;
    const branch = job.branches[0];
    const expr = job.exprs[0];
    const id = newId(ctx, node.wmId);
    addStep(ctx, { id, type: 'condition', label: labelOf(node, branch.summary || 'Condition'), expr }, ports);
    register(ctx, node.wmId, `steps.${id}.output`, null);
    reportModule(ctx, node, [failed ? 'ai' : 'mapped', failed ? 'low' : 'high', 'One branch and a default become a condition.', [id]]);
    const thenExits = branch.nodes.length ? recurse(ctx, branch.nodes, [{ from: id, label: 'then' }]) : [{ from: id, label: 'then' }];
    const elseExits = fallback.length ? recurse(ctx, fallback, [{ from: id, label: 'else' }]) : [{ from: id, label: 'else' }];
    return [...thenExits, ...elseExits];
}

function writeSwitch(ctx: MapCtx, job: BranchJob, ports: Port[], recurse: Recurse): Port[] {
    const { node, exprs, branches, fallback, failed } = job;
    const id = newId(ctx, node.wmId);
    const names = new Set<string>();
    const cases = branches.map((b, i) => {
        let name = slug(b.summary ?? '', `b${i + 1}`);
        if (name === 'default' || names.has(name)) name = `b${i + 1}`;
        names.add(name);
        return { name, expr: exprs[i] };
    });
    addStep(ctx, { id, type: 'switch', label: labelOf(node, 'Branch'), cases }, ports);
    register(ctx, node.wmId, `steps.${id}.output`, null);
    reportModule(ctx, node, [failed ? 'ai' : 'mapped', failed ? 'low' : 'high', 'The first matching branch wins: a switch with one rule per case.', [id]]);
    const exits: Port[] = [];
    branches.forEach((b, i) => {
        const port = { from: id, label: `case:${cases[i].name}` };
        exits.push(...(b.nodes.length ? recurse(ctx, b.nodes, [port]) : [port]));
    });
    const dport = { from: id, label: 'case:default' };
    exits.push(...(fallback.length ? recurse(ctx, fallback, [dport]) : [dport]));
    return exits;
}

// ── Sub-graphs: linear bodies and flowlets ───────────────────────────────

/** Map modules into a linear list (a loop body or a parallel branch). */
function linearBody(ctx: MapCtx, nodes: WmNode[], recurse: Recurse, scope: string, iter: MapCtx['iter']): { steps: Step[]; ctx: MapCtx } {
    const sink: Sink = { nested: true, steps: [], edges: [] };
    const inner: MapCtx = { ...ctx, sink, loops: [...ctx.loops, scope], iter };
    recurse(inner, nodes, []);
    return { steps: sink.steps, ctx: inner };
}

function uniqueLayerKey(ctx: MapCtx, base: string): string {
    let key = base.slice(0, 50);
    for (let n = 2; ctx.layers[key]; n += 1) key = `${base.slice(0, 46)}_${n}`;
    return key;
}

export interface LayerSpec {
    title: string;
    nodes: WmNode[];
    keyBase: string;
    /** The layer runs once per loop item: `flow_input.iter` reads its params. */
    loopItem?: string;
    /** Declared params with their bindings (a subflow's inputs). */
    params?: Array<{ name: string; type: string; binding?: Binding }>;
}

/** Build a flowlet from modules and answer the call_layer step that runs it (not yet added). */
export function buildLayer(ctx: MapCtx, spec: LayerSpec, recurse: Recurse, callId: string): { step: Step; base: string } {
    const key = uniqueLayerKey(ctx, spec.keyBase);
    ctx.layers[key] = { title: spec.title };
    ctx.ids.set(key, new Set(['trg', 'out']));
    const sink: Sink = { nested: false, steps: [], edges: [] };
    const layerCtx: MapCtx = {
        ...ctx, sink, graph: key, loops: [], approval: null,
        iter: spec.loopItem ? { value: 'trigger.output.item', index: 'trigger.output.index' } : null,
        layerScope: { key, params: new Map() },
        parent: { graph: ctx.graph, loops: ctx.loops, iter: ctx.iter, approval: ctx.approval },
    };
    const exits = recurse(layerCtx, spec.nodes, [{ from: 'trg' }]);
    const last = spec.nodes.length ? ctx.outputs.get(spec.nodes[spec.nodes.length - 1].wmId) : undefined;
    const fields = last && last.graph === key ? { result: { kind: 'ref', path: last.base } } : {};
    addStep(layerCtx, { id: 'out', type: 'layer_output', label: 'Return', fields }, exits);
    const inputs: Record<string, Binding> = {};
    const params: Array<{ name: string; type: string }> = [];
    if (spec.loopItem) {
        params.push({ name: 'item', type: 'object' }, { name: 'index', type: 'number' });
        inputs.item = { kind: 'ref', path: `loop.${spec.loopItem}` };
        inputs.index = { kind: 'ref', path: 'loop._index' };
    }
    for (const p of spec.params ?? []) {
        params.push({ name: p.name, type: p.type });
        if (p.binding) inputs[p.name] = p.binding;
    }
    for (const [name, binding] of layerCtx.layerScope?.params ?? []) {
        params.push({ name, type: 'object' });
        inputs[name] = binding;
    }
    ctx.layers[key] = { title: spec.title, trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params }, steps: sink.steps, edges: sink.edges };
    return { step: { id: callId, type: 'call_layer', label: spec.title, layerKey: key, inputs }, base: `steps.${callId}.output.result` };
}

// ── branchall ────────────────────────────────────────────────────────────

export function mapBranchAll(ctx: MapCtx, node: WmNode, ports: Port[], recurse: Recurse): Port[] {
    const branches = node.branches ?? [];
    const id = newId(ctx, node.wmId);
    const lists = branches.map((b, i) => branchList(ctx, b, i, id, recurse));
    const skip = branches.map((b) => b.skipFailure === true);
    if (skip.some(Boolean) && !skip.every(Boolean)) ctx.report.warn('option_approximated', 'Some branches were allowed to fail and others not; the parallel step now fails when any branch fails.', node.wmId);
    const out = addStep(ctx, { id, type: 'parallel', label: labelOf(node, 'In parallel'), branches: lists, failOnAnyBranchError: !skip.every(Boolean) || skip.length === 0 }, ports);
    register(ctx, node.wmId, `steps.${id}.output.branches`, (segs) => {
        const first = segs[0];
        if (!first || first.kind !== 'index') return null;
        return { segs: [first, { kind: 'name', v: 'output' }, ...segs.slice(1)] };
    });
    branches.forEach((b, i) => {
        const last = b.nodes[b.nodes.length - 1];
        const info = last ? ctx.outputs.get(last.wmId) : undefined;
        if (!last || !info || info.graph !== ctx.graph || !info.base.startsWith('steps.')) return;
        ctx.outputs.set(last.wmId, { base: `steps.${id}.output.branches[${i}].output${baseTail(info.base)}`, reshape: info.reshape, graph: ctx.graph, loops: [...ctx.loops] });
    });
    if (!node.loop?.parallel) ctx.report.warn('option_approximated', 'The branches ran one after the other in Windmill; in Bee Flow they run side by side.', node.wmId);
    reportModule(ctx, node, ['mapped', 'medium', 'All branches run: a parallel step.', [id]]);
    return out;
}

/** What follows `.output` in a step path (`.result` for a code step). */
function baseTail(base: string): string {
    const at = base.indexOf('.output');
    return at === -1 ? '' : base.slice(at + '.output'.length);
}

function branchList(ctx: MapCtx, branch: WmBranch, i: number, parId: string, recurse: Recurse): Step[] {
    if (canBeLinear(branch.nodes)) return linearBody(ctx, branch.nodes, recurse, `${parId}#${i}`, ctx.iter).steps;
    const scoped: MapCtx = { ...ctx, loops: [...ctx.loops, `${parId}#${i}`] };
    const callId = newId(ctx, `${parId}_branch_${i + 1}`);
    const { step } = buildLayer(scoped, { title: branch.summary || `Branch ${i + 1}`, nodes: branch.nodes, keyBase: slug(branch.summary ?? '', `branch_${i + 1}`) }, recurse, callId);
    return [step];
}

// ── Loops ────────────────────────────────────────────────────────────────

function itemVarFor(ctx: MapCtx): string {
    const depth = ctx.loops.filter((l) => !l.includes('#')).length;
    return depth === 0 ? 'item' : `item${depth + 1}`;
}

/** The list a loop walks, as a ref path (an expression iterator first goes through a set step). */
function overRefFor(ctx: MapCtx, node: WmNode, ports: Port[]): { overRef: string; ports: Port[] } | { problem: string } {
    if (!node.iterator) return { problem: 'The loop has no list to walk.' };
    const r = translateInput(node.iterator, scopeFor(ctx));
    if (r.kind !== 'binding') return { problem: r.kind === 'ai' ? r.reason : 'The loop list could not be read.' };
    if (r.binding.kind === 'ref') return { overRef: r.binding.path, ports };
    const id = newId(ctx, `${node.wmId}_list`);
    const out = addStep(ctx, { id, type: 'set', label: `${labelOf(node, 'Loop')}: list`, fields: { items: r.binding } }, ports);
    return { overRef: `steps.${id}.output.items`, ports: out };
}

export function mapForLoop(ctx: MapCtx, node: WmNode, ports: Port[], recurse: Recurse): Port[] {
    const list = overRefFor(ctx, node, ports);
    if ('problem' in list) return placeholder(ctx, node, list.problem, ports);
    const itemVar = itemVarFor(ctx);
    const children = node.children ?? [];
    const id = newId(ctx, node.wmId);
    let body: Step[];
    if (canBeLinear(children)) {
        body = linearBody(ctx, children, recurse, id, { value: `loop.${itemVar}`, index: 'loop._index' }).steps;
        if (children.length === 1 && body.length === 1 && FOREACH_TYPES.has(body[0].type)) {
            return addSingle(ctx, node, withForEach(ctx, node, body[0], list.overRef, itemVar), list.ports);
        }
    } else {
        const scoped: MapCtx = { ...ctx, loops: [...ctx.loops, id] };
        const callId = newId(ctx, `${node.wmId}_each`);
        body = [buildLayer(scoped, { title: `${labelOf(node, 'Loop')}: each item`, nodes: children, keyBase: slug(node.summary ?? '', `${slug(node.wmId, 'loop')}_each`), loopItem: itemVar }, recurse, callId).step];
    }
    if (body.length === 0) return placeholder(ctx, node, 'The loop body converted to nothing.', list.ports);
    return writeLoop(ctx, node, { id, body, overRef: list.overRef, itemVar }, list.ports);
}

function withForEach(ctx: MapCtx, node: WmNode, step: Step, overRef: string, itemVar: string): Step {
    const forEach: Record<string, unknown> = { overRef, itemVar, maxIterations: MAX_LOOP };
    if (node.loop?.parallel) {
        const canRunTogether = (step.type === 'ai_step' && !step.allowTools) || step.type === 'data_extraction';
        if (canRunTogether) forEach.concurrency = Math.max(1, Math.min(node.loop.parallelism ?? 4, 1000));
        else ctx.report.warn('parallel_serial', `"${labelOf(node, 'Loop')}" ran its items at the same time; this kind of step runs them one by one.`, node.wmId);
    }
    step.forEach = forEach;
    return step;
}

function addSingle(ctx: MapCtx, node: WmNode, step: Step, ports: Port[]): Port[] {
    const out = addStep(ctx, step, ports);
    const child = node.children?.[0];
    const info = child ? ctx.outputs.get(child.wmId) : undefined;
    const tail = info ? baseTail(info.base) : '';
    register(ctx, node.wmId, `steps.${step.id}.output.results[*].output${tail}`, info ? info.reshape : null);
    if (!node.loop?.skipFailures) ctx.report.warn('option_approximated', `"${labelOf(node, 'Loop')}" now carries on past an item that fails and fails only when every item failed; in Windmill the first failure stopped the loop.`, node.wmId);
    reportModule(ctx, node, ['mapped', 'high', 'A loop around one step becomes that step with "for each".', [step.id]]);
    return out;
}

function writeLoop(ctx: MapCtx, node: WmNode, loop: { id: string; body: Step[]; overRef: string; itemVar: string }, ports: Port[]): Port[] {
    const { id, body, overRef, itemVar } = loop;
    const children = node.children ?? [];
    const out = addStep(ctx, { id, type: 'loop', label: labelOf(node, 'Repeat for each'), overRef, itemVar, maxIterations: MAX_LOOP, body }, ports);
    const last = children[children.length - 1];
    const info = last ? ctx.outputs.get(last.wmId) : undefined;
    const linear = canBeLinear(children) && info && info.graph === ctx.graph;
    register(ctx, node.wmId, `steps.${id}.output.results[*].output${linear ? baseTail(info.base) : '.result'}`, linear ? info.reshape : 'same');
    if (node.loop?.parallel) ctx.report.warn('parallel_serial', `"${labelOf(node, 'Loop')}" ran its items at the same time; a Bee Flow loop runs them one by one.`, node.wmId);
    if (node.loop?.skipFailures) ctx.report.warn('option_approximated', `"${labelOf(node, 'Loop')}" carried on past failed items; a Bee Flow loop stops at the first failure.`, node.wmId);
    reportModule(ctx, node, ['mapped', 'medium', 'A loop over several steps.', [id]]);
    return out;
}

export function mapWhileLoop(ctx: MapCtx, node: WmNode, ports: Port[]): Port[] {
    const stop = node.options.stopAfterIf?.expr ?? (node.children ?? []).map((c) => c.options.stopAfterIf?.expr).find(Boolean);
    const why = `Bee Flow has no loop that repeats until a condition${stop ? ` ("${stop}")` : ''}; the builder can use a loop with a fixed maximum, or a schedule.`;
    return placeholder(ctx, node, why, ports);
}

// ── Subflows ─────────────────────────────────────────────────────────────

export function mapSubflow(ctx: MapCtx, node: WmNode, ports: Port[], recurse: Recurse): Port[] {
    const sub = ctx.bundle.flows.find((f) => f.path === node.scriptPath);
    if (!sub) return placeholder(ctx, node, `The sub-flow ${node.scriptPath ?? ''} is not in the export.`, ports);
    if (ctx.subflows.includes(sub.path)) return placeholder(ctx, node, 'The sub-flow calls itself.', ports, { status: 'unsupported' });
    if (hasSuspend(sub.nodes)) return placeholder(ctx, node, 'The sub-flow asks for an approval, which a flowlet cannot do; the builder can put its steps into this flow instead.', ports);
    const bound = bindInputs(ctx, node, node.inputs);
    const params = entries(asObject(sub.schema?.properties)).map(([name, raw]) => {
        const t = asObject(raw).type;
        const type = t === 'integer' || t === 'number' ? 'number' : (t === 'boolean' || t === 'array' || t === 'object' ? String(t) : 'string');
        return { name, type, ...(bound.bindings[name] ? { binding: bound.bindings[name] } : {}) };
    });
    const callId = newId(ctx, node.wmId);
    const inner: MapCtx = { ...ctx, subflows: [...ctx.subflows, sub.path] };
    const { step, base } = buildLayer(inner, { title: sub.summary, nodes: sub.nodes, keyBase: `subflow_${slug(sub.summary, 'flow')}`, params }, recurse, callId);
    const out = addStep(ctx, step, ports);
    register(ctx, node.wmId, base, 'same');
    flagUntranslated(ctx, node, callId, bound);
    reportModule(ctx, node, ['mapped', bound.untranslated.length ? 'low' : 'medium', 'The sub-flow becomes a flowlet of this automation.', [callId]]);
    return out;
}

function hasSuspend(nodes: WmNode[]): boolean {
    return nodes.some((n) => !!n.options.suspend || hasSuspend(n.children ?? []) || (n.branches ?? []).some((b) => hasSuspend(b.nodes)) || hasSuspend(n.defaultBranch ?? []));
}
