/**
 * Background actions: a sequence with `background: true` runs as a server job.
 *
 * A click POSTs /:id/actions/:actionId/background; startBackgroundRun checks the action
 * (backgroundRunPolicy), the caps and the lockKey, inserts a `running` row in
 * studio_app_action_runs (its id is the jobId) and starts the walk detached from the request,
 * so leaving or closing the page does not stop it. The browser polls the row for progress and
 * the result.
 *
 * The walk is the ONE server walker (sequenceWalk.mts) with the background host below:
 *   - decide: toast/refresh are recorded and replayed by the browser at the end (deferred),
 *     leading confirms were asked before the start (skipped), any other client kind stops the
 *     run (the validator refuses those already);
 *   - execute: the heavy-step role gate, the per-(viewer, app) budgets a click spends (a job
 *     WAITS for an empty per-minute bucket instead of failing after paid calls; the daily mail
 *     cap fails the step), executeDataStep with the context /step builds, usage logging;
 *   - progress: the current step, the loop position and the text of the action's progressVar,
 *     written at most once a second (and on every progressVar change);
 *   - shouldStop: the run-time and step caps, and shutdown.
 * A heartbeat keeps the row alive; a row whose process died is swept to `interrupted`
 * (jobs/studioAppActionRuns.js). There is no resume: steps are not idempotent.
 *
 * Logs carry ids, kinds, statuses, counts and durations only: never prompt text, values or a
 * provider's error text.
 */

import { createRequire } from 'node:module';
import { newWalkState, outcomeView, walkAction } from './sequenceWalk.mts';
import type { Obj, Step, StepEvent, StepResult, WalkHost, WalkState } from './sequenceWalk.mts';
import { resolveRunBinding } from './runBindings.mts';
import { withViewerAttributes } from './viewerAttributes.mts';
import { NOOP_RECORDER, startRun, withRunLog } from './runLog/recorder.mts';
import { ownAction } from './actionCalls.mts';
import {
    BACKGROUND_DEFERRED_KINDS, BACKGROUND_REFUSED_KINDS, MAX_DEFERRED_EFFECTS, backgroundActionProblems, leadingConfirmCount, limitLabel,
    normaliseLockKey, progressText, readRunOptions,
} from './backgroundRunPolicy.mts';
import type { BackgroundLimits } from './backgroundRunPolicy.mts';
import { newRunId } from '../stores/studioAppData/runPolicy.mts';
import type { ActionRunRow } from '../stores/studioAppData/actionRuns.mts';
import { lockedMessage, toJobView, trimToBytes, withDefaults, writtenVars } from './backgroundRunParts.mts';
import type { App, JobView, RunnerDeps, RunScopeInput, StartInput, StartResult, Viewer } from './backgroundRunParts.mts';

const nodeRequire = createRequire(import.meta.url);
type Attribution = { withUsageAttribution: <T>(a: { actorUserId?: string | null; runId?: string | null }, fn: () => T) => T };
const { withUsageAttribution } = nodeRequire('./usageAttribution') as Attribution;

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const LOOP_ROWS = 200;
const PROGRESS_EVERY_MS = 1000;

// ── Registry (this process's running jobs) ──────────────────────────────────

const registry = new Map<string, Promise<void>>();
let shuttingDown = false;

/** Test seam: resolves when job `jobId` of this process has finished (immediately when unknown). */
export function _settled(jobId: string): Promise<void> {
    return registry.get(jobId) ?? Promise.resolve();
}

/** The jobs this process is running. */
export function runningJobIds(): string[] {
    return [...registry.keys()];
}

// ── Start ───────────────────────────────────────────────────────────────────

type Job = {
    jobId: string; input: StartInput; action: Obj; deps: RunnerDeps; limits: BackgroundLimits;
    w: WalkState; startedAt: number; deadline: number; leading: number; progressVar: string | null;
    progress: JobView['progress']; lastWrite: number; seenEffects: Set<string>;
};

