/**
 * The migration steps for what is not a column (migrationLinked.js), planned and APPLIED on both
 * engines (SQLite in memory with foreign keys on, Postgres through PGlite):
 *   - a new many relation creates its junction and nothing on the table itself;
 *   - a single relation that becomes many copies its links into the junction (its column stays);
 *     the way back gives the column one of the links again, the junction stays;
 *   - a lookup or rollup field plans no statement at all;
 *   - the stored rows of the table are never touched.
 *
 * Run: cd server && node --test core/dataEngine/dataModel/migrationLinked.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { migrationPlan } = require('./migrationPlan');
const { junctionName } = require('./linkedFields');
const { bootLinkedEngines } = require('../../../testUtils/linkedEngines.testkit');

const TEAMS = { id: 'tbl_team01', key: 'teams', fields: [{ id: 'fld_tnam01', key: 'name', type: 'text' }] };
const single = { id: 'fld_team01', key: 'team', type: 'relation', relation: { table: 'tbl_team01' } };
const people = (fields) => ({ id: 'tbl_ppl001', key: 'people', fields: [{ id: 'fld_pnam01', key: 'name', type: 'text' }, ...fields] });
const model = (fields) => ({ modelVersion: 1, tables: [TEAMS, people(fields)] });
const JN = junctionName('tbl_ppl001', 'fld_team01');

const closers = [];
test.after(async () => { for (const close of closers) await close(); });

test('a lookup, a rollup or a new many relation plans no ALTER of the table', () => {
    const lookup = { id: 'fld_tlk001', key: 'team_name', type: 'lookup', lookup: { relation: 'team', field: 'name' } };
    for (const dialect of ['sqlite', 'pg']) {
        assert.deepStrictEqual(migrationPlan(model([single]), model([single, lookup]), { dialect }), []);
        const plan = migrationPlan(model([]), model([{ ...single, relation: { table: 'tbl_team01', many: true } }]), { dialect });
        assert.strictEqual(plan.length, 2, plan.join(' | '));
        assert.ok(plan[0].startsWith(`CREATE TABLE IF NOT EXISTS "${JN}"`) && plan[1].startsWith('CREATE INDEX IF NOT EXISTS'));
        assert.ok(!plan.some((s) => s.includes('ALTER TABLE')), dialect);
    }
});

test('single → many copies the links, many → single gives the column one back; the rows stay', async () => {
    const engines = await bootLinkedEngines(model([single]), closers);
    const many = { ...single, relation: { table: 'tbl_team01', many: true } };
    for (const engine of Object.values(engines)) {
        await engine.run('INSERT INTO "teams" (id, name) VALUES (?, ?), (?, ?)', ['t1', 'One', 't2', 'Two']);
        await engine.run('INSERT INTO "people" (id, name, team) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)', ['p1', 'Ann', 't1', 'p2', 'Bob', null, 'p3', 'Cy', 't2']);
        for (const sql of migrationPlan(model([single]), model([many]), { dialect: engine.dialect })) await engine.ddl(sql);
        const linked = await engine.all(`SELECT source_id, target_id FROM "${JN}" ORDER BY source_id`, []);
        assert.deepStrictEqual(linked.map((r) => `${r.source_id}>${r.target_id}`), ['p1>t1', 'p3>t2'], engine.dialect);
        await engine.run(`INSERT INTO "${JN}" (source_id, target_id) VALUES (?, ?)`, ['p2', 't2']);
        await engine.run('UPDATE "people" SET team = NULL', []);
        for (const sql of migrationPlan(model([many]), model([single]), { dialect: engine.dialect })) await engine.ddl(sql);
        const back = await engine.all('SELECT id, name, team FROM "people" ORDER BY id', []);
        assert.deepStrictEqual(back.map((r) => [r.id, r.name, r.team]), [['p1', 'Ann', 't1'], ['p2', 'Bob', 't2'], ['p3', 'Cy', 't2']], engine.dialect);
        assert.strictEqual((await engine.all(`SELECT COUNT(*) AS n FROM "${JN}"`, []))[0].n * 1, 3, `${engine.dialect}: the junction stays`);
    }
});

test('dropping the field drops its junction (never on a retaining stage deploy)', () => {
    const many = { ...single, relation: { table: 'tbl_team01', many: true } };
    assert.deepStrictEqual(migrationPlan(model([many]), model([]), { dialect: 'pg' }), [`DROP TABLE IF EXISTS "${JN}"`]);
    assert.ok(!migrationPlan(model([many]), model([]), { dialect: 'pg', retainRetired: true }).some((s) => s.includes(JN)));
    assert.deepStrictEqual(migrationPlan(model([many]), { modelVersion: 1, tables: [TEAMS] }, { dialect: 'sqlite' }), [`DROP TABLE IF EXISTS "${JN}"`, 'DROP TABLE IF EXISTS "people"']);
});
