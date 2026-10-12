/**
 * BFSF-433 — the boot kickoffs must be the SAME wrapped ticks as the intervals.
 *
 * start() mounts seven setInterval ticks, each wrapped as
 * nonOverlapping(moduleGatedTick(<module>, fn, name), name). Three of them also
 * get a one-shot kickoff so a freshly-booted pod does not sit idle for a whole
 * period before doing anything — and for retention a "period" is an HOUR, so on
 * a short-lived replica that 60s timeout is the ONLY retention pass that ever
 * runs.
 *
 * Those kickoffs used to be wired to the raw functions. Two consequences, both
 * only visible on a real install:
 *
 *   1. Ungated. boot/startupTasks.js starts the runner off the DEPLOY-TIME
 *      catalog flag (isModuleAvailable), so on an instance where an admin had
 *      switched Automations OFF in the Modules panel — the RUNTIME row that
 *      moduleGatedTick reads — every restart still fired one burst of work for
 *      a module that is supposed to behave as if it isn't installed. Including
 *      processRunRetention, which DELETEs for real.
 *   2. Not serialised with the interval, and not cancellable. nonOverlapping()
 *      closes over one `inFlight` flag per wrapper, so a raw kickoff (or a
 *      second wrapper around it) can run on top of the interval it shares work
 *      with; and a handle nobody kept cannot be cleared, so a SIGTERM inside
 *      the first minute could not stop the pending retention sweep.
 *
 * The fix is one local per tick, used for both timers. Assertion 2 below is the
 * whole bug in one line: every setTimeout callback must be reference-identical
 * to one of the setInterval callbacks. Everything after it guards what identity
 * alone doesn't prove — that the gate is really consulted, that the kickoffs
 * still do their work when the module IS active, that the shared reference
 * really shares one inFlight flag, and that stop() can cancel them.
 *
 * Run: node --test --test-force-exit core/automationRunner/scheduler/ticks.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

// ── Stubs, installed BEFORE the first require of ticks.js ───────────────
//
// ticks.js pulls in ../engine and ../../../stores/automationStore at require
// time (and destructures moduleGatedTick off ../../../modules on the same
// pass), which would open Postgres sockets in a unit test. Same require.cache
// idiom as execWait.test.js / automationRunner.test.js. The paths are relative
// to THIS file, which sits in the same directory as ticks.js, so they read
// exactly like the ones in the module under test.
function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// What the ticks actually touch, one counter each, so "did this pass reach its
// work?" is a number and not an inference.
const calls = { claimDue: 0, connect: 0, reapStuck: 0, reapOrphan: 0, flushEgress: 0 };
// Swappable so the overlap test can make the due tick hang mid-flight.
let claimDueImpl = async () => [];

mock('../../../stores/automationStore', {
    claimDueAutomations: async (...a) => { calls.claimDue += 1; return claimDueImpl(...a); },
    releaseAutomation: async () => {},
    updateAutomation: async () => {},
    deleteExpiredFormSessions: async () => 0,
});
// pool.connect has to be real enough to matter: with `{ pool: {} }` an ACTIVE
// retention kickoff throws a TypeError on pool.connect() which its own catch
// swallows — the "it reached the work" assertion would then pass while proving
// nothing. Returning locked:false lets the pass get as far as the advisory-lock
// check and stop there, which is exactly the observable we want.
mock('../../../db', {
    pool: {
        connect: async () => {
            calls.connect += 1;
            return { query: async () => ({ rows: [{ locked: false }] }), release() {} };
        },
    },
});
mock('../engine', { INSTANCE_ID: 'runner-test' });
mock('../execution', { executeAutomation: async () => ({}) });
mock('../cancellation', { ACTIVE_RUNS: new Map() });
mock('../../../automation/cron', { nextRunAt: () => null });
mock('./reapers', {
    reapStuckAutomations: async () => { calls.reapStuck += 1; },
    reapOrphanFormUploads: async () => { calls.reapOrphan += 1; },
    reapExpiredGeneratedFiles: async () => {},
    reapStuckTranscriptions: async () => {},
});
// stop() flushes the detached egress rows before the process goes.
mock('../../integrations/integrationLogging', { flushEgressLogs: async () => { calls.flushEgress += 1; } });

// A stand-in for the real gate with the same contract (pinned in
// modules/moduleGatedTick.test.js): consult state, no-op when inactive, pass
// arguments through when active. `moduleActive` is read per invocation, not
// captured at wrap time, so a test can flip it long after start() has run.
let moduleActive = true;
const gateConsulted = [];
mock('../../../modules', {
    moduleGatedTick(moduleId, fn, name = fn.name || 'tick') {
        return async function moduleGatedTickInner(...args) {
            gateConsulted.push({ moduleId, name });
            if (!moduleActive) return undefined;
            return fn(...args);
        };
    },
});

// ── Capture what start() mounts ─────────────────────────────────────────
//
// start() has no await before its last timer call, so the body runs to
// completion synchronously and the globals can go back immediately after.
// Note that start() calls .unref() NON-optionally on each interval handle and
// pushes its RETURN value, so the fake has to provide unref() and return itself
// the way Node's Timeout does.
const intervals = [];
const timeouts = [];
const realSetInterval = globalThis.setInterval;
const realSetTimeout = globalThis.setTimeout;

function fakeHandle(kind, index) {
    return { kind, index, unref() { return this; } };
}

globalThis.setInterval = (callback, delay) => {
    const h = fakeHandle('interval', intervals.length);
    intervals.push({ callback, delay, handle: h });
    return h;
};
globalThis.setTimeout = (callback, delay) => {
    const h = fakeHandle('timeout', timeouts.length);
    timeouts.push({ callback, delay, handle: h });
    return h;
};

const ticks = require('./ticks');
let startError = null;
try {
    ticks.start();
} catch (e) {
    startError = e;
} finally {
    globalThis.setInterval = realSetInterval;
    globalThis.setTimeout = realSetTimeout;
}

test('start() mounted the ten ticks and the four boot kickoffs', () => {
    assert.strictEqual(startError, null, startError && startError.stack);
    // Nine since handoff 5: the notification digest (throttle bundles and the
    // daily summary) has its own five-minute tick and lock.
    assert.strictEqual(intervals.length, 10, 'expected ten setInterval ticks');
    assert.strictEqual(timeouts.length, 4, 'expected four one-shot boot kickoffs');
    assert.deepStrictEqual(timeouts.map(t => t.delay), [10_000, 15_000, 60_000, 90_000]);
});

test('BFSF-433: every boot kickoff IS one of the mounted interval ticks', () => {
    // Reference identity is the entire fix. A kickoff that merely "looks the
    // same" — a fresh nonOverlapping(moduleGatedTick(...)) built for the
    // timeout — would satisfy the gate and still race the interval, because
    // every nonOverlapping() call allocates its own inFlight flag.
    const intervalCallbacks = intervals.map(i => i.callback);
    const shared = timeouts.map(t => intervalCallbacks.includes(t.callback));
    assert.deepStrictEqual(
        shared, [true, true, true, true],
        'a boot kickoff is wired to something other than the wrapped interval tick '
        + '(before the fix this is [false, false, false] — the raw functions)',
    );
});

test('an INACTIVE module: the kickoffs consult the gate and then do nothing', async () => {
    moduleActive = false;
    gateConsulted.length = 0;
    const before = { ...calls };
    for (const t of timeouts) await t.callback();
    // THREE of the four consult the gate. The fourth — datatable row retention
    // — deliberately does not, and that exception is the point rather than an
    // oversight: a module gate re-reads the runtime row on every invocation, so
    // switching Automations off (or letting a licence lapse) would stop DELETING
    // rows while the personal data stayed and the Studio kept promising
    // "deleted after N days". A retention obligation is not a billable feature.
    // See the header of jobs/datatableRetention.js.
    assert.deepStrictEqual(
        gateConsulted.map(g => g.moduleId), ['automation', 'automation', 'automation'],
        'the module-gated kickoffs did not go through the module gate at all',
    );
    assert.strictEqual(calls.claimDue, before.claimDue, 'the due-tick kickoff claimed work for an inactive module');
    assert.strictEqual(calls.reapStuck, before.reapStuck, 'the reaper kickoff ran for an inactive module');
    // One connect: the datatable-retention kickoff reaching its advisory lock.
    // The run-history retention kickoff must NOT have added a second.
    assert.strictEqual(calls.connect, before.connect + 1,
        'expected exactly the ungated datatable-retention kickoff to reach the pool; '
        + 'a different count means either it was gated after all, or the run-history '
        + 'retention kickoff — which DELETEs — ran for an inactive module');
});

test('an ACTIVE module: the same kickoffs still reach their work', async () => {
    // The gate must not become an excuse to delete the kickoffs.
    // RETENTION_INTERVAL_MS is an hour, so the 60s kickoff is the only
    // retention pass a short-lived pod ever gets; losing it would quietly stop
    // retention on every frequently-restarting deployment.
    moduleActive = true;
    const before = { ...calls };
    for (const t of timeouts) await t.callback();
    assert.strictEqual(calls.claimDue, before.claimDue + 1, 'the due-tick kickoff did not claim due automations');
    assert.strictEqual(calls.reapStuck, before.reapStuck + 1, 'the reaper kickoff did not run');
    // Two now: run-history retention and datatable row retention, each taking
    // its own advisory lock.
    assert.strictEqual(calls.connect, before.connect + 2, 'a retention kickoff never reached the advisory-lock check');
});

test('kickoff and interval share ONE inFlight flag — the second call is skipped', async () => {
    moduleActive = true;
    let release;
    const hanging = new Promise((resolve) => { release = resolve; });
    claimDueImpl = async () => { await hanging; return []; };
    const before = calls.claimDue;

    // The kickoff goes first and stalls inside claimDueAutomations…
    const kickoff = timeouts[0].callback();
    await new Promise(r => setImmediate(r));
    assert.strictEqual(calls.claimDue, before + 1, 'the kickoff never entered the work');

    // …and the 60s interval firing on top of it must be dropped, not queued.
    // This only holds because both timers hold the same wrapper closure.
    const overlapping = await intervals[0].callback();
    assert.strictEqual(overlapping, undefined);
    assert.strictEqual(calls.claimDue, before + 1, 'the overlapping tick was NOT skipped — two passes claimed rows at once');

    release();
    await kickoff;
    claimDueImpl = async () => [];
});

// Keep this LAST. stop() flips the module-level `stopping` flag permanently,
// after which processDueAutomations returns before doing anything — every test
// above would go green for the wrong reason if this one ran first.
test('stop() cancels the pending kickoffs, not just the intervals', async () => {
    const cleared = [];
    const realClearInterval = globalThis.clearInterval;
    const realClearTimeout = globalThis.clearTimeout;
    globalThis.clearInterval = (h) => { cleared.push(h); };
    globalThis.clearTimeout = (h) => { cleared.push(h); };
    try {
        await ticks.stop({ timeoutMs: 0 });
    } finally {
        globalThis.clearInterval = realClearInterval;
        globalThis.clearTimeout = realClearTimeout;
    }
    for (const t of timeouts) {
        assert.ok(
            cleared.includes(t.handle),
            `the ${t.delay}ms boot kickoff was never pushed to _tickHandles, so a SIGTERM inside `
            + 'the first minute cannot cancel it (clearInterval is an alias for clearTimeout)',
        );
    }
    for (const i of intervals) assert.ok(cleared.includes(i.handle), 'an interval handle went untracked');
    assert.strictEqual(cleared.length, 14, 'expected all ten intervals and all four kickoffs to be cleared');
    assert.strictEqual(calls.flushEgress, 1, 'stop() did not flush the detached egress logs');
});