function baseCtx(input: StartInput, w: WalkState, ownerActionId: string): Obj {
    const { app, def, viewer, role } = input;
    return {
        viewerId: viewer.id, actionId: ownerActionId, viewerName: viewer.name || null, viewerEmail: viewer.email || null,
        role, orgId: app.organizationId || null,
        formValues: w.form, vars: w.vars, params: w.params,
        ...(w.error ? { error: w.error } : {}),
        variables: Array.isArray(def.variables) ? def.variables : null,
        item: w.item, index: w.index, value: w.value,
        viewer: { id: viewer.id, role: role || null, organizationId: viewer.organizationId || null },
    };
}

async function resolveWith(input: StartInput, deps: RunnerDeps, binding: unknown, ctx: Obj, scope: unknown, where = ''): Promise<unknown> {
    const { app, model, viewer, role } = input;
    // email / groups / orgId for the row rules, read again for every binding: a job can run long.
    const reader = await withViewerAttributes({ id: viewer.id, role: role || null, organizationId: viewer.organizationId || null }, model);
    return resolveRunBinding(binding, {
        app, model, ctx, scope, maxRows: LOOP_ROWS, where,
        readData: deps.readData, resolveBinding: deps.resolveBinding,
        reader: { viewer: reader, role },
    });
}

/** The lockKey of a start, resolved in the request's scope (null = no lock). */
export async function resolveLockKey(input: StartInput, action: Obj, given: Partial<RunnerDeps> = {}): Promise<string | null> {
    const deps = withDefaults(given);
    const { lockKey } = readRunOptions(action);
    if (!lockKey) return null;
    const w = newWalkState({ vars: input.scope.vars, form: input.scope.formValues, item: input.scope.item, index: input.scope.index, value: input.scope.value });
    const ctx = baseCtx(input, w, input.actionId);
    try {
        return normaliseLockKey(await resolveWith(input, deps, lockKey, ctx, deps.buildScope(ctx), 'lockKey'));
    } catch {
        return null;
    }
}

/** Start the job, or say why not. Never throws for a refusal. */
export async function startBackgroundRun(input: StartInput, given: Partial<RunnerDeps> = {}): Promise<StartResult> {
    const deps = withDefaults(given);
    const limits = deps.limits();
    const actions = isObject(input.def.actions) ? input.def.actions : {};
    const action = ownAction(actions, input.actionId);
    if (!action || !readRunOptions(action).background) {
        return { ok: false, status: 400, code: 'not_background', error: 'This action does not run in the background.' };
    }
    if (shuttingDown) return { ok: false, status: 503, code: 'shutting_down', error: 'The server is restarting. Try again in a minute.' };
    const problems = backgroundActionProblems(action, input.actionId, { resolveCalled: (id) => ownAction(actions, id) });
    if (problems.length) return { ok: false, status: 400, code: 'background_not_runnable', error: problems[0].message };

    const store = deps.store();
    const mine = limits.perUser ? await store.countRunning(input.app.id, { viewerUserId: input.viewer.id, staleMs: limits.staleMs }) : 0;
    if (limits.perUser && mine >= limits.perUser) {
        return { ok: false, status: 429, code: 'background_limit', error: `You already have ${mine} runs of this app going (limit ${limits.perUser}, ${limitLabel(limits, 'perUser')}). Wait for one to finish.` };
    }
    const all = limits.perApp ? await store.countRunning(input.app.id, { staleMs: limits.staleMs }) : 0;
    if (limits.perApp && all >= limits.perApp) {
        return { ok: false, status: 429, code: 'background_limit', error: `This app already has ${all} runs going (limit ${limits.perApp}, ${limitLabel(limits, 'perApp')}). Wait for one to finish.` };
    }

    const lockKey = await resolveLockKey(input, action, deps);
    const jobId = newRunId();
    const inserted = await store.insertRunningRun({
        id: jobId, appId: input.app.id, ownerUserId: input.app.userId, viewerUserId: input.viewer.id, actionId: input.actionId,
        origin: 'background', draft: input.draft, definitionVersion: input.definitionVersion, dryRun: false, lockKey,
        instanceId: deps.instanceId, staleMs: limits.staleMs,
    });
    if (!inserted.ok) {
        const holder = inserted.holder;
        const mayAttach = !!holder && (holder.viewerUserId === input.viewer.id || input.isOwner);
        return { ok: false, status: 409, code: 'action_locked', error: lockedMessage(holder, deps.now()), ...(mayAttach && holder ? { jobId: holder.id } : {}) };
    }

    const job = newJob(jobId, input, action, deps, limits);
    const promise = executeRun(job).catch(async (e) => {
        deps.log.error(`[StudioBackground] ${jobId} app=${input.app.id} action=${input.actionId} crashed (${(e as Error)?.name || 'error'})`);
        try { await store.finishRun(jobId, { status: 'error', error: 'The run stopped unexpectedly.', errorCode: 'internal', durationMs: deps.now() - job.startedAt }); } catch { /* the sweep marks it interrupted */ }
    }).finally(() => { registry.delete(jobId); });
    registry.set(jobId, promise);
    return { ok: true, jobId };
}

