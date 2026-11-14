/**
 * A Cowork run and its schedule's status move together, against a real
 * Postgres (PGlite behind the real db.js): claimEventRun opens no run on a
 * schedule whose status write fails, and reapStaleRuns closes no run whose
 * schedule keeps claiming to run.
 *
 * The failure is a trigger that refuses the cowork_schedules update for one
 * schedule title, after the run write of the old two-statement code had run.
 *
 * Run: cd server && node --require ./testUtils/registerFeatures.js --test stores/coworkStore.atomic.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { ladderPglite } = require('../testUtils/pgliteTemplate');
const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool(ladderPglite());
const coworkStore = require('./coworkStore');
const coworkTriggerStore = require('./coworkTriggerStore');

const REFUSED = 'status-refused';

before(async () => {
    await coworkStore.initDB();
    await pg.exec(`
        CREATE FUNCTION refuse_status() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'status write refused';
        END $$;
        CREATE TRIGGER refuse_status BEFORE UPDATE ON cowork_schedules
            FOR EACH ROW WHEN (NEW.title = '${REFUSED}') EXECUTE FUNCTION refuse_status();
    `);
});
after(close);

const runsOf = async (scheduleId) => (await pg.query('SELECT status, finished_at FROM cowork_runs WHERE schedule_id = $1', [scheduleId])).rows;
const schedule = (title) => coworkStore.createSchedule({ userId: 'u1', title, prompt: 'p', triggerKind: 'app_event', trigger: { provider: 'gmail', event: 'mail.new' } });

test('claimEventRun: a failing status write leaves no open run', async () => {
    const s = await schedule(REFUSED);
    await assert.rejects(() => coworkTriggerStore.claimEventRun({ scheduleId: s.id, userId: 'u1', triggerRef: 'm-1' }), /status write refused/);
    assert.deepStrictEqual(await runsOf(s.id), []);
});

test('claimEventRun: the run opens and the schedule says running; a second claim of the same event opens nothing', async () => {
    const s = await schedule('ok');
    const id = await coworkTriggerStore.claimEventRun({ scheduleId: s.id, userId: 'u1', triggerRef: 'm-1' });
    assert.ok(id);
    assert.strictEqual((await pg.query('SELECT last_status FROM cowork_schedules WHERE id = $1', [s.id])).rows[0].last_status, 'running');
    assert.strictEqual(await coworkTriggerStore.claimEventRun({ scheduleId: s.id, userId: 'u1', triggerRef: 'm-1' }), null);
    assert.strictEqual((await runsOf(s.id)).length, 1);
});

async function staleRun(title) {
    const s = await schedule(title);
    // The run is written straight in: the status is set while the trigger is off.
    await pg.query(`ALTER TABLE cowork_schedules DISABLE TRIGGER refuse_status`);
    await pg.query(`UPDATE cowork_schedules SET last_status = 'running' WHERE id = $1`, [s.id]);
    await pg.query(`ALTER TABLE cowork_schedules ENABLE TRIGGER refuse_status`);
    await pg.query(
        `INSERT INTO cowork_runs (id, schedule_id, user_id, status, started_at) VALUES ($1, $2, 'u1', 'running', NOW() - INTERVAL '2 hours')`,
        [`run-${s.id}`, s.id],
    );
    return s;
}

test('reapStaleRuns: a failing schedule write leaves the run open', async () => {
    const s = await staleRun(REFUSED);
    await assert.rejects(() => coworkStore.reapStaleRuns({ olderThanMs: 60_000 }), /status write refused/);
    const [r] = await runsOf(s.id);
    assert.strictEqual(r.status, 'running');
    assert.strictEqual(r.finished_at, null);
    await pg.query('DELETE FROM cowork_runs WHERE schedule_id = $1', [s.id]);
});

test('reapStaleRuns: the run and its schedule end in error together', async () => {
    const s = await staleRun('ok-stale');
    assert.strictEqual(await coworkStore.reapStaleRuns({ olderThanMs: 60_000 }), 1);
    assert.strictEqual((await runsOf(s.id))[0].status, 'error');
    assert.strictEqual((await pg.query('SELECT last_status FROM cowork_schedules WHERE id = $1', [s.id])).rows[0].last_status, 'error');
});
