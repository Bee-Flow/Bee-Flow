/**
 * The job around the engine. Three things it must get right, each of which
 * fails silently in production if it does not:
 *
 *   - two replicas must not refresh the same source twice (the claim, not
 *     the advisory lock, is what guarantees it);
 *   - a worker that dies must not take its source offline forever;
 *   - a claim must ALWAYS be released, or the same thing happens for fifteen
 *     minutes on every ordinary failure.
 *
 * Run: node --test --test-force-exit jobs/kbSourceRefresh.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { refreshOne, LOCK_KEY } = require('./kbSourceRefresh');

const SOURCE = {
    id: 'src1', knowledgeBaseId: 'kb1', kind: 'webpage',
    refreshMode: 'schedule', refreshCron: '0 6 * * 1', refreshTz: 'UTC',
    consecutiveErrors: 0, config: { url: 'https://example.com' },
};

function fakeStore() {
    const finished = [];
    return { finished, finish: async (id, p) => { finished.push({ id, ...p }); } };
}

test('the advisory lock key is this job’s own', () => {
    // 0xBEEF105–0xBEEF10E belong to the other jobs. Sharing one means two
    // unrelated jobs silently taking turns, each thinking it ran.
    assert.strictEqual(LOCK_KEY, 0xBEEF10F);
});

test('a successful pass releases the claim and schedules the next one', async () => {
    const store = fakeStore();
    const sources = {
        syncSource: async () => ({ added: 1, truncated: false, cancelled: false, nextRefreshAt: '2026-09-07T06:00:00.000Z' }),
        nextRefreshFor: () => null,
    };
    const r = await refreshOne(SOURCE, { sources, store });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(store.finished, [{ id: 'src1', ok: true, nextRefreshAt: '2026-09-07T06:00:00.000Z' }]);
});

test('a pass that stopped early stays due, so the next tick continues it', async () => {
    // Waiting for the weekly schedule after processing 20 of 500 pages means
    // a source that never finishes catching up.
    for (const stop of [{ truncated: true }, { cancelled: true }]) {
        const store = fakeStore();
        const sources = {
            syncSource: async () => ({ added: 20, truncated: false, cancelled: false, nextRefreshAt: '2026-09-07T06:00:00.000Z', ...stop }),
            nextRefreshFor: () => null,
        };
        await refreshOne(SOURCE, { sources, store });
        const at = Date.parse(store.finished[0].nextRefreshAt);
        assert.ok(Math.abs(at - Date.now()) < 5000, `${Object.keys(stop)[0]} must stay due now`);
    }
});

test('a failed pass still releases the claim, and widens the gap', async () => {
    // A claim that is never released is a source that stops refreshing until
    // the reaper notices — fifteen minutes of silence for a one-second error.
    const store = fakeStore();
    const sources = {
        syncSource: async () => { throw new Error('host unreachable'); },
        nextRefreshFor: (src, opts) => {
            assert.strictEqual(opts.consecutiveErrors, 1, 'the streak must include this failure');
            return '2026-09-04T13:00:00.000Z';
        },
    };
    const r = await refreshOne(SOURCE, { sources, store });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(store.finished.length, 1);
    assert.strictEqual(store.finished[0].ok, false);
    assert.strictEqual(store.finished[0].error.message, 'host unreachable');
});

test('the streak carried into the backoff is the row’s, plus this failure', async () => {
    const store = fakeStore();
    let seen = null;
    const sources = {
        syncSource: async () => { throw new Error('still down'); },
        nextRefreshFor: (src, opts) => { seen = opts.consecutiveErrors; return null; },
    };
    await refreshOne({ ...SOURCE, consecutiveErrors: 4 }, { sources, store });
    assert.strictEqual(seen, 5);
});

test('a null or absent streak on the row does not produce NaN', async () => {
    // consecutive_errors read straight from a row can be null; NaN would
    // reach backoffMinutes and schedule an Invalid Date.
    const store = fakeStore();
    let seen = 'unset';
    const sources = {
        syncSource: async () => { throw new Error('x'); },
        nextRefreshFor: (src, opts) => { seen = opts.consecutiveErrors; return null; },
    };
    await refreshOne({ ...SOURCE, consecutiveErrors: null }, { sources, store });
    assert.strictEqual(seen, 1);
});
