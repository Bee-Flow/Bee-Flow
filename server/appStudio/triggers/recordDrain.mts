/**
 * Record triggers, the FIRE side: the pass that delivers the changed records waiting in the
 * outbox (stores/studioAppData/recordEvents.mts). It runs in the trigger job, after the pass of
 * the timed triggers (jobs/studioAppTriggers.js).
 *
 * PER PASS, at most STUDIO_APP_TRIGGER_BATCH deliveries:
 *   1. old rows go (prune): a change that waited longer than its time is dropped and its trigger
 *      says so; finished rows go after the retention;
 *   2. per armed trigger whose last run is not still going, its OLDEST waiting delivery is taken
 *      with a compare-and-set (of two instances one gets it). So a trigger handles its changes
 *      one at a time and in the order they were written, and a row's changes reach it in order;
 *   3. the rule is asked again with the data model of this moment (recordTriggerRule.mts: the
 *      table, the event, the public-table rule, the depth, the trigger's own write), then the
 *      watched fields, the `when` formula and the writer's burst limit;
 *   4. the trigger fires through triggerFire.mts `fireTrigger`: its own compare-and-set, who the
 *      run is read fresh (the app owner), the per-app limits, the run with the change as its
 *      `trigger` root.
 *
 * AT MOST ONE RUN PER DELIVERY. A delivery is claimed before anything else happens to it. A
 * crash after the claim leaves it claimed: it is never handed out again and goes with the old
 * rows. Only a claim on the trigger that another instance won gives the delivery back.
 *
 * A delivery that starts no run because a limit or the rule held it back is written on its
 * trigger (last status `skipped` and the reason), so the Triggers panel shows it. One whose
 * watched fields did not change or whose `when` is false is simply done: that is the trigger
 * working. A `when` that fails (an error, the engine's work budget) starts nothing and shows why.
 *
 * A trigger that keeps failing is held back as every trigger is: the wait after a failed run
 * (STUDIO_APP_TRIGGER_BACKOFF_MS, doubling) is counted from its last fire, and after
 * STUDIO_APP_TRIGGER_MAX_FAILURES it is paused; its changes wait, and expire.
 *
 * Logs carry ids, kinds, codes and counts only; never a row value.
 */

import { createRequire } from 'node:module';
import type { RecordDelivery, RecordEventStore } from '../../stores/studioAppData/recordEvents.mts';
import type { TriggerRow } from '../../stores/studioAppData/triggers.mts';
import { changedFields } from './recordOutbox.mts';
import { recordLimitLabel, recordTriggerLimits } from './recordTriggerLimits.mts';
import type { RecordTriggerLimits } from './recordTriggerLimits.mts';
import { UNKNOWN_DEPTH, deliveryRefusal } from './recordTriggerRule.mts';
import { defaultDeps as fireDefaults, fireTrigger, triggerPass } from './triggerFire.mts';
import type { FireDeps, PassResult } from './triggerFire.mts';
import { backoffMs } from './triggerLimits.mts';
import type { AppTrigger } from './triggerSpec.mts';

const nodeRequire = createRequire(import.meta.url);
const MINUTE_MS = 60_000;

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

export type DrainDeps = {
    events: () => RecordEventStore;
    fire: FireDeps;
    recordLimits: () => RecordTriggerLimits;
    /** The model table `tableId` of the app as it is now, or null. */
    tableOf: (appId: string, ownerUserId: string, tableId: string) => Promise<Obj | null>;
    evaluate: (expr: string, scope: Obj) => { value: unknown; error: string | null };
};

export type DrainResult = { ready: number; fired: number; skipped: number; expired: number };

function defaultDeps(): DrainDeps {
    return {
        events: () => (nodeRequire('../../stores/studioAppData/recordEvents.mts') as { recordEventStore: () => RecordEventStore }).recordEventStore(),
        fire: fireDefaults(),
        recordLimits: () => recordTriggerLimits(),
        tableOf: async (appId, ownerUserId, tableId) => {
            const store = nodeRequire('../../stores/studioAppDataStore') as { getDataModel: (appId: string, ownerId: string) => Promise<{ model?: unknown } | null> };
            const meta = await store.getDataModel(appId, ownerUserId);
            const tables = meta && isObject(meta.model) && Array.isArray(meta.model.tables) ? meta.model.tables : [];
            return (tables.find((t) => isObject(t) && (t.id === tableId || t['key'] === tableId)) as Obj | undefined) ?? null;
        },
        evaluate: (expr, scope) => (nodeRequire('../../shared/expr/index.mjs') as { tryEvaluate: DrainDeps['evaluate'] }).tryEvaluate(expr, scope),
    };
}

