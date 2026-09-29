'use strict';

/**
 * A12 — definition saves on an ACTIVE app_event routine must not reset the
 * subscription cursor.
 *
 * Two layers under test:
 *   1. Fingerprint gate: a PUT whose definition change does NOT touch any
 *      app-event trigger config (label edit, node drag) skips the
 *      delete-and-recreate entirely.
 *   2. Cursor carry: when a re-sync IS due (filter/provider/event changed),
 *      the new subscription row inherits the prior row's lastCursor instead
 *      of re-anchoring at null (null = poller bootstraps at "now" and drops
 *      every event since the last poll).
 *
 * Route handlers invoked directly — same harness as crud.multiTrigger.test.js.
 *
 * Run: node --test routes/automation/crud.subscriptionResync.test.js
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
let priorSubs = [];

mock(path.join(SERVER, 'stores/automationStore'), {
    getAutomation: async (id) => AUTOMATIONS[id] || null,
    updateAutomation: async (id, updates) => { AUTOMATIONS[id] = { ...AUTOMATIONS[id], ...updates }; return AUTOMATIONS[id]; },
    getSubscriptionsForAutomation: async () => priorSubs,
    deleteSubscriptionsForAutomation: async (id) => { deletedFor.push(id); },
    createSubscription: async (opts) => { const row = { id: `sub-${subscriptionCalls.length}`, ...opts }; subscriptionCalls.push(row); return row; },
    updateSubscription: async () => true,
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

const putHandler = findHandler(crudRouter, 'put', '/:id');

const gmailDef = (filter = null, label = 'Gmail in') => ({
    trigger: { id: 'trg1', kind: 'app_event', label, appEvent: { provider: 'gmail', event: 'mail.new', filter } },
    steps: [],
    edges: [],
});

function seed(def) {
    AUTOMATIONS = {
        auto1: {
            id: 'auto1', userId: 'user1', isActive: true, isDraft: false,
            triggerType: 'app_event', scheduleCron: null, scheduleTz: null,
            definition: def,
        },
    };
    subscriptionCalls = [];
    deletedFor = [];
    priorSubs = [{
        id: 'sub-old', automationId: 'auto1', userId: 'user1', provider: 'gmail',
        eventType: 'mail.new', mode: 'polling', lastCursor: 'history-12345',
        filter: def.trigger.appEvent.filter, triggerStepId: 'trg1',
    }];
}

async function put(definition) {
    const req = { params: { id: 'auto1' }, session: { user: { id: 'user1' } }, body: { definition } };
    const res = makeRes();
    await putHandler(req, res);
    return res;
}

test('a label-only definition edit does NOT delete/recreate the subscription', async () => {
    seed(gmailDef(null, 'Gmail in'));
    const res = await put(gmailDef(null, 'Renamed label'));
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(deletedFor, [], 'no wipe — the app-event config is unchanged');
    assert.deepStrictEqual(subscriptionCalls, [], 'no re-create');
});

test('a filter change re-syncs AND carries the prior cursor', async () => {
    seed(gmailDef(null));
    const res = await put(gmailDef({ from: 'boss@example.com' }));
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(deletedFor, ['auto1'], 'config changed → re-sync');
    assert.strictEqual(subscriptionCalls.length, 1);
    assert.strictEqual(subscriptionCalls[0].lastCursor, 'history-12345', 'cursor must survive the re-sync');
    assert.deepStrictEqual(subscriptionCalls[0].filter, { from: 'boss@example.com' }, 'new filter applies');
});

test('a genuinely NEW trigger bootstraps with a null cursor', async () => {
    seed(gmailDef(null));
    const next = gmailDef(null);
    next.triggers = [{ id: 'trg2', kind: 'app_event', appEvent: { provider: 'github', event: 'push', filter: null } }];
    await put(next);
    const github = subscriptionCalls.find(s => s.provider === 'github');
    assert.ok(github, 'new trigger got a row');
    assert.strictEqual(github.lastCursor, null, 'no history claim for a brand-new trigger');
    const gmail = subscriptionCalls.find(s => s.provider === 'gmail');
    assert.strictEqual(gmail.lastCursor, 'history-12345', 'existing trigger keeps its cursor');
});

test('legacy prior rows (triggerStepId null) still match by provider+event', async () => {
    seed(gmailDef(null));
    priorSubs[0].triggerStepId = null; // pre-multi-trigger row
    await put(gmailDef({ from: 'x@y.z' }));
    assert.strictEqual(subscriptionCalls[0].lastCursor, 'history-12345');
});

test('handoff 5: on a routine with a LIVE version a save changes only the working copy', async () => {
    // The live definition keeps the triggers: no re-sync, no column moves,
    // however much the working copy's trigger config changed.
    seed(gmailDef(null));
    AUTOMATIONS.auto1.liveVersion = 3;
    AUTOMATIONS.auto1.triggerType = 'app_event';
    const next = gmailDef({ from: 'boss@example.com' });
    next.triggers = [{ id: 'trg2', kind: 'app_event', appEvent: { provider: 'github', event: 'push', filter: null } }];
    next.trigger = { id: 'trg1', kind: 'manual' };
    const res = await put(next);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(deletedFor, [], 'the live subscription stays');
    assert.deepStrictEqual(subscriptionCalls, []);
    assert.strictEqual(AUTOMATIONS.auto1.triggerType, 'app_event', 'trigger columns follow the live definition');
    assert.deepStrictEqual(AUTOMATIONS.auto1.definition, next, 'the working copy is saved');
});

test('handoff 5: an out-of-range runPolicy is refused; a valid one is cleaned and saved', async () => {
    seed(gmailDef(null));
    const bad = { ...gmailDef(null), runPolicy: { retry: { max: 9 } } };
    const refused = await put(bad);
    assert.strictEqual(refused.statusCode, 400);
    assert.strictEqual(refused.body.details[0].path, 'runPolicy.retry.max');
    const good = { ...gmailDef(null), runPolicy: { concurrency: 'parallel', retentionDays: 30, junk: true } };
    const saved = await put(good);
    assert.strictEqual(saved.statusCode, 200);
    assert.deepStrictEqual(AUTOMATIONS.auto1.definition.runPolicy, { concurrency: 'parallel', retentionDays: 30 });
});
