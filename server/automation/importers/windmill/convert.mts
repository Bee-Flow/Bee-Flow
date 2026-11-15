/**
 * One Windmill flow to a Bee Flow automation draft, with its report (PLAN B3 convert.mts).
 *
 * Deterministic and pure: no database, no network, no AI. The answer carries
 * the `beeflow.automation` envelope (automation/portability.js is the one
 * place that knows it; the import pipeline takes it from there), the
 * definition and trigger, and the report: what became of every module, the
 * AI checklist, the warnings, the connections to set up and the outbound
 * hosts. Run-policy settings are suggestions in the report, because the
 * envelope does not carry a run policy.
 */

import { createRequire } from 'node:module';
import type { WmBundle, WmFlow } from './ir.mts';
import type { Capabilities } from './capabilities.mts';
import type { FlowReport } from './report.mts';
import type { MapCtx, Step } from './context.mts';
import type { TriggerResult } from './mapTrigger.mts';
import type { ExprScope } from './mapExpr.mts';
import { ReportBuilder } from './report.mts';
import { capabilitiesFrom } from './capabilities.mts';
import { addStep, newId, scopeFor } from './context.mts';
import { mapTriggers } from './mapTrigger.mts';
import { mapSequence } from './mapModules.mts';
import { translateRule } from './mapExpr.mts';
import { refOf, allNodes } from './refs.mts';
import { scrubSource } from './scrub.mts';

const nodeRequire = createRequire(import.meta.url);
const { triggerColumnsFromDefinition } = nodeRequire('../../triggerColumns') as {
    triggerColumnsFromDefinition: (def: unknown) => { triggerType: string; scheduleCron: string | null; scheduleTz: string };
};
const { scrubAutomationDefinition } = nodeRequire('../../../core/packaging/scrub') as { scrubAutomationDefinition: (def: unknown, report: unknown[]) => unknown[] };
const { validateDefinition } = nodeRequire('../../validate') as {
    validateDefinition: (def: unknown, opts: { stage: string }) => { errors: Array<{ code: string; message: string }>; warnings: Array<{ code: string }> };
};

const ON_ERROR_SOURCES = new Set(['integration_action', 'ai_step', 'code', 'call_layer', 'loop', 'parallel', 'notification', 'http_request', 'data_extraction']);

export interface SuggestedRunPolicy {
    concurrency?: 'serial' | 'parallel';
    maxDurationMin?: number;
    retentionDays?: number;
}

export interface ConversionReport extends FlowReport {
    suggestedRunPolicy: SuggestedRunPolicy;
    suggestedWebhookAuth?: string;
    /** Validator codes of the draft (stage "draft"): errors must be empty for the import to save. */
    validation: { errors: string[]; warnings: string[] };
}

export interface FlowConversion {
    flowPath: string;
    title: string;
    envelope: { format: 'beeflow.automation'; schemaVersion: 1; automation: Record<string, unknown> };
    definition: Record<string, unknown>;
    trigger: Record<string, unknown>;
    report: ConversionReport;
}

export interface ConvertOptions {
    capabilities?: Partial<Capabilities>;
    /** Skip the validator pass (tests that only look at the shape). */
    skipValidation?: boolean;
}

export function convertFlow(flow: WmFlow, bundle: WmBundle, opts: ConvertOptions = {}): FlowConversion {
    const report = new ReportBuilder(flow.path);
    const trigger = mapTriggers(flow, bundle, report);
    const ctx = newContext(flow, bundle, report, trigger, capabilitiesFrom(opts.capabilities));
    mapSequence(ctx, flow.nodes, [{ from: 'trg' }]);
    for (const t of trigger.triggers) ctx.sink.edges.push(...firstEdgesFor(ctx, String(t.id)));
    mapFailure(ctx, flow);
    applyFlowOptions(ctx, flow);
    const definition = assemble(ctx, flow, trigger);
    flowWarnings(ctx, flow, bundle);
    return finish(flow, definition, trigger, report, opts);
}

function newContext(flow: WmFlow, bundle: WmBundle, report: ReportBuilder, trigger: TriggerResult, caps: Capabilities): MapCtx {
    return {
        flow, bundle, report, caps, trigger,
        ids: new Map([['', new Set(['trg', ...trigger.triggers.map((t) => String(t.id))])]]),
        outputs: new Map(), layers: {}, rootNotes: [],
        sink: { nested: false, steps: [], edges: [] }, graph: '', loops: [], iter: null, approval: null,
        layerScope: null, tableHint: null, subflows: [flow.path], parent: null,
    };
}

