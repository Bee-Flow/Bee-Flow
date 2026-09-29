'use strict';

/**
 * W1/FIX2 — POST /_schedule/preview was the one run-ish route in this file
 * with NO rate limiter, and it called cron.nextRunAt up to 20 times per
 * request. With the old minute-by-minute scan that was ~527k
 * Intl.DateTimeFormat.formatToParts calls per preview: a single request for
 * "0 0 1 1 *" with count=20 blocked the Node event loop for ~64 seconds, so
 * every other request in the process — health checks included — stalled.
 *
 * Guards here:
 *   - the route carries the SAME runTriggerLimiter as /:id/run & friends
 *   - `count` is capped at 5
 *   - the preview is fast (fails loudly if the O(minutes) scan returns)
 *   - consecutive previews are one minute apart, not two
 *
 * Route handler invoked directly — same harness as crud.subscriptionResync.js.
 *
 * Run: node --test routes/automation/runs.schedulePreview.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const SERVER = path.resolve(__dirname, '..', '..');
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

// cron is deliberately NOT mocked — the preview must be bit-exact with what
// the scheduler would actually fire, so the real implementation is under test.
mock(path.join(SERVER, 'stores/automationStore'), {
    getAutomation: async () => null,
    getRunSteps: async () => [],
    listRunsForUser: async () => ({ runs: [], nextCursor: null }),
});
mock(path.join(SERVER, 'automation/deliverableEvents'), {
    getDeliverableEvents: () => ({ nextcloud: new Set() }),
    isPushPending: () => false,
});
mock(path.join(SERVER, 'automation/triggerBus'), {
    loadSession: async () => null,
    fetchLatestGmailMatch: async () => null,
    fetchLatestNextcloudMatch: async () => null,
});
const limiters = [];
mock(path.join(SERVER, 'utils/perUserRateLimit'), {
    perUserRateLimit: (opts) => {
        const mw = (req, res, next) => next();
        mw.__opts = opts;
        limiters.push(mw);
        return mw;
    },
});

const runsRouter = require('./runs');

function findRoute(router, method, routePath) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === routePath && layer.route.methods[method]) return layer.route;
    }
    throw new Error(`route not found: ${method} ${routePath}`);
}

function makeRes() {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}


/**
 * A route's WHOLE stack, not only its handler: `validate` sits in front of
 * these now, and a schema refusal leaves as an error rather than as a
 * response — so the terminal handler has to be here too, or a 400 reads as a
 * crashed test.
 */
function runStack(handles) {
    return async (req, res) => {
        for (const handle of handles) {
            const step = await new Promise((resolve, reject) => {
                let settled = false;
                const done = (v) => { if (!settled) { settled = true; resolve(v); } };
                try {
                    Promise.resolve(handle(req, res, (err) => done({ passed: true, err })))
                        .then(() => done({ passed: false }), reject);
                } catch (e) { reject(e); }
            });
            if (!step.passed) return res;
            if (step.err) {
                require(path.join(SERVER, 'core/http/terminalErrorHandler')).terminalErrorHandler(step.err, req, res, () => {});
                return res;
            }
        }
        return res;
    };
}

const previewRoute = findRoute(runsRouter, 'post', '/_schedule/preview');
const previewHandler = runStack(previewRoute.stack.map(l => l.handle));

async function preview(body) {
    const req = {
        method: 'POST', url: '/_schedule/preview', path: '/_schedule/preview',
        body, query: {}, headers: {}, session: { user: { id: 'user1' } },
    };
    const res = makeRes();
    await previewHandler(req, res);
    return res;
}

test('the preview route is behind the same limiter as the run routes', () => {
    assert.strictEqual(limiters.length, 1, 'runs.js builds exactly one run-trigger limiter');
    const runRoute = findRoute(runsRouter, 'post', '/:id/run');
    const guardOf = (route) => route.stack.some(l => l.handle === limiters[0]);
    assert.ok(guardOf(runRoute), 'sanity: /:id/run is limited');
    assert.ok(guardOf(previewRoute), '/_schedule/preview must be rate limited too');
});

test('count is capped at 5 (was 20)', async () => {
    const res = await preview({ cron: '*/5 * * * *', tz: 'UTC', count: 20 });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.valid, true);
    assert.strictEqual(res.body.next.length, 5);
});

test('count defaults to 3 and stays >= 1', async () => {
    assert.strictEqual((await preview({ cron: '*/5 * * * *', tz: 'UTC' })).body.next.length, 3);
    assert.strictEqual((await preview({ cron: '*/5 * * * *', tz: 'UTC', count: 0 })).body.next.length, 3);
    assert.strictEqual((await preview({ cron: '*/5 * * * *', tz: 'UTC', count: -4 })).body.next.length, 1);
});

