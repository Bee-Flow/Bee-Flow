/**
 * The MCP host of the shared walker (sequenceWalk.mts) for app_run_action and app_run_tests:
 * the policy per step (mcpRunActionPolicy.decideStep), the ONE place a step reaches the executor
 * (with the send_email re-check and the lazy run-budget charge of a dry run), the mocks, the
 * data-binding reads (runBindings.mts) and the per-step report. mcpRunAction.mts drives it.
 */

import {
    MAX_ERROR_CHARS, MAX_LOOP_ITERATIONS, MAX_REPORT_STEPS, RECORD_WRITES,
    decideStep, isObject, limitText, short, trimResult,
} from './mcpRunActionPolicy.mts';
import type { Obj, RunLimits, RunScope, Step } from './mcpRunActionPolicy.mts';
import type { StepEndEvent, StepEvent, StepResult, WalkHost, WalkState } from './sequenceWalk.mts';
import { BindingRefusal, resolveRunBinding } from './runBindings.mts';
import type { ReadData } from './runBindings.mts';
import { mockStepResult } from './actionTests/mockStep.mts';
import { ownAction } from './actionCalls.mts';
import type { MockHelpers } from './actionTests/mockStep.mts';

export type App = { id: string; userId: string; name?: string | null; organizationId?: string | null; definition?: unknown; definitionVersion?: number | null };

export type StepStatus = 'ok' | 'skipped' | 'refused' | 'error' | 'deferred';
export type StepReport = {
    path: string; kind: string; status: StepStatus; result?: unknown; error?: string; code?: string;
    ms?: number; mocked?: boolean; iteration?: number;
    /** Attempts of a retried step (only when more than one). */
    attempts?: number;
    /** The step failed and its onError handler ran; the run went on. */
    handled?: boolean;
};
export type RunReport = {
    ok: boolean; dryRun: boolean; actionId: string; definitionVersion?: number; steps: StepReport[]; vars?: unknown;
    stopped?: string; truncated?: boolean; notes: string[];
    /** True when the run took no paid run budget (nothing reached the executor in a dry run). */
    free: boolean;
    /** How many step runs got their mocked answer. */
    mocked: number;
    /** A background action: the lockKey this run resolved and the progress variable. */
    background?: { lockKey: string | null; progressVar: string | null };
};
export type RunOutcome = RunReport | { error: string; _fixHint?: string };

export type RunDeps = {
    getApp: (appId: string) => Promise<App | null>;
    canWrite: (app: App, userId: string) => boolean;
    getDataModel: (appId: string, ownerId: string) => Promise<unknown>;
    executeStep: (app: App, model: unknown, step: Step, ctx: Obj) => Promise<StepResult>;
    evaluate: (expr: string, scope: unknown) => unknown;
    buildScope: (ctx: Obj) => unknown;
    /** static / field / formula bindings. */
    resolveBinding: (binding: unknown, ctx: Obj, scope: unknown) => unknown;
    /** record / records / aggregate reads (default stepDataSource.resolveDataBinding). */
    readData?: ReadData;
    takeBudget: (userId: string, now: number) => boolean;
    takeFreeBudget?: (userId: string, now: number) => boolean;
    /** The interpolated prompt of an ai_generate step (default aiSteps.interpolatePrompt). */
    promptOf?: (step: Step, ctx: Obj) => string;
    mockHelpers?: MockHelpers;
    /** Read-only count for a filter-mode update/delete in a dry run (bulkRecords.previewMatching). */
    previewWrite?: (app: App, model: unknown, step: Step, ctx: Obj) => Promise<Obj>;
    audit: (entry: Obj, app: App, userId: string) => Promise<void>;
    log: { warn: (...a: unknown[]) => void };
    now: () => number;
    limits: () => Partial<RunLimits>;
    /** The run table (a live run of a background action with a lockKey takes its lock); default actionRunStore(). */
    actionRuns?: () => import('../stores/studioAppData/actionRuns.mts').ActionRunStore;
};

export type Deps = RunDeps & Required<Pick<RunDeps, 'readData' | 'takeFreeBudget' | 'promptOf'>>;

/** What every run of one call reads once: the app (as authorised now), its definition and data model. */
export type RunTarget = { app: App; def: Obj; model: unknown };

export type RunOnceOptions = {
    actionId: string; userId: string; dryRun: boolean; scope: RunScope; mock: Obj;
    /** The paid budget was already taken (a live run); a dry run is charged lazily. */
    chargeUpFront: boolean;
    /** Time budget for this run; defaults to the per-run budget. */
    budgetMs?: number;
    /** The tool name in messages. */
    tool?: string;
};

