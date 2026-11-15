/**
 * The per-module options of a Windmill flow around the step they belong to
 * (PLAN B3 mapOptions.mts, research 06 §C.2):
 *
 *   skip_if            -> a condition before the step (then: the step, else: past it)
 *   suspend            -> an approval after the step (the step itself goes when all it does is make the
 *                         approval link); expiresInHours = ceil(timeout / 3600), at most 720
 *   retry              -> step.retry { max <= 5, backoffMs <= 300000 } (exponential: approximated)
 *   continue_on_error  -> an on_error edge from the step to what follows
 *   mock               -> pinnedOutput (a test leftover: warned)
 *   cache_ttl          -> askOnce on an AI step, else dropped
 *   stop_after_if      -> a condition after the step (then: end, or stop_error with the message)
 *   sleep              -> a wait step after the step (at most 86400 s)
 *   timeout, priority, debouncing, tag, job_token_scopes -> dropped, reported
 *   retry.retry_if, stop_after_all_iters_if, a sleep that is an expression -> AI checklist
 */

import type { WmNode } from './ir.mts';
import type { MapCtx, Port, Step } from './context.mts';
import { addStep, newId, scopeFor } from './context.mts';
import { labelOf, placeholder, reportModule } from './emit.mts';
import { translateInput, translateRule } from './mapExpr.mts';
import { scrubValue } from './scrub.mts';
import { formFields } from './mapTrigger.mts';
import { isApprovalCarrier } from './modules/script.mts';

const ON_ERROR_SOURCES = new Set(['integration_action', 'ai_step', 'code', 'call_layer', 'call_block', 'loop', 'parallel', 'notification', 'wait', 'http_request', 'data_extraction', 'generate_document', 'fill_document', 'presentation']);
const RETRY_SOURCES = new Set(['integration_action', 'ai_step', 'code', 'http_request', 'data_extraction', 'notification']);
const MAX_WAIT_S = 86400;
const MAX_APPROVAL_HOURS = 720;

export type Core = (ctx: MapCtx, node: WmNode, ports: Port[]) => Port[];

export function mapWithOptions(ctx: MapCtx, node: WmNode, ports: Port[], core: Core): Port[] {
    reportDropped(ctx, node);
    let inPorts = ports;
    let skipped: Port[] = [];
    if (node.options.skipIf) {
        const pre = skipCondition(ctx, node, ports);
        inPorts = pre.then;
        skipped = pre.skipped;
    }
    const before = ctx.sink.steps.length;
    const carrier = !!node.options.suspend && isApprovalCarrier(ctx, node);
    let exits = carrier ? inPorts : core(ctx, node, inPorts);
    const main = carrier ? null : primaryStep(ctx, before, exits);
    if (main) applyStepOptions(ctx, node, main);
    if (node.options.suspend) exits = approvalAfter(ctx, node, exits, carrier);
    if (main && node.options.continueOnError && ON_ERROR_SOURCES.has(main.type)) exits = [...exits, { from: main.id, label: 'on_error' }];
    if (node.options.stopAfterIf) exits = stopAfter(ctx, node, exits);
    if (node.options.sleep) exits = sleepAfter(ctx, node, exits);
    return [...exits, ...skipped];
}

/** The step a module became: the one its single plain exit leaves from, when it was added just now. */
function primaryStep(ctx: MapCtx, before: number, exits: Port[]): Step | null {
    if (exits.length !== 1 || exits[0].label) return null;
    const added = ctx.sink.steps.slice(before);
    return added.find((s) => s.id === exits[0].from) ?? null;
}

function reportDropped(ctx: MapCtx, node: WmNode): void {
    const o = node.options;
    const dropped = [...o.reportOnly];
    if (o.timeout) dropped.push('timeout');
    for (const name of dropped) ctx.report.warn('option_dropped', `"${labelOf(node, node.wmId)}": the Windmill setting "${name}" has no Bee Flow counterpart and was left out.`, node.wmId);
    if (o.deleteAfterSecs !== undefined) {
        ctx.report.warn('privacy_retention', `"${labelOf(node, node.wmId)}" deleted its run data after ${o.deleteAfterSecs} s in Windmill; Bee Flow keeps run data per automation, at least 7 days. Set the shortest retention in the automation settings.`, node.wmId);
    }
    if (o.retry?.retryIf) ctx.report.ai({ wmId: node.wmId, stepId: null, title: `Retry condition of "${labelOf(node, node.wmId)}"`, why: 'Windmill retried only when a condition held; Bee Flow retries on every failure.', source: o.retry.retryIf });
    if (o.stopAfterAllItersIf) ctx.report.ai({ wmId: node.wmId, stepId: null, title: `Stop condition after the loop "${labelOf(node, node.wmId)}"`, why: 'A stop condition checked after all iterations is not converted.', source: o.stopAfterAllItersIf.expr });
}

