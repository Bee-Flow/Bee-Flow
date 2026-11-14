// @typecheck
/**
 * stores/lib/leasedJobs — the claim/lease/heartbeat/fail queue the Meet and
 * Teams import stores share, against a real Postgres (PGlite,
 * testUtils/pgliteDb.js) over a table with the columns the queue touches.
 *
 * Run: cd server && node --test stores/lib/leasedJobs.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { pgliteDb, dbFacade } = require('../../testUtils/pgliteDb');
const { makeLeasedJobQueue } = require('./leasedJobs');

const { pg, db } = pgliteDb();
const facade = /** @type {any} */ (dbFacade(db));

const TABLES = [['gmeet_import_jobs', 'preferred DESC, next_attempt_at ASC'], ['teams_import_jobs', 'next_attempt_at ASC']];

test.before(async () => {
    for (const [table] of TABLES) {
        await pg.exec(`CREATE TABLE ${table} (
            id UUID PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending', preferred BOOLEAN NOT NULL DEFAULT FALSE,
            attempts INT NOT NULL DEFAULT 0, error_code TEXT, last_error TEXT,
            next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    }
});
test.after(() => pg.close());

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let inits = 0;
const queue = (table, orderBy) => makeLeasedJobQueue({
    table, orderBy, mapRow: (r) => ({ mapped: r.id }), initDB: async () => { inits += 1; }, db: facade,
});
const minutesAhead = async (table, id) => Number((await pg.query(
    `SELECT EXTRACT(EPOCH FROM (next_attempt_at - NOW())) / 60 AS m FROM ${table} WHERE id = $1`, [id],
)).rows[0].m);
const rowOf = async (table, id) => (await pg.query(`SELECT status, attempts, error_code, last_error FROM ${table} WHERE id = $1`, [id])).rows[0];

for (const [table, orderBy] of TABLES) {
    test(`${table}: claim takes due pending/awaiting rows in the queue's order, up to the limit, and leases them for 10 minutes`, async () => {
        await pg.exec(`DELETE FROM ${table}`);
        await pg.query(`INSERT INTO ${table} (id, status, preferred, next_attempt_at) VALUES
            ($1, 'pending', FALSE, NOW() - INTERVAL '3 minutes'),
            ($2, 'awaiting_artifacts', TRUE, NOW() - INTERVAL '1 minute'),
            ($3, 'pending', FALSE, NOW() - INTERVAL '2 minutes'),
            ($4, 'pending', FALSE, NOW() + INTERVAL '1 hour'),
            ($5, 'failed', FALSE, NOW() - INTERVAL '9 minutes')`, [uuid(1), uuid(2), uuid(3), uuid(4), uuid(5)]);
        const before = inits;
        const jobs = await queue(table, orderBy).claimDueJobs(2);
        assert.strictEqual(inits, before + 1);
        const expected = table === 'gmeet_import_jobs' ? [uuid(2), uuid(1)] : [uuid(1), uuid(3)];
        assert.deepStrictEqual(jobs.map((j) => j.mapped).sort(), [...expected].sort());
        for (const id of expected) assert.ok(Math.abs(await minutesAhead(table, id) - 10) < 0.5, 'leased for 10 minutes');
        assert.ok(await minutesAhead(table, uuid(4)) > 50, 'a row not yet due is left alone');

        const next = await queue(table, orderBy).claimDueJobs();
        assert.strictEqual(next.length, 1, 'a leased row is not due again; the default limit is 2');
        assert.deepStrictEqual(await queue(table, orderBy).claimDueJobs(), [], 'nothing due');
    });

    test(`${table}: heartbeat extends the lease by the given minutes (default 10)`, async () => {
        await pg.query(`INSERT INTO ${table} (id) VALUES ($1) ON CONFLICT DO NOTHING`, [uuid(10)]);
        const q = queue(table, orderBy);
        assert.strictEqual(await q.heartbeatJob(uuid(10)), true);
        assert.ok(Math.abs(await minutesAhead(table, uuid(10)) - 10) < 0.5);
        await q.heartbeatJob(uuid(10), 120);
        assert.ok(Math.abs(await minutesAhead(table, uuid(10)) - 120) < 0.5);
        assert.strictEqual(await q.heartbeatJob(uuid(99)), false, 'no such job');
    });

    test(`${table}: failJob freezes on terminal, otherwise reschedules after backoffMs`, async () => {
        await pg.query(`INSERT INTO ${table} (id) VALUES ($1), ($2)`, [uuid(20), uuid(21)]);
        const q = queue(table, orderBy);
        await q.failJob(uuid(20), { lastError: 'x', terminal: true });
        assert.deepStrictEqual(await rowOf(table, uuid(20)), { status: 'failed', attempts: 1, error_code: null, last_error: 'x' });

        await q.failJob(uuid(21), { errorCode: 'failed', lastError: 'y', status: 'pending', backoffMs: 120000 });
        assert.deepStrictEqual(await rowOf(table, uuid(21)), { status: 'pending', attempts: 1, error_code: 'failed', last_error: 'y' });
        assert.ok(Math.abs(await minutesAhead(table, uuid(21)) - 2) < 0.5);
        await pg.query(`UPDATE ${table} SET status = 'awaiting_artifacts' WHERE id = $1`, [uuid(21)]);
        await q.failJob(uuid(21));
        assert.deepStrictEqual(await rowOf(table, uuid(21)), { status: 'awaiting_artifacts', attempts: 2, error_code: null, last_error: null },
            'no status keeps the one it has');
    });
}

test('a failing claim query propagates and leases nothing', async () => {
    await pg.exec("DELETE FROM teams_import_jobs; INSERT INTO teams_import_jobs (id, next_attempt_at) VALUES ('00000000-0000-4000-8000-000000000031', NOW() - INTERVAL '1 minute')");
    await assert.rejects(() => queue('teams_import_jobs', 'no_such_column ASC').claimDueJobs());
    assert.ok(await minutesAhead('teams_import_jobs', uuid(31)) < 0, 'still due');
});
