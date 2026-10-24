// @typecheck
/**
 * stores/lib/leasedJobs — the claim/lease/heartbeat/fail SQL the Meet and
 * Teams import stores share. Pins the statements and parameters each store
 * sent before the extraction (whitespace aside).
 *
 * Run: cd server && node --test stores/lib/leasedJobs.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeLeasedJobQueue } = require('./leasedJobs');

const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();

function fakeDb({ claimIds = [], failOn = null } = {}) {
    const calls = [];
    let inits = 0;
    const client = {
        query: async (sql, params) => {
            calls.push({ via: 'tx', sql: norm(sql), params });
            if (failOn && failOn.test(sql)) throw new Error('boom');
            if (/^\s*SELECT id/.test(sql)) return { rows: claimIds.map((id) => ({ id })) };
            return { rows: params[0].map((id) => ({ id, raw: true })) };
        },
    };
    return {
        calls,
        get inits() { return inits; },
        initDB: async () => { inits++; },
        db: {
            withTransaction: async (fn) => { calls.push({ via: 'tx', sql: 'BEGIN' }); const r = await fn(client); calls.push({ via: 'tx', sql: 'COMMIT' }); return r; },
            run: async (sql, params) => { calls.push({ via: 'run', sql: norm(sql), params }); return { rowCount: 1, rows: [] }; },
        },
    };
}

function queue(f, table, orderBy) {
    return makeLeasedJobQueue({ table, orderBy, mapRow: (r) => ({ mapped: r.id }), initDB: f.initDB, db: f.db });
}

for (const [table, orderBy] of [['gmeet_import_jobs', 'preferred DESC, next_attempt_at ASC'], ['teams_import_jobs', 'next_attempt_at ASC']]) {
    test(`${table}: claim selects due rows SKIP LOCKED in its order and leases them for 10 minutes in one transaction`, async () => {
        const f = fakeDb({ claimIds: ['a', 'b'] });
        const jobs = await queue(f, table, orderBy).claimDueJobs(3);
        assert.deepStrictEqual(jobs, [{ mapped: 'a' }, { mapped: 'b' }]);
        assert.strictEqual(f.inits, 1);
        assert.deepStrictEqual(f.calls.map((c) => c.sql), [
            'BEGIN',
            `SELECT id FROM ${table} WHERE status IN ('pending', 'awaiting_artifacts') AND next_attempt_at <= NOW() ORDER BY ${orderBy} LIMIT $1 FOR UPDATE SKIP LOCKED`,
            `UPDATE ${table} SET next_attempt_at = NOW() + INTERVAL '10 minutes', updated_at = NOW() WHERE id = ANY($1::uuid[]) RETURNING *`,
            'COMMIT',
        ]);
        assert.deepStrictEqual(f.calls[1].params, [3]);
        assert.deepStrictEqual(f.calls[2].params, [['a', 'b']]);
    });

    test(`${table}: nothing due commits without a lease update; default limit is 2`, async () => {
        const f = fakeDb();
        assert.deepStrictEqual(await queue(f, table, orderBy).claimDueJobs(), []);
        assert.deepStrictEqual(f.calls.map((c) => c.sql.split(' ')[0]), ['BEGIN', 'SELECT', 'COMMIT']);
        assert.deepStrictEqual(f.calls[1].params, [2]);
    });

    test(`${table}: heartbeat extends the lease by the given minutes (default 10)`, async () => {
        const f = fakeDb();
        const q = queue(f, table, orderBy);
        assert.strictEqual(await q.heartbeatJob('j1'), true);
        await q.heartbeatJob('j1', 120);
        assert.strictEqual(f.calls[0].sql, `UPDATE ${table} SET next_attempt_at = NOW() + ($2::int * INTERVAL '1 minute'), updated_at = NOW() WHERE id = $1`);
        assert.deepStrictEqual(f.calls.map((c) => c.params), [['j1', 10], ['j1', 120]]);
    });

    test(`${table}: failJob freezes on terminal, otherwise reschedules after backoffMs`, async () => {
        const f = fakeDb();
        const q = queue(f, table, orderBy);
        await q.failJob('j1', { lastError: 'x', terminal: true });
        await q.failJob('j1', { errorCode: 'failed', lastError: 'y', status: 'pending', backoffMs: 120000 });
        await q.failJob('j1');
        assert.strictEqual(f.calls[0].sql, `UPDATE ${table} SET attempts = attempts + 1, status = $2, error_code = $3, last_error = $4, updated_at = NOW() WHERE id = $1`);
        assert.deepStrictEqual(f.calls[0].params, ['j1', 'failed', null, 'x']);
        assert.strictEqual(f.calls[1].sql, `UPDATE ${table} SET attempts = attempts + 1, status = COALESCE($2, status), error_code = $3, last_error = $4, next_attempt_at = NOW() + ($5 * INTERVAL '1 millisecond'), updated_at = NOW() WHERE id = $1`);
        assert.deepStrictEqual(f.calls[1].params, ['j1', 'pending', 'failed', 'y', 120000]);
        assert.deepStrictEqual(f.calls[2].params, ['j1', null, null, null, 0]);
    });
}

test('a failing claim query propagates (the transaction helper rolls back)', async () => {
    const f = fakeDb({ failOn: /SELECT id/ });
    await assert.rejects(() => queue(f, 'teams_import_jobs', 'next_attempt_at ASC').claimDueJobs(), /boom/);
});
