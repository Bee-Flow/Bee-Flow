'use strict';
/**
 * stores/user/orgErasure.js, the organisation cascade's last rung: a core table is always erased;
 * a module's table (erasureCoverage.js MODULE_TABLES) while its module is here or its schema is in
 * this database, and never asked for when neither is (an edition that leaves the module out still
 * erases its rows). A missing core table is skipped, a missing module table fails the rung.
 * Real statements on PGlite; the module state and the schema ledger are doubles.
 *
 * Run: cd server && node --test stores/user/orgErasure.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const moduleData = require('../../modules/firstParty/moduleData');
const { eraseOrgKeyedRows, ORG_KEYED_TABLES } = require('./orgErasure');
const { moduleOfTable } = require('./erasureCoverage');
const ports = require('./erasurePorts');

const ORG = 'org-gone';
const TABLES = ORG_KEYED_TABLES.map(([t]) => t);

/**
 * Every module absent; the ledger holds the schema of the modules in `held`.
 * @param {string[]} held
 */
function absentModules(held) {
    const units = new Set(held.flatMap((m) => moduleData.unitsOf(m)));
    moduleData._setModuleDataDepsForTests({
        state: () => 'absent',
        ledgerQuery: () => async (/** @type {string} */ sql, /** @type {unknown[]} */ params = []) => {
            if (/to_regclass/.test(sql)) return { rows: [{ present: true }] };
            const asked = /** @type {string[]} */ (params[0]);
            return { rows: asked.some((u) => units.has(u)) ? [{ present: 1 }] : [] };
        },
    });
}

/** Every table of the list, with one row of the organisation and one of another. */
async function seed() {
    for (const [table, column] of ORG_KEYED_TABLES) {
        await pg.exec(`DROP TABLE IF EXISTS "${table}"; CREATE TABLE "${table}" ("${column}" TEXT)`);
        await pg.query(`INSERT INTO "${table}" ("${column}") VALUES ($1), ('org-stays')`, [ORG]);
    }
}

/** The tables (that exist) that still hold a row of the organisation, in list order. */
async function holding() {
    const left = [];
    for (const [table, column] of ORG_KEYED_TABLES) {
        const exists = await pg.query('SELECT to_regclass($1) IS NOT NULL AS present', [table]);
        if (!exists.rows[0].present) continue;
        const { rows } = await pg.query(`SELECT COUNT(*)::int AS n FROM "${table}" WHERE "${column}" = $1`, [ORG]);
        if (rows[0].n > 0) left.push(table);
    }
    return left;
}

before(() => {
    ports.resetErasurePortsForTests();
    ports.registerErasurePorts({ content: /** @type {any} */ ({ eraseOrgTranscriptions: async () => 0 }) });
});
beforeEach(seed);
after(async () => {
    moduleData._resetModuleDataForTests();
    ports.resetErasurePortsForTests();
    await close();
});

test('no module and no module schema: the core tables are erased, every module table is left alone', async () => {
    absentModules([]);
    await eraseOrgKeyedRows(ORG, () => {});
    assert.deepEqual(await holding(), TABLES.filter((t) => moduleOfTable(t) !== null));
});

test('a module left out by the edition with its schema here: its tables are erased too', async () => {
    absentModules(['compliance']);
    await eraseOrgKeyedRows(ORG, () => {});
    const left = await holding();
    assert.deepEqual(left, TABLES.filter((t) => ![null, 'compliance'].includes(moduleOfTable(t))));
    assert.ok(!left.includes('iso_risks'));
});

test('every module here: every table of the list, and nothing of another organisation', async () => {
    moduleData._setModuleDataDepsForTests({ state: () => 'loaded' });
    await eraseOrgKeyedRows(ORG, () => {});
    assert.deepEqual(await holding(), []);
    const { rows } = await pg.query(`SELECT COUNT(*)::int AS n FROM "playbooks" WHERE organization_id = 'org-stays'`);
    assert.equal(rows[0].n, 1);
});

