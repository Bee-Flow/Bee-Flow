/**
 * Unit — PAYG outbox drain: circuit breaker lifecycle + hard-fail terminality.
 *
 * Pins two regressions:
 *   1. A failed half-open probe must RE-OPEN the breaker (it used to stay
 *      half-open forever, so a sustained Stripe outage was protected for
 *      exactly one 5-minute window and then hammered upstream with a full
 *      50-row batch on every 30s tick).
 *   2. A row past HARD_FAIL_DAYS must become terminal — the audit entry fires
 *      once, the row is never claimed again, and it stops crowding the
 *      `ORDER BY created_at LIMIT 50` batch out of deliverable rows.
 *
 * No Postgres: `../db` is swapped for an in-memory outbox that models the real
 * claim semantics (delivered_at IS NULL, the hard-fail sentinel, exponential
 * backoff on last_attempt_at, ORDER BY created_at, LIMIT n). Date.now is faked
 * so the 5-minute cool-down and 14-day age are reachable without sleeping.
 *
 * Run: node --test server/workers/paygDrain.test.js
 */

const assert = require('assert');
const test = require('node:test');
const { installResolveStub, evictModule } = require('../testUtils/stubRequire');

const DRAIN_PATH = './paygDrain';
const TICK_MS = 30_000;      // PAYG_DRAIN_TICK_INTERVAL_MS default
const DAY_MS = 86_400_000;

/**
 * Build a stubbed stack + a freshly-evaluated paygDrain bound to it.
 * @param {() => boolean} stripeFails whether the next Stripe call throws
 */
function makeStack(stripeFails = () => true) {
    const clock = { now: Date.parse('2026-08-01T00:00:00Z') };
    const realNow = Date.now;
    Date.now = () => clock.now;

    const state = { rows: [], stripeCalls: 0, audits: [], claims: [] };
    let nextId = 1;

    function enqueue({ ageMs = 0, attemptCount = 0 } = {}) {
        const row = {
            id: nextId, usage_log_id: nextId, stripe_customer_id: 'cus_test',
            event_name: 'payg_usage', amount_micro_units: 1000,
            identifier: `usage_${nextId}`, created_at: new Date(clock.now - ageMs),
            attempt_count: attemptCount, last_attempt_at: null, last_error: null,
            delivered_at: null,
        };
        nextId++;
        state.rows.push(row);
        return row;
    }

    function eligible(row, sql, params) {
        if (row.delivered_at) return false;
        const target = sql.match(/AND identifier = \$(\d+)/);
        if (target && row.identifier !== params[Number(target[1]) - 1]) return false;
        const terminal = sql.match(/last_error IS DISTINCT FROM \$(\d+)/);
        if (terminal && row.last_error === params[Number(terminal[1]) - 1]) return false;
        if (row.last_attempt_at === null) return true;
        const backoffMs = Math.pow(2, Math.min(row.attempt_count, 12)) * 1000;
        return row.last_attempt_at.getTime() < clock.now - backoffMs;
    }

    const db = {
        async getClient() {
            return {
                async query(sql, params = []) {
                    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
                    if (!sql.includes('FROM payg_meter_outbox')) return { rows: [] };
                    const limit = Number(sql.match(/LIMIT (\d+)/)[1]);
                    const rows = state.rows
                        .filter(r => eligible(r, sql, params))
                        .sort((a, b) => a.created_at - b.created_at)
                        .slice(0, limit)
                        .map(r => ({ ...r }));
                    state.claims.push({ limit, count: rows.length });
                    return { rows };
                },
                release() {},
            };
        },
        async run(sql, params = []) {
            const row = state.rows.find(r => r.id === params[params.length - 1]);
            if (!row) return { rowCount: 0 };
            if (sql.includes('delivered_at = NOW()')) {
                row.delivered_at = new Date(clock.now);
                row.last_error = null;
            } else if (sql.includes('attempt_count = attempt_count + 1')) {
                row.attempt_count += 1;
                row.last_attempt_at = new Date(clock.now);
                row.last_error = params[0];
            } else {                                   // hard-fail branch
                row.last_error = params[0];
                row.last_attempt_at = new Date(clock.now);
            }
            return { rowCount: 1 };
        },
        async getAll() { return []; },
        async getOne() { return null; },
        async exec() { return {}; },
    };

    const restoreStub = installResolveStub({
        '../db': db,
        '../services/stripeService': {
            async reportPaygUsage() {
                state.stripeCalls++;
                if (stripeFails()) throw new Error('stripe unavailable');
                return { ok: true };
            },
        },
        '../stores/userStore': {
            async logSubscriptionAudit(action, entity, entityId, ..._rest) {
                state.audits.push({ action, entityId });
                return {};
            },
        },
    });

    evictModule(require.resolve(DRAIN_PATH));
    const drain = require(DRAIN_PATH);
    drain.resetCircuit();

    // The breaker logs loudly on every trip/probe; keep the test output clean.
    const realConsole = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = () => {};

    return {
        drain, state, clock, enqueue,
        async tick(target = null) {
            const r = await (target ? drain.drainOne(target) : drain.drainOnce());
            clock.now += TICK_MS;
            return r;
        },
        restore() {
            Object.assign(console, realConsole);
            restoreStub();
            evictModule(require.resolve(DRAIN_PATH));
            Date.now = realNow;
        },
    };
}

