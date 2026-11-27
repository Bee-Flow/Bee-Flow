// @typecheck
'use strict';

/**
 * Company-inbox retention against PGlite (the real support schema behind db.js's pool):
 *   - off by default (SUPPORT_THREAD_RETENTION_DAYS unset or 0): nothing is deleted;
 *   - on: website-form threads whose last message is older than the term go, with their
 *     messages, events and audit rows; recent ones, customer-linked ones (an organisation or a
 *     signed-in account) and tenant Support-studio mailbox threads stay;
 *   - one audit row per batch, in the batch's own transaction, holding the count and the term only;
 *   - batching and its cap, and a thread without messages judged by its creation time.
 *
 * Run: cd server && node --test jobs/supportThreadRetention.pg.test.js
 */

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const { newPglite } = require('../testUtils/pgliteTemplate');
const { usePglitePool } = require('../testUtils/pglitePool');

const pg = newPglite();
const { query, restore } = usePglitePool(pg);
const threads = require('../stores/supportStore/threads');
const messages = require('../stores/supportStore/messages');
const audit = require('../stores/supportStore/audit');
const job = require('./supportThreadRetention.mts');

const ENV = 'SUPPORT_THREAD_RETENTION_DAYS';
const infos = [];

/** A thread whose last message was `daysAgo` days ago. */
async function seed({ daysAgo, source = 'marketing', organizationId = null, requesterUserId = null, inboxId = null }) {
    const t = await threads.createThread({ requesterEmail: 'visitor@example.test', requesterName: 'Visitor', source, subject: 'Question', organizationId, requesterUserId, inboxId, requesterIp: '192.0.2.1' });
    await messages.appendMessage({ threadId: t.id, authorKind: 'requester', body: 'Hello', attachments: [{ filename: 'a.pdf' }] });
    await audit.recordThreadEvent({ threadId: t.id, actorKind: 'requester', action: 'reply', ip: '192.0.2.1', ua: 'UA' });
    await query(`UPDATE support_threads SET last_message_at = now() - make_interval(days => $2::int), created_at = now() - make_interval(days => $2::int) WHERE id = $1`, [t.id, daysAgo]);
    return t.id;
}
const exists = async (id) => (await query('SELECT 1 FROM support_threads WHERE id = $1', [id])).rows.length === 1;
const count = async (sql, params = []) => Number((await query(sql, params)).rows[0].n);

before(async () => {
    await threads.getThread('00000000-0000-0000-0000-000000000000'); // the store's own schema init
    job._setDeps({
        withNamedLock: async (_pool, _name, fn) => ({ ran: true, value: await fn() }),
        log: { info: (m) => infos.push(m), warn: (...a) => infos.push(`WARN ${a.join(' ')}`) },
    });
});
beforeEach(async () => {
    delete process.env[ENV];
    infos.length = 0;
    await query('DELETE FROM support_threads');
    await query('DELETE FROM support_audit_log');
});
after(async () => { delete process.env[ENV]; job._setDeps(null); restore(); await pg.close(); });

test('off by default: unset or 0 deletes nothing', async () => {
    const old = await seed({ daysAgo: 4000 });
    assert.equal(await job.runOnce(), null);
    process.env[ENV] = '0';
    assert.equal(await job.runOnce(), null);
    assert.ok(await exists(old));
});

test('deletes expired website-form threads with their messages, events and audit rows', async () => {
    process.env[ENV] = '365';
    const old = await seed({ daysAgo: 400 });
    const recent = await seed({ daysAgo: 300 });
    const customerOrg = await seed({ daysAgo: 400, source: 'in_app', organizationId: 'org-1', requesterUserId: 'u-1' });
    const customerUser = await seed({ daysAgo: 400, source: 'in_app', requesterUserId: 'u-2' });
    const orgOnly = await seed({ daysAgo: 400, source: 'email', organizationId: 'org-3' });
    const tenantMailbox = await seed({ daysAgo: 400, source: 'email', organizationId: 'org-2', inboxId: '11111111-1111-4111-8111-111111111111' });

    assert.equal(await job.runOnce(), 1);

    assert.equal(await exists(old), false);
    assert.equal(await count('SELECT COUNT(*)::int AS n FROM support_messages WHERE thread_id = $1', [old]), 0);
    assert.equal(await count('SELECT COUNT(*)::int AS n FROM support_thread_events WHERE thread_id = $1', [old]), 0);
    assert.equal(await count('SELECT COUNT(*)::int AS n FROM support_audit_log WHERE thread_id = $1', [old]), 0);
    for (const kept of [recent, customerOrg, customerUser, orgOnly, tenantMailbox]) assert.ok(await exists(kept), `kept ${kept}`);
});

