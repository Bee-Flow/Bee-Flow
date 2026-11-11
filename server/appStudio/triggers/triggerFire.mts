/**
 * The pass of the trigger job (jobs/studioAppTriggers.js): settle the runs of earlier fires, then
 * fire what is due.
 *
 * FIRE. An armed row whose time passed is taken with a compare-and-set on its fire counter, and
 * moves to its next time in the same statement: of two instances (or two passes) exactly one
 * fires it. Then, for the winner only:
 *   1. who and what the run is, read fresh (unattendedIdentity.mts). A row that no longer matches
 *      what is published is disarmed (removed); a trigger that is only held back for now (the
 *      owner's account, the capability) skips this fire and stays armed;
 *   2. the operator's limits (triggerLimits.mts): the trigger runs of the app going right now and
 *      the ones it started in the last hour. Over a limit the fire is skipped;
 *   3. the run starts on the server runner with origin `trigger` (triggerRun.mts).
 *
 * MISSED FIRES. The next time is counted from the moment of the fire, never from the time that
 * was missed. After downtime a trigger therefore fires ONCE, however many of its times passed,
 * and then goes on from now: there is no backlog to work through. The same holds for a skipped
 * fire: it is not made up for.
 *
 * ONE RUN AT A TIME. A trigger whose last run is still going (or is on hold) is not due: it fires
 * again after that run has ended and been settled.
 *
 * SETTLE. A fire only starts the run. How it ended is read from the run row in a later pass, on
 * whichever instance takes it: success clears the failures; a failed, refused or interrupted run
 * counts one and holds the trigger back (the wait doubles per failure in a row); after
 * STUDIO_APP_TRIGGER_MAX_FAILURES in a row the trigger is paused with the reason, until the owner
 * switches it on again or publishes. A run someone cancelled counts as neither.
 *
 * A crash between the claim and the start loses that one fire; nothing ever fires twice.
 * Logs carry ids, kinds, codes and counts only.
 */

import { createRequire } from 'node:module';
import type { ActionRunRow } from '../../stores/studioAppData/actionRuns.mts';
import type { Settle, TriggerRow, TriggerStore } from '../../stores/studioAppData/triggers.mts';
import type { StartInput, StartResult } from '../backgroundRunParts.mts';
import { triggerKind } from './triggerKinds.mts';
import { backoffMs, triggerLimitLabel, triggerLimits, withMinInterval } from './triggerLimits.mts';
import type { TriggerLimits } from './triggerLimits.mts';
import type { ArmedRef, UnattendedContext } from './unattendedIdentity.mts';

const nodeRequire = createRequire(import.meta.url);
const HOUR_MS = 3_600_000;

export type FireDeps = {
    store: () => TriggerStore;
    /** A run row by its id (the action-run store). */
    getRun: (runId: string) => Promise<ActionRunRow | null>;
    context: (armed: ArmedRef) => Promise<UnattendedContext>;
    start: (input: StartInput, triggerId: string) => Promise<StartResult>;
    now: () => number;
    limits: () => TriggerLimits;
    /** The heartbeat window of a run row: one that stopped beating does not count as going. */
    staleMs: () => number;
    isShuttingDown: () => boolean;
    cleanError: (text: unknown) => string | null;
    log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
};

export type PassResult = { settled: number; due: number; fired: number; skipped: number; disarmed: number };

/** The real stores and the real runner, each loaded when first asked. A kind that fires on an event starts from these (webhook/webhookReceive.mts). */
export function defaultFireDeps(): FireDeps {
    const policy = () => nodeRequire('../../stores/studioAppData/runPolicy.mts') as { staleMs: () => number; runLogError: (t: unknown) => string | null };
    return {
        store: () => (nodeRequire('../../stores/studioAppData/triggers.mts') as { triggerStore: () => TriggerStore }).triggerStore(),
        getRun: (runId) => (nodeRequire('../../stores/studioAppData/actionRuns.mts') as { actionRunStore: () => { getRunById: (id: string) => Promise<ActionRunRow | null> } }).actionRunStore().getRunById(runId),
        context: (armed) => (nodeRequire('./unattendedIdentity.mts') as { loadUnattendedContext: FireDeps['context'] }).loadUnattendedContext(armed),
        start: (input, triggerId) => (nodeRequire('./triggerRun.mts') as { startTriggerRun: FireDeps['start'] }).startTriggerRun(input, triggerId),
        now: () => Date.now(),
        limits: () => triggerLimits(),
        staleMs: () => policy().staleMs(),
        isShuttingDown: () => (nodeRequire('../backgroundRunJob.mts') as { isShuttingDown: () => boolean }).isShuttingDown(),
        cleanError: (text) => policy().runLogError(text),
        log: nodeRequire('../../telemetry/log') as FireDeps['log'],
    };
}

const FAILED = ['error', 'interrupted', 'refused'];

/**
 * What the end of a run means for its trigger. `run` null: the row is gone (pruned): unknown,
 * and not a failure. A run that is still going or on hold answers null (nothing to settle yet).
 */