test('a sparse cron previews in milliseconds, not a minute of blocked event loop', async () => {
    const t0 = Date.now();
    const res = await preview({ cron: '0 0 1 1 *', tz: 'Europe/Amsterdam', count: 5 });
    const elapsed = Date.now() - t0;
    assert.strictEqual(res.body.valid, true);
    assert.ok(res.body.next.length >= 1);
    assert.ok(elapsed < 1000, `preview of "0 0 1 1 *" took ${elapsed}ms — the minute-by-minute scan is back`);
});

test('consecutive previews of an every-minute cron are one minute apart', async () => {
    // The cursor used to be advanced by 60s ON TOP of nextRunAt's own round-up
    // to the next whole minute, so "every minute" previewed as every 2 minutes.
    const { next } = (await preview({ cron: '* * * * *', tz: 'UTC', count: 5 })).body;
    assert.strictEqual(next.length, 5);
    for (let i = 1; i < next.length; i++) {
        assert.strictEqual(Date.parse(next[i]) - Date.parse(next[i - 1]), 60_000,
            `gap ${i}: ${next[i - 1]} → ${next[i]}`);
    }
});

test('an unparseable cron answers valid:false instead of throwing', async () => {
    const res = await preview({ cron: 'not a cron', tz: 'UTC' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.valid, false);
    assert.ok(res.body.error);
});

test('a missing cron is a 400 that names the field, in a sentence', async () => {
    // An UNPARSEABLE cron is still a 200 with `valid: false` — that is the
    // preview answering the question it was asked. A cron that is not there
    // at all is a malformed request, and says so.
    const res = await preview({ tz: 'UTC' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A cron expression is required — the schedule to preview.');
    assert.ok(res.body.details.some(d => d.path === 'body.cron'));
});

test('a cron with no upcoming run previews as an empty list', async () => {
    const res = await preview({ cron: '0 0 31 2 *', tz: 'UTC', count: 3 });
    assert.strictEqual(res.body.valid, true);
    assert.deepStrictEqual(res.body.next, []);
});

// ── skipHolidays (handoff 5) ────────────────────────────────────────
// The clock is pinned: which holidays a preview meets depends on "now".

test('skipHolidays leaves Koningsdag out of a weekday preview and names it', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-04-24T12:00:00Z') });
    const plain = await preview({ cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam', count: 2 });
    assert.deepStrictEqual(plain.body.next, ['2026-04-27T05:00:00.000Z', '2026-04-28T05:00:00.000Z']);
    assert.strictEqual(plain.body.skipHolidays, false);
    assert.deepStrictEqual(plain.body.skipped, []);

    const res = await preview({ cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam', count: 2, skipHolidays: true });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.valid, true);
    assert.strictEqual(res.body.skipHolidays, true);
    assert.deepStrictEqual(res.body.next, ['2026-04-28T05:00:00.000Z', '2026-04-29T05:00:00.000Z']);
    assert.deepStrictEqual(res.body.skipped, [{ date: '2026-04-27', key: 'kings_day', name: "King's Day" }]);
});

test('skipHolidays over Easter skips both days of a daily schedule', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-04-04T12:00:00Z') });
    const res = await preview({ cron: '0 9 * * *', tz: 'Europe/Amsterdam', count: 1, skipHolidays: true });
    assert.deepStrictEqual(res.body.next, ['2026-04-07T07:00:00.000Z']);
    assert.deepStrictEqual(res.body.skipped.map(h => h.key), ['easter_sunday', 'easter_monday']);
});

test('a schedule that only fires on holidays previews empty and says why', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-06-01T00:00:00Z') });
    const res = await preview({ cron: '0 9 25,26 12 *', tz: 'Europe/Amsterdam', skipHolidays: true });
    assert.strictEqual(res.body.valid, true);
    assert.deepStrictEqual(res.body.next, []);
    assert.deepStrictEqual(res.body.skipped.map(h => h.key), ['christmas_day', 'boxing_day']);
});

test('skipHolidays must be a boolean', async () => {
    const res = await preview({ cron: '0 9 * * *', tz: 'UTC', skipHolidays: 'yes' });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some(d => d.path === 'body.skipHolidays'));
});

test('an unknown time zone answers valid:false instead of a 500', async () => {
    const res = await preview({ cron: '0 9 * * *', tz: 'Mars/Olympus' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.valid, false);
    assert.match(res.body.error, /Mars\/Olympus/);
});