/** The `trigger` root a delivery hands its run (kinds/record.mts lists the fields). */
export function triggerScopeOf(d: RecordDelivery): Obj {
    return {
        kind: 'record', triggerId: d.triggerId, event: d.event, tableId: d.tableId, id: d.rowId,
        row: d.after ?? d.before, before: d.event === 'create' ? null : d.before,
        changed: d.event === 'update' ? changedFields(d.before, d.after) : [],
        by: d.writerKind, depth: d.depth,
    };
}

type Verdict = { go: true } | { go: false; code: string; note: string | null };
const quiet = (code: string): Verdict => ({ go: false, code, note: null });
const shown = (code: string, note: string): Verdict => ({ go: false, code, note });

/** Step 3: may this delivery start its trigger's run? */
async function verdictFor(d: RecordDelivery, row: TriggerRow, deps: DrainDeps, now: number): Promise<Verdict> {
    const limits = deps.recordLimits();
    const config = row.config;
    const on = Array.isArray(config.on) ? config.on.filter((e): e is string => typeof e === 'string') : [];
    const table = await deps.tableOf(d.appId, row.ownerUserId, d.tableId);
    const refusal = deliveryRefusal(
        { event: d.event, writerKind: d.writerKind, depth: d.depth, causeTriggerId: d.causeTriggerId },
        { triggerId: row.triggerId, on, allowPublicWrites: config.allowPublicWrites === true }, table, limits.maxDepth,
    );
    if (refusal) return refusal.code === 'event_off' || refusal.code === 'own_write' ? quiet(refusal.code) : shown(refusal.code, refusal.reason);
    const scope = triggerScopeOf(d);
    const watched = Array.isArray(config.fields) ? config.fields : [];
    if (d.event === 'update' && watched.length && !(scope.changed as string[]).some((name) => watched.includes(name))) return quiet('fields_unchanged');
    if (typeof config.when === 'string' && config.when) {
        const iso = new Date(now).toISOString();
        const out = deps.evaluate(config.when, { trigger: scope, now: iso, today: iso.slice(0, 10) });
        if (out.error) return shown('when_failed', 'Skipped: the when formula of this trigger failed, so it started nothing. Check the formula.');
        if (!out.value) return quiet('when_false');
    }
    if (limits.writerBurst && d.writerKey && (await deps.events().countWriterFires(d.appId, d.writerKey, now - MINUTE_MS)) >= limits.writerBurst) {
        return shown('writer_burst', `Skipped: one writer already started ${limits.writerBurst} runs of this app in a minute (${recordLimitLabel(limits, 'writerBurst')}).`);
    }
    return { go: true };
}

/** Is the trigger still waiting out a failed run? */
function heldBack(row: TriggerRow, deps: DrainDeps, now: number): boolean {
    if (!row.consecutiveFailures || !row.lastFiredAt) return false;
    const wait = backoffMs(row.consecutiveFailures, deps.fire.limits());
    return wait > 0 && now < Date.parse(row.lastFiredAt) + wait;
}

