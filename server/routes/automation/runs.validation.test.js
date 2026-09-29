'use strict';

/**
 * What the run routes accept, and what they say when they refuse
 * (routes/automation/runs.js).
 *
 * Two silent fall-backs lived here. `?staus=error` on an executions list was
 * dropped, so the list answered a WIDER question than the one it was asked —
 * every run, presented as the failures somebody had filtered for. And
 * `mode: 'upto'` on a partial run fell back to `only`, which runs that one
 * step instead of everything leading up to it, and answered 200. What this
 * file pins is the part a caller can act on:
 *
 *   - the 400 NAMES the field (`query.status`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the store and the runner are never reached, so a refused request
 *     changes nothing.
 *
 * Route stack invoked directly — same technique as runs.orgScope.test.js.
 *
 * Run: cd server && node --test --test-force-exit routes/automation/runs.validation.test.js
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

// Every store and runner call lands in `touched`. A refused request must
// leave it empty.
const touched = [];

const AUTOMATION = { id: 'a1', userId: 'u1', definition: { trigger: { id: 'trg', kind: 'manual' }, steps: [] } };

mock(path.join(SERVER, 'stores/automationStore'), {
    getAutomation: async (id) => { touched.push({ what: 'getAutomation', args: [id] }); return { ...AUTOMATION }; },
    listRunsForUser: async (...a) => { touched.push({ what: 'listRunsForUser', args: a }); return { runs: [], nextCursor: null }; },
    getRunFacetsForUser: async (...a) => { touched.push({ what: 'getRunFacetsForUser', args: a }); return {}; },
    getRunSteps: async () => [],
    getActiveRunsForUser: async () => [],
});
mock(path.join(SERVER, 'core/automationRunner'), {
    executeAutomation: async (...a) => { touched.push({ what: 'executeAutomation', args: a }); return { id: 'run1' }; },
    runPartial: async (...a) => { touched.push({ what: 'runPartial', args: a }); return { id: 'run1' }; },
});
mock(path.join(SERVER, 'automation/deliverableEvents'), { getDeliverableEvents: () => [], isPushPending: () => false });
mock(path.join(SERVER, 'automation/triggerBus'), { getPublicBaseUrl: () => null, dispatchEvent: async () => [] });
mock(path.join(SERVER, 'utils/perUserRateLimit'), { perUserRateLimit: () => (req, res, next) => next() });

const router = require('./runs');
const { terminalErrorHandler } = require(path.join(SERVER, 'core/http/terminalErrorHandler'));

function dispatch({ method, url, body = {} }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, query, body, headers: {},
            session: { user: { id: 'u1' } }, get() { return undefined; }, setTimeout() {},
        };
        const res = {
            statusCode: 200, headersSent: false,
            set() { return this; }, setHeader() {}, flushHeaders() {}, setTimeout() {},
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched.length = 0; });

/** Assert: refused with 400, the named field is in `details`, nothing touched. */
async function refuses(request, field) {
    const res = await dispatch(request);
    const what = `${request.method} ${request.url} ${JSON.stringify(request.body)}`;
    assert.strictEqual(res.statusCode, 400, what);
    assert.strictEqual(res.body.code, 'invalid_request', what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
}

// ═══ The executions list ════════════════════════════════════════════

test('a misspelled filter is refused, not dropped into a wider list', async () => {
    // `?staus=error` used to be ignored, so the list answered "every run" to
    // somebody who had asked for the failures.
    await refuses({ method: 'GET', url: '/_runs/recent?staus=error' }, 'query');
});

test('a limit that is not a number is refused in words', async () => {
    const res = await dispatch({ method: 'GET', url: '/_runs/recent?limit=veel' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'limit must be a number.');
    assert.deepStrictEqual(touched, []);
});

test('the filters a caller may narrow on still narrow', async () => {
    const res = await dispatch({ method: 'GET', url: '/_runs/recent?status=error,cancelled&triggerKind=manual&limit=10' });
    assert.strictEqual(res.statusCode, 200);
    const filters = touched.find((t) => t.what === 'listRunsForUser').args[1];
    assert.deepStrictEqual(filters.status, ['error', 'cancelled']);
    assert.deepStrictEqual(filters.triggerKind, ['manual']);
    assert.strictEqual(filters.limit, 10);
});

test('a facets query only takes the context keys, not the list filters', async () => {
    // The chips show the full breakdown you can switch TO, so a status
    // filter there would be a caller expecting something this cannot do.
    await refuses({ method: 'GET', url: '/_runs/facets?status=error' }, 'query');
});

// ═══ POST /:id/steps/:stepId/run ════════════════════════════════════

test('a partial-run mode nobody implements is refused instead of running one step', async () => {
    // `upto` fell back to `only`: the steps leading to it never ran, and the
    // answer was a 200 with a result that looked right.
    const res = await dispatch({ method: 'POST', url: '/a1/steps/s1/run', body: { mode: 'upto' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'mode is "only", "from" or "upTo".');
    assert.ok(res.body.details.some((d) => d.path === 'body.mode'));
    assert.deepStrictEqual(touched, [], 'and nothing runs');
});

test('no mode still means "only", from the schema', async () => {
    const res = await dispatch({ method: 'POST', url: '/a1/steps/s1/run', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'runPartial').args[2].mode, 'only');
});

// ═══ POST /:id/dry-run ══════════════════════════════════════════════

test('a numeric triggerStepId is refused by name, not read as "the primary trigger"', async () => {
    await refuses({ method: 'POST', url: '/a1/dry-run', body: { triggerStepId: 42 } }, 'body.triggerStepId');
});

test('a key the run route does not read is refused rather than answered with 200', async () => {
    await refuses({ method: 'POST', url: '/a1/dry-run', body: { payload: { x: 1 } } }, 'body');
});

// ═══ POST /_schedule/preview ════════════════════════════════════════

test('a key the preview does not read is refused rather than previewing the default zone', async () => {
    await refuses({ method: 'POST', url: '/_schedule/preview', body: { cron: '0 7 * * *', timezone: 'UTC' } }, 'body');
});
