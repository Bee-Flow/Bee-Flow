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
const { refreshOne, scheduleLicensed, LOCK_KEY } = require('./kbSourceRefresh');

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

// ── The schedule is the paid part, never the pass ───────────────────
//
// Without `kb_scheduled_refresh` a scheduled source is treated as a manual
// one: the pass that came due runs (the job cannot tell it from "Refresh
// now"), its documents stay, and it is not armed again. A datatable source is
// never asked: its pass is how an erased row leaves the knowledge base.

const NEXT_MONDAY = '2026-09-07T06:00:00.000Z';
const passThatWorked = () => ({
    syncSource: async () => ({ added: 1, truncated: false, cancelled: false, nextRefreshAt: NEXT_MONDAY }),
    nextRefreshFor: () => null,
});

test('without the licence, a scheduled page is refreshed once and not scheduled again', async () => {
    const store = fakeStore();
    let synced = 0;
    const sources = { ...passThatWorked(), syncSource: async () => { synced += 1; return { truncated: false, cancelled: false, nextRefreshAt: NEXT_MONDAY }; } };
    const r = await refreshOne(SOURCE, { sources, store, scheduleAllowed: async () => false });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(synced, 1, 'the due pass still runs: refreshing by hand is free');
    assert.deepStrictEqual(store.finished, [{ id: 'src1', ok: true, nextRefreshAt: null }],
        'but nothing arms the schedule again');
});

test('without the licence, a failed pass is not retried on the schedule either', async () => {
    const store = fakeStore();
    let seenMode = null;
    const sources = {
        syncSource: async () => { throw new Error('host unreachable'); },
        nextRefreshFor: (src) => { seenMode = src.refreshMode; return src.refreshMode === 'manual' ? null : '2026-09-04T13:00:00.000Z'; },
    };
    await refreshOne(SOURCE, { sources, store, scheduleAllowed: async () => false });
    assert.strictEqual(seenMode, 'manual', 'the backoff is asked about the source as the plan allows it');
    assert.strictEqual(store.finished[0].nextRefreshAt, null);
});

test('a pass that stopped early still continues next tick, licensed or not', async () => {
    // Finishing the pass somebody asked for is not scheduling a new one.
    const store = fakeStore();
    const sources = { ...passThatWorked(), syncSource: async () => ({ truncated: true, nextRefreshAt: NEXT_MONDAY }) };
    await refreshOne(SOURCE, { sources, store, scheduleAllowed: async () => false });
    assert.ok(Math.abs(Date.parse(store.finished[0].nextRefreshAt) - Date.now()) < 5000);
});

test('with the licence, the schedule is armed as before', async () => {
    const store = fakeStore();
    await refreshOne(SOURCE, { sources: passThatWorked(), store, scheduleAllowed: async () => true });
    assert.strictEqual(store.finished[0].nextRefreshAt, NEXT_MONDAY);
});

test('a check that throws keeps the schedule: an outage is not a downgrade', async () => {
    const store = fakeStore();
    await refreshOne(SOURCE, { sources: passThatWorked(), store, scheduleAllowed: async () => { throw new Error('down'); } });
    assert.strictEqual(store.finished[0].nextRefreshAt, NEXT_MONDAY);
});

// ── scheduleLicensed: who is asked, and who never is ────────────────

function entitlementsWith({ has = false, degraded = false } = {}) {
    const asked = [];
    return {
        asked,
        resolveCapabilitySet: async (ctx) => { asked.push(ctx); return { degraded, has: (id) => has && id === 'kb_scheduled_refresh' }; },
    };
}
const kbStore = { getKB: async (id) => (id === 'kb1' ? { id: 'kb1', tenant_id: 'owner1', organization_id: 'org1' } : null) };

test('a scheduled page asks the plan of the knowledge base\'s own organisation and owner', async () => {
    const entitlements = entitlementsWith({ has: false });
    assert.strictEqual(await scheduleLicensed(SOURCE, { kbStore, entitlements }), false);
    assert.deepStrictEqual(entitlements.asked, [{ userId: 'owner1', orgId: 'org1' }]);
    assert.strictEqual(await scheduleLicensed(SOURCE, { kbStore, entitlements: entitlementsWith({ has: true }) }), true);
});

test('a scheduled DATATABLE source keeps syncing without the licence, and nobody is asked', async () => {
    const entitlements = entitlementsWith({ has: false });
    const table = { ...SOURCE, kind: 'datatable', config: { datatableId: 'dt1' } };
    assert.strictEqual(await scheduleLicensed(table, { kbStore, entitlements }), true);
    assert.deepStrictEqual(entitlements.asked, []);

    // And through the job: its next pass is armed from its schedule as ever.
    const store = fakeStore();
    await refreshOne(table, { sources: passThatWorked(), store, scheduleAllowed: (s) => scheduleLicensed(s, { kbStore, entitlements }) });
    assert.strictEqual(store.finished[0].nextRefreshAt, NEXT_MONDAY);
});

test('manual and live sources are never asked', async () => {
    const entitlements = entitlementsWith({ has: false });
    for (const refreshMode of ['manual', 'live', 'after_meeting']) {
        assert.strictEqual(await scheduleLicensed({ ...SOURCE, refreshMode }, { kbStore, entitlements }), true);
    }
    assert.deepStrictEqual(entitlements.asked, []);
});

test('an unreadable plan or a vanished base keeps the schedule', async () => {
    assert.strictEqual(await scheduleLicensed(SOURCE, { kbStore, entitlements: entitlementsWith({ degraded: true }) }), true);
    assert.strictEqual(await scheduleLicensed({ ...SOURCE, knowledgeBaseId: 'gone' }, { kbStore, entitlements: entitlementsWith() }), true);
});
