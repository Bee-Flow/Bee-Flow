// @typecheck
/**
 * A share row that names a member of another organisation gives them nothing, on a real Postgres (PGlite): the row is
 * written by SQL (the use case would refuse it), and what they see, open and decide stays empty.
 *
 * Run: cd server && node --test usecases/coworkShares.tenant.pg.test.js
 */

'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert');
const { pg, store } = require('../stores/coworkStore.testkit').coworkStoreOnPglite();
const { makeCoworkShares } = require('../stores/coworkShares.mts');
const { sharedWithMe, sharedItemOf } = require('./coworkShares.mts');

const shares = makeCoworkShares({ ready: () => store.initDB() });
const deps = { shares, getUser: async () => null, listMembers: async () => [], getSchedule: store.getSchedule, listRuns: store.listRuns };

before(async () => {
    await pg.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, "organizationId" TEXT DEFAULT '', status TEXT DEFAULT 'active');
        INSERT INTO users (id, "organizationId", status) VALUES ('owner', 'org-a', 'active'), ('outsider', 'org-b', 'active') ON CONFLICT (id) DO NOTHING`);
});

test('a share naming a member of another organisation lists nothing, opens nothing and decides nothing', async () => {
    const item = /** @type {{ id: string }} */ (await store.createSchedule({ userId: 'owner', title: 'Supplier radar', prompt: 'P', repeatInterval: 'daily', nextRunAt: new Date(Date.now() + 86_400_000).toISOString() }));
    await pg.query(`INSERT INTO cowork_shares (schedule_id, user_id, role, added_by) VALUES ($1, 'outsider', 'approver', 'owner')`, [item.id]);
    assert.strictEqual((await shares.listShares(item.id)).length, 1, 'the row is there');
    assert.deepStrictEqual(await sharedWithMe('outsider', deps), []);
    await assert.rejects(sharedItemOf('outsider', item.id, deps), { status: 404 });
    assert.strictEqual(await shares.approverOf(item.id), null);
});
