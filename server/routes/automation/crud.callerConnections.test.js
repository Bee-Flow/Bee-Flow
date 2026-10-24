// @typecheck
'use strict';

/**
 * runPolicy.connections (whose connections a shared or agent-called run uses)
 * is the OWNER's call: an editor may not change it through a save or a version
 * restore, and the owner's change is logged.
 *
 * Run: node --test routes/automation/crud.callerConnections.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { installCrudRouteStubs } = require('../../testUtils/crudRouteStubs');
const { runRoute, makeRes } = require('../../testUtils/routeHandlers');

let AUTOMATIONS = {};
let VERSIONS = {};
let lastUpdate = null;

installCrudRouteStubs({
    store: {
        getAutomation: async (id) => AUTOMATIONS[id] || null,
        updateAutomation: async (id, updates) => {
            lastUpdate = updates;
            AUTOMATIONS[id] = { ...AUTOMATIONS[id], ...updates };
            return AUTOMATIONS[id];
        },
        listSharesForAutomation: async () => [{ principalType: 'user', principalId: 'editor1', role: 'edit' }],
        getVersion: async (id) => VERSIONS[id] || null,
        getSubscriptionsForAutomation: async () => [],
        deleteSubscriptionsForAutomation: async () => {},
        createSubscription: async (o) => ({ id: 'sub-1', ...o }),
        updateSubscription: async () => true,
    },
});

const putHandler = runRoute(require('./crud'), 'put', '/:id');
const restoreHandler = runRoute(require('./versions'), 'post', '/:id/versions/:versionId/restore');

const defWith = (connections) => ({
    trigger: { id: 'trg', kind: 'manual' }, steps: [], edges: [],
    ...(connections ? { runPolicy: { connections } } : {}),
});
function seed(connections) {
    AUTOMATIONS = { auto1: { id: 'auto1', userId: 'owner1', organizationId: 'org1', isActive: false, isDraft: true, title: 'Flow', definition: defWith(connections) } };
    VERSIONS = { v1: { id: 'v1', automationId: 'auto1', definition: defWith('caller') } };
    lastUpdate = null;
}
const put = async (userId, definition) => {
    const res = makeRes();
    await putHandler({ params: { id: 'auto1' }, session: { user: { id: userId } }, body: { definition } }, res);
    return res;
};

test('an editor cannot switch the connections policy on or off through a save', async () => {
    seed(null);
    const on = await put('editor1', defWith('caller'));
    assert.strictEqual(on.statusCode, 403);
    assert.strictEqual(on.body.need, 'owner');
    assert.strictEqual(lastUpdate, null, 'nothing was written');
    seed('caller');
    const off = await put('editor1', defWith(null));
    assert.strictEqual(off.statusCode, 403);
    assert.strictEqual(lastUpdate, null);
});

test('an editor may still save everything else, with the policy unchanged', async () => {
    seed('caller');
    const res = await put('editor1', { ...defWith('caller'), runPolicy: { connections: 'caller', retry: { max: 2 } } });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(lastUpdate.definition.runPolicy.connections, 'caller');
});

test('the owner may change it', async () => {
    seed(null);
    const res = await put('owner1', defWith('caller'));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(lastUpdate.definition.runPolicy.connections, 'caller');
});

test('a version restore by an editor cannot move the policy either', async () => {
    seed(null);
    const res = makeRes();
    await restoreHandler({ params: { id: 'auto1', versionId: 'v1' }, session: { user: { id: 'editor1' } }, body: {}, query: {} }, res);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.need, 'owner');
    assert.strictEqual(lastUpdate, null);
});