export type Run = {
    target: RunTarget; deps: Deps; limits: RunLimits; opts: RunOnceOptions;
    reports: StepReport[]; reportTruncated: boolean; charged: boolean; chargedHere: boolean;
    reads: number; mocked: number; current: string; deadline: number; w: WalkState;
};

function ctxFor(run: Run, w: WalkState): Obj {
    const { app, def } = run.target;
    return {
        viewerId: app.userId, actionId: run.opts.actionId, viewerName: null, viewerEmail: null,
        role: 'owner', orgId: app.organizationId || null,
        formValues: w.form, vars: w.vars, params: w.params,
        ...(w.error ? { error: w.error } : {}),
        variables: Array.isArray(def.variables) ? def.variables : null,
        item: w.item, index: w.index,
        viewer: { id: app.userId, role: 'owner', organizationId: app.organizationId || null },
    };
}

function resolveFor(run: Run, binding: unknown, ctx: Obj, scope: unknown): Promise<unknown> {
    const { app, model } = run.target;
    return resolveRunBinding(binding, {
        app, model, ctx, scope, maxRows: MAX_LOOP_ITERATIONS,
        readData: run.deps.readData, resolveBinding: run.deps.resolveBinding,
        where: run.current,
        onNote: (text) => { if (run.w.notes.size < 50) run.w.notes.add(text); },
        onRead: () => {
            run.reads += 1;
            if (run.limits.maxReads && run.reads > run.limits.maxReads) {
                throw new BindingRefusal(`This run read data bindings more than ${run.limits.maxReads} times (${limitText(run.limits, 'maxReads')}).`, 'read_limit');
            }
        },
    });
}

const DATA_KINDS = ['record', 'records', 'aggregate'];

/**
 * What a send_email step WOULD address. Resolved with the executor's own resolver
 * (deps.resolveBinding), not resolveFor: the real step (actionExecutor/emailStep.js) does not
 * read record / records / aggregate bindings, so the preview must not either. Pure.
 */
function wouldSendOf(run: Run, step: Step, ctx: Obj): Obj {
    const scope = run.deps.buildScope(ctx);
    const read = (b: unknown): unknown => {
        if (b === undefined || b === null) return null;
        try { return run.deps.resolveBinding(b, ctx, scope); } catch { return null; }
    };
    if (isObject(step.to) && DATA_KINDS.includes(String(step.to.kind)) && run.w.notes.size < 50) {
        run.w.notes.add(`${run.current}: send_email does not read a ${String(step.to.kind)} binding on \`to\`, so this step would have no recipient. Bind \`to\` to a field, formula or static value.`);
    }
    const to = read(step.to);
    return {
        to: Array.isArray(to) ? to.slice(0, 10).map((v) => short(v, 120)) : short(to, 200),
        subject: short(read(step.subject), 200),
        mode: step.mode === 'draft' ? 'draft' : 'send',
    };
}

/** The values and record id a record write WOULD use (only the parts the step sets). Pure. */
function wouldWriteOf(run: Run, step: Step, ctx: Obj): Obj {
    const scope = run.deps.buildScope(ctx);
    const read = (b: unknown): unknown => { try { return run.deps.resolveBinding(b, ctx, scope); } catch { return null; } };
    const out: Obj = {};
    if (isObject(step.values) && Object.keys(step.values).length) {
        const values: Obj = {};
        for (const [col, b] of Object.entries(step.values).slice(0, 200)) values[col] = read(b);
        out.values = values;
    }
    if (step.recordId !== undefined) out.recordId = read(step.recordId);
    return out;
}

/** wouldWrite of a record write; a filter-mode one also says how many rows it would change (read only). */
async function wouldWriteFor(run: Run, step: Step, ctx: Obj): Promise<Obj> {
    const out = wouldWriteOf(run, step, ctx);
    if (step.filter === undefined || step.filter === null || !run.deps.previewWrite) return out;
    try {
        const preview = await run.deps.previewWrite(run.target.app, run.target.model, step, ctx);
        return { ...out, ...preview };
    } catch {
        return out;
    }
}

/** A writeTo with replaceWhere: the dry run does not apply it (the AI step runs without its writeTo). */
function noteReplaceWhere(run: Run, step: Step): void {
    const w = isObject(step.writeTo) ? step.writeTo : null;
    if (w && w.replaceWhere !== undefined && w.replaceWhere !== null && run.w.notes.size < 50) {
        run.w.notes.add(`${run.current}: writeTo.replaceWhere not applied in this run (the step runs without its writeTo).`);
    }
}

