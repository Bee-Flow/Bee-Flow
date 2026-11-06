'use strict';

/**
 * The retention job against PGlite: it deletes expired rows (and only those) in batches, takes the
 * advisory lock, and the kill switch turns the pass into a no-op.
 *
 * Run: cd server && node --test jobs/kbQueryLogRetention.pg.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { pgliteDb } = require('../testUtils/pgliteDb');
const { makeKbQueryLogStore } = require('../stores/kb/queryLog/index.mts');
const { KB_QUERY_LOG_COLUMN_DDL, KB_QUERY_LOG_TABLE_DDL } = require('../stores/kb/queryLog/ddl.mts');
const crypto = require('../core/kb/queryLog/crypto.mts');
const job = require('./kbQueryLogRetention.mts');

const { pg, db } = pgliteDb();
const store = makeKbQueryLogStore(db);
const KB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const seed = async (id, daysAgo, retentionDays) => store.insertEntries([{
    id, searchGroupId: id, organizationId: 'org1', kbId: KB, userId: 'u1', channel: 'direct_chat', query: 'q', chunks: [], outcome: 'no_results',
    createdAt: new Date(Date.now() - daysAgo * 86_400_000), retentionDays,
}]);
const ids = async () => (await pg.query('SELECT id FROM kb_query_log ORDER BY id')).rows.map((r) => r.id);

let lockNames;
let lockFree;
const infos = [];
const makeDeps = (env = {}) => ({
    pool: {},
    withNamedLock: async (_pool, name, fn) => { lockNames.push(name); return lockFree ? { ran: true, value: await fn() } : { ran: false }; },
    deleteExpired: (limit) => store.deleteExpired(limit),
    log: { info: (m) => infos.push(m), warn: (...a) => infos.push(`WARN ${a.join(" ")}`) },
    env,
});

before(async () => {
    crypto._setCryptoDeps({ getOrgRootKey: async () => Buffer.alloc(32, 5), sealingEnabled: async () => false });
    await pg.exec(`CREATE TABLE knowledge_bases (id UUID PRIMARY KEY, tenant_id TEXT, name TEXT, organization_id TEXT);
        INSERT INTO knowledge_bases (id, organization_id) VALUES ('${KB}', 'org1');`);
    for (const sql of KB_QUERY_LOG_COLUMN_DDL) await pg.exec(sql);
    await pg.exec(`UPDATE knowledge_bases SET query_log_enabled = true`);
    for (const sql of KB_QUERY_LOG_TABLE_DDL) await pg.exec(sql);
});
after(async () => { job._setDeps(null); crypto._setCryptoDeps(null); await pg.close(); });
beforeEach(async () => {
    await pg.exec('DELETE FROM kb_query_log');
    lockNames = []; lockFree = true; infos.length = 0;
    job._setDeps(makeDeps());
});

test('deletes the expired rows and keeps the others', async () => {
    await seed('expired-1', 100, 30);
    await seed('expired-2', 40, 30);
    await seed('alive-1', 10, 30);
    await seed('alive-2', 100, 365);
    assert.equal(await job.runOnce(), 2);
    assert.deepEqual(await ids(), ['alive-1', 'alive-2']);
    assert.deepEqual(lockNames, [job.LOCK_NAME]);
    assert.ok(infos.some((m) => m.includes('deleted 2')));
});

test('a backlog larger than one batch is cleared in one pass', async () => {
    await pg.exec(`INSERT INTO kb_query_log (id, search_group_id, kb_id, channel, expires_at)
        SELECT 'bulk-' || g, 'g' || g, '${KB}', 'direct_chat', now() - interval '1 day' FROM generate_series(1, ${job.BATCH_SIZE + 5}) g`);
    await seed('alive', 1, 30);
    assert.equal(await job.runOnce(), job.BATCH_SIZE + 5);
    assert.deepEqual(await ids(), ['alive']);
});

test('the kill switch turns the pass into a no-op, without taking the lock', async () => {
    await seed('expired', 100, 30);
    job._setDeps(makeDeps({ KB_QUERY_LOG_RETENTION_DISABLED: '1' }));
    assert.equal(await job.runOnce(), null);
    assert.deepEqual(await ids(), ['expired']);
    assert.deepEqual(lockNames, []);
});

test('another replica holding the lock means this pass does nothing', async () => {
    await seed('expired', 100, 30);
    lockFree = false;
    assert.equal(await job.runOnce(), null);
    assert.deepEqual(await ids(), ['expired']);
});

test('a failing pass is logged and resolves to null', async () => {
    job._setDeps({ ...makeDeps(), deleteExpired: async () => { throw new Error('db down'); } });
    assert.equal(await job.runOnce(), null);
    assert.ok(infos.some((m) => m.startsWith('WARN') && m.includes('db down')));
});

test('the job has its own lock name', () => {
    assert.equal(job.LOCK_NAME, 'beeflow:job:kbQueryLogRetention');
});
