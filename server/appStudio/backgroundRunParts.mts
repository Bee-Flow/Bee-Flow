/**
 * The parts of backgroundRun.mts that hold no run state: its types, the injected dependencies
 * and their defaults, the job view the browser reads, and the small pure helpers.
 */

import { createRequire } from 'node:module';
import type { Obj, Step, StepResult } from './sequenceWalk.mts';
import type { ReadData } from './runBindings.mts';
import { backgroundLimits } from './backgroundRunPolicy.mts';
import type { BackgroundLimits } from './backgroundRunPolicy.mts';
import type { ActionRunRow, ActionRunStore } from '../stores/studioAppData/actionRuns.mts';
import type { StepBudget } from '../routes/studioAppStepBudget.mts';

const nodeRequire = createRequire(import.meta.url);
const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

export type App = { id: string; userId: string; name?: string | null; organizationId?: string | null };
export type Viewer = { id: string; name?: string | null; email?: string | null; organizationId?: string | null };
export type RunScopeInput = { formValues?: Obj; vars?: Obj; item?: unknown; index?: number; value?: unknown };

export type StartInput = {
    app: App; def: Obj; model: unknown; actionId: string; viewer: Viewer; role: string | null; isOwner: boolean;
    draft: boolean; definitionVersion: number | null; scope: RunScopeInput;
};

export type RunnerDeps = {
    store: () => ActionRunStore;
    executeStep: (app: App, model: unknown, step: Step, ctx: Obj) => Promise<StepResult>;
    evaluate: (expr: string, scope: unknown) => unknown;
    buildScope: (ctx: Obj) => unknown;
    resolveBinding: (binding: unknown, ctx: Obj, scope: unknown) => unknown;
    readData?: ReadData;
    budgetsFor: (kind: string, step?: Step) => StepBudget[];
    heavyKinds: readonly string[];
    stepDocumentContext: (step: Step, def: Obj, role: string | null) => Obj;
    logUsage: (entry: Obj) => Promise<unknown>;
    log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    limits: () => BackgroundLimits;
    instanceId: string;
    /** Timers for the heartbeat (fake in tests). */
    setInterval: (fn: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
};

export type StartResult =
    | { ok: true; jobId: string }
    | { ok: false; status: number; code: string; error: string; jobId?: string };

export type JobView = {
    jobId: string; actionId: string; status: string;
    progress: { stepIndex: number | null; kind: string | null; executed: number; message: string | null; loop: { index: number; count: number } | null; waiting: string | null };
    result?: unknown; vars?: Obj; effects?: unknown[];
    error: string | null; errorStep: Obj | null; startedAt: string | null; finishedAt: string | null; durationMs: number | null;
};

function minutesAgo(iso: string | null, now: number): number {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 60_000)) : 0;
}

export function lockedMessage(holder: ActionRunRow | null, now: number): string {
    const ago = holder ? minutesAgo(holder.startedAt, now) : 0;
    const when = ago < 1 ? 'less than a minute ago' : `${ago} min ago`;
    return `This is already running for the same item (started ${when}). Wait until it finishes.`;
}

export function writtenVars(before: Obj, after: Obj): Obj {
    const out: Obj = {};
    for (const [k, v] of Object.entries(after)) if (!Object.hasOwn(before, k) || before[k] !== v) out[k] = v;
    return out;
}

export function trimToBytes(value: unknown, max: number): unknown {
    if (value === undefined) return null;
    if (!max) return value ?? null;
    let size = 0;
    try { size = Buffer.byteLength(JSON.stringify(value ?? null), 'utf8'); } catch { return { _resultTooLarge: true }; }
    return size > max ? { _resultTooLarge: true } : (value ?? null);
}

/** A run row as the browser reads it (additive contract). */
export function toJobView(row: ActionRunRow): JobView {
    const p = row.progress || {};
    const loop = isObject(p.loop) && typeof p.loop.index === 'number' && typeof p.loop.count === 'number' ? { index: p.loop.index, count: p.loop.count } : null;
    return {
        jobId: row.id, actionId: row.actionId, status: row.status,
        progress: {
            stepIndex: typeof p.stepIndex === 'number' ? p.stepIndex : null,
            kind: typeof p.kind === 'string' ? p.kind : null,
            executed: typeof p.executed === 'number' ? p.executed : 0,
            message: typeof p.message === 'string' ? p.message : null,
            loop, waiting: typeof p.waiting === 'string' ? p.waiting : null,
        },
        ...(row.status === 'success' ? { result: row.result ?? null } : {}),
        ...(row.vars ? { vars: row.vars } : {}),
        ...(row.effects ? { effects: row.effects } : {}),
        error: row.error, errorStep: row.errorStep, startedAt: row.startedAt, finishedAt: row.endedAt, durationMs: row.durationMs,
    };
}

export function withDefaults(given: Partial<RunnerDeps>): RunnerDeps {
    return {
        store: given.store ?? (() => (nodeRequire('../stores/studioAppData/actionRuns.mts') as { actionRunStore: () => ActionRunStore }).actionRunStore()),
        executeStep: given.executeStep ?? ((app, model, step, ctx) => nodeRequire('./actionExecutor').executeDataStep(app, model, step, ctx)),
        evaluate: given.evaluate ?? ((expr, scope) => nodeRequire('../shared/expr/index.mjs').tryEvaluate(expr, scope)?.value),
        buildScope: given.buildScope ?? ((ctx) => nodeRequire('./actionExecutor/shared').buildServerScope(ctx)),
        resolveBinding: given.resolveBinding ?? ((binding, ctx, scope) => nodeRequire('./actionExecutor/shared').resolveBinding(binding, ctx, scope)),
        readData: given.readData,
        budgetsFor: given.budgetsFor ?? ((kind, step) => (nodeRequire('../routes/studioAppStepBudget.mts') as { limitersForStepDef: (s: unknown) => StepBudget[] }).limitersForStepDef(step ?? { kind })),
        heavyKinds: given.heavyKinds ?? (nodeRequire('../routes/studioAppStepBudget.mts') as { HEAVY_STEP_KINDS: readonly string[] }).HEAVY_STEP_KINDS,
        stepDocumentContext: given.stepDocumentContext ?? ((step, def, role) => nodeRequire('../routes/studioAppRunGate').stepDocumentContext(step, def, role)),
        logUsage: given.logUsage ?? ((entry) => nodeRequire('../stores/usageStore').logUsage(entry)),
        log: given.log ?? nodeRequire('../telemetry/log'),
        now: given.now ?? (() => Date.now()),
        sleep: given.sleep ?? ((ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); })),
        limits: given.limits ?? (() => backgroundLimits()),
        instanceId: given.instanceId ?? `${process.pid}`,
        setInterval: given.setInterval ?? ((fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; }),
        clearInterval: given.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>)),
    };
}