test('failed half-open probe re-opens the breaker instead of leaving it half-open', async () => {
    const s = makeStack(() => true);
    try {
        for (let i = 0; i < 60; i++) s.enqueue({ ageMs: i * 1000 });

        await s.tick();                                        // trips: 50 failures
        assert.strictEqual(s.drain.getCircuitState().state, 'open');

        await s.tick();                                        // still cooling down
        assert.strictEqual(s.state.claims.length, 1, 'open breaker must not claim rows');

        s.clock.now += 5 * 60_000;                             // cool-down elapsed
        const callsBeforeProbe = s.state.stripeCalls;
        await s.tick();                                        // half-open probe, fails

        assert.strictEqual(s.drain.getCircuitState().state, 'open',
            'a failed probe must re-open the breaker, not leave it half-open');
        assert.strictEqual(s.state.stripeCalls - callsBeforeProbe, 1,
            'the probe must cost exactly one upstream call');
        assert.strictEqual(s.state.claims[s.state.claims.length - 1].limit, 1,
            'a probing breaker claims a single row, not a full batch');
    } finally { s.restore(); }
});

test('sustained outage stays rate-limited to one probe per cool-down window', async () => {
    const s = makeStack(() => true);
    try {
        for (let i = 0; i < 200; i++) s.enqueue({ ageMs: i * 1000 });

        for (let t = 0; t < (4 * 3600_000) / TICK_MS; t++) await s.tick();   // 4 hours

        // Pre-fix this ran 2800 calls with the breaker stuck half-open. The
        // bound is the initial 50-failure trip plus one probe per 5 minutes.
        assert.ok(s.state.stripeCalls <= 50 + (4 * 60) / 5 + 2,
            `expected a probe-rate-limited outage, got ${s.state.stripeCalls} Stripe calls`);
        assert.strictEqual(s.drain.getCircuitState().state, 'open');
        assert.strictEqual(s.state.audits.filter(a => a.action === 'payg_circuit_open').length, 1,
            'the closed->open edge alerts once; re-opens stay on the log');
    } finally { s.restore(); }
});

test('successful probe closes the breaker and the backlog drains', async () => {
    let down = true;
    const s = makeStack(() => down);
    try {
        for (let i = 0; i < 120; i++) s.enqueue({ ageMs: i * 1000 });

        for (let t = 0; t < 40; t++) await s.tick();          // outage
        assert.strictEqual(s.drain.getCircuitState().state, 'open');

        down = false;
        for (let t = 0; t < 60; t++) await s.tick();          // recovery
        assert.strictEqual(s.drain.getCircuitState().state, 'closed');
        assert.strictEqual(s.state.rows.filter(r => !r.delivered_at).length, 0,
            'every queued row must still reach Stripe once it recovers');
    } finally { s.restore(); }
});

test('a hard-failed row is audited once and never claimed again', async () => {
    const s = makeStack(() => false);
    try {
        const dead = s.enqueue({ ageMs: 20 * DAY_MS });
        const live = s.enqueue({ ageMs: 60_000 });

        const first = await s.tick();
        assert.strictEqual(first.hardFailed, 1);
        assert.strictEqual(first.delivered, 1, 'the deliverable row still goes out');

        for (let t = 0; t < 5; t++) {
            const r = await s.tick();
            assert.strictEqual(r.hardFailed, 0, 'the dead row must not be re-processed');
        }

        assert.strictEqual(s.state.audits.filter(a => a.action === 'payg_meter_hard_fail').length, 1,
            'hard-fail audit is one-time, not once per tick');
        assert.strictEqual(s.state.rows.find(r => r.id === dead.id).last_error,
            'hard_failed_after_14_days');
        assert.ok(s.state.rows.find(r => r.id === live.id).delivered_at);

        // The fast path must not resurrect it either.
        const viaFastPath = await s.tick(dead.identifier);
        assert.deepStrictEqual(viaFastPath, { delivered: 0, failed: 0, hardFailed: 0 });
    } finally { s.restore(); }
});

test('hard-failed rows stop crowding deliverable rows out of the batch', async () => {
    const s = makeStack(() => false);
    try {
        for (let i = 0; i < 60; i++) s.enqueue({ ageMs: 20 * DAY_MS + i * 1000 });   // dead, oldest
        const live = [];
        for (let i = 0; i < 10; i++) live.push(s.enqueue({ ageMs: 60_000 }));

        await s.tick();                                    // batch of 50 dead rows
        await s.tick();                                    // remaining 10 dead + live rows
        await s.tick();

        assert.strictEqual(live.filter(r => !s.state.rows.find(x => x.id === r.id).delivered_at).length, 0,
            'deliverable rows must reach Stripe once the dead head of the queue is terminal');
    } finally { s.restore(); }
});
