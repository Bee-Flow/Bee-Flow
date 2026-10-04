'use strict';

/**
 * The usage breakdowns leave the store as NUMBERS.
 *
 * node-postgres returns COUNT/SUM over INTEGER (bigint) and NUMERIC as strings.
 * The "Models per Agent" card summed them per agent with `+=` and so
 * concatenated them: "Direct Chat" showed 98282.7M tokens.
 *
 * The breakdown queries run against a real Postgres (PGlite behind db.js's
 * pool, testUtils/pglitePool.js) — no module mocking.
 * Run: cd server && node --test stores/usageStore.numericAggregates.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { PGlite } = require('@electric-sql/pglite');
const { usePglitePool } = require('../testUtils/pglitePool');

// PGlite parses bigint and numeric into numbers; node-postgres — what the
// server actually runs on — leaves both as strings. Answer like node-postgres
// (oid 20 = int8, 1700 = numeric), or this test could not see the bug.
const { pg, close } = usePglitePool(new PGlite({ parsers: { 20: (v) => v, 1700: (v) => v } }));
const usageStore = require('./usageStore');

before(async () => {
    await usageStore.initDB();
    const insert = `INSERT INTO ai_usage_log (user_id, agent_id, agent_name, model, source, prompt_tokens, completion_tokens, total_tokens, estimated_cost, duration_ms)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;
    await pg.query(insert, ['u1', null, null, 'claude-sonnet-5-5', 'direct-chat', 90000, 8282, 98282, 0.25, 1200]);
    await pg.query(insert, ['u1', null, null, 'gpt-5', 'direct-chat', 6000, 1000, 7000, 0.1, 800]);
});

after(close);

// What node-postgres hands back for one GROUP BY row: every aggregate a string.
const PG_ROW = {
    model: 'claude-sonnet-5-5', agent_name: 'Direct Chat', agent_id: null,
    calls: '12', prompt_tokens: '98282', completion_tokens: '7000', total_tokens: '105282',
    estimated_cost: '0.4210', avg_duration_ms: '1834.5',
};

test('numericAggregates turns pg strings into numbers and leaves the rest alone', () => {
    const [row] = usageStore.numericAggregates([PG_ROW]);
    assert.strictEqual(row.total_tokens, 105282);
    assert.strictEqual(row.prompt_tokens, 98282);
    assert.strictEqual(row.calls, 12);
    assert.strictEqual(row.estimated_cost, 0.421);
    assert.strictEqual(row.avg_duration_ms, 1834.5);
    assert.strictEqual(row.model, 'claude-sonnet-5-5');
    assert.strictEqual(row.agent_id, null);
    assert.ok(!('cached_tokens' in row), 'a column the query did not select is not invented');
});

test('numericAggregates tolerates a missing list and junk values', () => {
    assert.deepStrictEqual(usageStore.numericAggregates(null), []);
    const [row] = usageStore.numericAggregates([{ total_tokens: 'abc', calls: null }]);
    assert.strictEqual(row.total_tokens, 0);
    assert.strictEqual(row.calls, null);
});

for (const fn of ['getUsageByModelAndAgent', 'getUsageByModelAndUser', 'getUsageByModel', 'getUsageByAgent', 'getUsageBySource', 'getUsageByUser']) {
    test(`${fn} returns numeric aggregates`, async () => {
        const rows = await usageStore[fn]({});
        assert.ok(rows.length > 0);
        for (const r of rows) {
            for (const k of ['calls', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'estimated_cost']) {
                assert.strictEqual(typeof r[k], 'number', `${fn}.${k} is ${typeof r[k]}`);
            }
        }
        // The dashboard's own per-agent sum is arithmetic, not concatenation.
        assert.strictEqual(rows.reduce((s, r) => s + r.total_tokens, 0), 105282);
    });
}
