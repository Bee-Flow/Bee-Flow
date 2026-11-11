'use strict';

/**
 * The set-up the server-trigger tests share (appStudio/triggers/*.test.js, the trigger routes):
 * the background-run harness (the REAL run store on PGlite, a fake clock, an injected executor)
 * plus the REAL trigger store on the same database, one published app held in memory, and the
 * deps the trigger modules take.
 *
 * `triggerHarness({ before, after, beforeEach })` registers the hooks and returns the harness:
 *
 *   t.app        the app row the fake store answers (publish(def) / unpublish() change it)
 *   t.owner      the owner's account row (set `status` to deactivate it)
 *   t.capability whether the owner has App Studio
 *   t.limits     triggerLimits({}), a copy a test may change
 *   publish(def) freeze `def` as the published copy and sync the triggers, like the publish route
 *   pass()       one pass of the job on the fake clock; settle(runId) waits for a started run
 *   rows()       the armed rows of the app
 */

const { backgroundRunHarness } = require('./backgroundRunHarness.testkit');
const { studioRunTableDdl } = require('./studioRunTables');
const { makeTriggerStore } = require('../stores/studioAppData/triggers.mts');
const BG = require('../appStudio/backgroundRun.mts');
const { triggerLimits } = require('../appStudio/triggers/triggerLimits.mts');
const { syncAppTriggers } = require('../appStudio/triggers/triggerSync.mts');
const { triggerPass } = require('../appStudio/triggers/triggerFire.mts');
const { loadUnattendedContext } = require('../appStudio/triggers/unattendedIdentity.mts');
const { startTriggerRun } = require('../appStudio/triggers/triggerRun.mts');
const { listTriggerState, setTriggerEnabled } = require('../appStudio/triggers/triggerState.mts');

const MINUTE = 60_000;
const write = (tableId) => ({ kind: 'create_record', tableId, values: {} });
/** A definition with one action `act_job` and the given triggers. */
const definition = (triggers, steps = [write('log')], extra = {}) => ({
    schemaVersion: 3, actions: { act_job: { kind: 'sequence', steps }, ...(extra.actions || {}) }, ...(triggers ? { triggers } : {}),
});
const every = (minutes, over = {}) => ({ id: 'tick', kind: 'schedule', actionId: 'act_job', schedule: { everyMinutes: minutes }, ...over });

function triggerHarness(hooks) {
    const h = backgroundRunHarness(hooks);
    const store = makeTriggerStore(h.db);
    const t = { app: null, owner: null, capability: true, limits: {} };
    const quiet = { info() {}, warn() {}, error() {} };

    hooks.before(async () => { await h.pg.exec(studioRunTableDdl('studio_app_triggers')); });
    hooks.beforeEach(async () => {
        await h.pg.query('DELETE FROM studio_app_triggers');
        Object.assign(t, {
            app: { ...h.APP, isPublished: false, definition: {}, publishedDefinition: null, publishedVersion: null },
            owner: { id: 'owner', name: 'Olga Owner', email: 'olga@example.test', organizationId: 'org_1', status: 'active' },
            capability: true, limits: { ...triggerLimits({}) },
        });
    });

    const identity = () => ({
        getApp: async (id) => (t.app && t.app.id === id ? t.app : null),
        getUser: async (id) => (t.owner && t.owner.id === id ? t.owner : null),
        isActiveAccount: (u) => !!u && (!u.status || u.status === 'active'),
        hasAppStudio: async () => t.capability,
        getModel: async () => null,
        resolveRole: async (app, userId) => (app.userId === userId ? 'owner' : null),
    });
    const syncDeps = () => ({ store: () => store, getApp: identity().getApp, now: () => h.s.clock, limits: () => t.limits, log: quiet });
    const fireDeps = (over = {}) => ({
        store: () => store,
        getRun: (id) => h.store.getRunById(id),
        context: (armed) => loadUnattendedContext(armed, identity()),
        start: (input, triggerId) => startTriggerRun(input, triggerId, h.deps()),
        now: () => h.s.clock,
        limits: () => t.limits,
        staleMs: () => 90_000,
        isShuttingDown: () => false,
        cleanError: (text) => (typeof text === 'string' ? text : null),
        log: quiet,
        ...over,
    });
    const stateDeps = () => ({ store: () => store, context: fireDeps().context, now: () => h.s.clock, limits: () => t.limits });

    /** Publish `def` (the draft becomes it too) and sync, as PATCH /:id/publish does. */
    async function publish(def) {
        Object.assign(t.app, { isPublished: true, definition: def, publishedDefinition: def, publishedVersion: (t.app.publishedVersion || 0) + 1 });
        return syncAppTriggers(t.app.id, syncDeps());
    }
    async function unpublish() {
        t.app.isPublished = false;
        return syncAppTriggers(t.app.id, syncDeps());
    }
    const rows = () => store.listForApp('app_1');
    const row = async (id = 'tick') => (await rows()).find((r) => r.triggerId === id) || null;
    const pass = (over) => triggerPass(fireDeps(over));
    /** Wait for the run a fire started, and answer its row. */
    async function settle(runId) {
        await BG._settled(runId);
        return h.store.getRun('app_1', runId);
    }
    const runs = async () => (await h.pg.query("SELECT * FROM studio_app_action_runs WHERE origin = 'trigger' ORDER BY started_at, id")).rows;

    return {
        ...h, t, triggers: store, identity, syncDeps, fireDeps, stateDeps, publish, unpublish, rows, row, pass, settle, runs,
        state: () => listTriggerState(t.app, stateDeps()),
        switchTrigger: (id, enabled) => setTriggerEnabled(t.app, id, enabled, stateDeps()),
        definition, every, write, MINUTE,
    };
}

module.exports = { triggerHarness };