/** An extra trigger starts the same chain: wire it to the steps the primary trigger leads to. */
function firstEdgesFor(ctx: MapCtx, triggerId: string): Array<{ from: string; to: string }> {
    return ctx.sink.edges.filter((e) => e.from === 'trg' && !e.label).map((e) => ({ from: triggerId, to: e.to }));
}

// ── The failure module ───────────────────────────────────────────────────

function mapFailure(ctx: MapCtx, flow: WmFlow): void {
    if (!flow.failure) return;
    const sources = ctx.sink.steps.filter((s) => ON_ERROR_SOURCES.has(s.type) && !ctx.sink.edges.some((e) => e.from === s.id && e.label === 'on_error'));
    if (!sources.length) {
        ctx.report.warn('option_dropped', 'The flow\'s failure handler was left out: no step here can fail in a way Bee Flow routes.');
        return;
    }
    const before = ctx.sink.steps.length;
    const exits = mapSequence(ctx, [flow.failure], []);
    const entry = ctx.sink.steps[before];
    if (!entry) return;
    const last = ctx.sink.steps[ctx.sink.steps.length - 1];
    if (last && last.type !== 'stop_error') {
        const id = newId(ctx, 'failed');
        addStep(ctx, { id, type: 'stop_error', label: 'The run failed', message: 'A step failed; the failure handler from Windmill has run.' }, exits);
    }
    for (const s of sources) ctx.sink.edges.push({ from: s.id, to: entry.id, label: 'on_error' });
    ctx.report.warn('option_approximated', 'The flow\'s failure handler now runs from an error branch of every step that can fail, and the run still ends as failed.');
}

// ── Flow-level options ───────────────────────────────────────────────────

/** Trigger-filter scope: the filter reads `trigger.<field>`, not `trigger.output.<field>`. */
function filterScope(ctx: MapCtx): ExprScope {
    const base = scopeFor(ctx);
    return {
        flowInput: (segs) => {
            const r = base.flowInput(segs);
            return 'path' in r && r.path.startsWith('trigger.output') ? { ...r, path: `trigger${r.path.slice('trigger.output'.length)}` } : r;
        },
        result: () => ({ unsupported: 'A step result is not known when the trigger decides.' }),
    };
}

function applyFlowOptions(ctx: MapCtx, flow: WmFlow): void {
    const o = flow.options;
    if (o.skipExpr) applySkipExpr(ctx, o.skipExpr);
    for (const name of o.reportOnly) {
        const msg = name.startsWith('debounce')
            ? 'Windmill grouped runs that came in quickly (debounce); Bee Flow starts a run per event. A "Remove duplicates" step can help.'
            : `The flow setting "${name}" has no Bee Flow counterpart and was left out.`;
        ctx.report.warn('option_dropped', msg);
    }
    if (o.earlyReturn) ctx.report.warn('option_dropped', 'The flow answered its webhook early with a step result; a Bee Flow webhook answers 202 at once.');
    if (flow.preprocessor) {
        ctx.report.ai({ wmId: 'preprocessor', stepId: null, title: 'Reshape the trigger payload', why: 'The flow reshaped what its trigger delivered before the first step; the builder can do that with an "Edit data" step after the trigger.', ...(flow.preprocessor.source ? { source: scrubSource(flow.preprocessor.source).text } : {}) });
    }
}

function applySkipExpr(ctx: MapCtx, expr: string): void {
    const t = ctx.trigger.trigger;
    const appEvent = t.appEvent as Record<string, unknown> | undefined;
    const rule = translateRule(`!(${expr})`, filterScope(ctx));
    if (!appEvent || rule.kind === 'ai') {
        ctx.report.ai({ wmId: 'skip_expr', stepId: null, title: 'Skip condition of the flow', why: rule.kind === 'ai' ? rule.reason : 'The flow skipped some runs; add a condition after the trigger.', source: expr });
        return;
    }
    const filter = (appEvent.filter ?? {}) as Record<string, unknown>;
    filter.expr = typeof filter.expr === 'string' && filter.expr ? `(${filter.expr}) && (${rule.expr})` : rule.expr;
    appEvent.filter = filter;
}

