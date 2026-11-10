/**
 * An organisation's Nextcloud instance id (orgNcInstance.mts,
 * claimNcInstanceForOrganization), against a real Postgres
 * (@electric-sql/pglite behind db.js, testUtils/pglitePool.js) with the real
 * schema; nothing mocked.
 *
 *   - an instance id belongs to one organisation;
 *   - an organisation has one instance id: it is set on an organisation that
 *     has none, and setting the one it has is a no-op that answers true.
 *
 * Run: cd server && node --test stores/user/orgNcInstance.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const { initDB } = require('./schema');
const orgs = require('./orgNcInstance.mts');

before(async () => {
    await initDB();
    for (const id of ['org-claim-a', 'org-claim-b']) {
        await pg.query(`INSERT INTO organizations (id, name) VALUES ($1, $2)`, [id, id]);
    }
});
after(close);

const instanceOf = async (id) => (await pg.query(`SELECT nc_instance_id FROM organizations WHERE id = $1`, [id])).rows[0].nc_instance_id;

test('an organisation without a Nextcloud gets the instance id; the same id again answers true', async () => {
    assert.equal(await orgs.claimNcInstanceForOrganization('org-claim-a', 'inst-claim-1'), true);
    assert.equal(await instanceOf('org-claim-a'), 'inst-claim-1');
    assert.equal(await orgs.claimNcInstanceForOrganization('org-claim-a', 'inst-claim-1'), true);
});

test('an organisation that has an instance id keeps it', async () => {
    assert.equal(await orgs.claimNcInstanceForOrganization('org-claim-a', 'inst-claim-2'), false);
    assert.equal(await instanceOf('org-claim-a'), 'inst-claim-1');
});

test('an instance id that belongs to one organisation is not given to another', async () => {
    assert.equal(await orgs.claimNcInstanceForOrganization('org-claim-b', 'inst-claim-1'), false);
    assert.equal(await instanceOf('org-claim-b'), null);
    assert.equal(await instanceOf('org-claim-a'), 'inst-claim-1');
});

test('two requests for the same organisation with different instance ids: one of them holds', async () => {
    await pg.query(`INSERT INTO organizations (id, name) VALUES ('org-claim-c', 'c')`);
    const results = await Promise.all([
        orgs.claimNcInstanceForOrganization('org-claim-c', 'inst-claim-x'),
        orgs.claimNcInstanceForOrganization('org-claim-c', 'inst-claim-y'),
    ]);
    assert.deepEqual([...results].sort(), [false, true]);
    assert.equal(await instanceOf('org-claim-c'), results[0] ? 'inst-claim-x' : 'inst-claim-y');
});

test('an unknown organisation or an empty instance id answers false', async () => {
    assert.equal(await orgs.claimNcInstanceForOrganization('no-such-org', 'inst-claim-9'), false);
    assert.equal(await orgs.claimNcInstanceForOrganization('org-claim-b', ''), false);
});
