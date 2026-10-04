'use strict';

/**
 * A13 — activation's immediate Gmail catchup must dispatch each of THIS
 * automation's subscriptions exactly once via dispatchToSubscription.
 *
 * The old loop called the BROAD dispatchEvent once per gmail trigger, which
 * fans out to EVERY gmail/mail.new subscription of the user — N triggers on
 * one automation produced N² catchup runs of the same email, plus a spurious
 * run of every unrelated active gmail automation.
 *
 * Run: node --test routes/automation/crud.activateCatchup.test.js
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
let broadDispatches = [];
let targetedDispatches = [];
let fetchCalls = [];

mock(path.join(SERVER, 'stores/automationStore'), {
    getAutomation: async (id) => AUTOMATIONS[id] || null,
    updateAutomation: async (id, updates) => { AUTOMATIONS[id] = { ...AUTOMATIONS[id], ...updates }; return AUTOMATIONS[id]; },
    // Activation first re-syncs (creates rows), then the catchup lists them —
    // return whatever the sync created.
    getSubscriptionsForAutomation: async () => subscriptionCalls,
    deleteSubscriptionsForAutomation: async () => {},
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
    fetchLatestGmailMatch: async (userId, filter) => { fetchCalls.push(filter); return { id: 'msg-1', subject: 'Latest' }; },
    dispatchEvent: async (args) => { broadDispatches.push(args); return []; },
});
mock(path.join(SERVER, 'automation/triggerBus/dispatch'), {
    dispatchEvent: async (args) => { broadDispatches.push(args); return []; },
    dispatchToSubscription: (sub, evt) => { targetedDispatches.push({ subId: sub.id, triggerStepId: sub.triggerStepId, event: evt.event }); return []; },
});
mock(path.join(SERVER, 'utils/perUserRateLimit'), { perUserRateLimit: () => (req, res, next) => next() });
// Loaded for real BEFORE the mock replaces the cache entry: the activation
// gate's whole job is reading pins out of a definition, and a stub of that
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

const activateHandler = findHandler(crudRouter, 'post', '/:id/activate');

const flushAsync = () => new Promise(r => setImmediate(() => setImmediate(r)));

test('two gmail triggers → exactly two targeted dispatches, zero broad fan-outs', async () => {
    subscriptionCalls = []; broadDispatches = []; targetedDispatches = []; fetchCalls = [];
    AUTOMATIONS.auto1 = {
        id: 'auto1', userId: 'user1', isActive: false, isDraft: true, triggerType: 'manual', scheduleCron: null,
        definition: {
            trigger: { id: 'trg1', kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new', filter: { from: 'a@x' } } },
            triggers: [{ id: 'trg2', kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new', filter: { from: 'b@y' } } }],
            steps: [], edges: [],
        },
    };
    const req = { params: { id: 'auto1' }, session: { user: { id: 'user1' }, isAdmin: false }, body: {} };
    const res = makeRes();
    await activateHandler(req, res);
    await flushAsync();

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(targetedDispatches.length, 2, 'one catchup run per subscription — not N²');
    assert.deepStrictEqual(
        targetedDispatches.map(d => d.triggerStepId).sort(),
        ['trg1', 'trg2'],
        'each dispatch seeds its OWN trigger node',
    );
    assert.strictEqual(broadDispatches.length, 0, 'the broad dispatchEvent (fans out to unrelated automations) must not be used');
    // The fetch uses each subscription's own normalized filter.
    assert.deepStrictEqual(fetchCalls.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [{ from: 'a@x' }, { from: 'b@y' }]);
});

test('no gmail triggers → no catchup work at all', async () => {
    subscriptionCalls = []; broadDispatches = []; targetedDispatches = []; fetchCalls = [];
    AUTOMATIONS.auto2 = {
        id: 'auto2', userId: 'user1', isActive: false, isDraft: true, triggerType: 'manual', scheduleCron: null,
        definition: { trigger: { id: 'trg1', kind: 'manual' }, steps: [], edges: [] },
    };
    const req = { params: { id: 'auto2' }, session: { user: { id: 'user1' }, isAdmin: false }, body: {} };
    const res = makeRes();
    await activateHandler(req, res);
    await flushAsync();
    assert.strictEqual(targetedDispatches.length, 0);
    assert.strictEqual(fetchCalls.length, 0);
});

// ══════════════════════════════════════════════════════════════════════════
// BFSF-408/409/434 — pinned sample data at activation
//
// A pinned node SERVES saved data instead of running. While you build that is
// the point; live it is a trap, because the step never calls the thing it names
// and the run is still reported green. Activation is where that stops being the
// author's private business — and nothing else in the pipeline says a word
// about it (validateDefinition checks a pin's shape and size, not whether
// serving one is what you meant).
//
// captured → warning. edited → 400: hand-written data has never come out of
// anything, so a live run would hand invented values to real side effects.
// ══════════════════════════════════════════════════════════════════════════

function pinnedAutomation(id, nodes) {
    AUTOMATIONS[id] = {
        id, userId: 'user1', isActive: false, isDraft: true, triggerType: 'manual', scheduleCron: null,
        definition: {
            trigger: { id: 'trg1', kind: 'manual', ...(nodes.trigger || {}) },
            steps: [{ id: 's1', type: 'notification', title: 'x', body: 'y', ...(nodes.step || {}) }],
            edges: [{ from: 'trg1', to: 's1' }],
            ...(nodes.layers ? { layers: nodes.layers } : {}),
        },
    };
    return { params: { id }, session: { user: { id: 'user1' }, isAdmin: false }, body: {} };
}

test('a CAPTURED pin activates, with a warning naming the node', async () => {
    subscriptionCalls = []; broadDispatches = []; targetedDispatches = []; fetchCalls = [];
    const req = pinnedAutomation('autoPinCaptured', {
        step: { pinnedOutput: { ok: true }, pinnedAt: '2026-08-30T00:00:00.000Z', pinnedSource: 'captured' },
    });
    const res = makeRes();
    await activateHandler(req, res);
    await flushAsync();

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(AUTOMATIONS.autoPinCaptured.isActive, true, 'a captured pin does not block activation');
    const warn = (res.body.warnings || []).find(w => w.code === 'pin.serves_sample_data');
    assert.ok(warn, `expected a pin warning, got ${JSON.stringify(res.body.warnings)}`);
    assert.match(warn.message, /Step "s1"/);
    assert.match(warn.message, /serves pinned data instead of running/);
    assert.strictEqual(warn.path, 'steps[s1]');
});

test('an EDITED pin refuses activation with 400 and the automation stays off', async () => {
    subscriptionCalls = []; broadDispatches = []; targetedDispatches = []; fetchCalls = [];
    const req = pinnedAutomation('autoPinEdited', {
        step: { pinnedOutput: { total: 999999 }, pinnedSource: 'edited' },
    });
    const res = makeRes();
    await activateHandler(req, res);
    await flushAsync();

    assert.strictEqual(res.statusCode, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'pinned_edited_sample');
    assert.match(res.body.error, /Step "s1"/);
    assert.strictEqual(AUTOMATIONS.autoPinEdited.isActive, false, 'the automation is NOT switched on');
    assert.strictEqual(targetedDispatches.length, 0, 'and no catchup work ran');
});

test('an edited pin on the TRIGGER refuses too — the trigger is a node like any other', async () => {
    subscriptionCalls = []; broadDispatches = []; targetedDispatches = []; fetchCalls = [];
    const req = pinnedAutomation('autoPinTrigger', {
        trigger: { pinnedOutput: { who: 'made up' }, pinnedSource: 'edited' },
    });
    const res = makeRes();
    await activateHandler(req, res);
    await flushAsync();

    assert.strictEqual(res.statusCode, 400, JSON.stringify(res.body));
    assert.match(res.body.error, /Trigger "trg1"/);
    assert.strictEqual(res.body.details[0].path, 'trigger');
});

test('a pin inside a FLOWLET is seen as well, and named by its layer', async () => {
    subscriptionCalls = []; broadDispatches = []; targetedDispatches = []; fetchCalls = [];
    const req = pinnedAutomation('autoPinLayer', {
        layers: {
            enrich: {
                trigger: { id: 'lin', kind: 'layer_input', params: [] },
                steps: [{ id: 'ln1', type: 'notification', title: 'x', body: 'y', pinnedOutput: { a: 1 }, pinnedSource: 'edited' }],
                edges: [{ from: 'lin', to: 'ln1' }],
            },
        },
    });
    const res = makeRes();
    await activateHandler(req, res);
    await flushAsync();

    assert.strictEqual(res.statusCode, 400, JSON.stringify(res.body));
    assert.match(res.body.error, /in flowlet "enrich"/);
    assert.strictEqual(res.body.details[0].path, 'layers.enrich.steps[ln1]');
});

test('a pin with no pinnedSource is treated as captured — every pin predating the field came from a run', async () => {
    subscriptionCalls = []; broadDispatches = []; targetedDispatches = []; fetchCalls = [];
    const req = pinnedAutomation('autoPinLegacy', { step: { pinnedOutput: { ok: true } } });
    const res = makeRes();
    await activateHandler(req, res);
    await flushAsync();

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.ok((res.body.warnings || []).some(w => w.code === 'pin.serves_sample_data'));
});

test('no pins → no pin warnings, and the existing warnings are untouched', async () => {
    subscriptionCalls = []; broadDispatches = []; targetedDispatches = []; fetchCalls = [];
    const req = pinnedAutomation('autoNoPins', {});
    const res = makeRes();
    await activateHandler(req, res);
    await flushAsync();

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.warnings, [], 'validateDefinition is stubbed to warn nothing here');
});
