/**
 * Arming: the armed rows of an app (studio_app_triggers) are made equal to what its PUBLISHED
 * definition arms. This is the only writer of an armed row besides the fire itself.
 *
 * WHEN. After a publish and after an unpublish, from the publish route (routes/studioApps/publish.js);
 * and after a Solution stage wrote the published copy or the publish state: a deploy's converge
 * and a stage's on/off of the app (deploySync.mts, under the publish route's conditions).
 * Nothing else arms a trigger:
 *   - a save of the draft, an AI builder call, an import, a template or Blueprint install, a
 *     version restore, a stage's prepare: they change the draft, and a draft has no rows;
 *   - a published copy that changed some other way: the next fire finds the armed row no longer
 *     matches it and disarms it (unattendedIdentity.mts rule 4).
 * Disarming needs no hook of its own either: an unpublish removes the rows here, a deleted app
 * takes its rows with it (ON DELETE CASCADE, stores/studioApp/deleteApp.js), and a deactivated
 * owner, a lapsed licence or a switched-off module is read at every fire and by the job's own
 * module gate, so nothing fires while it lasts and nothing has to be re-armed afterwards.
 *
 * WHAT. A trigger of the published definition is armed when it is switched on (`enabled` is not
 * false), its kind is known and every step of its action may run unattended
 * (unattendedPolicy.mts). The publish validated the same thing; it is checked again because this
 * is where the row is written.
 *
 * Safe to repeat and safe on two instances: the store compares and writes the app's rows in one
 * transaction with the rows locked, an unchanged trigger keeps its row (its next time, its
 * history, a pause the owner set), and a second call with the same input changes nothing.
 */

import { createRequire } from 'node:module';
import { ownAction } from '../actionCalls.mts';
import type { DesiredTrigger, SyncResult, TriggerStore } from '../../stores/studioAppData/triggers.mts';
import { refusedKindsOf, triggerKind } from './triggerKinds.mts';
import { triggerLimits, withMinInterval } from './triggerLimits.mts';
import type { TriggerLimits } from './triggerLimits.mts';
import { readTriggers, triggerFingerprint } from './triggerSpec.mts';
import { unattendedActionProblems } from './unattendedPolicy.mts';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

type AppRow = { id: string; userId: string; isPublished?: boolean; publishedDefinition?: Obj | null };

export type SyncDeps = {
    store: () => TriggerStore;
    getApp: (appId: string) => Promise<AppRow | null>;
    now: () => number;
    limits: () => TriggerLimits;
    log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
};

function defaultDeps(): SyncDeps {
    return {
        store: () => (nodeRequire('../../stores/studioAppData/triggers.mts') as { triggerStore: () => TriggerStore }).triggerStore(),
        getApp: (appId) => (nodeRequire('../../stores/studioAppStore') as { getStudioApp: SyncDeps['getApp'] }).getStudioApp(appId),
        now: () => Date.now(),
        limits: () => triggerLimits(),
        log: nodeRequire('../../telemetry/log') as SyncDeps['log'],
    };
}

/** The write path keeps the armed record triggers in memory (recordOutbox.mts): after a sync this replica reads them again. */
function forgetArmedRecordTriggers(): void {
    (nodeRequire('./recordOutbox.mts') as { invalidateArmed: () => void }).invalidateArmed();
}

/** The triggers a published definition arms, as the rows they become. `now` is the moment a new row counts from. */
export function armedTriggersOf(def: unknown, now: number, limits: TriggerLimits): DesiredTrigger[] {
    if (!isObject(def)) return [];
    const out: DesiredTrigger[] = [];
    for (const trigger of readTriggers(def)) {
        const kind = triggerKind(trigger.kind);
        if (!kind || trigger.enabled === false) continue;
        const problems = unattendedActionProblems(ownAction(def.actions, trigger.actionId), trigger.actionId, {
            resolveCalled: (id) => ownAction(def.actions, id), refusedKinds: refusedKindsOf(kind, trigger),
        });
        if (problems.length) continue;
        const config = kind.config(trigger);
        const next = kind.nextFireAt ? withMinInterval(kind.nextFireAt(config, now), now, limits) : null;
        if (kind.nextFireAt && next === null) continue;
        out.push({ triggerId: trigger.id, kind: kind.kind, actionId: trigger.actionId, config, fingerprint: triggerFingerprint(def, trigger), nextFireAt: next });
    }
    return out;
}

/**
 * Make the app's armed rows equal to its published definition (none when it is not published).
 * Never throws: the publish that called it has already happened. Null when the sync failed; the
 * rows are then as they were, and a row that no longer matches is disarmed by its next fire.
 */
export async function syncAppTriggers(appId: string, given: Partial<SyncDeps> = {}): Promise<SyncResult | null> {
    const deps = { ...defaultDeps(), ...given };
    try {
        const app = await deps.getApp(appId);
        const store = deps.store();
        if (!app || !app.isPublished || !isObject(app.publishedDefinition)) {
            const removed = await store.disarmApp(appId);
            forgetArmedRecordTriggers();
            return { armed: 0, updated: 0, kept: 0, removed };
        }
        const out = await store.syncApp(app.id, app.userId, armedTriggersOf(app.publishedDefinition, deps.now(), deps.limits()));
        forgetArmedRecordTriggers();
        if (out.armed || out.updated || out.removed) deps.log.info(`[StudioTriggers] app=${app.id} armed ${out.armed}, updated ${out.updated}, kept ${out.kept}, removed ${out.removed}`);
        return out;
    } catch (e) {
        deps.log.warn(`[StudioTriggers] app=${appId} could not sync its triggers (${(e as Error)?.name || 'error'})`);
        return null;
    }
}