function newJob(jobId: string, input: StartInput, action: Obj, deps: RunnerDeps, limits: BackgroundLimits): Job {
    const { scope } = input;
    const startedAt = deps.now();
    return {
        jobId, input, action, deps, limits, startedAt,
        w: newWalkState({ vars: scope.vars, form: scope.formValues, item: scope.item, index: scope.index, value: scope.value }),
        deadline: limits.maxRunMs ? startedAt + limits.maxRunMs : 0,
        leading: leadingConfirmCount(action.steps),
        progressVar: readRunOptions(action).progressVar,
        progress: { stepIndex: null, kind: null, executed: 0, message: null, loop: null, waiting: null },
        lastWrite: 0, seenEffects: new Set(),
    };
}

// ── The host ────────────────────────────────────────────────────────────────

async function writeProgress(job: Job, force: boolean): Promise<void> {
    const now = job.deps.now();
    if (!force && now - job.lastWrite < PROGRESS_EVERY_MS) return;
    job.lastWrite = now;
    try { await job.deps.store().updateProgress(job.jobId, { ...job.progress }); } catch { /* progress is best effort */ }
}

function deferEffect(job: Job, step: Step): void {
    const effect: Obj = step.kind === 'toast'
        ? { kind: 'toast', message: typeof step.message === 'string' ? step.message.slice(0, 500) : '', tone: typeof step.tone === 'string' ? step.tone : 'info' }
        : { kind: 'refresh', ...(typeof step.tableId === 'string' ? { tableId: step.tableId } : {}), ...(typeof step.datasetId === 'string' ? { datasetId: step.datasetId } : {}) };
    const key = JSON.stringify(effect);
    if (job.seenEffects.has(key) || job.w.deferred.length >= MAX_DEFERRED_EFFECTS) return;
    job.seenEffects.add(key);
    job.w.deferred.push(effect);
}

/** Charge the budgets of a step; a full per-minute bucket is waited out within the run's deadline. */
async function chargeBudgets(job: Job, step: Step): Promise<StepResult | null> {
    const { deps, input } = job;
    const key = `${input.viewer.id}:${input.app.id}`;
    for (const budget of deps.budgetsFor(String(step.kind), step)) {
        if (!budget.limiter || typeof budget.limiter.take !== 'function') continue;
        for (;;) {
            if (shuttingDown) return { ok: false, error: 'The server is restarting.', code: 'shutting_down', retryable: false };
            const got = await budget.limiter.take(key);
            if (got.ok) break;
            if (budget.daily) {
                return { ok: false, error: `The daily e-mail limit of this app is reached (${budget.name}). Try again tomorrow.`, code: 'rate_limited', retryable: false };
            }
            const waitMs = got.retryAfterSecs * 1000;
            if (job.deadline && deps.now() + waitMs > job.deadline) {
                return { ok: false, error: `The step budget (${budget.name}) stayed full until the run's time limit.`, code: 'rate_limited', retryable: false };
            }
            job.progress.waiting = 'budget';
            await writeProgress(job, true);
            await deps.sleep(waitMs);
            job.progress.waiting = null;
        }
    }
    return null;
}

