/**
 * One server run of an action (backgroundRun.mts starts it, backgroundRunResume.mts continues
 * one that was on hold): the job, its walker host, and what happens when the walk stops.
 *
 * The walk is the ONE server walker (sequenceWalk.mts) with the host below; backgroundRun.mts
 * says what the host decides. When the walk stops the run has ended (endRun: success, the
 * failing step, a limit, a cancel, a shutdown) or is on hold (holdRun: a step waits, the row
 * turns `paused` and takes the walk state, this process lets go of it).
 *
 * This module also holds what this process knows about its runs: the registry of the jobs it
 * is running and whether it is shutting down.
 */

import { createRequire } from 'node:module';
import { newWalkState, outcomeView, walkAction } from './sequenceWalk.mts';
import type { Obj, PauseRequest, Step, StepEvent, StepResult, WalkHost, WalkState } from './sequenceWalk.mts';
import { resolveRunBinding } from './runBindings.mts';
import { withViewerAttributes } from './viewerAttributes.mts';
import { NOOP_RECORDER, startRun, withRunLog } from './runLog/recorder.mts';
import { ownAction } from './actionCalls.mts';
import { BACKGROUND_DEFERRED_KINDS, BACKGROUND_REFUSED_KINDS, MAX_DEFERRED_EFFECTS, leadingConfirmCount, limitLabel, progressText, readRunOptions } from './backgroundRunPolicy.mts';
import type { BackgroundLimits } from './backgroundRunPolicy.mts';
import { actionsSnapshot, pauseRefusal, pausedCapRefusal, pausedRecord, waitOf, waitingLabel, wakePlan } from './backgroundRunDurable.mts';
import type { Refusal } from './backgroundRunDurable.mts';
import { trimToBytes, writtenVars } from './backgroundRunParts.mts';
import { runsUnattended } from './triggers/unattendedPolicy.mts';
import type { JobView, RunnerDeps, StartInput } from './backgroundRunParts.mts';

const nodeRequire = createRequire(import.meta.url);
type Attribution = { withUsageAttribution: <T>(a: { actorUserId?: string | null; runId?: string | null }, fn: () => T) => T };
const { withUsageAttribution } = nodeRequire('./usageAttribution') as Attribution;

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const LOOP_ROWS = 200;
const PROGRESS_EVERY_MS = 1000;
const CANCEL_POLL_MS = 1000;
export const CANCELLED = 'The run was cancelled.';

// ── This process's runs ─────────────────────────────────────────────────────

/** The jobs this process is running, by id: the promise each settles with. */
export const registry = new Map<string, Promise<void>>();
/** The same jobs as objects, so a cancel on this instance reaches its job without a database round trip. */
export const running = new Map<string, Job>();
let shuttingDown = false;

export const isShuttingDown = (): boolean => shuttingDown;
/** True from the start of a shutdown: no start, no resume, and the running walks stop at their next step. */
export function setShuttingDown(on: boolean): void {
    shuttingDown = on;
}

export type Job = {
    jobId: string; input: StartInput; action: Obj; deps: RunnerDeps; limits: BackgroundLimits;
    w: WalkState; startedAt: number; deadline: number; leading: number; progressVar: string | null;
    progress: JobView['progress']; lastWrite: number; seenEffects: Set<string>;
    /**
     * The actions the run walks: those of the definition it started on, or, for a run that was on
     * hold, the snapshot its pause kept (a later edit of the app does not reach a run under way).
     */
    actions: Obj;
    /** A resumed run: the milliseconds it ran before its pauses, and the variables it wrote before them. */
    activeMs: number; written: string[];
    cancelled: boolean; lastCancelPoll: number;
};

