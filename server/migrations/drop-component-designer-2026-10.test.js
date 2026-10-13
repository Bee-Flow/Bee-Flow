'use strict';

/**
 * Removal of the Component Designer's database traces, against a real
 * Postgres (pglite).
 *
 * Run: cd server && node --test migrations/drop-component-designer-2026-10.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');

const { pgliteDb } = require('../testUtils/pgliteDb');
const { up } = require('./drop-component-designer-2026-10');
const { LOOSE_MIGRATIONS } = require('../boot/bootMigrations');

const open = [];
function fresh() {
    const h = pgliteDb(new PGlite());
    open.push(h.pg);
    return h;
}
after(async () => { for (const pg of open) await pg.close(); });

async function seed(pg) {
    await pg.exec(`
        CREATE TABLE organizations (
            id TEXT PRIMARY KEY,
            "org_granted_capabilities" TEXT DEFAULT '["notebooks","projects","component_designer"]'
        );
        CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, owner_id TEXT);
        CREATE TABLE agent_tools (
            id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, component_id TEXT,
            FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
        );
    `);
    await pg.query(`INSERT INTO organizations (id, "org_granted_capabilities") VALUES
        ('org-default', '["notebooks","projects","component_designer"]'),
        ('org-order', '["component_designer","projects","x_other"]'),
        ('org-without', '["notebooks"]'),
        ('org-off', '[]'),
        ('org-null', NULL),
        ('org-broken', 'not json "component_designer"')`);
    await pg.query(`INSERT INTO agents (id, name, owner_id) VALUES
        ('system-component-designer', 'AI Component Designer', 'system'),
        ('system-title-generator', 'Title Generator', 'system')`);
    await pg.query(`INSERT INTO agent_tools (id, agent_id, component_id) VALUES ('t1', 'system-component-designer', 'get-date-time')`);
}

async function grants(pg) {
    const { rows } = await pg.query(`SELECT id, "org_granted_capabilities" AS caps FROM organizations ORDER BY id`);
    return Object.fromEntries(rows.map((r) => [r.id, r.caps]));
}

test('registered in the boot ladder', () => {
    assert.ok(LOOSE_MIGRATIONS.includes('drop-component-designer-2026-10'));
});

test('absent tables are skipped, not an error', async () => {
    const { db } = fresh();
    assert.deepStrictEqual(await up({ db }), { orgsUpdated: null, agentDeleted: null });
});

test('drops the capability from every list, keeps the rest in order, and deletes the agent', async () => {
    const { pg, db } = fresh();
    await seed(pg);

    const first = await up({ db });
    assert.deepStrictEqual(first, { orgsUpdated: 2, agentDeleted: true });
    assert.deepStrictEqual(await grants(pg), {
        'org-broken': 'not json "component_designer"',
        'org-default': '["notebooks","projects"]',
        'org-null': null,
        'org-off': '[]',
        'org-order': '["projects","x_other"]',
        'org-without': '["notebooks"]',
    });

    const { rows: agents } = await pg.query(`SELECT id FROM agents ORDER BY id`);
    assert.deepStrictEqual(agents.map((a) => a.id), ['system-title-generator']);
    const { rows: tools } = await pg.query(`SELECT id FROM agent_tools`);
    assert.deepStrictEqual(tools, [], 'the agent\'s tool rows go with it');

    // A new org gets the new column DEFAULT.
    await pg.query(`INSERT INTO organizations (id) VALUES ('org-new')`);
    assert.strictEqual((await grants(pg))['org-new'], '["notebooks","projects"]');

    // A rerun changes nothing.
    const before = await grants(pg);
    assert.deepStrictEqual(await up({ db }), { orgsUpdated: 0, agentDeleted: false });
    assert.deepStrictEqual(await grants(pg), before);
});