async function executeFor(job: Job, step: Step, f: StepEvent, w: WalkState): Promise<StepResult> {
    const { deps, input } = job;
    const kind = String(step.kind);
    if (!input.isOwner && !input.role && deps.heavyKinds.includes(kind)) {
        return { ok: false, error: 'You do not have access to this app yet', code: 'forbidden', retryable: false };
    }
    const refused = await chargeBudgets(job, step);
    if (refused) return refused;
    const ctx = { ...baseCtx(input, w, f.ownerActionId), ...deps.stepDocumentContext(step, input.def, input.role) };
    const t0 = deps.now();
    // The owner pays; the viewer who started the job is the actor of every
    // ledger row of this step, and the job's id is the run (usageAttribution.js).
    const attribution = { actorUserId: input.viewer.id || null, runId: job.jobId };
    const res = await withUsageAttribution(attribution, () => deps.executeStep(input.app, input.model, step, ctx));
    deps.logUsage({
        user_id: input.app.userId, organization_id: input.app.organizationId || null, agent_id: input.app.id,
        agent_name: `App: ${input.app.name || 'Untitled app'}`, agent_type: 'studio_app',
        prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, duration_ms: deps.now() - t0,
        source: 'studio_app_action', conversation_id: input.app.id,
        actor_user_id: attribution.actorUserId, run_id: attribution.runId,
    }).catch(() => {});
    return res;
}

function stopReason(job: Job, w: WalkState): string | null {
    const { limits, deps } = job;
    if (shuttingDown) return 'The server restarted while this ran.';
    if (job.deadline && deps.now() > job.deadline) {
        return `Stopped after ${Math.round(limits.maxRunMs / 1000)} s, the limit for a background run (${limitLabel(limits, 'maxRunMs')}).`;
    }
    if (limits.maxSteps && w.executed >= limits.maxSteps) {
        return `Stopped after ${limits.maxSteps} steps, the limit for a background run (${limitLabel(limits, 'maxSteps')}).`;
    }
    return null;
}

function hostFor(job: Job): WalkHost {
    const { deps, input } = job;
    const actions = isObject(input.def.actions) ? input.def.actions : {};
    return {
        async decide(step, f) {
            const kind = String(step.kind);
            if (BACKGROUND_DEFERRED_KINDS.includes(kind)) {
                deferEffect(job, step);
                return { run: false, status: 'deferred', reason: 'shown when the run ends' };
            }
            const top = /^steps\[(\d+)\]$/.exec(f.path);
            if (kind === 'confirm' && f.ownerActionId === input.actionId && top && Number(top[1]) < job.leading) {
                return { run: false, status: 'skipped', reason: 'asked before the run started' };
            }
            if (kind === 'confirm' || BACKGROUND_REFUSED_KINDS.includes(kind)) {
                throw new Error(`A ${kind} step cannot run in the background.`);
            }
            return { run: true, step };
        },
        execute: (step, f, w) => executeFor(job, step, f, w),
        resolve: (binding, ctx, scope) => resolveWith(input, deps, binding, ctx, scope),
        evaluate: (expr, scope) => deps.evaluate(expr, scope),
        buildScope: (ctx) => deps.buildScope(ctx),
        ctxFor: (w, f) => baseCtx(input, w, f.ownerActionId),
        resolveCallee: (id) => ownAction(actions, id),
        onStepStart: async (e) => {
            job.progress = { ...job.progress, stepIndex: e.ordinal, kind: e.kind, executed: job.w.executed, loop: e.loop };
            await writeProgress(job, false);
        },
        onVar: (name, value) => {
            if (name !== job.progressVar) return;
            job.progress.message = progressText(value) || null;
            void writeProgress(job, true);
        },
        shouldStop: (w) => stopReason(job, w),
        sleep: (ms) => deps.sleep(ms),
        now: () => deps.now(),
    };
}

// ── The run ─────────────────────────────────────────────────────────────────