test('a missing core table is skipped; a missing module table fails the rung', async () => {
    moduleData._setModuleDataDepsForTests({ state: () => 'loaded' });
    await pg.exec('DROP TABLE "skills"');
    await eraseOrgKeyedRows(ORG, () => {});
    assert.deepEqual(await holding(), []);
    await pg.exec('DROP TABLE "playbooks"');
    await assert.rejects(eraseOrgKeyedRows(ORG, () => {}), /relation "playbooks" does not exist/);
});

// ── Legacy tables: group_chats, tasks, custom_tables, dashboards, dashboard_panels ──────────────
// No file of the tree creates them. An older installation has them; a database migrated from
// empty does not, and deleting an organisation there must not fail at the first of them.

const { onLegacyTable, dropCustomTables, eraseDashboards } = require('./orgErasure');

const LEGACY = ['group_chats', 'tasks', 'custom_tables', 'dashboards', 'dashboard_panels', 'ct_org_gone_orders'];
const dropLegacy = async () => { for (const t of LEGACY) await pg.exec(`DROP TABLE IF EXISTS "${t}"`); };
const present = async (/** @type {string} */ table) => (await pg.query('SELECT to_regclass($1) IS NOT NULL AS present', [table])).rows[0].present;
const rowsOf = async (/** @type {string} */ table) => (await pg.query(`SELECT * FROM "${table}"`)).rows;

test('a legacy table that is not there is skipped; any other failure still fails the step', async () => {
    await dropLegacy();
    assert.equal(await onLegacyTable(() => pg.query('DELETE FROM group_chats WHERE organization_id = $1', [ORG])), undefined);
    assert.equal(await onLegacyTable(() => dropCustomTables(ORG)), undefined);
    assert.equal(await onLegacyTable(() => eraseDashboards(ORG)), undefined);
    await assert.rejects(onLegacyTable(() => pg.query('SELECT 1 FROM organizations_no WHERE nope = ', [])), (/** @type {any} */ e) => e.code !== '42P01');
    await assert.rejects(onLegacyTable(async () => { throw new Error('connection lost'); }), /connection lost/);
});

test('where an older installation has them, the organisation\'s rows and its custom tables go, another organisation\'s stay', async () => {
    await dropLegacy();
    await pg.exec(`CREATE TABLE custom_tables (table_name TEXT, organization_id TEXT);
        CREATE TABLE ct_org_gone_orders (id TEXT);
        CREATE TABLE dashboards (id TEXT, organization_id TEXT);
        CREATE TABLE dashboard_panels (dashboard_id TEXT)`);
    await pg.query(`INSERT INTO custom_tables VALUES ('ct_org_gone_orders', $1), ('ct_other', 'org-stays')`, [ORG]);
    await pg.query(`INSERT INTO dashboards VALUES ('d1', $1), ('d2', 'org-stays')`, [ORG]);
    await pg.query(`INSERT INTO dashboard_panels VALUES ('d1'), ('d2')`);

    await onLegacyTable(() => dropCustomTables(ORG));
    await onLegacyTable(() => eraseDashboards(ORG));

    assert.equal(await present('ct_org_gone_orders'), false, 'the physical custom table is dropped');
    assert.deepEqual(await rowsOf('custom_tables'), [{ table_name: 'ct_other', organization_id: 'org-stays' }]);
    assert.deepEqual(await rowsOf('dashboards'), [{ id: 'd2', organization_id: 'org-stays' }]);
    assert.deepEqual(await rowsOf('dashboard_panels'), [{ dashboard_id: 'd2' }]);
});

test('dashboards without a panel table still lose the organisation\'s dashboards', async () => {
    await dropLegacy();
    await pg.exec('CREATE TABLE dashboards (id TEXT, organization_id TEXT)');
    await pg.query(`INSERT INTO dashboards VALUES ('d1', $1), ('d2', 'org-stays')`, [ORG]);
    await onLegacyTable(() => eraseDashboards(ORG));
    assert.deepEqual(await rowsOf('dashboards'), [{ id: 'd2', organization_id: 'org-stays' }]);
});
