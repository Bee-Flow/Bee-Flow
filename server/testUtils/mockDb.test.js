/**
 * Unit — testUtils/mockDb recording double (H2). DB-free.
 * Run: node --test testUtils/mockDb.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { createRecordingDb } = require('./mockDb');

function seed() {
    return createRecordingDb({
        tables: {
            widgets: [
                { id: 'w1', user_id: 'alice', name: 'A' },
                { id: 'w2', user_id: 'bob', name: 'B' },
            ],
        },
    });
}

test('getOne matches WHERE equalities and refuses a foreign owner', async () => {
    const mock = seed();
    const mine = await mock.db.getOne('SELECT * FROM widgets WHERE id = $1 AND user_id = $2', ['w1', 'alice']);
    assert.strictEqual(mine.name, 'A');
    const foreign = await mock.db.getOne('SELECT * FROM widgets WHERE id = $1 AND user_id = $2', ['w2', 'alice']);
    assert.strictEqual(foreign, null, 'bob\'s row is not visible to alice');
});

test('getAll returns copies (mutating a result does not corrupt the fixture)', async () => {
    const mock = seed();
    const rows = await mock.db.getAll('SELECT * FROM widgets WHERE user_id = $1', ['alice']);
    rows[0].name = 'MUTATED';
    const again = await mock.db.getAll('SELECT * FROM widgets WHERE user_id = $1', ['alice']);
    assert.strictEqual(again[0].name, 'A', 'fixture untouched');
});

test('records run/getOne/getAll calls and reset clears them', async () => {
    const mock = seed();
    await mock.db.run('UPDATE widgets SET name = $1 WHERE id = $2 AND user_id = $3', ['x', 'w1', 'alice']);
    await mock.db.getOne('SELECT * FROM widgets WHERE id = $1', ['w1']);
    assert.strictEqual(mock.calls.run.length, 1);
    assert.strictEqual(mock.calls.getOne.length, 1);
    mock.reset();
    assert.strictEqual(mock.calls.run.length, 0);
    assert.strictEqual(mock.calls.getOne.length, 0);
});

test('mutations() collects UPDATE/DELETE/INSERT across helpers and transaction', async () => {
    const mock = seed();
    await mock.db.run('INSERT INTO widgets (id) VALUES ($1)', ['w3']);
    await mock.db.withTransaction(async (client) => {
        await client.query('UPDATE widgets SET name = $1 WHERE id = $2 AND user_id = $3', ['y', 'w1', 'alice']);
    });
    const muts = mock.mutations();
    assert.strictEqual(muts.length, 2, 'the INSERT and the in-transaction UPDATE');
    assert.ok(muts.some((m) => /^INSERT/i.test(m.sql.trim())));
    assert.ok(muts.some((m) => /^UPDATE/i.test(m.sql.trim())));
});

test('withTransaction records BEGIN…COMMIT and returns the callback value', async () => {
    const mock = seed();
    const out = await mock.db.withTransaction(async (client) => {
        await client.query('UPDATE widgets SET name = $1 WHERE id = $2', ['z', 'w1']);
        return 'done';
    });
    assert.strictEqual(out, 'done');
    const verbs = mock.calls.client.map((c) => c.sql.trim().split(' ')[0].toUpperCase());
    assert.deepStrictEqual(verbs, ['BEGIN', 'UPDATE', 'COMMIT']);
});

test('withTransaction records ROLLBACK and rethrows on failure', async () => {
    const mock = seed();
    await assert.rejects(() => mock.db.withTransaction(async () => { throw new Error('nope'); }), /nope/);
    const verbs = mock.calls.client.map((c) => c.sql.trim().toUpperCase());
    assert.deepStrictEqual(verbs, ['BEGIN', 'ROLLBACK']);
});

test('per-table matcher models an OR disjunction the equality matcher cannot', async () => {
    const mock = createRecordingDb({
        tables: { docs: [{ id: 'd1', user_id: 'alice', published: true }, { id: 'd2', user_id: 'bob', published: false }] },
        matchers: {
            docs: (rows, sql, params) => rows.filter((r) => r.user_id === params[0] || r.published === true),
        },
    });
    const rows = await mock.db.getAll('SELECT * FROM docs WHERE user_id = $1 OR published = true', ['carol']);
    assert.deepStrictEqual(rows.map((r) => r.id), ['d1'], 'only the published doc, none owned by carol');
});

test('a matcher returning undefined falls back to default equality for ordinary statements', async () => {
    const mock = createRecordingDb({
        tables: { docs: [{ id: 'd1', user_id: 'alice', published: true }, { id: 'd2', user_id: 'bob', published: false }] },
        matchers: {
            // Only handles the OR query; returns undefined for everything else.
            docs: (rows, sql, params) => (/\bOR\b/i.test(sql)
                ? rows.filter((r) => r.user_id === params[0] || r.published === true)
                : undefined),
        },
    });
    const or = await mock.db.getAll('SELECT * FROM docs WHERE user_id = $1 OR published = true', ['carol']);
    assert.deepStrictEqual(or.map((r) => r.id), ['d1']);
    const eq = await mock.db.getOne('SELECT * FROM docs WHERE id = $1 AND user_id = $2', ['d2', 'alice']);
    assert.strictEqual(eq, null, 'falls back to equality: bob\'s doc is not alice\'s');
});