function skipCondition(ctx: MapCtx, node: WmNode, ports: Port[]): { then: Port[]; skipped: Port[] } {
    const rule = translateRule(node.options.skipIf ?? 'false', scopeFor(ctx));
    if (rule.kind === 'ai' || ctx.sink.nested) {
        ctx.report.ai({ wmId: node.wmId, stepId: null, title: `Skip condition of "${labelOf(node, node.wmId)}"`, why: rule.kind === 'ai' ? rule.reason : 'A skip condition inside a loop body is not converted.', source: node.options.skipIf });
        return { then: ports, skipped: [] };
    }
    const id = newId(ctx, `${node.wmId}_run`);
    addStep(ctx, { id, type: 'condition', label: `Run "${labelOf(node, node.wmId)}"?`, expr: `!(${rule.expr})` }, ports);
    return { then: [{ from: id, label: 'then' }], skipped: [{ from: id, label: 'else' }] };
}

function applyStepOptions(ctx: MapCtx, node: WmNode, step: Step): void {
    const o = node.options;
    if (o.retry && (o.retry.constant || o.retry.exponential)) {
        if (!RETRY_SOURCES.has(step.type)) ctx.report.warn('option_dropped', `"${labelOf(node, node.wmId)}" retried in Windmill; this kind of step is not retried in Bee Flow.`, node.wmId);
        else step.retry = retryOf(ctx, node);
    }
    if (o.mock?.enabled) {
        const counter = { removed: 0 };
        step.pinnedOutput = scrubValue(o.mock.returnValue ?? null, counter);
        if (counter.removed) ctx.report.warn('secret_removed', `A value that looked like a secret was left out of the mocked answer of "${labelOf(node, node.wmId)}".`, node.wmId);
        step.pinnedSource = 'edited';
        ctx.report.warn('mock_pinned', `"${labelOf(node, node.wmId)}" was mocked in Windmill; it now answers that fixed value until you remove the pinned output.`, node.wmId);
    }
    if (o.cacheTtl !== undefined) {
        if (step.type === 'ai_step') step.askOnce = { ttlSeconds: Math.max(1, Math.min(900, Math.round(o.cacheTtl))) };
        else ctx.report.warn('option_dropped', `"${labelOf(node, node.wmId)}" cached its result in Windmill; that is not carried over.`, node.wmId);
    }
}

function retryOf(ctx: MapCtx, node: WmNode): { max: number; backoffMs: number } {
    const r = node.options.retry ?? {};
    if (r.constant) {
        return { max: clamp(r.constant.attempts ?? 1, 0, 5), backoffMs: clamp((r.constant.seconds ?? 0) * 1000, 0, 300_000) };
    }
    const e = r.exponential ?? {};
    ctx.report.warn('option_approximated', `"${labelOf(node, node.wmId)}" waited longer before each retry in Windmill; Bee Flow waits the same time every try.`, node.wmId);
    return { max: clamp(e.attempts ?? 1, 0, 5), backoffMs: clamp((e.seconds ?? 1) * (e.multiplier ?? 1) * 1000, 0, 300_000) };
}

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, Math.round(n)));
}

function stopAfter(ctx: MapCtx, node: WmNode, ports: Port[]): Port[] {
    const s = node.options.stopAfterIf;
    if (!s) return ports;
    const info = ctx.outputs.get(node.wmId);
    const rule = translateRule(s.expr, scopeFor(ctx, info ? { current: info.base } : {}));
    if (rule.kind === 'ai' || ctx.sink.nested) {
        ctx.report.ai({ wmId: node.wmId, stepId: null, title: `Stop condition after "${labelOf(node, node.wmId)}"`, why: rule.kind === 'ai' ? rule.reason : 'A stop condition inside a loop body is not converted.', source: s.expr });
        return ports;
    }
    const id = newId(ctx, `${node.wmId}_stop`);
    addStep(ctx, { id, type: 'condition', label: `Stop after "${labelOf(node, node.wmId)}"?`, expr: rule.expr }, ports);
    if (s.errorMessage) {
        const stopId = newId(ctx, `${node.wmId}_stopped`);
        addStep(ctx, { id: stopId, type: 'stop_error', label: 'Stopped', message: s.errorMessage }, [{ from: id, label: 'then' }]);
    }
    return [{ from: id, label: 'else' }];
}

