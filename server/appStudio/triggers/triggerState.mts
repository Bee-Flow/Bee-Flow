/**
 * The triggers of an app as its owner reads them in the editor (routes/studioApps/triggers.js):
 * what is armed, when it fires next, how the last fire went; and the owner's switch.
 *
 * An armed row exists only for a published app, so a trigger of the draft that has no row reads
 * `armed: false`. `live` says whether the row is still what the draft holds: false means the
 * draft was changed and the change goes live with the next publish.
 *
 * The switch pauses or re-arms the ROW. It does not change the definition: a trigger the owner
 * paused stays paused through a publish that did not change it, and comes back on with one that
 * did. Re-arming asks the fire's own question first (unattendedIdentity.mts), so a trigger that
 * would not run is not shown as on.
 */

import { createRequire } from 'node:module';
import type { TriggerRow, TriggerStore } from '../../stores/studioAppData/triggers.mts';
import { USER_PAUSE } from '../../stores/studioAppData/triggers.mts';
import { triggerKind } from './triggerKinds.mts';
import { triggerLimits, withMinInterval } from './triggerLimits.mts';
import type { TriggerLimits } from './triggerLimits.mts';
import { readTriggers, triggerFingerprint } from './triggerSpec.mts';
import type { ArmedRef, UnattendedContext } from './unattendedIdentity.mts';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

type AppRow = { id: string; userId: string; isPublished?: boolean; definition?: Obj | null };

export type TriggerView = {
    id: string; kind: string; actionId: string;
    /** True when a row exists and is not paused: this trigger fires. */
    armed: boolean; state: 'armed' | 'paused' | 'none'; pausedCode: string | null; pausedReason: string | null;
    /** The armed row is what the draft holds (false: publish to bring the change live). Null without a row. */
    live: boolean | null;
    nextFireAt: string | null; lastFiredAt: string | null; lastRunId: string | null; lastStatus: string | null; lastError: string | null;
    consecutiveFailures: number;
};

export type StateDeps = {
    store: () => TriggerStore;
    context: (armed: ArmedRef) => Promise<UnattendedContext>;
    now: () => number;
    limits: () => TriggerLimits;
};

function defaultDeps(): StateDeps {
    return {
        store: () => (nodeRequire('../../stores/studioAppData/triggers.mts') as { triggerStore: () => TriggerStore }).triggerStore(),
        context: (armed) => (nodeRequire('./unattendedIdentity.mts') as { loadUnattendedContext: StateDeps['context'] }).loadUnattendedContext(armed),
        now: () => Date.now(),
        limits: () => triggerLimits(),
    };
}

function viewOf(row: TriggerRow, live: boolean | null): TriggerView {
    return {
        id: row.triggerId, kind: row.kind, actionId: row.actionId, armed: row.state === 'armed', state: row.state,
        pausedCode: row.pausedCode, pausedReason: row.pausedReason, live,
        nextFireAt: row.state === 'armed' ? row.nextFireAt : null, lastFiredAt: row.lastFiredAt, lastRunId: row.lastRunId,
        lastStatus: row.lastStatus, lastError: row.lastError, consecutiveFailures: row.consecutiveFailures,
    };
}

/** Every trigger of the draft and every armed row, by trigger id (a row whose trigger left the draft is still listed: it fires until a publish). */
export async function listTriggerState(app: AppRow, given: Partial<StateDeps> = {}): Promise<{ published: boolean; triggers: TriggerView[] }> {
    const deps = { ...defaultDeps(), ...given };
    const rows = new Map((await deps.store().listForApp(app.id)).map((r) => [r.triggerId, r]));
    const def = isObject(app.definition) ? app.definition : {};
    const out: TriggerView[] = [];
    for (const trigger of readTriggers(def)) {
        const row = rows.get(trigger.id);
        rows.delete(trigger.id);
        if (row) {
            out.push(viewOf(row, trigger.enabled !== false && triggerFingerprint(def, trigger) === row.fingerprint));
        } else {
            out.push({
                id: trigger.id, kind: trigger.kind, actionId: trigger.actionId, armed: false, state: 'none', pausedCode: null, pausedReason: null, live: null,
                nextFireAt: null, lastFiredAt: null, lastRunId: null, lastStatus: null, lastError: null, consecutiveFailures: 0,
            });
        }
    }
    for (const row of rows.values()) out.push(viewOf(row, false));
    return { published: app.isPublished === true, triggers: out };
}

export type SwitchResult = { ok: true; trigger: TriggerView } | { ok: false; status: number; code: string; error: string };

/** The owner switches an armed trigger off or on again. */
export async function setTriggerEnabled(app: AppRow, triggerId: string, enabled: boolean, given: Partial<StateDeps> = {}): Promise<SwitchResult> {
    const deps = { ...defaultDeps(), ...given };
    const store = deps.store();
    const row = (await store.listForApp(app.id)).find((r) => r.triggerId === triggerId);
    if (!row) return { ok: false, status: 409, code: 'not_armed', error: 'This trigger is not armed. Publish the app to arm its triggers.' };
    const def = isObject(app.definition) ? app.definition : {};
    const draft = readTriggers(def).find((t) => t.id === triggerId);
    const live = draft ? draft.enabled !== false && triggerFingerprint(def, draft) === row.fingerprint : false;
    if (!enabled) {
        const paused = await store.setPaused(app.id, triggerId, { paused: true, code: USER_PAUSE, reason: 'Switched off by the owner.' });
        return paused ? { ok: true, trigger: viewOf(paused, live) } : { ok: false, status: 409, code: 'not_armed', error: 'This trigger is not armed any more.' };
    }
    const ctx = await deps.context({ appId: row.appId, triggerId: row.triggerId, ownerUserId: row.ownerUserId, fingerprint: row.fingerprint });
    if (!ctx.ok) {
        if (ctx.stale) await store.remove(app.id, triggerId);
        return { ok: false, status: 409, code: ctx.code, error: ctx.error };
    }
    const kind = triggerKind(row.kind);
    const now = deps.now();
    const next = kind?.nextFireAt ? withMinInterval(kind.nextFireAt(row.config, now), now, deps.limits()) : null;
    const armed = await store.setPaused(app.id, triggerId, { paused: false, nextFireAt: next });
    return armed ? { ok: true, trigger: viewOf(armed, live) } : { ok: false, status: 409, code: 'not_armed', error: 'This trigger is not armed any more.' };
}