export function settleOutcome(row: TriggerRow, run: ActionRunRow | null, now: number, limits: TriggerLimits, clean: (t: unknown) => string | null = (t) => (typeof t === 'string' ? t : null)): Settle | null {
    if (!run) return { status: 'unknown', error: 'The run of the last fire is no longer in the run log.', failures: row.consecutiveFailures };
    if (run.status === 'running' || run.status === 'paused') return null;
    if (run.status === 'success') return { status: 'success', error: null, failures: 0 };
    if (!FAILED.includes(run.status)) return { status: run.status, error: clean(run.error), failures: row.consecutiveFailures };
    const failures = row.consecutiveFailures + 1;
    const base = { status: run.status, error: clean(run.error) ?? 'The run failed.', failures };
    if (limits.maxFailures && failures >= limits.maxFailures) {
        return { ...base, pause: { code: 'failures', reason: `Paused after ${failures} failed runs in a row (${triggerLimitLabel(limits, 'maxFailures')}). Fix the action, then switch the trigger on again or publish the app.` } };
    }
    const wait = backoffMs(failures, limits);
    return { ...base, notBefore: wait ? now + wait : null };
}

/** Read how the runs of earlier fires ended and write it on their triggers. */
export async function settleFires(deps: FireDeps): Promise<number> {
    const store = deps.store();
    const limits = deps.limits();
    let settled = 0;
    for (const row of await store.listUnsettled(limits.batch)) {
        try {
            const outcome = settleOutcome(row, row.lastRunId ? await deps.getRun(row.lastRunId) : null, deps.now(), limits, deps.cleanError);
            if (!outcome || !(await store.settle(row, outcome))) continue;
            settled += 1;
            if (outcome.pause) deps.log.info(`[StudioTriggers] app=${row.appId} trigger=${row.triggerId} paused after ${outcome.failures} failed runs`);
        } catch (e) {
            deps.log.warn(`[StudioTriggers] app=${row.appId} trigger=${row.triggerId} could not be settled (${(e as Error)?.name || 'error'})`);
        }
    }
    return settled;
}

/** Why the operator's limits hold this fire back, or null. */
async function limitRefusal(row: TriggerRow, deps: FireDeps): Promise<string | null> {
    const limits = deps.limits();
    const store = deps.store();
    if (limits.runsPerApp && (await store.countRunningRuns(row.appId, deps.staleMs())) >= limits.runsPerApp) {
        return `Skipped: ${limits.runsPerApp} trigger runs of this app were already going (${triggerLimitLabel(limits, 'runsPerApp')}).`;
    }
    if (limits.firesPerHour && (await store.countRunsInWindow(row.appId, HOUR_MS)) >= limits.firesPerHour) {
        return `Skipped: this app already started ${limits.firesPerHour} trigger runs in the last hour (${triggerLimitLabel(limits, 'firesPerHour')}).`;
    }
    return null;
}

export type FireOutcome = 'fired' | 'skipped' | 'disarmed' | 'lost';

/**
 * Fire one armed row: the claim, the fresh identity, the limits, the start. `lost`: another
 * instance took the fire (or the row is no longer armed). `scope` is what a kind hands its
 * action (nothing for a schedule).
 */
export async function fireTrigger(row: TriggerRow, deps: FireDeps, scope: StartInput['scope'] = {}): Promise<FireOutcome> {
    const store = deps.store();
    const now = deps.now();
    const kind = triggerKind(row.kind);
    // A kind that fires by time moves to its next time, counted from now; any other kind keeps none.
    const next = kind?.nextFireAt ? withMinInterval(kind.nextFireAt(row.config, now), now, deps.limits()) : null;
    const claimed = await store.claimFire(row, { firedAt: now, nextFireAt: next });
    if (!claimed) return 'lost';
    let ctx: UnattendedContext;
    try {
        ctx = await deps.context({ appId: row.appId, triggerId: row.triggerId, ownerUserId: row.ownerUserId, fingerprint: row.fingerprint });
    } catch (e) {
        deps.log.warn(`[StudioTriggers] app=${row.appId} trigger=${row.triggerId} could not be checked (${(e as Error)?.name || 'error'}); this fire is skipped`);
        await store.recordSkip(claimed, 'skipped', 'Skipped: the app could not be read.');
        return 'skipped';
    }
    if (!ctx.ok) {
        if (ctx.stale) {
            await store.remove(row.appId, row.triggerId);
            deps.log.info(`[StudioTriggers] app=${row.appId} trigger=${row.triggerId} disarmed (${ctx.code})`);
            return 'disarmed';
        }
        await store.recordSkip(claimed, 'refused', ctx.error);
        return 'skipped';
    }
    const held = await limitRefusal(row, deps);
    if (held) {
        await store.recordSkip(claimed, 'skipped', held);
        return 'skipped';
    }
    const started = await deps.start({ ...ctx.input, scope }, row.triggerId);
    if (!started.ok) {
        await store.recordSkip(claimed, 'skipped', `Skipped: ${started.error}`);
        return 'skipped';
    }
    await store.recordStart(claimed, started.jobId);
    return 'fired';
}

/** One pass: settle, then fire every due trigger (at most the batch). */
export async function triggerPass(given: Partial<FireDeps> = {}): Promise<PassResult> {
    const deps = { ...defaultFireDeps(), ...given };
    const out: PassResult = { settled: 0, due: 0, fired: 0, skipped: 0, disarmed: 0 };
    out.settled = await settleFires(deps);
    if (deps.isShuttingDown()) return out;
    const due = await deps.store().listDue(deps.now(), deps.limits().batch);
    out.due = due.length;
    for (const row of due) {
        try {
            const outcome = await fireTrigger(row, deps);
            if (outcome === 'fired') out.fired += 1;
            else if (outcome === 'skipped') out.skipped += 1;
            else if (outcome === 'disarmed') out.disarmed += 1;
        } catch (e) {
            deps.log.warn(`[StudioTriggers] app=${row.appId} trigger=${row.triggerId} could not fire (${(e as Error)?.name || 'error'})`);
        }
    }
    return out;
}
