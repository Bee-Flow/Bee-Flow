'use strict';

/**
 * Compliance scheduler — one replica sweeps per tick (advisory lock), every
 * org plus 'default' is swept, one failing org does not stop the others, and
 * the daily digest gets its chance after each org.
 *
 * Run: cd server && node --test compliance/scheduler.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const scheduler = require('./scheduler');

function fakePool({ locked = true, connectError = null } = {}) {
    const queries = [];
    let released = 0;
    return {
        queries,
        released: () => released,
        connect: async () => {
            if (connectError) throw connectError;
            return {
                query: async (sql, params) => {
                    queries.push([sql, params]);
                    return /pg_try_advisory_lock/.test(sql) ? { rows: [{ locked }] } : { rows: [] };
                },
                release: () => { released++; },
            };
        },
    };
}

function deps(over = {}) {
    const runs = [];
    const digests = [];
    return {
        runs,
        digests,
        runner: { runAll: async (orgId) => { runs.push(orgId); if (orgId === 'bad') throw new Error('boom'); return []; } },
        userStore: { getAllOrganizations: async () => [{ id: 'org1' }, { id: 'bad' }, { id: 'org2' }] },
        digest: { sendDigest: async (orgId) => { digests.push(orgId); return { sent: false }; } },
        pool: fakePool(),
        ...over,
    };
}

test('the replica that wins the lock sweeps every org and the default bucket, then unlocks', async () => {
    const d = deps();
    const r = await scheduler._runAllOrgs(d);
    assert.deepStrictEqual(r, { ran: true, orgs: 4 });
    assert.deepStrictEqual(d.runs, ['default', 'org1', 'bad', 'org2']);
    assert.deepStrictEqual(d.digests, ['default', 'org1', 'org2'], 'no digest for an org whose sweep failed');
    const sql = d.pool.queries.map(q => q[0]);
    assert.match(sql[0], /pg_try_advisory_lock/);
    assert.match(sql[sql.length - 1], /pg_advisory_unlock/);
    assert.strictEqual(d.pool.queries[0][1][0], scheduler.LOCK_KEY);
    assert.strictEqual(d.pool.released(), 1);
});

test('a replica that loses the lock sweeps nothing', async () => {
    const d = deps({ pool: fakePool({ locked: false }) });
    assert.deepStrictEqual(await scheduler._runAllOrgs(d), { ran: false, reason: 'locked' });
    assert.deepStrictEqual(d.runs, []);
    assert.strictEqual(d.pool.released(), 1, 'the probing client goes back to the pool');
});

test('an unreachable database skips the tick instead of throwing', async () => {
    const d = deps({ pool: fakePool({ connectError: new Error('ECONNREFUSED') }) });
    assert.deepStrictEqual(await scheduler._runAllOrgs(d), { ran: false, reason: 'locked' });
    assert.deepStrictEqual(d.runs, []);
});

test('an org list that cannot be read still sweeps the default bucket', async () => {
    const d = deps({ userStore: { getAllOrganizations: async () => { throw new Error('nope'); } } });
    await scheduler._runAllOrgs(d);
    assert.deepStrictEqual(d.runs, ['default']);
});

test('a sweep that overlaps a running one is skipped in-process', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const d = deps({ runner: { runAll: async () => { await gate; return []; } }, userStore: { getAllOrganizations: async () => [] } });
    const first = scheduler._runAllOrgs(d);
    const second = await scheduler._runAllOrgs(d);
    assert.deepStrictEqual(second, { ran: false, reason: 'running' });
    release();
    assert.deepStrictEqual(await first, { ran: true, orgs: 1 });
});

test('once per tick, after every org, the dismissals of deleted projects and people are pruned — and a failing prune is only a log line', async () => {
    const order = [];
    const d = deps({
        runner: { runAll: async (orgId) => { order.push(`run:${orgId}`); return []; } },
        complianceStore: { pruneHintDismissals: async () => { order.push('prune'); throw new Error('reset'); } },
    });
    const r = await scheduler._runAllOrgs(d);
    assert.strictEqual(r.ran, true);
    assert.deepStrictEqual(order.filter(x => x === 'prune'), ['prune']);
    assert.strictEqual(order[order.length - 1], 'prune');
    const lost = await scheduler._runAllOrgs(deps({ pool: fakePool({ locked: false }), complianceStore: { pruneHintDismissals: async () => { order.push('prune-lost'); } } }));
    assert.strictEqual(lost.ran, false);
    assert.ok(!order.includes('prune-lost'), 'the replica that did not sweep does not prune either');
});