export function baseCtx(input: StartInput, w: WalkState, ownerActionId: string): Obj {
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

export async function resolveWith(input: StartInput, deps: RunnerDeps, binding: unknown, ctx: Obj, scope: unknown, where = ''): Promise<unknown> {
    const { app, model, viewer, role } = input;
    // email / groups / orgId for the row rules, read again for every binding: a job can run long.
    const reader = await withViewerAttributes({ id: viewer.id, role: role || null, organizationId: viewer.organizationId || null }, model);
    return resolveRunBinding(binding, {
        app, model, ctx, scope, maxRows: LOOP_ROWS, where,
        readData: deps.readData, resolveBinding: deps.resolveBinding,
        reader: { viewer: reader, role },
    });
}

/** Run `job` detached from whoever started or resumed it, registered as one of this process's jobs. */
export function launch(job: Job): void {
    const { jobId, deps, input } = job;
    const promise = executeRun(job).catch(async (e) => {
        deps.log.error(`[StudioBackground] ${jobId} app=${input.app.id} action=${input.actionId} crashed (${(e as Error)?.name || 'error'})`);
        try { await deps.store().finishRun(jobId, { status: 'error', error: 'The run stopped unexpectedly.', errorCode: 'internal', durationMs: activeMsOf(job) }); } catch { /* the sweep marks it interrupted */ }
    }).finally(() => { registry.delete(jobId); running.delete(jobId); });
    registry.set(jobId, promise);
    running.set(jobId, job);
}

/** The milliseconds the run was really running: this stretch plus the ones before its pauses. */
export const activeMsOf = (job: Job): number => job.activeMs + (job.deps.now() - job.startedAt);

export function newJob(jobId: string, input: StartInput, action: Obj, deps: RunnerDeps, limits: BackgroundLimits): Job {
    const { scope } = input;
    const startedAt = deps.now();
    return {
        jobId, input, action, deps, limits, startedAt,
        w: newWalkState({ vars: scope.vars, form: scope.formValues, item: scope.item, index: scope.index, value: scope.value }),
        deadline: limits.maxRunMs ? startedAt + limits.maxRunMs : 0,
        leading: leadingConfirmCount(action.steps),
        progressVar: readRunOptions(action).progressVar,
        progress: { stepIndex: null, kind: null, executed: 0, message: null, loop: null, waiting: null },
        lastWrite: 0, seenEffects: new Set(), activeMs: 0, written: [], cancelled: false, lastCancelPoll: 0,
        actions: isObject(input.def.actions) ? input.def.actions : {},
    };
}

// ── The host ────────────────────────────────────────────────────────────────

async function writeProgress(job: Job, force: boolean): Promise<void> {
    const now = job.deps.now();
    if (!force && now - job.lastWrite < PROGRESS_EVERY_MS) return;
    job.lastWrite = now;
    try { await job.deps.store().updateProgress(job.jobId, { ...job.progress }); } catch { /* progress is best effort */ }
}

/** A toast's text: its `messageExpr` worked out in the run's scope (since 3), else the literal `message`. */
function toastMessage(job: Job, step: Step, ownerActionId: string): string {
    const literal = typeof step.message === 'string' ? step.message : '';
    if (typeof step.messageExpr !== 'string' || !step.messageExpr) return literal.slice(0, 500);
    try {
        const ctx = baseCtx(job.input, job.w, ownerActionId);
        const got = job.deps.evaluate(step.messageExpr, job.deps.buildScope(ctx));
        const text = typeof got === 'string' || typeof got === 'number' || typeof got === 'boolean' ? String(got).trim() : '';
        return (text || literal).slice(0, 500);
    } catch {
        return literal.slice(0, 500);
    }
}

function deferEffect(job: Job, step: Step, ownerActionId: string): void {
    const effect: Obj = step.kind === 'toast'
        ? { kind: 'toast', message: toastMessage(job, step, ownerActionId), tone: typeof step.tone === 'string' ? step.tone : 'info' }
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
            if (isShuttingDown()) return { ok: false, error: 'The server is restarting.', code: 'shutting_down', retryable: false };
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
    // canPause: this host can put the run on hold, so the executor lets a step's wait through (actionExecutor/dispatch.js).
    const ctx = { ...baseCtx(input, w, f.ownerActionId), ...deps.stepDocumentContext(step, input.def, input.role), canPause: true };
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
    if (isShuttingDown()) return 'The server restarted while this ran.';
    if (job.cancelled) return CANCELLED;
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
    const { actions } = job;
    return {
        async decide(step, f) {
            const kind = String(step.kind);
            // Nobody is at a page: what the validator and the fire refused is refused again where it would run.
            if (input.unattended && !runsUnattended(kind, input.unattended.refusedKinds)) {
                throw new Error(`A ${kind} step cannot run without a person at the page.`);
            }
            if (BACKGROUND_DEFERRED_KINDS.includes(kind)) {
                deferEffect(job, step, f.ownerActionId);
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
        beforeStep: () => readCancel(job),
        canPause: true,
        acceptPause: (request, state) => acceptPause(job, request, state),
        sleep: (ms) => deps.sleep(ms),
        now: () => deps.now(),
    };
}

/** Before a step: was a cancel asked? The row's flag is read at most once a second (another instance may have set it). */
async function readCancel(job: Job): Promise<void> {
    if (job.cancelled) return;
    const now = job.deps.now();
    if (job.lastCancelPoll && now - job.lastCancelPoll < CANCEL_POLL_MS) return;
    job.lastCancelPoll = now || 1;
    try { if (await job.deps.store().cancelRequested(job.jobId)) job.cancelled = true; } catch { /* a missed read is made up for at the next step */ }
}

/** A step asked to wait: the operator's limits decide whether this run may be put on hold. The size limit counts the walk and the actions kept with it. */
async function acceptPause(job: Job, request: PauseRequest, state: Obj): Promise<Refusal | null> {
    const kept = { walk: state, actions: actionsSnapshot(job.actions, job.input.actionId) };
    const refused = pauseRefusal(request, kept, job.deps.now(), job.limits);
    if (refused || !job.limits.pausedPerApp) return refused;
    return pausedCapRefusal(await job.deps.store().countPaused(job.input.app.id), job.limits);
}

// ── The run ─────────────────────────────────────────────────────────────────

/** The variables the run wrote: those of this stretch, and of the stretches before its pauses. */
function writtenBy(job: Job, initialVars: Obj): Obj {
    const out: Obj = {};
    for (const name of job.written) if (Object.hasOwn(job.w.vars, name)) out[name] = job.w.vars[name];
    return { ...out, ...writtenVars(initialVars, job.w.vars) };
}

/**
 * The walk stopped at a step that waits: the row turns `paused` and takes the state; this
 * process lets go of the run. A cancel asked in the meantime wins (the store refuses the pause).
 */
async function holdRun(job: Job, vars: Obj): Promise<string> {
    const { deps, input, jobId, w } = job;
    const paused = w.paused;
    if (!paused) return 'running';
    const store = deps.store();
    const plan = wakePlan(paused.request, deps.now(), job.limits);
    const run = { role: input.role, activeMs: activeMsOf(job), written: Object.keys(vars) };
    const kept = { walk: paused.state, actions: actionsSnapshot(job.actions, input.actionId) };
    const held = await store.pauseRun(jobId, {
        state: { ...pausedRecord(kept, run, paused.request, plan) }, wakeAt: plan.wakeAt, ...waitOf(paused.request),
        progress: { ...job.progress, executed: w.executed, waiting: waitingLabel(paused.request) },
    });
    if (held) return 'paused';
    // Not put on hold: a cancel was asked while the step ran (or the row is no longer this job's).
    await store.finishRun(jobId, { status: 'cancelled', error: CANCELLED, errorCode: 'cancelled', durationMs: activeMsOf(job), stepCount: w.executed, truncated: true, endedBy: 'user' });
    return 'cancelled';
}

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
    const durationMs = activeMsOf(job);
    const vars = writtenBy(job, initialVars);
    const effects = w.deferred.length ? w.deferred : null;
    const status = w.paused ? await holdRun(job, vars) : await endRun(job, { vars, effects, durationMs, result: view.result });
    deps.log.info(`[StudioBackground] ${jobId} app=${input.app.id} action=${input.actionId} ${status} in ${durationMs} ms (${w.executed} steps)`);
}

/** Write how a walk that did not pause ended, and answer the status. */
async function endRun(job: Job, o: { vars: Obj; effects: Obj[] | null; durationMs: number; result: unknown }): Promise<string> {
    const { w, jobId } = job;
    const store = job.deps.store();
    const base = { vars: o.vars, durationMs: o.durationMs, stepCount: w.executed };
    if (w.failed) {
        await store.finishRun(jobId, {
            ...base, status: 'error', error: w.failed.error.slice(0, 1000), errorCode: w.failed.code ?? null,
            errorStep: { path: w.failed.path, kind: w.failed.kind, stepIndex: w.failed.ordinal }, effects: o.effects,
        });
        return 'error';
    }
    if (w.stopped && w.truncated && job.cancelled && !isShuttingDown()) {
        await store.finishRun(jobId, { ...base, status: 'cancelled', error: CANCELLED, errorCode: 'cancelled', truncated: true, endedBy: 'user' });
        return 'cancelled';
    }
    if (w.stopped && w.truncated) {
        const status = isShuttingDown() ? 'interrupted' : 'error';
        await store.finishRun(jobId, { ...base, status, error: w.stopped, errorCode: isShuttingDown() ? 'interrupted' : 'run_limit', effects: o.effects, truncated: true, endedBy: isShuttingDown() ? 'shutdown' : 'limit' });
        return status;
    }
    await store.finishRun(jobId, { ...base, status: 'success', result: trimToBytes(o.result, job.limits.resultMaxBytes), effects: o.effects });
    return 'success';
}
