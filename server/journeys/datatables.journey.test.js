'use strict';

/**
 * Journey: a data table from creation to an organisation-wide read.
 *
 * The owner creates a table with two columns (a real Postgres table in the
 * organisation's schema), writes three rows, reads them back and deletes one;
 * a colleague gets a 404 until the owner publishes the table to the
 * organisation, then reads it but cannot write; a member of another
 * organisation gets a 404 before and after.
 *
 * Run: cd server && npm run test:journeys
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openWorld } = require('./journeyWorld.testkit');

const PW = 'Granite-lantern-3307!';

/** @type {Awaited<ReturnType<typeof openWorld>>} */
let world;

before(async () => {
    world = await openWorld({ mounts: ['auth', 'datatables'] });
    await world.seedOrg({ id: 'org-dt-a', name: 'Tables org A' });
    await world.seedOrg({ id: 'org-dt-b', name: 'Tables org B' });
    // Creating a table takes manage_datatables, which an organisation admin holds.
    await world.seedUser({ id: 'dt-owner', password: PW, organizationId: 'org-dt-a', orgRole: 'org_admin' });
    await world.seedUser({ id: 'dt-colleague', password: PW, organizationId: 'org-dt-a', orgRole: 'member' });
    await world.seedUser({ id: 'dt-outsider', password: PW, organizationId: 'org-dt-b', orgRole: 'member' });
}, { timeout: 120_000 });

after(() => world?.close());

test('create → write rows → read → delete one → publish to the organisation → colleague reads, cannot write; outsider 404', { timeout: 60_000 }, async () => {
    const owner = await world.login('dt-owner', PW);
    const colleague = await world.login('dt-colleague', PW);
    const outsider = await world.login('dt-outsider', PW);

    const created = await owner.call('POST', '/api/datatables', {
        body: { name: 'Leads', key: 'leads', description: 'incoming leads', fields: [{ key: 'company', name: 'Company', type: 'text' }, { key: 'stage', name: 'Stage', type: 'text' }] },
    });
    assert.equal(created.status, 200, created.text);
    const id = created.body.datatable.id;

    for (const [company, stage] of [['Acme', 'new'], ['Globex', 'won'], ['Initech', 'new']]) {
        const res = await owner.call('POST', `/api/datatables/${id}/rows`, { body: { values: { company, stage } } });
        assert.equal(res.status, 200, res.text);
    }
    const rows = await owner.call('GET', `/api/datatables/${id}/rows`);
    assert.equal(rows.status, 200, rows.text);
    assert.deepEqual(rows.body.rows.map((/** @type {{ company: string }} */ r) => r.company).sort(), ['Acme', 'Globex', 'Initech']);

    const initech = rows.body.rows.find((/** @type {{ company: string }} */ r) => r.company === 'Initech');
    const removed = await owner.call('DELETE', `/api/datatables/${id}/rows/${initech.id}`);
    assert.equal(removed.status, 200, removed.text);

    for (const who of [colleague, outsider]) {
        const res = await who.call('GET', `/api/datatables/${id}/rows`);
        assert.equal(res.status, 404, `${who.id} before publishing: ${res.status} ${res.text.slice(0, 200)}`);
    }

    const shared = await owner.call('PUT', `/api/datatables/${id}/sharing`, { body: { audience: 'organisation' } });
    assert.equal(shared.status, 200, shared.text);

    const read = await colleague.call('GET', `/api/datatables/${id}/rows`);
    assert.equal(read.status, 200, read.text);
    assert.deepEqual(read.body.rows.map((/** @type {{ company: string }} */ r) => r.company).sort(), ['Acme', 'Globex']);

    const write = await colleague.call('POST', `/api/datatables/${id}/rows`, { body: { values: { company: 'Sneaky', stage: 'new' } } });
    assert.equal(write.status, 403, `a reader writing: ${write.text}`);

    const foreign = await outsider.call('GET', `/api/datatables/${id}/rows`);
    assert.equal(foreign.status, 404, `another organisation after publishing: ${foreign.text.slice(0, 200)}`);
    const foreignList = await outsider.call('GET', '/api/datatables');
    assert.equal(foreignList.status, 200, foreignList.text);
    assert.ok(!JSON.stringify(foreignList.body).includes(id), 'the table is not in another organisation\'s list');

    const after = await owner.call('GET', `/api/datatables/${id}/rows`);
    assert.equal(after.body.rows.length, 2, 'the reader\'s write left no row');
});