async function deliver(ready: RecordDelivery, deps: DrainDeps, out: DrainResult): Promise<void> {
    const events = deps.events();
    const now = deps.fire.now();
    const row = (await deps.fire.store().listForApp(ready.appId)).find((r) => r.triggerId === ready.triggerId && r.kind === 'record');
    if (!row || row.state !== 'armed' || heldBack(row, deps, now)) return;
    const d = await events.claim(ready.seq, now);
    if (!d) return;
    const verdict = await verdictFor(d, row, deps, now);
    if ('code' in verdict) {
        await events.finish(d, now, { state: 'skipped', code: verdict.code });
        if (verdict.note) await events.noteSkip(d.appId, d.triggerId, 'skipped', verdict.note);
        out.skipped += 1;
        return;
    }
    const outcome = await fireTrigger(row, deps.fire, { trigger: triggerScopeOf(d) });
    if (outcome === 'lost') {
        await events.release(d.seq);
        return;
    }
    if (outcome === 'fired') {
        await events.finish(d, now, { state: 'fired' });
        out.fired += 1;
        return;
    }
    // The fire wrote its own reason on the trigger (a limit, the owner's account) or removed the row.
    await events.finish(d, now, { state: 'skipped', code: outcome === 'disarmed' ? 'disarmed' : 'fire_skipped' });
    out.skipped += 1;
}

/** One pass over the outbox. */
export async function recordEventPass(given: Partial<DrainDeps> = {}): Promise<DrainResult> {
    const deps = { ...defaultDeps(), ...given };
    const out: DrainResult = { ready: 0, fired: 0, skipped: 0, expired: 0 };
    const events = deps.events();
    const limits = deps.recordLimits();
    const now = deps.fire.now();
    const pruned = await events.prune({ nowMs: now, pendingBeforeMs: limits.eventTtlMs ? now - limits.eventTtlMs : null, doneBeforeMs: now - limits.retentionMs });
    out.expired = pruned.expired.length;
    for (const gone of pruned.expired) {
        await events.noteSkip(gone.appId, gone.triggerId, 'skipped', `Skipped: a change waited longer than allowed for its run and was dropped (${recordLimitLabel(limits, 'eventTtlMs')}).`);
    }
    if (deps.fire.isShuttingDown()) return out;
    const ready = await events.listReady(deps.fire.limits().batch);
    out.ready = ready.length;
    for (const one of ready) {
        try {
            await deliver(one, deps, out);
        } catch (e) {
            deps.fire.log.warn(`[StudioRecordTriggers] app=${one.appId} trigger=${one.triggerId} a change could not be delivered (${(e as Error)?.name || 'error'})`);
        }
    }
    return out;
}

/** The job's pass: the timed triggers, then the changed records. A failure of the second never hides the first. */
export async function triggerAndRecordPass(): Promise<PassResult> {
    const out = await triggerPass();
    try {
        const drained = await recordEventPass();
        return { ...out, due: out.due + drained.ready, fired: out.fired + drained.fired, skipped: out.skipped + drained.skipped };
    } catch (e) {
        fireDefaults().log.warn(`[StudioRecordTriggers] the pass over changed records failed (${(e as Error)?.name || 'error'})`);
        return out;
    }
}

/**
 * The `trigger` root of a trigger run that goes on after a wait (unattendedIdentity.mts). A
 * record trigger's run whose delivery is gone gets a root that says so, at a depth beyond every
 * limit: what it writes then starts no further trigger. Null for a kind that hands no root.
 */
export async function resumeScope(runId: string, trigger: AppTrigger, given: Partial<Pick<DrainDeps, 'events'>> = {}): Promise<Obj | null> {
    if (trigger.kind !== 'record') return null;
    const lost: Obj = { kind: 'record', triggerId: trigger.id, event: null, tableId: null, id: null, row: null, before: null, changed: [], by: null, depth: UNKNOWN_DEPTH };
    try {
        const events = given.events ? given.events() : defaultDeps().events();
        const d = await events.forRun(runId);
        return d ? triggerScopeOf(d) : lost;
    } catch {
        return lost;
    }
}

/**
 * What started a run, for the run log (routes/studioApps/runLog.js): the event, the table, the
 * row's id and the kind of writer. No row values: the run log carries none. Null for a run no
 * record trigger started, or once the delivery is past its retention.
 */
export async function runStartedBy(runId: string, given: Partial<Pick<DrainDeps, 'events'>> = {}): Promise<{ kind: 'record'; event: string; tableId: string; rowId: string; by: string; depth: number } | null> {
    try {
        const d = await (given.events ? given.events() : defaultDeps().events()).forRun(runId);
        return d ? { kind: 'record', event: d.event, tableId: d.tableId, rowId: d.rowId, by: d.writerKind, depth: d.depth } : null;
    } catch {
        return null;
    }
}
