// @typecheck
/**
 * importJobPool — the due import jobs run as a pool: a tick starts what fits
 * and does not wait, a long job holds one slot and nothing else, and a person
 * who started watching a run makes its failure final.
 *
 * Run: cd server && node --test core/meetingNotes/importJobPool.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { makeDueJobPool, makeAutoImportQueue, autoImportConcurrency, requestedDuringRun } = require('./importJobPool.mts');

/** A queue of jobs whose work the test finishes by hand. */
function harness(ids, { max = 2 } = {}) {
    const queue = ids.map((id) => ({ id }));
    /** @type {Record<string, { resolve: () => void, reject: (e: Error) => void }>} */
    const open = {};
    /** @type {string[]} */
    const events = [];
    const pool = makeDueJobPool({
        store: { claimDueJobs: async (limit) => { events.push(`claim(${limit})`); return queue.splice(0, limit); } },
        label: 'T', describe: (j) => String(j.id), quietCodes: new Set(['quiet']), maxConcurrent: () => max,
        processClaimedJob: (j) => new Promise((resolve, reject) => {
            events.push(`start ${j.id}`);
            open[j.id] = { resolve: () => resolve(undefined), reject };
        }),
    });
    return { pool, open, events, queue };
}
const settle = () => new Promise((r) => setImmediate(r));

test('a tick starts the due jobs up to the limit and returns while they are still running', async () => {
    const { pool, open, events } = harness(['long', 'b', 'c']);
    assert.strictEqual(await pool.fill(), 2);
    assert.strictEqual(pool.size(), 2);
    assert.deepStrictEqual(events, ['claim(1)', 'start long', 'claim(1)', 'start b'], 'one claim per job, right before it runs');

    // The long meeting is still at the engine: the next tick starts nothing new while the pool is full...
    assert.strictEqual(await pool.fill(), 0);
    // ...and as soon as the short one is done, the next job gets its slot. The long one holds only its own.
    open.b.resolve();
    await settle();
    assert.strictEqual(await pool.fill(), 1);
    assert.deepStrictEqual(events.slice(-2), ['claim(1)', 'start c']);
    assert.strictEqual(pool.size(), 2);

    open.long.resolve();
    open.c.resolve();
    await pool.idle();
    assert.strictEqual(pool.size(), 0);
});

test('a failing job and a failing claim never stop the rest', async () => {
    const { pool, open } = harness(['bad', 'quiet', 'good'], { max: 3 });
    assert.strictEqual(await pool.fill(), 3);
    open.bad.reject(new Error('boom'));
    open.quiet.reject(Object.assign(new Error('expected'), { code: 'quiet' }));
    open.good.resolve();
    await pool.idle();
    assert.strictEqual(pool.size(), 0);

    const broken = makeDueJobPool({
        store: { claimDueJobs: async () => { throw new Error('db'); } },
        label: 'T', describe: String, quietCodes: new Set(), maxConcurrent: () => 2,
        processClaimedJob: async () => { throw new Error('never'); },
    });
    assert.strictEqual(await broken.fill(), 0);
});

test('a limit of 0 starts everything that is due; an empty queue asks once', async () => {
    const all = harness(['a', 'b', 'c', 'd', 'e'], { max: 0 });
    assert.strictEqual(await all.pool.fill(), 5);
    for (const id of ['a', 'b', 'c', 'd', 'e']) all.open[id].resolve();
    await all.pool.idle();

    const empty = harness([]);
    assert.strictEqual(await empty.pool.fill(), 0);
    assert.deepStrictEqual(empty.events, ['claim(1)']);
});

test('the queue\'s processDue waits for its imports only when asked to', async () => {
    /** @type {Array<() => void>} */
    const finish = [];
    let done = 0;
    const jobs = [{ id: 1 }];
    const { processDue, pool } = makeAutoImportQueue({
        store: () => ({ claimDueJobs: async (limit) => jobs.splice(0, limit) }),
        label: 'T', describe: (j) => String(j.id), quietCodes: new Set(),
        processClaimedJob: () => new Promise((resolve) => { finish.push(() => { done += 1; resolve(undefined); }); }),
    });
    await processDue({ wait: false });
    assert.strictEqual(pool.size(), 1, 'the scheduler has its tick back while the import runs');
    assert.strictEqual(done, 0);
    const waited = processDue();
    finish[0]();
    await waited;
    assert.strictEqual(done, 1);
    assert.strictEqual(pool.size(), 0);
});

test('MEETING_IMPORT_AUTO_MAX_CONCURRENT sets the limit: default 3, 0 = unlimited', () => {
    const before = process.env.MEETING_IMPORT_AUTO_MAX_CONCURRENT;
    try {
        delete process.env.MEETING_IMPORT_AUTO_MAX_CONCURRENT;
        assert.strictEqual(autoImportConcurrency(), 3);
        process.env.MEETING_IMPORT_AUTO_MAX_CONCURRENT = '8';
        assert.strictEqual(autoImportConcurrency(), 8);
        process.env.MEETING_IMPORT_AUTO_MAX_CONCURRENT = '0';
        assert.strictEqual(autoImportConcurrency(), 0);
    } finally {
        if (before === undefined) delete process.env.MEETING_IMPORT_AUTO_MAX_CONCURRENT;
        else process.env.MEETING_IMPORT_AUTO_MAX_CONCURRENT = before;
    }
});

test('requestedDuringRun: only a request that arrived while the run was going counts', async () => {
    const store = (row) => ({ getJob: async () => row });
    assert.strictEqual(await requestedDuringRun(store({ requestedByUser: true }), { id: 'j', requestedByUser: false }), true);
    assert.strictEqual(await requestedDuringRun(store({ requestedByUser: false }), { id: 'j', requestedByUser: false }), false);
    assert.strictEqual(await requestedDuringRun(store({ requestedByUser: true }), { id: 'j', requestedByUser: true }), false, 'it was already the user\'s request');
    assert.strictEqual(await requestedDuringRun(store(null), { id: 'j' }), false, 'the job is gone');
    assert.strictEqual(await requestedDuringRun({ getJob: async () => { throw new Error('db'); } }, { id: 'j' }), false);
});
