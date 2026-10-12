'use strict';

/**
 * The chat signals purge runs on every retention pass: also when both the
 * monitoring-ledger window and the access-audit window are off, because the
 * organisation promised its people 30-90 days, not "until an operator turns
 * retention on". It runs under the pass's advisory lock, and not at all when
 * another pod holds it.
 *
 * The pass is built by makeMonitoringRetentionPass over injected doubles (a
 * pool, a SQL runner, the purge and the two windows), so no module is stubbed.
 *
 * Run: cd server && node --test jobs/monitoringRetention.chatSignals.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeMonitoringRetentionPass } = require('./monitoringRetention');

/** A pass over doubles that record what happens, in order. */
function passWith({ retentionDays, accessAuditRetentionDays, locked = true, purge = null }) {
    const events = [];
    let lockHeld = false;
    const pass = makeMonitoringRetentionPass({
        pool: {
            connect: async () => ({
                query: async (sql) => {
                    if (/pg_try_advisory_lock/.test(sql)) { lockHeld = locked; events.push('lock'); return { rows: [{ locked }] }; }
                    if (/pg_advisory_unlock/.test(sql)) { lockHeld = false; events.push('unlock'); return { rows: [] }; }
                    return { rows: [] };
                },
                release: () => {},
            }),
        },
        run: async (sql) => { events.push(`delete:${(/DELETE FROM (\w+)/.exec(sql) || [])[1]}`); return { rowCount: 0 }; },
        purgeChatSignals: purge || (async () => { events.push(lockHeld ? 'chat_purge:locked' : 'chat_purge:UNLOCKED'); return 3; }),
        recordJobRun: (row) => events.push(`job:${row.status}`),
        retentionDays,
        accessAuditRetentionDays,
    });
    return { pass, events };
}

test('the chat signals purge runs with MONITORING_LOG_RETENTION_DAYS=0 and no access-audit window', async () => {
    const { pass, events } = passWith({ retentionDays: 0, accessAuditRetentionDays: 0 });
    const out = await pass();
    assert.deepEqual(events, ['lock', 'chat_purge:locked', 'unlock', 'job:ok'], 'the lock is taken although both windows are off');
    assert.deepEqual(out.deleted, { chat_signal_counts: 3 });
    assert.equal(out.disabled, undefined, 'the disabled result shape is gone');
    assert.equal(out.cutoff, null);
});

test('it runs inside the advisory lock, after the other windows', async () => {
    const { pass, events } = passWith({ retentionDays: 400, accessAuditRetentionDays: 400 });
    await pass();
    assert.equal(events[0], 'lock');
    assert.deepEqual(events.slice(-3), ['chat_purge:locked', 'unlock', 'job:ok']);
    assert.ok(events.includes('delete:access_audit_log'));
    assert.ok(events.includes('delete:guardrail_events'));
});

test('skipped when another pod holds the lock', async () => {
    const { pass, events } = passWith({ retentionDays: 0, accessAuditRetentionDays: 0, locked: false });
    const out = await pass();
    assert.equal(out.skipped, 'lock');
    assert.deepEqual(events, ['lock']);
});

test('a failed chat purge is reported, and the lock is still released', async () => {
    const { pass, events } = passWith({
        retentionDays: 0,
        accessAuditRetentionDays: 0,
        purge: async () => { throw Object.assign(new Error('relation does not exist'), { code: '42P01' }); },
    });
    const out = await pass();
    assert.deepEqual(out.deleted, {});
    assert.deepEqual(events, ['lock', 'unlock', 'job:error']);
});
