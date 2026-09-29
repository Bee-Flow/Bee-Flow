/**
 * The pentest sent 120 consecutive failed logins in about two seconds and got
 * 120 × 401 back — no 429, no lockout, no delay. These tests pin the controls
 * that replace that, and pin the two properties that make them safe to ship:
 *
 *   1. the throttle must not become a NEW enumeration oracle — a real account
 *      and an imaginary one have to behave identically;
 *   2. it must switch itself off when it cannot see a real client address,
 *      because behind an L4 load balancer without PROXY protocol every visitor
 *      shares one IP and a per-IP cap would lock out the whole platform.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const throttle = require('./loginThrottle');

// A public source address, so the per-IP half of the module is live.
const publicReq = (ip = '203.0.113.9') => ({ ip, headers: {}, socket: { remoteAddress: ip } });
// What the app actually sees behind an ingress that does not forward the peer.
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

describe('per-account failure counting', () => {
    test('a fresh identifier is allowed through', async () => {
        const r = await throttle.checkLoginAllowed(publicReq(), 'iemand');
        assert.strictEqual(r.allowed, true);
    });

    test('the cost of failing accumulates once failures pile up', async () => {
        const req = publicReq();
        const delays = [];
        for (let i = 0; i < 6; i++) {
            delays.push((await throttle.recordLoginFailure(req, 'iemand')).delayMs);
        }
        // The first few are free (delayAfter = 3).
        assert.strictEqual(delays[0], 0);
        assert.strictEqual(delays[2], 0);

        // From there the cost is charged as a QUEUE POSITION, not as a nap, so
        // the assertion is about the total and not about any single call. The
        // first request to cross the threshold finds an empty queue and is
        // waved through — that is what a rate limit does, and it is why this
        // used to be assertable per-call and no longer is. What matters is that
        // the caller cannot get N attempts for the price of one.
        const total = delays.reduce((a, b) => a + b, 0);
        assert.ok(total > 0, `six failures must cost something, got ${total}ms`);
        assert.ok(delays[5] > delays[3], 'and the cost must climb as failures pile up');
    });

    test('the identifier locks out after the configured number of failures', async () => {
        process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = '5';
        const req = publicReq();
        let last;
        for (let i = 0; i < 5; i++) last = await throttle.recordLoginFailure(req, 'iemand');
        assert.strictEqual(last.locked, true);
        assert.ok(last.retryAfterSec > 0);

        const gate = await throttle.checkLoginAllowed(req, 'iemand');
        assert.strictEqual(gate.allowed, false);
        assert.strictEqual(gate.scope, 'account');
        assert.ok(gate.retryAfterSec > 0);
    });

    test('lock durations escalate rather than handing out the same minute forever', async () => {
        process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = '2';
        const req = publicReq();

        await throttle.recordLoginFailure(req, 'iemand');
        const first = await throttle.recordLoginFailure(req, 'iemand');
        // Second round: the lock expired, they came back and failed again. The
        // lock HISTORY deliberately survives — that is what makes it escalate.
        await throttle.recordLoginFailure(req, 'iemand');
        const second = await throttle.recordLoginFailure(req, 'iemand');

        assert.strictEqual(first.locked, true);
        assert.strictEqual(second.locked, true);
        assert.ok(second.retryAfterSec > first.retryAfterSec,
            `expected escalation, got ${first.retryAfterSec}s then ${second.retryAfterSec}s`);
    });

    test('a success clears the failure counter', async () => {
        process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = '5';
        const req = publicReq();
        for (let i = 0; i < 4; i++) await throttle.recordLoginFailure(req, 'iemand');
        await throttle.recordLoginSuccess(req, 'iemand');
        // Back to zero: four more failures must not trip the fifth-failure lock.
        for (let i = 0; i < 4; i++) {
            const r = await throttle.recordLoginFailure(req, 'iemand');
            assert.strictEqual(r.locked, false);
        }
    });

    test('case and surrounding whitespace share one counter', async () => {
        process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = '3';
        const req = publicReq();
        await throttle.recordLoginFailure(req, 'Iemand');
        await throttle.recordLoginFailure(req, ' iemand ');
        const third = await throttle.recordLoginFailure(req, 'IEMAND');
        assert.strictEqual(third.locked, true, 'case variants must not multiply the attacker budget');
    });
});

describe('no new enumeration oracle', () => {
    test('a real and an imaginary identifier are throttled identically', async () => {
        process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = '4';
        const req = publicReq();

        const real = [];
        const fake = [];
        for (let i = 0; i < 4; i++) real.push(await throttle.recordLoginFailure(req, 'admin'));
        throttle._resetMemory();
        for (let i = 0; i < 4; i++) fake.push(await throttle.recordLoginFailure(req, 'nonexistent_zzz1'));

        // The module never learns which of these exists — it only ever sees the
        // submitted string — so the observable behaviour has to match exactly.
        assert.deepStrictEqual(
            real.map(r => [r.delayMs, r.locked]),
            fake.map(r => [r.delayMs, r.locked]),
        );
    });
});

describe('the per-IP backstop', () => {
    test('a public address is blocked after enough failures across many identifiers', async () => {
        process.env.LOGIN_MAX_FAILURES_PER_IP = '5';
        process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = '1000';   // isolate the IP half
        const req = publicReq();
        for (let i = 0; i < 5; i++) await throttle.recordLoginFailure(req, `spray_${i}`);

        const gate = await throttle.checkLoginAllowed(req, 'someone_new');
        assert.strictEqual(gate.allowed, false);
        assert.strictEqual(gate.scope, 'ip');
    });

    test('a private/proxy address is never BLOCKED — that is what would take the platform down', async () => {
        process.env.LOGIN_MAX_FAILURES_PER_IP = '3';
        process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = '1000';
        const req = proxiedReq();
        for (let i = 0; i < 20; i++) await throttle.recordLoginFailure(req, `spray_${i}`);

        const gate = await throttle.checkLoginAllowed(req, 'someone_new');
        assert.strictEqual(gate.allowed, true,
            'behind an L4 LB every visitor shares one private IP; blocking it takes the platform down');
    });

    // The first version of this module switched the per-IP half off entirely
    // for untrusted addresses. A retest then sprayed one password across forty
    // usernames from localhost and met nothing at all: per-account limits are
    // blind to breadth, and the breadth control had disabled itself.
    test('a private/proxy address spraying distinct identifiers still pays a delay', async () => {
        process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = '1000';   // never a per-account lock
        process.env.LOGIN_IP_DELAY_AFTER_IDENTIFIERS = '5';
        const req = proxiedReq();

        const delays = [];
        for (let i = 0; i < 12; i++) {
            delays.push((await throttle.recordLoginFailure(req, `victim_${i}`)).delayMs);
        }
        // Each identifier is touched once, so the per-account delay is zero
        // throughout — everything here comes from the breadth counter.
        assert.strictEqual(delays[0], 0, 'a handful of distinct failures is normal traffic');
        assert.ok(delays[11] > 0, `a spray must get slower; last delay was ${delays[11]}ms`);
        assert.ok(delays[11] > delays[6], 'and keep getting slower as it widens');
    });

    test('the breadth delay is capped, so a shared bucket can never hang a request', async () => {
        process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = '1000';
        process.env.LOGIN_IP_DELAY_MAX_MS = '1500';
        const req = proxiedReq();
        let last = 0;
        for (let i = 0; i < 200; i++) last = (await throttle.recordLoginFailure(req, `victim_${i}`)).delayMs;
        assert.ok(last <= 1500, `delay must be capped, got ${last}ms`);
    });

    test('account and source delays do not stack — the worse of the two applies', async () => {
        process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = '1000';
        process.env.LOGIN_DELAY_STEP_MS = '400';
        process.env.LOGIN_IP_DELAY_STEP_MS = '250';
        process.env.LOGIN_IP_DELAY_MAX_MS = '5000';
        const req = proxiedReq();

        // Hammer ONE identifier: both counters climb together, and both hit
        // their caps (account 2000, source 5000).
        const delays = [];
        for (let i = 0; i < 20; i++) {
            delays.push((await throttle.recordLoginFailure(req, 'iemand')).delayMs);
        }

        // The returned value is a queue POSITION, so it grows without bound as
        // failures pile up — that is the point. What must stay bounded is how
        // far each individual request advances the queue, and that is where
        // max-vs-sum actually lives: at the caps, a max() charges 5000 per
        // request and a sum would charge 7000. Calls are back-to-back here, so
        // the gap between consecutive positions is the per-request charge.
        const advance = delays.at(-1) - delays.at(-2);
        assert.ok(advance <= 6000,
            `each failure must cost max(account, source), not their sum (advanced ${advance}ms)`);
        assert.ok(advance > 0, 'and it must cost something once both thresholds are crossed');
    });

    test('the IP half can be switched off explicitly', async () => {
        process.env.LOGIN_THROTTLE_IP_ENABLED = 'false';
        process.env.LOGIN_MAX_FAILURES_PER_IP = '2';
        process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = '1000';
        const req = publicReq();
        for (let i = 0; i < 10; i++) await throttle.recordLoginFailure(req, `spray_${i}`);
        assert.strictEqual((await throttle.checkLoginAllowed(req, 'x')).allowed, true);
    });
});

describe('operational safety', () => {
    test('the whole module can be disabled', async () => {
        process.env.LOGIN_THROTTLE_ENABLED = 'false';
        const req = publicReq();
        for (let i = 0; i < 50; i++) await throttle.recordLoginFailure(req, 'iemand');
        assert.strictEqual((await throttle.checkLoginAllowed(req, 'iemand')).allowed, true);
    });

    test('clearIdentifier lifts a lock — the password-reset recovery path depends on it', async () => {
        process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = '2';
        const req = publicReq();
        await throttle.recordLoginFailure(req, 'iemand');
        await throttle.recordLoginFailure(req, 'iemand');
        assert.strictEqual((await throttle.checkLoginAllowed(req, 'iemand')).allowed, false);

        await throttle.clearIdentifier('iemand');
        assert.strictEqual((await throttle.checkLoginAllowed(req, 'iemand')).allowed, true);
    });

    test('a request with no resolvable identifier or IP does not throw', async () => {
        const bare = { headers: {}, socket: {} };
        assert.strictEqual((await throttle.checkLoginAllowed(bare, '')).allowed, true);
        const r = await throttle.recordLoginFailure(bare, '');
        assert.strictEqual(r.locked, false);
    });

    // A retest measured a deleted account at 1.28s and a live one at 0.06s and
    // read that as an existence oracle. It was neither — it was the progressive
    // backoff, which tracks how often an identifier has been PROBED. The floor
    // exists so that reading is impossible to make in the first place: every
    // failed sign-in takes the same minimum time whichever branch produced it.
    test('a failed sign-in is padded to a constant floor', async () => {
        process.env.LOGIN_MIN_RESPONSE_MS = '200';
        const fast = Date.now();
        await throttle.padFailureResponse(fast);
        assert.ok(Date.now() - fast >= 195, 'a fast path must be padded up to the floor');

        // A path that already took longer than the floor is not padded further.
        const slow = Date.now() - 500;
        const before = Date.now();
        await throttle.padFailureResponse(slow);
        assert.ok(Date.now() - before < 50, 'a slow path must not be padded twice');
    });

    test('the default floor clears the slowest bcrypt path', () => {
        // A floor only equalises what it exceeds. The config admin's hash is
        // cost 12 — ~233 ms of compare on modest hardware, ~327 ms end to end —
        // so a 250 ms floor left that one account name measurably slower than
        // every other failure, which is precisely the leak the floor exists to
        // remove. Measured live: admin 0.327 s vs 0.260–0.267 s for everything
        // else, before this was raised.
        delete process.env.LOGIN_MIN_RESPONSE_MS;
        assert.ok(
            throttle.CONFIG.minFailureResponseMs >= 400,
            `the floor must sit above a cost-12 compare, got ${throttle.CONFIG.minFailureResponseMs}ms`,
        );
    });

    test('the response floor can be switched off', async () => {
        process.env.LOGIN_MIN_RESPONSE_MS = '0';
        const before = Date.now();
        await throttle.padFailureResponse(before);
        assert.ok(Date.now() - before < 50);
    });

    test('denyLogin sends a 429 with Retry-After and no hint about the account', () => {
        const sent = {};
        const res = {
            set: (k, v) => { sent.headers = { ...(sent.headers || {}), [k]: v }; },
            status(code) { sent.status = code; return this; },
            json(body) { sent.body = body; return this; },
        };
        throttle.denyLogin(res, 42);
        assert.strictEqual(sent.status, 429);
        assert.strictEqual(sent.headers['Retry-After'], '42');
        assert.strictEqual(sent.body.code, 'too_many_attempts');
        assert.ok(!/exist|unknown|user/i.test(sent.body.error), 'the 429 must not describe the account');
    });
});

// ── Spoofed forwarding ───────────────────────────────────────────────
// The API port is bound to loopback and sits behind nginx, which APPENDS the
// real peer via $proxy_add_x_forwarded_for — so a forwarded address arriving
// over a non-loopback connection was written by our own proxy and is worth
// acting on. A forwarded address arriving over LOOPBACK is a claim by whoever
// reached the port directly, and acting on it would let them park a block on
// somebody else's IP.
describe('forwarded source addresses', () => {
    // Through nginx: peer is the container bridge address, not loopback.
    const behindNginx = (claimed) => ({
        ip: claimed, headers: {}, socket: { remoteAddress: '172.18.0.5' },
    });
    // Straight at the API port: peer is loopback, header is the caller's own.
    const directToPort = (claimed) => ({
        ip: claimed, headers: {}, socket: { remoteAddress: '127.0.0.1' },
    });

    test('a proxied public address can still be blocked outright', async () => {
        process.env.LOGIN_MAX_FAILURES_PER_IP = '3';
        let locked = false;
        for (let i = 0; i < 4; i++) {
            locked = (await throttle.recordLoginFailure(behindNginx('198.51.100.7'), `u${i}`)).locked || locked;
        }
        assert.ok(locked, 'production sits behind a proxy — the hard block must survive');
    });

    test('an address claimed over a loopback connection is never blocked', async () => {
        process.env.LOGIN_MAX_FAILURES_PER_IP = '3';
        let locked = false;
        const delays = [];
        for (let i = 0; i < 8; i++) {
            const r = await throttle.recordLoginFailure(directToPort('198.51.100.7'), `u${i}`);
            locked = locked || r.locked;
            delays.push(r.delayMs);
        }
        assert.ok(!locked, 'a spoofable header must not be able to park a block on a victim IP');
        assert.ok(delays.at(-1) > 0, 'it must still cost the caller time');
    });
});

// ── Fan-out across distinct targets ──────────────────────────────────
// The per-target cap stops one mailbox being flooded; this stops one source
// walking a list of addresses, which is what a retest did 40 times for free.
describe('fan-out breadth control', () => {
    test('the first few distinct targets are free, then the cost climbs', async () => {
        const req = proxiedReq();
        const delays = [];
        for (let i = 0; i < 10; i++) {
            delays.push((await throttle.recordFanOut(req, 'forgot', `victim${i}@example.com`)).delayMs);
        }
        assert.strictEqual(delays[0], 0, 'an ordinary reset request pays nothing');
        assert.strictEqual(delays[4], 0);
        assert.ok(delays[6] > 0, `expected a delay by the 7th distinct address, got ${delays[6]}`);
        assert.ok(delays.at(-1) > delays[6], 'and it must keep climbing');
    });

    test('it runs even when the source address is untrustworthy', async () => {
        // The whole point: this is the case where the per-IP limiter stands
        // aside, which is how 40 addresses went through unbounded.
        const req = proxiedReq();
        for (let i = 0; i < 12; i++) await throttle.recordFanOut(req, 'forgot', `v${i}@example.com`);
        const r = await throttle.recordFanOut(req, 'forgot', 'one-more@example.com');
        assert.ok(r.delayMs > 0);
    });

    test('hammering ONE address is not fan-out — that is the per-target limiter\'s job', async () => {
        const req = proxiedReq();
        let last = 0;
        for (let i = 0; i < 20; i++) {
            last = (await throttle.recordFanOut(req, 'forgot', 'same@example.com')).delayMs;
        }
        assert.strictEqual(last, 0, 'one distinct target must never accumulate a fan-out delay');
    });

    test('namespaces do not bleed into each other', async () => {
        const req = proxiedReq();
        for (let i = 0; i < 12; i++) await throttle.recordFanOut(req, 'forgot', `v${i}@example.com`);
        const other = await throttle.recordFanOut(req, 'resend', 'first@example.com');
        assert.strictEqual(other.delayMs, 0, 'a different route starts with its own budget');
    });

    test('the target is normalised, so case and padding are one address', async () => {
        const req = proxiedReq();
        const seen = [];
        for (const form of ['Ann@Example.com ', ' ann@example.com', 'ANN@EXAMPLE.COM']) {
            seen.push((await throttle.recordFanOut(req, 'forgot', form)).distinct);
        }
        assert.deepStrictEqual(seen, [1, 1, 1], 'one address counted once');
    });

    test('a missing target is ignored rather than counted as a distinct one', async () => {
        const req = proxiedReq();
        for (let i = 0; i < 10; i++) await throttle.recordFanOut(req, 'forgot', '');
        const r = await throttle.recordFanOut(req, 'forgot', 'real@example.com');
        assert.strictEqual(r.delayMs, 0);
    });
});
