/**
 * BFSF-440: the dead trigger-sample table is dropped, once, and stays gone.
 *
 * Pinned here:
 *   - an install that carries the table loses it (index and FK go with it);
 *   - a second run — every store init replays the ladder — is a probe and
 *     nothing else, so it can never fail on a table that is already gone;
 *   - an install that never had the table is not an error.
 *
 * The db facade is injected through up()'s parameter; no module mocking.
 *
 * Run: node --test migrations/drop-automation-trigger-samples-2026-09.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const migration = require('./drop-automation-trigger-samples-2026-09');

/** A db facade over one fake catalogue: the set of tables that exist. */
function fakeDb(tables) {
    const statements = [];
    return {
        statements,
        async getOne(sql) {
            statements.push(sql);
            const m = /to_regclass\('public\.(\w+)'\)/.exec(sql);
            return { oid: m && tables.has(m[1]) ? m[1] : null };
        },
        async exec(sql) {
            statements.push(sql);
            const m = /DROP TABLE IF EXISTS (\w+)/.exec(sql);
            if (m) tables.delete(m[1]);
        },
    };
}

test('drops the table when it is there, and a second run does nothing', async () => {
    const tables = new Set(['automation_trigger_samples', 'automations']);
    const db = fakeDb(tables);

    assert.deepEqual(await migration.up({ db }), { dropped: true });
    assert.equal(tables.has('automation_trigger_samples'), false);
    assert.equal(tables.has('automations'), true, 'nothing else is touched');
    const drop = db.statements.find(s => /DROP TABLE/.test(s));
    assert.match(drop, /^DROP TABLE IF EXISTS automation_trigger_samples$/);
    assert.doesNotMatch(drop, /CASCADE/, 'a dependent object must make the drop fail, not vanish with it');

    db.statements.length = 0;
    assert.deepEqual(await migration.up({ db }), { dropped: false });
    assert.equal(db.statements.length, 1, 'the re-run is the probe alone');
    assert.doesNotMatch(db.statements[0], /DROP/);
});

test('an install that never had the table is a no-op, not an error', async () => {
    const db = fakeDb(new Set(['automations']));
    assert.deepEqual(await migration.up({ db }), { dropped: false });
    assert.ok(!db.statements.some(s => /DROP/.test(s)));
});

