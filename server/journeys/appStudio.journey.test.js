'use strict';

/**
 * Journey: an App Studio app gets a table, rows and a query.
 *
 * The maker (an organisation admin) creates an app, saves a data model with
 * one table (the per-app Postgres schema of the pg engine, on PGlite), adds
 * three records, lists them and runs an aggregate over them; a member of
 * another organisation cannot open the app, read its records or query it.
 *
 * Run: cd server && npm run test:journeys
 */

// The per-app engine: the Postgres one (stores/studioAppDbStore.js), so the
// app's tables live in the same PGlite as everything else and nothing is
// written to disk.
process.env.STUDIO_APP_ENGINE = 'pg';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openWorld } = require('./journeyWorld.testkit');

const PW = 'Juniper-anchor-4470!';

const MODEL = {
    modelVersion: 1,
    roles: [{ key: 'manager' }, { key: 'member' }],
    roleMapping: { default: 'member', byGroup: {} },
    tables: [{
        id: 'tbl_orders', key: 'orders', name: 'Orders',
        fields: [
            { id: 'fld_customer', key: 'customer', type: 'text' },
            { id: 'fld_amount', key: 'amount', type: 'number', subtype: 'integer' },
        ],
        access: {
            default: 'none',
            roles: {
                manager: { read: 'all', create: true, update: 'all', delete: 'all' },
                member: { read: 'own', create: true, update: 'own', delete: 'none' },
            },
            rowFilters: {},
        },
    }],
};

/** @type {Awaited<ReturnType<typeof openWorld>>} */
let world;

before(async () => {
    world = await openWorld({ mounts: ['auth', 'studioApps'] });
    await world.seedOrg({ id: 'org-app-a', name: 'Apps org A' });
    await world.seedOrg({ id: 'org-app-b', name: 'Apps org B' });
    await world.seedUser({ id: 'app-maker', password: PW, organizationId: 'org-app-a', orgRole: 'org_admin' });
    await world.seedUser({ id: 'app-outsider', password: PW, organizationId: 'org-app-b', orgRole: 'org_admin' });
}, { timeout: 120_000 });

after(() => world?.close());

test('create an app → save a table → add records → list and aggregate; another organisation is refused', { timeout: 60_000 }, async () => {
    const maker = await world.login('app-maker', PW);
    const outsider = await world.login('app-outsider', PW);

    const created = await maker.call('POST', '/api/studio-apps', { body: { name: 'Order desk' } });
    assert.ok(created.status === 200 || created.status === 201, created.text);
    const id = created.body.id || created.body.app?.id;
    assert.ok(id, created.text);

    const schema = await maker.call('PUT', `/api/studio-apps/${id}/schema`, { body: { model: MODEL } });
    assert.equal(schema.status, 200, schema.text);

    for (const [customer, amount] of [['Acme', 120], ['Globex', 80], ['Acme', 30]]) {
        const res = await maker.call('POST', `/api/studio-apps/${id}/data/tables/tbl_orders/records`, { body: { values: { customer, amount } } });
        assert.ok(res.status === 200 || res.status === 201, res.text);
    }

    const records = await maker.call('GET', `/api/studio-apps/${id}/data/tables/tbl_orders/records`);
    assert.equal(records.status, 200, records.text);
    const rows = records.body.records || records.body.rows || [];
    assert.equal(rows.length, 3, records.text);

    const total = await maker.call('POST', `/api/studio-apps/${id}/data/query`, {
        body: { tableId: 'tbl_orders', aggregate: { aggregates: [{ fn: 'sum', field: 'amount', as: 'total' }] } },
    });
    assert.equal(total.status, 200, total.text);
    assert.equal(Number(total.body.rows[0].total), 230, total.text);

    for (const [method, url, body] of [
        ['GET', `/api/studio-apps/${id}`, undefined],
        ['GET', `/api/studio-apps/${id}/data/tables/tbl_orders/records`, undefined],
        ['POST', `/api/studio-apps/${id}/data/query`, { tableId: 'tbl_orders', aggregate: { aggregates: [{ fn: 'sum', field: 'amount', as: 'total' }] } }],
        ['POST', `/api/studio-apps/${id}/data/tables/tbl_orders/records`, { values: { customer: 'Intruder', amount: 1 } }],
    ]) {
        const res = await outsider.call(/** @type {string} */ (method), /** @type {string} */ (url), { body });
        assert.ok(res.status === 403 || res.status === 404, `${method} ${url} as another organisation: ${res.status} ${res.text.slice(0, 200)}`);
    }
    const after = await maker.call('GET', `/api/studio-apps/${id}/data/tables/tbl_orders/records`);
    assert.equal((after.body.records || after.body.rows || []).length, 3, 'the refused write left no record');
});
