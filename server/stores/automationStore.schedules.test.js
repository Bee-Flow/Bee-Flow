/**
 * Integration tests for the additional-schedule store (automation_schedules).
 *
 * Run: node stores/automationStore.schedules.test.js
 *
 * Requires a Postgres reachable through the server's normal database config;
 * skips with exit 0 when it is not (same contract as automationStore.claim.test.js).
 */

const assert = require('assert');
const crypto = require('crypto');

(async () => {
    let store;
    try {
        store = require('./automationStore');
        await store.initDB();
    } catch (e) {
        console.warn(`[schedules.test] Postgres unavailable, skipping: ${e.message}`);
        process.exit(0);
    }
    const { pool } = require('../db');

    async function withAutomation(fn) {
        const id = crypto.randomUUID();
        const userId = `tu_${crypto.randomBytes(4).toString('hex')}`;
        await pool.query(
            `INSERT INTO automations
                (id, user_id, title, definition_json, version, is_active, is_draft,
                 needs_first_run_confirm, trigger_type, schedule_cron, schedule_tz,
                 next_run_at, last_status, attempts)
             VALUES ($1, $2, 'schedules-test', '{}'::jsonb, 1, TRUE, FALSE, FALSE,
                     'manual', NULL, 'UTC', NULL, NULL, 0)`,
            [id, userId],
        );
        try { await fn({ id, userId }); }
        finally { await pool.query('DELETE FROM automations WHERE id = $1', [id]).catch(() => {}); }
    }

    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 3_600_000);

    // ── upsert keeps an unchanged schedule's slot, rearm recomputes it ────
    await withAutomation(async ({ id }) => {
        const a = await store.upsertSchedule({ automationId: id, triggerStepId: 'trig_a', cron: '0 7 * * 1-5', tz: 'UTC', nextRunAt: past });
        assert.strictEqual(a.triggerStepId, 'trig_a');
        assert.strictEqual(new Date(a.nextRunAt).getTime(), past.getTime());
        const same = await store.upsertSchedule({ automationId: id, triggerStepId: 'trig_a', cron: '0 7 * * 1-5', tz: 'UTC', nextRunAt: future });
        assert.strictEqual(new Date(same.nextRunAt).getTime(), past.getTime(), 'same cron/tz keeps the slot (A12)');
        assert.strictEqual(same.id, a.id, 'one row per (automation, trigger)');
        const changed = await store.upsertSchedule({ automationId: id, triggerStepId: 'trig_a', cron: '30 7 * * 1-5', tz: 'UTC', nextRunAt: future });
        assert.strictEqual(new Date(changed.nextRunAt).getTime(), future.getTime(), 'a new cron takes the new slot');
        const rearmed = await store.upsertSchedule({ automationId: id, triggerStepId: 'trig_a', cron: '30 7 * * 1-5', tz: 'UTC', nextRunAt: past, rearm: true });
        assert.strictEqual(new Date(rearmed.nextRunAt).getTime(), past.getTime(), 'rearm recomputes unconditionally');
        await store.upsertSchedule({ automationId: id, triggerStepId: 'trig_b', cron: '0 8 * * 1', tz: 'UTC', nextRunAt: future });
        assert.strictEqual((await store.listSchedulesForAutomation(id)).length, 2);
        await store.deleteSchedulesExcept(id, ['trig_b']);
        const left = await store.listSchedulesForAutomation(id);
        assert.deepStrictEqual(left.map(s => s.triggerStepId), ['trig_b']);
    });

    // ── claim: one winner, automation row becomes the lock, advance frees it ─
    await withAutomation(async ({ id }) => {
        const row = await store.upsertSchedule({ automationId: id, triggerStepId: 'trig_x', cron: '* * * * *', tz: 'UTC', nextRunAt: past });
        await store.upsertSchedule({ automationId: id, triggerStepId: 'trig_y', cron: '* * * * *', tz: 'UTC', nextRunAt: past });
        const [a, b] = await Promise.all([store.claimDueSchedules('w-A', 10), store.claimDueSchedules('w-B', 10)]);
        const mine = [...a, ...b].filter(c => c.automation.id === id);
        assert.strictEqual(mine.length, 1, 'two due rows of one automation yield ONE claim');
        assert.strictEqual(mine[0].automation.lastStatus, 'running');
        assert.strictEqual(mine[0].schedule.triggerStepId, 'trig_x', 'the earliest (first upserted, equal slot → trig id order) wins');
        const again = await store.claimDueSchedules('w-C', 10);
        assert.ok(!again.some(c => c.automation.id === id), 'a running automation is not claimed again');

        await store.advanceSchedule(row.id, { nextRunAt: future, lastRunAt: new Date(), lastStatus: 'success' });
        await store.releaseAutomation(id);
        await pool.query(`UPDATE automations SET last_status = NULL WHERE id = $1`, [id]);
        const next = await store.claimDueSchedules('w-D', 10);
        const nextMine = next.filter(c => c.automation.id === id);
        assert.strictEqual(nextMine.length, 1);
        assert.strictEqual(nextMine[0].schedule.triggerStepId, 'trig_y', 'the other due row fires on the next tick');
        const rows = await store.listSchedulesForAutomation(id);
        const x = rows.find(r => r.triggerStepId === 'trig_x');
        assert.strictEqual(x.lastStatus, 'success');
        assert.strictEqual(x.runningInstanceId, null, 'advance clears the claim marker');
    });

    // ── an inactive automation's rows are never claimed ─────────────────────
    await withAutomation(async ({ id }) => {
        await store.upsertSchedule({ automationId: id, triggerStepId: 'trig_z', cron: '* * * * *', tz: 'UTC', nextRunAt: past });
        await pool.query(`UPDATE automations SET is_active = FALSE WHERE id = $1`, [id]);
        const claimed = await store.claimDueSchedules('w-E', 10);
        assert.ok(!claimed.some(c => c.automation.id === id));
    });

    console.log('automationStore.schedules.test.js — all checks passed');
    await pool.end().catch(() => {});
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
