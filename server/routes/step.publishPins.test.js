'use strict';

/**
 * BFSF-408/434 — publishing a reusable Step must refuse to snapshot pinned data.
 *
 * A published Step is not a private draft: publishStep() snapshots
 * definition_json verbatim, getCallableStepsForUser() serves that snapshot to
 * everyone in the org, and execCallBlock() dispatches it through the SAME
 * pinned-output short-circuit as any other step. So a pin inside a published
 * Step serves one author's captured — or, once the output editor ships,
 * hand-authored — sample to every caller, forever.
 *
 * The activation gate in routes/automation/crud.js does not cover this: a Step
 * is published, never activated, so /activate is never on its path.
 *
 * Run: node --test --test-force-exit routes/step.publishPins.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const SERVER = path.resolve(__dirname, '..');
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

let AUTOMATIONS = {};
let publishCalls = [];

mock(path.join(SERVER, 'stores/automationStore'), {
    getAutomation: async (id) => AUTOMATIONS[id] || null,
    publishStep: async (id, userId) => { publishCalls.push({ id, userId }); return { id, published: true }; },
});
let VALIDATE_OK = true;
mock(path.join(SERVER, 'automation/validate'), {
    // Identity must stay stable: step.js destructures this at require time,
    // so re-mocking the module later would not be seen. Flip the flag instead.
    validateDefinition: () => (VALIDATE_OK ? { ok: true, warnings: [] } : { ok: false, errors: [{ code: 'nope' }] }),
});
mock(path.join(SERVER, 'automation/summarise'), { summariseDefinition: () => ({ summary: '' }) });
mock(path.join(SERVER, 'stores/userStore'), {});
mock(path.join(SERVER, 'auth/audience'), { resolveAudienceContext: async () => ({}) });
mock(path.join(SERVER, 'utils/perUserRateLimit'), { perUserRateLimit: () => (req, res, next) => next() });

// collectPinnedNodes is the thing under test, so it loads for real. It is pure.
const realPortability = require(path.join(SERVER, 'automation/portability'));
mock(path.join(SERVER, 'automation/portability'), {
    buildExport: () => ({}),
    sanitizeImport: () => ({ automation: null, errors: ['not used'] }),
    rekeyDefinition: (d) => ({ definition: d }),
    collectPinnedNodes: realPortability.collectPinnedNodes,
});

const stepRouter = require('./step');

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
const publish = findHandler(stepRouter, 'post', '/:id/publish');

function block(definition) {
    AUTOMATIONS.blk1 = { id: 'blk1', userId: 'user1', kind: 'block', definition };
    return { params: { id: 'blk1' }, session: { user: { id: 'user1' } }, body: {} };
}

test('a Step with no pins publishes as before', async () => {
    publishCalls = [];
    const req = block({
        trigger: { id: 'trg', kind: 'layer_input' },
        steps: [{ id: 's1', type: 'set' }],
        edges: [{ from: 'trg', to: 's1' }],
    });
    const res = makeRes();
    await publish(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(publishCalls, [{ id: 'blk1', userId: 'user1' }]);
});

test('a pinned STEP blocks the publish, and nothing is snapshotted', async () => {
    publishCalls = [];
    const req = block({
        trigger: { id: 'trg', kind: 'layer_input' },
        steps: [{ id: 's1', type: 'http_request', pinnedOutput: { rows: [1, 2, 3] }, pinnedAt: '2026-08-31T00:00:00.000Z' }],
        edges: [{ from: 'trg', to: 's1' }],
    });
    const res = makeRes();
    await publish(req, res);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'pinned_data_in_published_step');
    assert.ok(Array.isArray(res.body.details) && res.body.details.length >= 1);
    // The snapshot must NOT have been taken — a 400 that still publishes is
    // worse than no gate at all.
    assert.deepStrictEqual(publishCalls, []);
});

test("a pinned TRIGGER blocks it too — that is the case the output editor makes reachable", async () => {
    publishCalls = [];
    const req = block({
        trigger: { id: 'trg', kind: 'layer_input', pinnedOutput: { email: 'sample@example.com' }, pinnedSource: 'edited' },
        steps: [{ id: 's1', type: 'set' }],
        edges: [{ from: 'trg', to: 's1' }],
    });
    const res = makeRes();
    await publish(req, res);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'pinned_data_in_published_step');
    assert.deepStrictEqual(publishCalls, []);
});

test('a pin inside a nested layer is caught as well', async () => {
    publishCalls = [];
    const req = block({
        trigger: { id: 'trg', kind: 'layer_input' },
        steps: [{ id: 's1', type: 'call_layer', layerKey: 'inner' }],
        edges: [{ from: 'trg', to: 's1' }],
        layers: {
            inner: {
                trigger: { id: 'i-trg', kind: 'layer_input' },
                steps: [{ id: 'i1', type: 'ai_step', pinnedOutput: { text: 'sample answer' } }],
                edges: [],
            },
        },
    });
    const res = makeRes();
    await publish(req, res);

    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(publishCalls, []);
});

test('an invalid definition still fails validation first, before the pin gate', async () => {
    publishCalls = [];
    VALIDATE_OK = false;
    const req = block({ trigger: { id: 'trg', kind: 'layer_input', pinnedOutput: { a: 1 } }, steps: [], edges: [] });
    const res = makeRes();
    await publish(req, res);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Cannot publish an invalid Step');
    assert.deepStrictEqual(publishCalls, []);
    VALIDATE_OK = true;
});
