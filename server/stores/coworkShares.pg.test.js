// @typecheck
/**
 * Who a cowork is shared with, on a real Postgres (PGlite): replacing the shares, the one who decides, what a person
 * has shared with them, and the shares going with the item.
 *
 * Run: cd server && node --test stores/coworkShares.pg.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { before } = require('node:test');
const { pg, store } = require('./coworkStore.testkit').coworkStoreOnPglite();
const { makeCoworkShares } = require('./coworkShares.mts');

const shares = makeCoworkShares({ ready: () => store.initDB() });

// The user store's own table is not part of the Cowork schema: the columns the shares read, with Ann's organisation.
before(async () => {
    await pg.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, "organizationId" TEXT DEFAULT '', status TEXT DEFAULT 'active');
        INSERT INTO users (id, "organizationId", status) VALUES ('ann', 'org-a', 'active'), ('bob', 'org-a', 'active'), ('cas', 'org-a', 'active'),
            ('dan', 'org-a', 'active'), ('eve', 'org-b', 'active') ON CONFLICT (id) DO NOTHING`);
});

const createItem = async () => /** @type {{ id: string }} */ (await store.createSchedule({ userId: 'ann', title: 'Supplier radar', prompt: 'P', repeatInterval: 'daily', nextRunAt: new Date(Date.now() + 86_400_000).toISOString() })).id;

test('shares are replaced in one go, read back per item and per person, and go with the item', async () => {
    const id = await createItem();
    await shares.setShares(id, [{ userId: 'bob', role: 'approver' }, { userId: 'cas', role: 'viewer' }], 'ann');
    await shares.setShares(id, [{ userId: 'cas', role: 'approver' }], 'ann');
    assert.deepStrictEqual(await shares.listShares(id), [{ userId: 'cas', role: 'approver' }]);
    assert.strictEqual(await shares.approverOf(id), 'cas');
    assert.strictEqual(await shares.roleOf(id, 'bob'), null);
    assert.deepStrictEqual((await shares.sharedWith('cas')).map((i) => [i.id, i.ownerId, i.role]), [[id, 'ann', 'approver']]);
    await store.deleteSchedule(id);
    assert.deepStrictEqual(await shares.sharedWith('cas'), []);
});

test('a share counts only while its holder is an active member of the owner\'s organisation', async () => {
    const id = await createItem();
    await shares.setShares(id, [{ userId: 'dan', role: 'approver' }, { userId: 'eve', role: 'viewer' }], 'ann');
    assert.deepStrictEqual([await shares.roleOf(id, 'eve'), await shares.sharedWith('eve')], [null, []], 'someone of another organisation sees nothing');
    assert.strictEqual(await shares.approverOf(id), 'dan');
    await pg.query(`UPDATE users SET status = 'disabled' WHERE id = 'dan'`);
    assert.deepStrictEqual([await shares.approverOf(id), await shares.roleOf(id, 'dan'), await shares.sharedWith('dan')], [null, null, []], 'a switched-off colleague decides nothing');
    await pg.query(`UPDATE users SET status = 'active', "organizationId" = 'org-b' WHERE id = 'dan'`);
    assert.strictEqual(await shares.approverOf(id), null, 'nor one who moved to another organisation');
    await store.deleteSchedule(id);
});
