/**
 * When a mirror needs another look, for every kind: the one schedule (live),
 * the backoff, the stale rules, and a kick that is one per mirror id whatever
 * kind asked — the `_kicks` map is shared.
 *
 * Run: cd server && node --test core/dataEngine/sources/mirror/staleness.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../../../testUtils/stubRequire');

const world = { fresh: null, synced: [] };
const restore = installResolveStub({
    '../../../../stores/datatableStore': { getDatatable: async () => world.fresh },
});
const staleness = require('./staleness');
test.after(() => restore());
test.beforeEach(() => { world.fresh = null; world.synced.length = 0; for (const t of staleness._kicks.values()) clearTimeout(t); staleness._kicks.clear(); });

test('there is one schedule — live: a minute in the background, five seconds while watched', () => {
    const now = Date.parse('2026-09-13T10:00:00Z');
    assert.deepEqual(staleness.scheduleOf({ schedule: { everyMinutes: 1440 } }), { everyMinutes: 1, live: true });
    assert.deepEqual(staleness.scheduleOf(), { everyMinutes: 1, live: true });
    assert.equal(staleness.nextRunAtFor({ everyMinutes: 1440 }, now, 0), '2026-09-13T10:01:00.000Z');
    assert.equal(staleness.nextRunAtFor({ everyMinutes: 0 }, now, 0), '2026-09-13T10:01:00.000Z');
    // three errors in a row: 1 min × 2³ = 8 min
    assert.equal(staleness.nextRunAtFor({}, now, 3), '2026-09-13T10:08:00.000Z');
});

test('isStale: never refreshed, marked, or older than five seconds; never while running or when opted out', () => {
    const src = { refreshOnView: true };
    const now = Date.parse('2026-09-13T10:00:00Z');
    assert.equal(staleness.isStale(null, src, now), true);
    assert.equal(staleness.isStale({ lastSuccessAt: '2026-09-13T09:59:57Z' }, src, now), false);
    assert.equal(staleness.isStale({ lastSuccessAt: '2026-09-13T09:59:54Z' }, src, now), true);
    assert.equal(staleness.isStale({ lastSuccessAt: '2026-09-13T09:59:59Z', staleReason: 'write' }, src, now), true);
    assert.equal(staleness.isStale({ lastSuccessAt: 'garbage' }, src, now), true);
    assert.equal(staleness.isStale({ lastSuccessAt: '2026-09-13T09:00:00Z', status: 'running' }, src, now), false);
    assert.equal(staleness.isStale(null, { ...src, refreshOnView: false }, now), false);
});

test('kickStale: only its own kind, only when stale, one pending kick per mirror across kinds, re-checked fresh before running', async () => {
    const kickA = staleness.makeKickStale({ syncRows: async (t, o) => { world.synced.push(['A', t.id, o.reason]); }, isMirror: (t) => t.managedKind === 'a', TAG: '[A]' });
    const kickB = staleness.makeKickStale({ syncRows: async (t, o) => { world.synced.push(['B', t.id, o.reason]); }, isMirror: (t) => t.managedKind === 'b', TAG: '[B]' });
    const stale = { id: 'tbl_1', managedKind: 'a', scope: { kind: 'org', id: 'o' }, syncState: null, source: {} };
    assert.equal(kickB(stale), false, 'not B\'s kind');
    assert.equal(kickA({ ...stale, syncState: { lastSuccessAt: new Date().toISOString() } }), false, 'fresh enough');
    assert.equal(kickA(stale, { reason: 'view', delayMs: 1 }), true);
    assert.equal(kickA(stale, { reason: 'view', delayMs: 1 }), true, 'a second kick joins the pending one');
    assert.equal(staleness._kicks.size, 1);
    // The fresh row is re-read: still stale → a pass; already refreshed → nothing.
    world.fresh = stale;
    await new Promise(r => setTimeout(r, 15));
    assert.deepEqual(world.synced, [['A', 'tbl_1', 'view']]);
    assert.equal(staleness._kicks.size, 0);
    world.fresh = { ...stale, syncState: { lastSuccessAt: new Date().toISOString() } };
    kickA(stale, { reason: 'live', delayMs: 1 });
    await new Promise(r => setTimeout(r, 15));
    assert.deepEqual(world.synced, [['A', 'tbl_1', 'view']], 'nothing ran: somebody else refreshed it meanwhile');
});