function sleepAfter(ctx: MapCtx, node: WmNode, ports: Port[]): Port[] {
    const input = node.options.sleep;
    const r = input ? translateInput(input, scopeFor(ctx)) : null;
    const seconds = r && r.kind === 'binding' && r.binding.kind === 'literal' ? Number(r.binding.value) : NaN;
    if (!Number.isFinite(seconds) || seconds <= 0) {
        ctx.report.ai({ wmId: node.wmId, stepId: null, title: `Pause after "${labelOf(node, node.wmId)}"`, why: 'The pause was computed at run time; set a fixed wait.', source: input && input.type === 'javascript' ? input.expr : undefined });
        return ports;
    }
    if (seconds > MAX_WAIT_S) ctx.report.warn('option_approximated', `The pause after "${labelOf(node, node.wmId)}" was ${seconds} s; a Bee Flow wait lasts at most a day.`, node.wmId);
    const id = newId(ctx, `${node.wmId}_wait`);
    return addStep(ctx, { id, type: 'wait', label: 'Wait', seconds: Math.min(Math.ceil(seconds), MAX_WAIT_S) }, ports);
}

// ── Approval ─────────────────────────────────────────────────────────────

function approvalAfter(ctx: MapCtx, node: WmNode, ports: Port[], carrier: boolean): Port[] {
    const s = node.options.suspend ?? {};
    if (ctx.sink.nested || ctx.layerScope) {
        return placeholder(ctx, { ...node, wmId: `${node.wmId}_approval`, summary: `${labelOf(node, 'Approval')}: approval` }, 'An approval inside a loop, a parallel branch or a sub-flow cannot pause the run; the builder can move it to the main flow.', ports);
    }
    const id = newId(ctx, carrier ? node.wmId : `${node.wmId}_approval`);
    const approval: Record<string, unknown> = {};
    if (s.timeoutS !== undefined) {
        const hours = Math.max(1, Math.ceil(s.timeoutS / 3600));
        approval.expiresInHours = Math.min(hours, MAX_APPROVAL_HOURS);
        if (hours > MAX_APPROVAL_HOURS) ctx.report.warn('approval_expiry', `The approval waited ${hours} hours in Windmill; a Bee Flow approval waits at most 30 days.`, node.wmId);
    }
    const fields = s.resumeSchema ? formFields(s.resumeSchema, ctx.report) : [];
    if (fields.length) approval.fields = fields;
    const step: Step = { id, type: 'approval', label: labelOf(node, 'Approval'), prompt: approvalPrompt(ctx, node), approval };
    const out = addStep(ctx, step, ports);
    ctx.approval = { stepId: id, expiredToRejected: s.continueOnDisapproveTimeout === true };
    approvalWarnings(ctx, node);
    if (carrier) reportModule(ctx, node, ['pattern', 'high', 'The step made an approval link and waited for it: a Bee Flow approval.', [id]]);
    return out;
}

function approvalPrompt(ctx: MapCtx, node: WmNode): string {
    const src = node.inputs.description ?? node.inputs.message ?? node.inputs.title;
    if (src) {
        const r = translateInput(src, scopeFor(ctx));
        if (r.kind === 'binding') {
            const b = r.binding;
            if (b.kind === 'literal' && typeof b.value === 'string' && b.value.trim()) return b.value;
            if (b.kind === 'ref') return `{{${b.path}}}`;
            if (b.kind === 'template') return b.value;
        }
    }
    return `Approve "${labelOf(node, 'this step')}"?`;
}

function approvalWarnings(ctx: MapCtx, node: WmNode): void {
    const s = node.options.suspend ?? {};
    const who = (s.requiredEvents ?? 1) > 1 ? ` Windmill waited for ${s.requiredEvents} approvals: add that many approvers and a quorum.` : '';
    ctx.report.warn('approval_people', `Choose who approves "${labelOf(node, 'Approval')}": Windmill sent a link, Bee Flow asks a person or group in this organisation (deciding for a colleague needs Enterprise).${who}`, node.wmId);
    if (s.userGroupsRequired) ctx.report.warn('approval_people', 'Windmill limited who could approve to certain groups; pick those groups as approvers.', node.wmId);
    if (s.continueOnDisapproveTimeout) ctx.report.warn('approval_expiry', 'In Windmill a rejection or a timeout went on to the next step; in Bee Flow only the "rejected" path does, wired from the approval.', node.wmId);
}
