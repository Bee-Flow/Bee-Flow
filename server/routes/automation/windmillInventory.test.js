'use strict';

/**
 * GET /api/automation/import/windmill/inventory (routes/automation/windmillInventory.mts).
 *
 * Pins the answer contract the import dialog reads, the gates in their order
 * (org admin first, then the `automation_import` licence feature), and that a
 * non-Nextcloud org or an old connector is `available: false`. The org-admin
 * gate and the licence middleware are handed in as doubles through the
 * router's factory (their own suites cover them); what matters is that this
 * route carries both, admin first. The real ones are pinned by
 * auth/routes.contract.json (scope gate) and the generated API reference.
 *
 * Run: cd server && node --test routes/automation/windmillInventory.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');

/** @type {string[]} */
const gateLog = [];
/** @type {string[]} */
const featuresAsked = [];
const GATES = {
    orgAdmin: () => (/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ next) => {
        gateLog.push('admin');
        if (req.get('x-test-admin') !== 'yes') return res.status(403).json({ error: 'Organization admin access required' });
        req.primaryOrgId = 'org-1';
        return next();
    },
    licenseFeature: (/** @type {string} */ feature) => {
        featuresAsked.push(feature);
        return (/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ next) => {
            gateLog.push(`licence:${feature}`);
            if (req.get('x-test-licensed') !== 'yes') return res.status(403).json({ error: 'feature_locked', feature });
            return next();
        };
    },
};

const { makeWindmillInventoryRouter } = require('./windmillInventory.mts');
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

/**
 * @param {Record<string, unknown>} deps
 */
async function serve(deps) {
    const app = express();
    app.use(makeWindmillInventoryRouter(/** @type {any} */ (deps), GATES));
    app.use(terminalErrorHandler);
    const server = app.listen(0);
    const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
    /**
     * @param {Record<string, string>} [headers]
     * @param {string} [query]
     */
    const get = async (headers = { 'x-test-admin': 'yes', 'x-test-licensed': 'yes' }, query = '') => {
        const res = await fetch(`http://127.0.0.1:${port}/import/windmill/inventory${query}`, { headers });
        return { status: res.status, body: await res.json() };
    };
    return { get, close: () => new Promise((r) => server.close(r)) };
}

const ITEMS = [
    { generation: 'flow_exapp', workspace: 'nextcloud', path: 'u/admin/invoice_intake', kind: 'flow', events: { 'OCP\\Files\\Events\\Node\\NodeCreatedEvent': 'file.new', 'OCP\\Files\\Events\\Node\\NodeTouchedEvent': null }, hasEventFilter: true },
    { generation: 'standalone', workspace: 'finance', path: 'f/mail/sort', kind: 'script', events: { 'OCA\\Mail\\Events\\NewMessageReceivedEvent': 'mail.new' }, hasEventFilter: false },
    { generation: 'standalone', workspace: 'finance', path: 'f/forms/new_hire', kind: 'flow', events: { 'OCA\\Unknown\\Event': null }, hasEventFilter: false },
];

test('the licence feature is automation_import, asked after the org-admin gate', async () => {
    const app = await serve({ isNcOrg: async () => true, fetchInventory: async () => ({ outcome: 'ok', items: [] }) });
    assert.deepStrictEqual(featuresAsked, ['automation_import']);
    gateLog.length = 0;
    assert.strictEqual((await app.get({ 'x-test-licensed': 'yes' })).status, 403, 'not an org admin');
    assert.deepStrictEqual(gateLog, ['admin'], 'refused before the licence is consulted');
    gateLog.length = 0;
    const locked = await app.get({ 'x-test-admin': 'yes' });
    assert.strictEqual(locked.status, 403);
    assert.strictEqual(locked.body.feature, 'automation_import');
    assert.deepStrictEqual(gateLog, ['admin', 'licence:automation_import']);
    await app.close();
});

test('the answer: flows only, Bee Flow events (exact or approximate), the generation', async () => {
    /** @type {string[]} */
    const asked = [];
    const app = await serve({ isNcOrg: async () => true, fetchInventory: async (/** @type {string} */ orgId) => { asked.push(orgId); return { outcome: 'ok', items: ITEMS }; } });
    const res = await app.get();
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(asked, ['org-1'], 'the org the admin gate resolved');
    assert.deepStrictEqual(res.body, {
        available: true,
        generation: 'standalone',
        flows: [
            { path: 'u/admin/invoice_intake', summary: 'invoice intake', events: ['file.new', 'file.changed'], active: true },
            { path: 'f/forms/new_hire', summary: 'new hire', events: [], active: true },
        ],
    });
    await app.close();
});

test('not available: an org without Nextcloud (the connector is not asked), no connector, an old connector', async () => {
    let calls = 0;
    const noNc = await serve({ isNcOrg: async () => false, fetchInventory: async () => { calls++; return { outcome: 'ok', items: ITEMS }; } });
    assert.deepStrictEqual((await noNc.get()).body, { available: false, flows: [] });
    assert.strictEqual(calls, 0);
    await noNc.close();
    for (const outcome of ['not_connected', 'unsupported']) {
        const app = await serve({ isNcOrg: async () => true, fetchInventory: async () => ({ outcome }) });
        assert.deepStrictEqual((await app.get()).body, { available: false, flows: [] }, outcome);
        await app.close();
    }
});

test('webhook_listeners off: available, nothing found; an unreachable connector is a 502', async () => {
    const off = await serve({ isNcOrg: async () => true, fetchInventory: async () => ({ outcome: 'no_listeners' }) });
    assert.deepStrictEqual((await off.get()).body, { available: true, flows: [] });
    await off.close();
    const down = await serve({ isNcOrg: async () => true, fetchInventory: async () => ({ outcome: 'unreachable', detail: 'timeout' }) });
    const res = await down.get();
    assert.strictEqual(res.status, 502);
    assert.strictEqual(res.body.code, 'nextcloud_connector_unreachable');
    await down.close();
});

test('only ?orgId is accepted in the query', async () => {
    const app = await serve({ isNcOrg: async () => true, fetchInventory: async () => ({ outcome: 'ok', items: [] }) });
    assert.strictEqual((await app.get(undefined, '?orgId=org-1')).status, 200);
    assert.strictEqual((await app.get(undefined, '?token=x')).status, 400);
    await app.close();
});