function suggestedRunPolicy(report: ReportBuilder, flow: WmFlow): SuggestedRunPolicy {
    const o = flow.options;
    const out: SuggestedRunPolicy = {};
    if (o.concurrentLimit !== undefined) {
        out.concurrency = o.concurrentLimit <= 1 ? 'serial' : 'parallel';
        if (o.concurrentLimit > 1) report.warn('option_approximated', `Windmill ran at most ${o.concurrentLimit} runs at the same time; Bee Flow runs one at a time or without a limit.`);
    }
    if (o.timeoutS !== undefined) out.maxDurationMin = Math.max(1, Math.min(60, Math.ceil(o.timeoutS / 60)));
    if (o.deleteAfterSecs !== undefined) {
        out.retentionDays = Math.max(7, Math.min(365, Math.ceil(o.deleteAfterSecs / 86400)));
        report.warn('privacy_retention', `Windmill deleted the run data after ${o.deleteAfterSecs} s; Bee Flow keeps it at least 7 days. The shortest retention is suggested.`);
    }
    return out;
}

// ── Assembling ───────────────────────────────────────────────────────────

function assemble(ctx: MapCtx, flow: WmFlow, trigger: TriggerResult): Record<string, unknown> {
    const notes: Step[] = flow.notes.map((text, i) => ({ id: newId(ctx, `windmill_note_${i + 1}`), type: 'note', text: scrubSource(text).text.slice(0, 4000) }));
    const definition: Record<string, unknown> = {
        trigger: trigger.trigger,
        steps: [...ctx.sink.steps, ...ctx.rootNotes, ...notes],
        edges: ctx.sink.edges,
    };
    if (trigger.triggers.length) definition.triggers = trigger.triggers;
    const vars = { ...trigger.vars, ...plainFlowEnv(flow) };
    if (Object.keys(vars).length) definition.vars = vars;
    if (Object.keys(ctx.layers).length) {
        definition.layers = ctx.layers;
        definition.schemaVersion = 2;
    }
    scrubAutomationDefinition(definition, []);
    return definition;
}

function plainFlowEnv(flow: WmFlow): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(flow.options.flowEnv ?? {})) if (!refOf(v)) out[k] = v;
    return out;
}

function flowWarnings(ctx: MapCtx, flow: WmFlow, bundle: WmBundle): void {
    for (const r of [...bundle.refs.resources, ...bundle.refs.variables]) {
        if (r.where.startsWith(`${flow.path}#`)) ctx.report.connection(r.kind, r.path, r.where.slice(flow.path.length + 1), r.resourceType);
    }
    const usesEventUser = allNodes(flow).some((n) => Object.values(n.inputs).some((i) => i.type === 'javascript' && i.expr.includes('authentication.trigger')));
    const who = flow.options.onBehalfOf ? `as ${flow.options.onBehalfOf}` : (usesEventUser ? 'as the Nextcloud user who caused the event' : 'with the connections of whoever set it up');
    ctx.report.warn('identity_change', `Windmill ran parts of this flow ${who}; Bee Flow runs it with the connections of the automation's owner, so what it may read and change follows the owner's rights.`);
    if (ctx.trigger.payload === 'nextcloud' && allNodes(flow).some((n) => Object.values(n.inputs).some((i) => i.type === 'javascript' && i.expr.includes('node.path')))) {
        ctx.report.warn('trigger_approximated', 'File paths in Bee Flow start inside the user\'s files ("/Uploads/x.pdf"); Windmill read "/<user>/files/Uploads/x.pdf".');
    }
}

function finish(flow: WmFlow, definition: Record<string, unknown>, trigger: TriggerResult, report: ReportBuilder, opts: ConvertOptions): FlowConversion {
    const title = (flow.summary || flow.path).slice(0, 200);
    const cols = triggerColumnsFromDefinition(definition);
    const automation: Record<string, unknown> = {
        title, description: (flow.description ?? '').slice(0, 2000), triggerType: cols.triggerType,
        scheduleCron: cols.scheduleCron, scheduleTz: cols.scheduleCron ? cols.scheduleTz : null, definition,
    };
    const ctxPolicy = suggestedRunPolicy(report, flow);
    const base = report.finish();
    const validation = opts.skipValidation ? { errors: [], warnings: [] } : validationCodes(definition);
    const full: ConversionReport = { ...base, suggestedRunPolicy: ctxPolicy, validation, ...(trigger.suggestedWebhookAuth ? { suggestedWebhookAuth: trigger.suggestedWebhookAuth } : {}) };
    return {
        flowPath: flow.path, title,
        envelope: { format: 'beeflow.automation', schemaVersion: 1, automation },
        definition, trigger: trigger.trigger, report: full,
    };
}

function validationCodes(definition: unknown): { errors: string[]; warnings: string[] } {
    const r = validateDefinition(definition, { stage: 'draft' });
    return { errors: (r.errors ?? []).map((e) => e.code), warnings: [...new Set((r.warnings ?? []).map((w) => w.code))].sort() };
}