function rateLimitedStep(run: Run, f: StepEvent): StepResult {
    const { limits, opts } = run;
    return {
        ok: false, code: 'rate_limited', retryable: false,
        error: `Too many ${opts.tool || 'app_run_action'} calls (limit ${limits.perMinute} per minute per user, ${limitText(limits, 'perMinute')}). ${f.path} (${f.kind}) is not mocked and would call the model; mock it to run for free.`,
    };
}

async function executeFor(run: Run, step: Step, f: StepEvent, w: WalkState): Promise<StepResult> {
    const { dryRun, userId } = run.opts;
    if (step.kind === 'send_email' && (dryRun || f.loop !== null || step.mode !== 'draft')) {
        return { ok: false, error: 'send_email is not allowed here', retryable: false };
    }
    if (!run.charged) {
        if (!run.deps.takeBudget(userId, run.deps.now())) return rateLimitedStep(run, f);
        run.charged = true;
        run.chargedHere = true;
    }
    return run.deps.executeStep(run.target.app, run.target.model, step, ctxFor(run, w));
}

function reportOf(e: StepEndEvent): StepReport {
    const error = e.error ?? e.note;
    return {
        path: e.path, kind: e.kind, status: e.status,
        ...(e.result !== undefined ? { result: trimResult(e.result) } : {}),
        ...(error !== undefined ? { error: String(error).slice(0, MAX_ERROR_CHARS) } : {}),
        ...(e.code ? { code: e.code } : {}),
        ms: e.ms,
        ...(e.mocked ? { mocked: true } : {}),
        ...(e.iteration !== null ? { iteration: e.iteration } : {}),
        ...(e.attempts !== undefined && e.attempts > 1 ? { attempts: e.attempts } : {}),
        ...(e.handled ? { handled: true } : {}),
    };
}

export function hostFor(run: Run): WalkHost {
    const { deps, opts } = run;
    return {
        async decide(step, f, w) {
            const kind = String(step.kind);
            const ctx = ctxFor(run, w);
            const wouldSend = kind === 'send_email' ? wouldSendOf(run, step, ctx) : undefined;
            const wouldWrite = opts.dryRun && RECORD_WRITES.includes(kind) ? await wouldWriteFor(run, step, ctx) : undefined;
            if (opts.dryRun) noteReplaceWhere(run, step);
            return decideStep(step, opts.dryRun, f.loop !== null, wouldSend, wouldWrite);
        },
        execute: (step, f, w) => executeFor(run, step, f, w),
        mockFor: (path) => (Object.hasOwn(opts.mock, path) ? { value: opts.mock[path] } : null),
        mocked(step, value, ctx, attempt) {
            run.mocked += 1;
            const prompt = step.kind === 'ai_generate' ? deps.promptOf(step, ctx) : undefined;
            return mockStepResult(step, value, { prompt, attempt, ...(deps.mockHelpers ? { helpers: deps.mockHelpers } : {}) });
        },
        resolve: (binding, ctx, scope) => resolveFor(run, binding, ctx, scope),
        // call_action: an own action of the draft the run read (never a prototype key).
        resolveCallee: (id) => ownAction(run.target.def.actions, id),
        evaluate: (expr, scope) => deps.evaluate(expr, scope),
        buildScope: (ctx) => deps.buildScope(ctx),
        ctxFor: (w) => ctxFor(run, w),
        promptOf: (step, ctx) => (step.kind === 'ai_generate' ? deps.promptOf(step, ctx) : undefined),
        onStepStart: (e) => { run.current = e.path; },
        onStepEnd: (e) => {
            if (run.reports.length >= MAX_REPORT_STEPS) { run.reportTruncated = true; return; }
            run.reports.push(reportOf(e));
        },
        shouldStop: (w) => {
            if (run.deadline && deps.now() > run.deadline) return 'time budget used up';
            if (run.limits.maxExecuted && w.executed >= run.limits.maxExecuted) return `step limit of ${run.limits.maxExecuted} executed steps reached (${limitText(run.limits, 'maxExecuted')})`;
            return null;
        },
        sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
        now: () => deps.now(),
    };
}

export function dryRunNote(run: Run): string {
    if (run.chargedHere) return 'dryRun: nothing was written or sent. AI steps that were not mocked ran and cost the owner\'s AI budget like a click.';
    return 'dryRun: nothing was written or sent. No step reached the model or the executor, so this run was free.';
}
