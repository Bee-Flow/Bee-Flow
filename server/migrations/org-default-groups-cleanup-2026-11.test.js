'use strict';

/**
 * Cleanup of stored organisation default groups, against a real Postgres (pglite).
 *
 * Run: cd server && node --test migrations/org-default-groups-cleanup-2026-11.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const { newPglite } = require('../testUtils/pgliteTemplate');

const { pgliteDb } = require('../testUtils/pgliteDb');
const { up } = require('./org-default-groups-cleanup-2026-11');
const { LOOSE_MIGRATIONS } = require('../boot/bootMigrations');

const open = [];
function fresh() {
    const h = pgliteDb(newPglite());
    open.push(h.pg);
    return h;
}
after(async () => { for (const pg of open) await pg.close(); });

async function seed(pg) {
    await pg.exec(`
        CREATE TABLE groups (
            id TEXT PRIMARY KEY, "organizationId" TEXT, name TEXT NOT NULL,
            permissions TEXT DEFAULT '[]', roles TEXT DEFAULT '[]', "orgRole" TEXT
        );
        CREATE TABLE organizations (id TEXT PRIMARY KEY, "defaultGroups" TEXT DEFAULT '[]');
    `);
    await pg.query(`INSERT INTO groups (id, "organizationId", name, permissions, roles, "orgRole") VALUES
        ('acme-staff', 'acme', 'Staff', '[]', '[]', NULL),
        ('beta-staff', 'beta', 'Staff', '[]', '[]', NULL),
        ('admins', NULL, 'Administrators', '["all"]', '[]', NULL),
        ('roled', NULL, 'Roled', '[]', '["r1"]', NULL),
        ('oa', NULL, 'Org admins', '[]', '[]', 'org_admin'),
        ('broken', NULL, 'Broken', 'not json', '[]', NULL),
        ('users', NULL, 'Users', '["read","chat"]', '[]', NULL)`);
    await pg.query(`INSERT INTO organizations (id, "defaultGroups") VALUES
        ('acme', '["users","beta-staff","acme-staff","admins","roled","oa","broken","gone"]'),
        ('beta', '["beta-staff","users"]'),
        ('empty', '[]'),
        ('nulled', NULL),
        ('garbled', 'not json')`);
}

const lists = async (pg) => Object.fromEntries((await pg.query(`SELECT id, "defaultGroups" AS dg FROM organizations ORDER BY id`)).rows.map((r) => [r.id, r.dg]));

test('keeps own-org and plain global groups, strips the rest, counts it', async () => {
    const { db, pg } = fresh();
    await seed(pg);
    const result = await up({ db });
    assert.deepStrictEqual(result, { orgsChecked: 5, orgsUpdated: 1, idsRemoved: 6, unparseable: 1 });
    const after1 = await lists(pg);
    assert.deepStrictEqual(JSON.parse(after1.acme), ['users', 'acme-staff']);
    assert.strictEqual(after1.beta, '["beta-staff","users"]', 'a clean list is not rewritten');
    assert.strictEqual(after1.garbled, 'not json', 'an unreadable list is left alone');

    const again = await up({ db });
    assert.strictEqual(again.orgsUpdated, 0, 'idempotent');
    assert.deepStrictEqual(await lists(pg), after1);
});

test('a database without the tables is skipped', async () => {
    const { db } = fresh();
    assert.deepStrictEqual(await up({ db }), { orgsChecked: 0, orgsUpdated: 0, idsRemoved: 0, unparseable: 0 });
});

test('the migration is registered in the boot ladder, or it never runs', () => {
    assert.ok(LOOSE_MIGRATIONS.includes('org-default-groups-cleanup-2026-11'));
});
