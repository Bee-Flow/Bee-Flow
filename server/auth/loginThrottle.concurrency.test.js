/**
 * The throttle under PARALLEL load — the axis two rounds of testing missed.
 *
 * Round 3 shipped a progressive delay and measured it serially: one failed
 * sign-in cost 5.1s, forty cost 205s, and that looked like a working brake. It
 * was not one. A pentest fired eight requests AT ONCE and every one came back
 * in 0.67-1.42s — a 28x speed-up bought with nothing but sockets.
 *
 * The cause is that `await sleep(delayMs)` holds nothing. N handlers register N
 * independent timers that elapse simultaneously, so a batch costs max(delay)
 * and never sum(delay). A delay is a deterrent per request; it is not a rate
 * limit, and only a parallel test can tell the two apart.
 *
 * The same blind spot produced the second finding: 20 simultaneous attempts
 * against one username got 11 through against a threshold of 10, because
 * locking DELETES the failure counter (`del(kAcctFail)`) and every increment
 * landing after that delete restarts the ladder at 1.
 *
 * So every test here runs its attack with Promise.all. A serial version of any
 * of them would have passed against the code that shipped.
 *
 * Run: cd server && node --test auth/loginThrottle.concurrency.test.js
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const throttle = require('./loginThrottle');

// A public source address, so the per-IP half is live.
const publicReq = (ip = '203.0.113.9') => ({ ip, headers: {}, socket: { remoteAddress: ip } });
// What the app sees behind an ingress that does not forward the peer — the
// case that matters most, because it is production and it is where the
// hard block is deliberately withheld.
const proxiedReq = () => ({ ip: '10.42.0.7', headers: {}, socket: { remoteAddress: '10.42.0.7' } });

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
    throttle._resetMemory();
    for (const k of Object.keys(process.env)) {
        if (k.startsWith('LOGIN_')) delete process.env[k];
    }
    for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
        if (k.startsWith('LOGIN_')) process.env[k] = v;
    }
});

// ── The finding, directly ────────────────────────────────────────────

describe('parallel attempts cannot outrun the delay', () => {
    test('eight simultaneous failures pay eight costs, not one', async () => {
        process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = '10000';   // isolate the delay
        process.env.LOGIN_IP_DELAY_AFTER_FAILURES = '0';
        process.env.LOGIN_IP_DELAY_STEP_MS = '250';
        process.env.LOGIN_IP_DELAY_MAX_MS = '5000';
        process.env.LOGIN_QUEUE_MAX_MS = '600000';              // no overflow in this test
        const req = proxiedReq();

        const outcomes = await Promise.all(
            Array.from({ length: 8 }, (_, i) => throttle.recordLoginFailure(req, `victim${i}`)),
        );
        const waits = outcomes.map((o) => o.delayMs).sort((a, b) => a - b);

        // The shipped bug: every one of these was the SAME number, so the batch
        // finished in the time of a single request.
        const distinct = new Set(waits).size;
        assert.ok(distinct >= 7, `parallel failures must be queued, not overlapped (waits: ${waits})`);

        // The real property: the batch's wall-clock is the sum of its costs.
        // Any one request finishing early is fine; the LAST one is what bounds
        // the attacker's throughput.
        const total = waits.reduce((a, b) => a + b, 0);
        assert.ok(total > 3000, `eight failures must cost real time together, got ${total}ms`);
        assert.ok(waits.at(-1) > waits[0], 'the queue must stagger them');
    });

    test('parallel and serial cost the same — that is what makes it a rate limit', async () => {
        process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = '10000';
        process.env.LOGIN_IP_DELAY_AFTER_FAILURES = '0';
        process.env.LOGIN_IP_DELAY_STEP_MS = '250';
        process.env.LOGIN_IP_DELAY_MAX_MS = '5000';
        process.env.LOGIN_QUEUE_MAX_MS = '600000';

        const runParallel = async () => {
            throttle._resetMemory();
            const out = await Promise.all(
                Array.from({ length: 6 }, (_, i) => throttle.recordLoginFailure(proxiedReq(), `p${i}`)),
            );
            return Math.max(...out.map((o) => o.delayMs));
        };
        const runSerial = async () => {
            throttle._resetMemory();
            let last = 0;
            for (let i = 0; i < 6; i++) {
                last = (await throttle.recordLoginFailure(proxiedReq(), `s${i}`)).delayMs;
            }
            return last;
        };

        const parallel = await runParallel();
        const serial = await runSerial();
        // Serial calls are back-to-back in a test, so the horizons should land
        // within a few ms of each other. Before the fix, parallel was ~1/6th.
        assert.ok(Math.abs(parallel - serial) < 500,
            `firing at once must not be cheaper than firing in sequence (parallel ${parallel}ms vs serial ${serial}ms)`);
    });

    test('a source that floods past the ceiling is refused, not queued forever', async () => {
        process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = '10000';
        process.env.LOGIN_IP_DELAY_AFTER_FAILURES = '0';
        process.env.LOGIN_IP_DELAY_STEP_MS = '1000';
        process.env.LOGIN_IP_DELAY_MAX_MS = '5000';
        process.env.LOGIN_QUEUE_MAX_MS = '3000';
        const req = proxiedReq();

        const outcomes = await Promise.all(
            Array.from({ length: 20 }, (_, i) => throttle.recordLoginFailure(req, `flood${i}`)),
        );

        const refused = outcomes.filter((o) => o.locked);
        assert.ok(refused.length > 0, 'the queue must have a ceiling');
        // Refusal must be instant — holding the socket IS the exhaustion the
        // ceiling exists to prevent.
        for (const o of refused) {
            assert.strictEqual(o.delayMs, 0, 'a refused request must not also be made to wait');
            assert.ok(o.retryAfterSec > 0, 'and it must say when to come back');
        }
        for (const o of outcomes) {
            assert.ok(o.delayMs <= 3000, `no request may be parked beyond the ceiling, saw ${o.delayMs}ms`);
        }
    });

    test('a successful sign-in is never queued behind an attack', async () => {
        process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = '10000';
        process.env.LOGIN_IP_DELAY_AFTER_FAILURES = '0';
        process.env.LOGIN_IP_DELAY_STEP_MS = '1000';
        const req = proxiedReq();

        // An attack is in flight from the same (shared) address...
        await Promise.all(
            Array.from({ length: 10 }, (_, i) => throttle.recordLoginFailure(req, `noise${i}`)),
        );

        // ...and a real customer behind that same load balancer signs in.
        const before = Date.now();
        await throttle.recordLoginSuccess(req, 'real.customer');
        const gate = await throttle.checkLoginAllowed(req, 'real.customer');
        assert.ok(Date.now() - before < 200, 'a successful sign-in must not wait on anyone else');
        assert.strictEqual(gate.allowed, true, 'and it must not be refused either');
    });
});

// ── The counter reset ────────────────────────────────────────────────

describe('the lockout counter survives concurrency', () => {
    test('twenty simultaneous attempts do not get more than the threshold', async () => {
        process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = '10';
        process.env.LOGIN_THROTTLE_IP_ENABLED = 'false';   // isolate the account half
        const req = publicReq();

        const outcomes = await Promise.all(
            Array.from({ length: 20 }, () => throttle.recordLoginFailure(req, 'victim')),
        );

        // Before the fix: locking deleted the counter, so every increment that
        // landed afterwards restarted at 1, came in under the threshold, and
        // was answered as an ordinary failure. The pentest measured 11 through
        // against a threshold of 10, and the surplus was bounded only by how
        // much concurrency the attacker could muster.
        const allowed = outcomes.filter((o) => !o.locked).length;
        assert.ok(allowed <= 10,
            `at most the threshold may be answered as ordinary failures, ${allowed} were`);
    });

    test('once locked, a late-landing attempt is still refused', async () => {
        process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = '3';
        process.env.LOGIN_THROTTLE_IP_ENABLED = 'false';
        const req = publicReq();

        // Drive it into lockout.
        for (let i = 0; i < 3; i++) await throttle.recordLoginFailure(req, 'victim');

        // This is the request that was already past the entry gate when the
        // lock landed. Its increment starts a fresh counter at 1 — well under
        // the threshold — so only consulting the lock can refuse it.
        const late = await throttle.recordLoginFailure(req, 'victim');
        assert.strictEqual(late.locked, true, 'the lock, not the counter, is authoritative once set');
        assert.ok(late.retryAfterSec > 0);
    });

    test('the entry gate still refuses everything while the lock is live', async () => {
        process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = '3';
        process.env.LOGIN_THROTTLE_IP_ENABLED = 'false';
        const req = publicReq();
        for (let i = 0; i < 3; i++) await throttle.recordLoginFailure(req, 'victim');

        const gates = await Promise.all(
            Array.from({ length: 10 }, () => throttle.checkLoginAllowed(req, 'victim')),
        );
        assert.ok(gates.every((g) => !g.allowed), 'a live lock must refuse every concurrent arrival');
    });

    test('a different identifier from the same source is unaffected by the lock', async () => {
        process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = '3';
        process.env.LOGIN_THROTTLE_IP_ENABLED = 'false';
        const req = publicReq();
        for (let i = 0; i < 4; i++) await throttle.recordLoginFailure(req, 'victim');

        const other = await throttle.checkLoginAllowed(req, 'someone.else');
        assert.strictEqual(other.allowed, true,
            'locking one identifier must not lock the account next to it');
    });
});

// ── The reservation primitive ────────────────────────────────────────

describe('reserveDelaySlot', () => {
    test('the first caller finds an empty queue and is waved through', () => {
        const r = throttle.reserveDelaySlot('src', 1000);
        assert.strictEqual(r.waitMs, 0);
        assert.strictEqual(r.overflow, false);
    });

    test('each later caller waits for the one in front', () => {
        throttle.reserveDelaySlot('src', 1000);
        const second = throttle.reserveDelaySlot('src', 1000);
        const third = throttle.reserveDelaySlot('src', 1000);
        assert.ok(second.waitMs >= 900 && second.waitMs <= 1000, `got ${second.waitMs}`);
        assert.ok(third.waitMs >= 1900 && third.waitMs <= 2000, `got ${third.waitMs}`);
    });

    test('separate sources have separate queues', () => {
        throttle.reserveDelaySlot('a', 5000);
        throttle.reserveDelaySlot('a', 5000);
        const b = throttle.reserveDelaySlot('b', 5000);
        assert.strictEqual(b.waitMs, 0, 'one attacker must not slow down an unrelated address');
    });

    test('overflow does not extend the queue further', () => {
        process.env.LOGIN_QUEUE_MAX_MS = '2000';
        for (let i = 0; i < 5; i++) throttle.reserveDelaySlot('src', 1000);
        const overflowed = throttle.reserveDelaySlot('src', 1000);
        assert.strictEqual(overflowed.overflow, true);
        // A refused request must not push the horizon out for whoever comes
        // next — otherwise a flood makes the refusal permanent for everyone.
        const after = throttle.reserveDelaySlot('src', 1000);
        assert.strictEqual(after.overflow, true);
        assert.strictEqual(after.waitMs, 0);
    });

    test('a queue that has drained costs nothing again', () => {
        const r = throttle.reserveDelaySlot('src', 1);
        assert.strictEqual(r.waitMs, 0);
        // The timeline is in the past almost immediately, so the next caller
        // starts fresh rather than inheriting a stale horizon.
        return new Promise((resolve) => setTimeout(() => {
            assert.strictEqual(throttle.reserveDelaySlot('src', 1).waitMs, 0);
            resolve();
        }, 20));
    });
});
