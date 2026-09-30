'use strict';

/**
 * Project live-feed retention (jobs/projectEventsPrune.js).
 *
 * Pinned: a pass takes the named advisory lock, prunes a week, releases the
 * lock and the client; another replica holding the lock means no prune; a
 * failing prune is logged and never thrown, and the lock is still released;
 * start/stop schedule and clear the timers.
 *
 * Run: cd server && node --test jobs/projectEventsPrune.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const job = require('./projectEventsPrune');

function fakes({ locked = true, prune = async () => 3 } = {}) {
    const rec = { queries: [], released: 0, prunedWith: [], info: [], warn: [] };
    const client = {
        async query(sql, params) {
            rec.queries.push([sql, params]);
            if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ locked }] };
            return { rows: [] };
        },
        release() { rec.released += 1; },
    };
    job._setDeps({
        pool: { connect: async () => client },
        pruneProjectEvents: async (days) => { rec.prunedWith.push(days); return prune(days); },
        log: { info: (...a) => rec.info.push(a.join(' ')), warn: (...a) => rec.warn.push(a.join(' ')) },
    });
    return rec;
}

test.afterEach(() => { job.stop(); job._setDeps(null); });

test('prunes a week under the named lock, then releases it', async () => {
    const rec = fakes();
    assert.strictEqual(await job.runOnce(), 3);
    assert.deepStrictEqual(rec.prunedWith, [7]);
    assert.deepStrictEqual(rec.queries.map(([sql, params]) => [sql.includes('unlock') ? 'unlock' : 'lock', params[0]]), [
        ['lock', job.LOCK_NAME], ['unlock', job.LOCK_NAME],
    ]);
    assert.strictEqual(rec.released, 1);
    assert.match(rec.info[0], /pruned 3 project event/);
});

test('does nothing while another replica holds the lock', async () => {
    const rec = fakes({ locked: false });
    assert.strictEqual(await job.runOnce(), null);
    assert.deepStrictEqual(rec.prunedWith, []);
    assert.ok(!rec.queries.some(([sql]) => sql.includes('unlock')));
    assert.strictEqual(rec.released, 1);
});

test('a failing prune is logged, never thrown, and the lock is released', async () => {
    const rec = fakes({ prune: async () => { throw new Error('statement timeout'); } });
    assert.strictEqual(await job.runOnce(), null);
    assert.match(rec.warn[0], /statement timeout/);
    assert.ok(rec.queries.some(([sql]) => sql.includes('unlock')));
    assert.strictEqual(rec.released, 1);
});

test('start schedules once and stop clears the timers', () => {
    const rec = fakes();
    job.start();
    job.start();
    assert.strictEqual(rec.info.filter((l) => /Started/.test(l)).length, 1);
    job.stop();
});
