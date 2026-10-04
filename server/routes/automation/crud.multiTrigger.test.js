'use strict';

/**
 * Regression tests for the multi-trigger dispatch rewiring in
 * routes/automation/crud.js and webhooksAndRunOps.js (Track 4 remainder —
 * see automation/validate.js's `triggers[]` rules and engine.js's runDag
 * `rootStepId` primitive, already covered by
 * core/automationRunner/runDag.rootTrigger.test.js).
 *
 * syncAppEventSubscription must create ONE subscription row PER app_event
 * trigger — the primary `definition.trigger` AND every app_event entry in
 * `definition.triggers[]` — each tagged with its OWN triggerStepId, so
 * dispatch.js can seed runDag from whichever trigger node actually fired
 * instead of always the primary. POST /:id/webhook must similarly accept
 * (and validate) an optional triggerStepId naming a webhook-kind trigger.
 *
 * Route handlers invoked directly (no supertest) — same technique as
 * routes/automation.routetable.test.js.
 *
 * Run: node --test routes/automation/crud.multiTrigger.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const SERVER = path.resolve(__dirname, '..', '..');
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

let AUTOMATIONS = {};
let subscriptionCalls = [];
let deletedFor = [];
let webhookCalls = [];
let scheduleCalls = [];
let scheduleDeletes = [];

mock(path.join(SERVER, 'stores/automationStore'), {
    getAutomation: async (id) => AUTOMATIONS[id] || null,
    updateAutomation: async (id, updates) => { AUTOMATIONS[id] = { ...AUTOMATIONS[id], ...updates }; return AUTOMATIONS[id]; },
    getSubscriptionsForAutomation: async () => [],
    deleteSubscriptionsForAutomation: async (id) => { deletedFor.push(id); },
    createSubscription: async (opts) => { const row = { id: `sub-${subscriptionCalls.length}`, ...opts }; subscriptionCalls.push(row); return row; },
    updateSubscription: async () => true,
    createWebhook: async (automationId, triggerStepId) => { const row = { id: `wh-${webhookCalls.length}`, automationId, triggerStepId }; webhookCalls.push(row); return row; },
    // Additional schedule triggers (automation_schedules).
    upsertSchedule: async (opts) => { scheduleCalls.push(opts); return { id: `sch-${scheduleCalls.length}`, ...opts }; },
    deleteSchedulesExcept: async (automationId, keep) => { scheduleDeletes.push({ automationId, keep }); },
});
mock(path.join(SERVER, 'automation/cron'), { nextRunAt: () => null });
mock(path.join(SERVER, 'automation/validate'), { validateDefinition: () => ({ ok: true, warnings: [] }) });
mock(path.join(SERVER, 'automation/summarise'), { summariseDefinition: () => ({ summary: '' }) });
mock(path.join(SERVER, 'automation/deliverableEvents'), { getDeliverableEvents: () => [] });
mock(path.join(SERVER, 'automation/toolRegistry'), { TOOL_REGISTRY: [], loadTools: () => [] });
mock(path.join(SERVER, 'automation/triggerBus'), {
    getPublicBaseUrl: () => null,
    loadSession: async () => null,
    revokeSubscription: async () => {},
    fetchLatestGmailMatch: async () => null,
    dispatchEvent: async () => [],
});
mock(path.join(SERVER, 'utils/perUserRateLimit'), { perUserRateLimit: () => (req, res, next) => next() });
// Loaded for real BEFORE the mock replaces the cache entry: activate reads the
// definition's pinned nodes through collectPinnedNodes, and a stub of that
// reader would test the stub. It is a pure module, so this costs nothing.
const realPortability = require(path.join(SERVER, 'automation/portability'));
mock(path.join(SERVER, 'automation/portability'), {
    buildExport: () => ({}),
    sanitizeImport: () => ({ automation: null, errors: ['not used'] }),
    rekeyDefinition: (d) => ({ definition: d }),
    collectPinnedNodes: realPortability.collectPinnedNodes,
});
mock(path.join(SERVER, 'core/integrations/integrationTools'), { getUserPermittedApps: async () => new Set() });

const crudRouter = require('./crud');
const webhookRouter = require('./webhooksAndRunOps');

function findHandler(router, method, routePath) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
            return layer.route.stack[layer.route.stack.length - 1].handle;
        }
    }
    throw new Error(`route not found: ${method} ${routePath}`);
}

function makeRes() {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}

const activateHandler = findHandler(crudRouter, 'post', '/:id/activate');
const putHandler = findHandler(crudRouter, 'put', '/:id');
const createWebhookHandler = findHandler(webhookRouter, 'post', '/:id/webhook');

test('activate: one subscription row per app_event trigger (primary + triggers[]), each tagged with its own triggerStepId', async () => {
    subscriptionCalls = []; deletedFor = [];
    AUTOMATIONS.auto1 = {
        id: 'auto1', userId: 'user1', isActive: false, isDraft: true, triggerType: 'manual', scheduleCron: null,
        definition: {
            trigger: { id: 'trg1', kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new', filter: null } },
            triggers: [
                { id: 'trg2', kind: 'app_event', appEvent: { provider: 'github', event: 'push', filter: null } },
            ],
            steps: [], edges: [],
        },
    };
    const req = { params: { id: 'auto1' }, session: { user: { id: 'user1' }, isAdmin: false } };
    const res = makeRes();
    await activateHandler(req, res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(deletedFor, ['auto1'], 'sync wipes stale rows before recreating');
    assert.strictEqual(subscriptionCalls.length, 2, 'one row per app_event trigger');
    const byProvider = Object.fromEntries(subscriptionCalls.map(s => [s.provider, s]));
    assert.strictEqual(byProvider.gmail.triggerStepId, 'trg1');
    assert.strictEqual(byProvider.github.triggerStepId, 'trg2');
});

test('activate: a webhook-kind primary trigger with an app_event secondary only syncs the secondary', async () => {
    subscriptionCalls = []; deletedFor = [];
    AUTOMATIONS.auto2 = {
        id: 'auto2', userId: 'user1', isActive: false, isDraft: true, triggerType: 'manual', scheduleCron: null,
        definition: {
            trigger: { id: 'trg1', kind: 'webhook' },
            triggers: [
                { id: 'trg2', kind: 'app_event', appEvent: { provider: 'nextcloud', event: 'file.new', filter: null } },
            ],
            steps: [], edges: [],
        },
    };
    const req = { params: { id: 'auto2' }, session: { user: { id: 'user1' }, isAdmin: false } };
    await activateHandler(req, makeRes());

    assert.strictEqual(subscriptionCalls.length, 1);
    assert.strictEqual(subscriptionCalls[0].triggerStepId, 'trg2');
    assert.strictEqual(subscriptionCalls[0].provider, 'nextcloud');
});

test('PUT /:id: definition edit re-syncs when ONLY a secondary trigger is app_event (primary is manual)', async () => {
    subscriptionCalls = []; deletedFor = [];
    const existingDef = {
        trigger: { id: 'trg1', kind: 'manual' },
        triggers: [{ id: 'trg2', kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new', filter: null } }],
        steps: [], edges: [],
    };
    AUTOMATIONS.auto3 = { id: 'auto3', userId: 'user1', isActive: true, isDraft: false, definition: existingDef };
    const newDef = { ...existingDef, triggers: [{ ...existingDef.triggers[0], appEvent: { ...existingDef.triggers[0].appEvent, filter: { changed: true } } }] };
    const req = { params: { id: 'auto3' }, session: { user: { id: 'user1' } }, body: { definition: newDef } };
    await putHandler(req, makeRes());

    assert.strictEqual(subscriptionCalls.length, 1, 'secondary-trigger-only app_event still triggers a re-sync');
    assert.strictEqual(subscriptionCalls[0].triggerStepId, 'trg2');
});

test('POST /:id/webhook: rejects a triggerStepId that does not match any trigger on the automation', async () => {
    webhookCalls = [];
    AUTOMATIONS.auto4 = {
        id: 'auto4', userId: 'user1',
        definition: { trigger: { id: 'trg1', kind: 'webhook' }, triggers: [], steps: [], edges: [] },
    };
    const req = { params: { id: 'auto4' }, session: { user: { id: 'user1' } }, body: { triggerStepId: 'nope' } };
    const res = makeRes();
    await createWebhookHandler(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(webhookCalls, []);
});

test('POST /:id/webhook: rejects a triggerStepId that names a real but non-webhook trigger', async () => {
    webhookCalls = [];
    AUTOMATIONS.auto5 = {
        id: 'auto5', userId: 'user1',
        definition: {
            trigger: { id: 'trg1', kind: 'webhook' },
            triggers: [{ id: 'trg2', kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new' } }],
            steps: [], edges: [],
        },
    };
    const req = { params: { id: 'auto5' }, session: { user: { id: 'user1' } }, body: { triggerStepId: 'trg2' } };
    const res = makeRes();
    await createWebhookHandler(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(webhookCalls, []);
});

test('POST /:id/webhook: a valid secondary webhook trigger id is accepted and threaded to createWebhook', async () => {
    webhookCalls = [];
    AUTOMATIONS.auto6 = {
        id: 'auto6', userId: 'user1',
        definition: {
            trigger: { id: 'trg1', kind: 'manual' },
            triggers: [{ id: 'trg2', kind: 'webhook' }],
            steps: [], edges: [],
        },
    };
    const req = { params: { id: 'auto6' }, session: { user: { id: 'user1' } }, body: { triggerStepId: 'trg2' } };
    const res = makeRes();
    await createWebhookHandler(req, res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(webhookCalls.length, 1);
    assert.strictEqual(webhookCalls[0].triggerStepId, 'trg2');
});

test('POST /:id/webhook: omitted triggerStepId defaults to null (primary trigger) — unchanged behavior', async () => {
    webhookCalls = [];
    AUTOMATIONS.auto7 = {
        id: 'auto7', userId: 'user1',
        definition: { trigger: { id: 'trg1', kind: 'webhook' }, triggers: [], steps: [], edges: [] },
    };
    const req = { params: { id: 'auto7' }, session: { user: { id: 'user1' } }, body: {} };
    const res = makeRes();
    await createWebhookHandler(req, res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(webhookCalls[0].triggerStepId, null);
});

test('activate: every additional schedule trigger gets a re-armed automation_schedules row; the primary schedule does not', async () => {
    scheduleCalls = []; scheduleDeletes = []; subscriptionCalls = []; deletedFor = [];
    AUTOMATIONS.auto5 = {
        id: 'auto5', userId: 'user1', isActive: false, isDraft: true, triggerType: 'manual', scheduleCron: null,
        definition: {
            trigger: { id: 'trg1', kind: 'manual' },
            triggers: [
                { id: 'trg_daily', kind: 'schedule', schedule: { cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam' } },
                { id: 'trg_cal', kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new', filter: null } },
                { id: 'trg_week', kind: 'schedule', schedule: { cron: '0 8 * * 1' } },
            ],
            steps: [], edges: [],
        },
    };
    const req = { params: { id: 'auto5' }, session: { user: { id: 'user1' }, isAdmin: false } };
    const res = makeRes();
    await activateHandler(req, res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(scheduleCalls.map(c => [c.triggerStepId, c.cron, c.tz, c.rearm]), [
        ['trg_daily', '0 7 * * 1-5', 'Europe/Amsterdam', true],
        ['trg_week', '0 8 * * 1', 'Europe/Amsterdam', true],
    ]);
    assert.deepStrictEqual(scheduleDeletes, [{ automationId: 'auto5', keep: ['trg_daily', 'trg_week'] }]);
    assert.strictEqual(subscriptionCalls.length, 1, 'the app_event secondary still gets its subscription');
});

test('PUT /:id on an active automation re-syncs schedules only when a secondary cron changed', async () => {
    scheduleCalls = []; scheduleDeletes = [];
    const existingDef = {
        trigger: { id: 'trg1', kind: 'manual' },
        triggers: [{ id: 'trg_daily', kind: 'schedule', schedule: { cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam' }, position: { x: 0, y: 0 } }],
        steps: [], edges: [],
    };
    AUTOMATIONS.auto6 = { id: 'auto6', userId: 'user1', isActive: true, isDraft: false, definition: existingDef };
    // A node nudge: same cron, new position → no re-sync (nothing re-anchors).
    const nudged = { ...existingDef, triggers: [{ ...existingDef.triggers[0], position: { x: 40, y: 0 } }] };
    await putHandler({ params: { id: 'auto6' }, session: { user: { id: 'user1' } }, body: { definition: nudged } }, makeRes());
    assert.deepStrictEqual(scheduleCalls, [], 'a position change must not touch the schedule rows');
    // A cron change → re-sync without re-arming (the store keeps unchanged slots itself).
    const changed = { ...existingDef, triggers: [{ ...existingDef.triggers[0], schedule: { cron: '30 7 * * 1-5', tz: 'Europe/Amsterdam' } }] };
    await putHandler({ params: { id: 'auto6' }, session: { user: { id: 'user1' } }, body: { definition: changed } }, makeRes());
    assert.strictEqual(scheduleCalls.length, 1);
    assert.strictEqual(scheduleCalls[0].cron, '30 7 * * 1-5');
    assert.strictEqual(scheduleCalls[0].rearm, false);
});
