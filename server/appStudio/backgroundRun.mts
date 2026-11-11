/**
 * Background actions: a sequence with `background: true` runs as a server job.
 *
 * A click POSTs /:id/actions/:actionId/background; startBackgroundRun checks the action
 * (backgroundRunPolicy), the caps and the lockKey, inserts a `running` row in
 * studio_app_action_runs (its id is the jobId) and starts the walk detached from the request,
 * so leaving or closing the page does not stop it. The browser polls the row for progress and
 * the result.
 *
 * The walk is the ONE server walker (sequenceWalk.mts) with the background host (backgroundRunJob.mts):
 *   - decide: toast/refresh are recorded and replayed by the browser at the end (deferred),
 *     leading confirms were asked before the start (skipped), any other client kind stops the
 *     run (the validator refuses those already);
 *   - execute: the heavy-step role gate, the per-(viewer, app) budgets a click spends (a job
 *     WAITS for an empty per-minute bucket instead of failing after paid calls; the daily mail
 *     cap fails the step), executeDataStep with the context /step builds, usage logging;
 *   - progress: the current step, the loop position and the text of the action's progressVar,
 *     written at most once a second (and on every progressVar change);
 *   - shouldStop: the run-time and step caps, shutdown, and a cancel (beforeStep reads the
 *     row's flag at most once a second; a cancel on this instance is seen at once).
 * A heartbeat keeps the row alive; a row whose process died is swept to `interrupted`
 * (jobs/studioAppActionRuns.js). There is no resume after a crash: steps are not idempotent.
 *
 * `runOn: 'server'` (since 3) runs a sequence the same way; the page then waits for the job
 * instead of letting it go (the browser's choice: the server run is the same).
 *
 * A DELIBERATE pause does resume. A step may ask to wait (runPause.mts): the walk stops there,
 * the row turns `paused` with the walk state on it (backgroundRunDurable.mts) and no process
 * holds anything. resumeBackgroundRun continues it, on any instance, for the wake job, a
 * server-side caller or the holder of the resume token: it checks who and what the run
 * continues as (backgroundRunIdentity.mts), claims the row with a compare-and-set (one resumer
 * wins, the others read `already_resumed`) and walks on from the paused step.
 * cancelBackgroundRun ends a paused run at once and stops a running one before its next step.
 *
 * This file is the way in: the start, the lock, the views and the shutdown. The job, its host
 * and its end are backgroundRunJob.mts; resume, wake and cancel are backgroundRunResume.mts.
 *
 * Logs carry ids, kinds, statuses, counts and durations only: never prompt text, values or a
 * provider's error text.
 */

import { newWalkState } from './sequenceWalk.mts';
import type { Obj } from './sequenceWalk.mts';
import { ownAction } from './actionCalls.mts';
import { backgroundActionProblems, limitLabel, normaliseLockKey, readRunOptions, runsOnServer } from './backgroundRunPolicy.mts';
import { newRunId } from '../stores/studioAppData/runPolicy.mts';
import type { ActionRunRow } from '../stores/studioAppData/actionRuns.mts';
import { baseCtx, isShuttingDown, launch, newJob, registry, resolveWith, setShuttingDown } from './backgroundRunJob.mts';
import { lockedMessage, toJobView, withDefaults } from './backgroundRunParts.mts';
import type { App, JobView, RunnerDeps, RunScopeInput, StartInput, StartResult, Viewer } from './backgroundRunParts.mts';

export { cancelBackgroundRun, resumeBackgroundRun, resumeWaiting, wakeDueRuns } from './backgroundRunResume.mts';
export type { ResumeResult } from './backgroundRunResume.mts';

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Test seam: resolves when job `jobId` of this process has finished (immediately when unknown). */
export function _settled(jobId: string): Promise<void> {
    return registry.get(jobId) ?? Promise.resolve();
}

/** The jobs this process is running. */
export function runningJobIds(): string[] {
    return [...registry.keys()];
}

// ── Start ───────────────────────────────────────────────────────────────────

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
    if (!action || !runsOnServer(action)) {
        return { ok: false, status: 400, code: 'not_background', error: 'This action does not run in the background.' };
    }
    if (isShuttingDown()) return { ok: false, status: 503, code: 'shutting_down', error: 'The server is restarting. Try again in a minute.' };
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

    launch(newJob(jobId, input, action, deps, limits));
    return { ok: true, jobId };
}

// ── Views and lifecycle ─────────────────────────────────────────────────────

/**
 * The lock of a background action for a /step of it (a foreground walk of the same action,
 * e.g. an older client): the live holder of the key resolved in this request's scope, or null.
 */
export async function lockHolderFor(input: StartInput, given: Partial<RunnerDeps> = {}): Promise<ActionRunRow | null> {
    const deps = withDefaults(given);
    const action = ownAction(isObject(input.def.actions) ? input.def.actions : {}, input.actionId);
    if (!action || !runsOnServer(action) || !readRunOptions(action).lockKey) return null;
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
    setShuttingDown(true);
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
    setShuttingDown(false);
}