async function executeRun(job: Job): Promise<void> {
    const { deps, input, jobId } = job;
    const store = deps.store();
    const initialVars = { ...job.w.vars };
    const beat = deps.setInterval(() => { store.heartbeat([jobId]).catch(() => {}); }, Math.max(1000, Math.floor(job.limits.staleMs / 3)));
    // The run log writes its step rows onto the job's own row (no second row).
    const recorder = deps.runLog
        ? await startRun({
            appId: input.app.id, ownerUserId: input.app.userId, actionId: input.actionId, origin: 'background',
            viewerUserId: input.viewer.id, draft: input.draft, definitionVersion: input.definitionVersion, existingId: jobId,
        }, { store: deps.runLog, log: deps.log })
        : NOOP_RECORDER;
    try {
        await writeProgress(job, true);
        await walkAction(job.w, job.action, withRunLog(hostFor(job), recorder), { actionId: input.actionId });
    } finally {
        deps.clearInterval(beat);
        await recorder.finish({ status: 'success', durationMs: deps.now() - job.startedAt });
    }
    const w = job.w;
    const view = outcomeView(w);
    const durationMs = deps.now() - job.startedAt;
    const vars = writtenVars(initialVars, w.vars);
    const effects = w.deferred.length ? w.deferred : null;
    let status: 'success' | 'error' | 'interrupted';
    if (w.failed) {
        status = 'error';
        await store.finishRun(jobId, {
            status, error: w.failed.error.slice(0, 1000), errorCode: w.failed.code ?? null,
            errorStep: { path: w.failed.path, kind: w.failed.kind, stepIndex: w.failed.ordinal },
            vars, effects, durationMs, stepCount: w.executed,
        });
    } else if (w.stopped && w.truncated) {
        status = shuttingDown ? 'interrupted' : 'error';
        await store.finishRun(jobId, { status, error: w.stopped, errorCode: shuttingDown ? 'interrupted' : 'run_limit', vars, effects, durationMs, stepCount: w.executed, truncated: true, endedBy: shuttingDown ? 'shutdown' : 'limit' });
    } else {
        status = 'success';
        await store.finishRun(jobId, {
            status, result: trimToBytes(view.result, job.limits.resultMaxBytes), vars, effects, durationMs, stepCount: w.executed,
        });
    }
    deps.log.info(`[StudioBackground] ${jobId} app=${input.app.id} action=${input.actionId} ${status} in ${durationMs} ms (${w.executed} steps)`);
}

// ── Views and lifecycle ─────────────────────────────────────────────────────

/**
 * The lock of a background action for a /step of it (a foreground walk of the same action,
 * e.g. an older client): the live holder of the key resolved in this request's scope, or null.
 */
export async function lockHolderFor(input: StartInput, given: Partial<RunnerDeps> = {}): Promise<ActionRunRow | null> {
    const deps = withDefaults(given);
    const action = ownAction(isObject(input.def.actions) ? input.def.actions : {}, input.actionId);
    if (!action || !readRunOptions(action).background || !readRunOptions(action).lockKey) return null;
    const key = await resolveLockKey(input, action, deps);
    return key ? deps.store().isLockHeld(input.app.id, key, deps.limits().staleMs) : null;
}

export { lockedMessage, toJobView };
export type { App, JobView, RunnerDeps, RunScopeInput, StartInput, StartResult, Viewer };

/**
 * Shutdown: no new starts, the running walks stop at their next step, and whatever has not
 * finished within `timeoutMs` is marked interrupted.
 */
export async function stop({ timeoutMs = 20_000 }: { timeoutMs?: number } = {}, given: Partial<RunnerDeps> = {}): Promise<void> {
    shuttingDown = true;
    if (!registry.size) return;
    const deps = withDefaults(given);
    const pending = [...registry.values()];
    let timer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
    if (timer) clearTimeout(timer);
    const left = [...registry.keys()];
    if (left.length) {
        try { await deps.store().markInterrupted(left, 'The server restarted while this ran.'); } catch { /* the sweep marks them */ }
    }
}

/** Test seam: accept starts again after stop(). */
export function _resetForTests(): void {
    shuttingDown = false;
}