test('one audit row per batch with the count and the term, in the company inbox scope, no personal data', async () => {
    process.env[ENV] = '30';
    await seed({ daysAgo: 40 });
    await seed({ daysAgo: 50 });
    assert.equal(await job.runOnce(), 2);
    const { rows } = await query(`SELECT * FROM support_audit_log WHERE action = 'retention_purge'`);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].payload, { threads: 2, retentionDays: 30 });
    assert.equal(rows[0].thread_id, null);
    assert.equal(rows[0].organization_id, null);
    assert.equal(rows[0].inbox_id, null);
    assert.equal(rows[0].ip, null);
    assert.equal(rows[0].ua, null);
    assert.equal(rows[0].actor_kind, 'system');
    // The audit view's company-inbox filter (config events: inbox_id IS NULL) lists it.
    const { events } = await audit.listAuditEvents({ inboxIdIn: [], action: 'retention_purge' });
    assert.equal(events.length, 1);
});

test('batches: each batch deletes and records in one transaction; the pass stops at the batch cap', async () => {
    process.env[ENV] = '30';
    for (let i = 0; i < 5; i++) await seed({ daysAgo: 40 + i });
    const base = { withNamedLock: async (_pool, _name, fn) => ({ ran: true, value: await fn() }), log: { info: () => {}, warn: () => {} } };
    job._setDeps({ ...base, batchSize: 2, maxBatches: 2 });
    try {
        assert.equal(await job.runOnce(), 4, 'two batches of two, then the cap');
        assert.equal(await count('SELECT COUNT(*)::int AS n FROM support_threads'), 1);
        const { rows } = await query(`SELECT payload FROM support_audit_log WHERE action = 'retention_purge' ORDER BY created_at, id`);
        assert.deepEqual(rows.map((r) => r.payload.threads).sort(), [2, 2]);
        assert.equal(await job.runOnce(), 1, 'the next pass goes on; a short batch ends it');
        assert.equal(await count(`SELECT COUNT(*)::int AS n FROM support_audit_log WHERE action = 'retention_purge'`), 3);
    } finally {
        job._setDeps({ ...base, log: { info: (m) => infos.push(m), warn: (...a) => infos.push(`WARN ${a.join(' ')}`) } });
    }
});

test('a failed batch rolls back: the threads stay and no audit row claims them', async () => {
    process.env[ENV] = '30';
    const old = await seed({ daysAgo: 40 });
    const { purgeExpiredCompanyThreads } = require('../stores/supportStore/retention.mts');
    // A NOT NULL / CHECK failure on the audit insert is simulated by a trigger that refuses it.
    await query(`CREATE OR REPLACE FUNCTION refuse_purge_row() RETURNS trigger AS $$ BEGIN
        IF NEW.action = 'retention_purge' THEN RAISE EXCEPTION 'audit refused'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await query(`CREATE TRIGGER refuse_purge BEFORE INSERT ON support_audit_log FOR EACH ROW EXECUTE FUNCTION refuse_purge_row()`);
    try {
        await assert.rejects(purgeExpiredCompanyThreads({ olderThanDays: 30, limit: 10 }), /audit refused/);
    } finally {
        await query('DROP TRIGGER refuse_purge ON support_audit_log');
    }
    assert.ok(await exists(old), 'the delete was rolled back with the audit insert');
});

test('a thread without any message is judged by its creation time', async () => {
    process.env[ENV] = '30';
    const oldEmpty = await seed({ daysAgo: 40 });
    const newEmpty = await seed({ daysAgo: 5 });
    await query('UPDATE support_threads SET last_message_at = NULL WHERE id = ANY($1::uuid[])', [[oldEmpty, newEmpty]]);
    assert.equal(await job.runOnce(), 1);
    assert.equal(await exists(oldEmpty), false);
    assert.ok(await exists(newEmpty));
});

test('a pass with nothing to delete writes no audit row', async () => {
    process.env[ENV] = '30';
    await seed({ daysAgo: 5 });
    assert.equal(await job.runOnce(), 0);
    assert.equal(await count(`SELECT COUNT(*)::int AS n FROM support_audit_log WHERE action = 'retention_purge'`), 0);
});

test('another replica holding the lock: no pass', async () => {
    process.env[ENV] = '30';
    const old = await seed({ daysAgo: 40 });
    job._setDeps({ withNamedLock: async () => ({ ran: false }), log: { info: () => {}, warn: () => {} } });
    try {
        assert.equal(await job.runOnce(), null);
    } finally {
        job._setDeps({
            withNamedLock: async (_pool, _name, fn) => ({ ran: true, value: await fn() }),
            log: { info: (m) => infos.push(m), warn: (...a) => infos.push(`WARN ${a.join(' ')}`) },
        });
    }
    assert.ok(await exists(old));
});
