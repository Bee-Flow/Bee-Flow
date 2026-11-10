/**
 * Paging on the real engines: walking a record list with its keyset cursor
 * visits every visible row exactly once, in order, on SQLite (better-sqlite3,
 * the per-app engine) and on Postgres (PGlite), and compileRecordCount counts
 * the same rows the walk sees: same row rule, same filters, no page.
 *
 * Run: cd server && node --test core/dataEngine/queryCompilerCount.engines.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const qc = require('./queryCompiler');
const { ddlForTable } = require('./dataModel/ddl');
const { APP_ENGINES } = require('../../testUtils/appEngines');

const TASKS = {
    id: 'tbl_tasks1',
    key: 'tasks',
    fields: [
        { id: 'fld_t1', key: 'title', type: 'text' },
        { id: 'fld_t2', key: 'points', type: 'number', subtype: 'integer' },
    ],
};
const MINE = { where: '"created_by" = ?', params: ['user-1'] };

/** Walk every page the way the read runner does: limit+1 probe, cursor from the last kept row. */
async function walk(engine, opts, access) {
    const seen = [];
    let cursor = null;
    for (let page = 0; page < 20; page++) {
        const compiled = qc.compileRecordList(TASKS, { ...opts, cursor, dialect: engine.dialect }, access);
        const { rows } = await engine.query(compiled.sql, compiled.params);
        const kept = rows.slice(0, compiled.limit);
        seen.push(...kept.map((r) => r.title));
        if (rows.length <= compiled.limit) return seen;
        const last = kept[kept.length - 1];
        cursor = qc.encodeCursor(last[compiled.primaryField], last.id);
    }
    throw new Error('the walk did not end');
}

async function count(engine, opts, access) {
    const { sql, params } = qc.compileRecordCount(TASKS, { ...opts, dialect: engine.dialect }, access);
    const { rows } = await engine.query(sql, params);
    return Number(rows[0].total);
}

for (const [name, make] of APP_ENGINES) {
    test(`${name}: the cursor walk and the count agree, under the row rule and a filter`, async () => {
        const engine = make();
        try {
            await engine.exec(ddlForTable(TASKS, { dialect: engine.dialect }));
            // Equal points on purpose: the id tie-break must keep the walk exact.
            for (let i = 0; i < 7; i++) {
                const ins = qc.compileInsert(TASKS, { title: `t${i}`, points: i % 3 }, { createdBy: i === 5 ? 'user-2' : 'user-1', orgId: 'org-1', dialect: engine.dialect });
                await engine.query(ins.sql, ins.params);
            }
            const sort = { field: 'points', dir: 'asc' };
            const all = await walk(engine, { sort, limit: 2 }, MINE);
            assert.strictEqual(all.length, 6, 'the other user\'s row is not visible');
            assert.strictEqual(new Set(all).size, 6, 'no row twice');
            assert.ok(!all.includes('t5'));
            assert.strictEqual(await count(engine, { sort, limit: 2 }, MINE), 6);

            const filter = { filters: [{ field: 'points', op: 'gte', value: 1 }] };
            const filtered = await walk(engine, { ...filter, sort, limit: 3 }, MINE);
            assert.strictEqual(await count(engine, filter, MINE), filtered.length);
            assert.strictEqual(filtered.length, 3);
        } finally {
            await engine.close();
        }
    });
}
