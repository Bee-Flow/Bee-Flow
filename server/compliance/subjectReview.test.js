/**
 * Subject review — the queue that turns "switched on at 09:05" into "judged at
 * 09:05" instead of "judged at 12:00, by the next sweep".
 *
 * What is under test is the queue's three promises, because each one is a
 * different way this could have hurt somebody:
 *
 *   - it never runs on the caller's turn        (activation must not wait)
 *   - five flips of one switch are one review   (a toggle must not be a sweep)
 *   - a compliance failure stays inside         (activation must not break)
 *
 * The runner is a double: what runs a check is runner.test.js's business, and
 * this file's is what gets asked of it and when.
 *
 * Run: node --test --test-force-exit server/compliance/subjectReview.test.js
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../testUtils/stubRequire');

// A debounce window short enough to wait out for real. The coalescing tests
// below MUST run on the real timers rather than on _drain(): _drain only sees
// what is in the queue's map, so a version that armed a timer per toggle and
// merely overwrote the map entry would look perfectly coalesced to it while
// five timers were still out there waiting to fire. Read once at module load,
// so it is set before the require.
process.env.COMPLIANCE_SUBJECT_REVIEW_DEBOUNCE_MS = '25';
const WINDOW_MS = 25;
const settle = () => new Promise(r => setTimeout(r, WINDOW_MS * 6));

let calls = [];
let behaviour = async () => [];

const fakeRunner = {
    runForSubject: async (orgId, subjectIds, opts) => {
        calls.push({ orgId, subjectIds, opts });
        return behaviour(orgId, subjectIds, opts);
    },
};

const restore = installResolveStub({ './runner': fakeRunner });
const subjectReview = require('./subjectReview');
after(() => { subjectReview._reset(); restore(); });

beforeEach(() => {
    calls = [];
    behaviour = async () => [];
    subjectReview._reset();
});

test('queueing a review does no compliance work on the caller\'s turn', async (t) => {
    // The debounce timer is frozen for this test. It used to race the real
    // clock: the assertion is "the 25ms window has not elapsed", and on a
    // loaded machine the setImmediate below lands after 25ms of wall time, the
    // review fires, and the test reports a product bug that is not there.
    // Freezing the clock states the property exactly — no work happens because
    // no time passes, not because we got there first.
    t.mock.timers.enable({ apis: ['setTimeout'] });

    subjectReview.reviewAutomation('org1', 'auto-1');
    assert.deepStrictEqual(calls, [], 'not synchronously');
    // A microtask boundary is all the activation handler has before it answers
    // the request — nothing may have happened by then either.
    await Promise.resolve();
    await new Promise(r => setImmediate(r));
    assert.deepStrictEqual(calls, [], 'and not on the next tick either — the user is not waiting for this');
    assert.strictEqual(subjectReview._armedCount(), 1, 'it is queued, though');
});

test('five flips of one switch are ONE review, not five', async () => {
    // The thing this prevents: someone toggling a routine while they fiddle
    // with it, and every click queueing its own run of the compliance checks.
    //
    // Deliberately waited out on the REAL clock instead of drained. A queue
    // that armed a fresh timer per toggle and just overwrote its map entry
    // would satisfy _drain() and still fire five reviews a moment later — the
    // orphaned timers are invisible to everything except time passing.
    for (let i = 0; i < 5; i++) subjectReview.reviewAutomation('org1', 'auto-1');
    assert.strictEqual(subjectReview._armedCount(), 1, 'one entry queued');
    await settle();
    assert.strictEqual(calls.length, 1, 'and exactly one review actually ran — no stragglers behind it');
});

test('a queued review fires on its own, without anyone draining it', async () => {
    // The whole point: nothing else in the request path is going to come back
    // and do this. If the timer never fires, the verdict waits for the
    // 6-hourly sweep again and this module has achieved nothing.
    subjectReview.reviewAutomation('org1', 'auto-1', { reason: 'activation' });
    await settle();
    assert.deepStrictEqual(calls.map(c => [c.orgId, c.subjectIds[0]]), [['org1', 'auto-1']]);
    assert.strictEqual(subjectReview._armedCount(), 0, 'and the queue empties itself');
});

test('a fresh toggle AFTER a review has run gets its own review', async () => {
    // Coalescing must not become "once per routine, ever": the queue entry has
    // to be released when it fires, or a routine reviewed at 09:05 would never
    // be looked at again for any later change.
    subjectReview.reviewAutomation('org1', 'auto-1');
    await settle();
    assert.strictEqual(calls.length, 1);
    subjectReview.reviewAutomation('org1', 'auto-1');
    await settle();
    assert.strictEqual(calls.length, 2);
});

test('the queue is per routine — a busy workspace still reviews each one', async () => {
    subjectReview.reviewAutomation('org1', 'auto-1');
    subjectReview.reviewAutomation('org1', 'auto-2');
    subjectReview.reviewAutomation('org2', 'auto-1');   // same id, different organisation
    assert.strictEqual(subjectReview._armedCount(), 3, 'coalescing is per (org, routine), never global');
    await subjectReview._drain();
    assert.deepStrictEqual(
        calls.map(c => [c.orgId, c.subjectIds[0]]).sort(),
        [['org1', 'auto-1'], ['org1', 'auto-2'], ['org2', 'auto-1']],
    );
});

test('the review asks under every spelling a check may hold the routine by', async () => {
    // Art. 50 holds a routine by its bare id; the Machinery check holds the
    // same routine as "automation:<id>". One spelling reviews half of what
    // applies to it and looks exactly like working.
    subjectReview.reviewAutomation('org1', 'auto-1');
    await subjectReview._drain();
    assert.deepStrictEqual(calls[0].subjectIds, ['auto-1', 'automation:auto-1']);
    assert.strictEqual(calls[0].opts.runType, 'event');
});

test('a compliance run that blows up never reaches the caller', async () => {
    behaviour = async () => { throw new Error('framework policy unreachable'); };
    subjectReview.reviewAutomation('org1', 'auto-1');
    // _drain awaits the review; if the failure escaped, this rejects and the
    // activation handler that queued it would have 500'd on a routine it had
    // already switched on.
    await subjectReview._drain();
    assert.strictEqual(calls.length, 1);
});

test('a runner that is missing or malformed is survived, not thrown', async () => {
    behaviour = async () => { const e = new TypeError('runner.runForSubject is not a function'); throw e; };
    subjectReview.reviewAutomation('org1', 'auto-1');
    await assert.doesNotReject(() => subjectReview._drain());
});

test('nonsense in never throws back out', () => {
    assert.doesNotThrow(() => subjectReview.reviewAutomation(null, 'auto-1'));
    assert.doesNotThrow(() => subjectReview.reviewAutomation('org1', null));
    assert.doesNotThrow(() => subjectReview.reviewAutomation('org1', '   '));
    assert.doesNotThrow(() => subjectReview.reviewAutomation(undefined, undefined));
    assert.strictEqual(subjectReview._armedCount(), 0, 'and queues nothing it cannot act on');
});

test('a toggle that lands DURING a review is re-queued, never swallowed', async () => {
    // The failure this guards: a review slower than the debounce window, with
    // a toggle arriving inside it. Drop that toggle and the routine's verdict
    // describes the state it was in before the last change — which is the
    // stale dashboard this whole module exists to end, just with a shorter
    // staleness.
    let release;
    const held = new Promise(r => { release = r; });
    behaviour = async () => { await held; return []; };

    subjectReview.reviewAutomation('org1', 'auto-1');
    const first = subjectReview._drain();          // enters the review and blocks on `held`
    await new Promise(r => setImmediate(r));
    assert.strictEqual(calls.length, 1);

    subjectReview.reviewAutomation('org1', 'auto-1');   // the toggle during the review
    const second = subjectReview._drain();              // its timer fires while the first still runs
    await new Promise(r => setImmediate(r));

    release();
    await first;
    await second;

    assert.strictEqual(subjectReview._armedCount(), 1, 'the toggle that arrived mid-review is queued again, not lost');
    behaviour = async () => [];
    await subjectReview._drain();
    assert.strictEqual(calls.length, 2, 'and it really does get its own review');
});

test('subjectSpellings is the single place the two id shapes are written down', () => {
    assert.deepStrictEqual(subjectReview.subjectSpellings('abc'), ['abc', 'automation:abc']);
    assert.deepStrictEqual(subjectReview.subjectSpellings(7), ['7', 'automation:7']);
});

// ── projects ─────────────────────────────────────────────────────────────

test('a project review asks for both spellings of the project and never collides with a routine of the same id', async () => {
    subjectReview.reviewProject('org1', 'x1', { reason: 'members' });
    subjectReview.reviewAutomation('org1', 'x1');
    assert.strictEqual(subjectReview._armedCount(), 2, 'a project and a routine sharing an id have separate slots');
    await subjectReview._drain();
    const asked = calls.map(c => c.subjectIds).sort((a, b) => a[0].localeCompare(b[0]));
    assert.deepStrictEqual(asked, [['project:x1', 'x1'], ['x1', 'automation:x1']]);
    assert.deepStrictEqual(subjectReview.projectSpellings('p9'), ['project:p9', 'p9']);
});

test('a failing project review stays inside the queue', async () => {
    behaviour = async () => { throw new Error('db down'); };
    subjectReview.reviewProject('org1', 'p1');
    await assert.doesNotReject(subjectReview._drain());
    subjectReview.reviewProject('', 'p1');
    subjectReview.reviewProject('org1', '  ');
    assert.strictEqual(subjectReview._armedCount(), 0);
});
