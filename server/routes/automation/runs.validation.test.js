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
 * And the plan gate (automation/licensedSteps.js): a run of the WORKING copy
 * with a Privacy Shield step that is not live yet is a readable 403 without
 * `automation_privacy_steps`, the runner is never reached, and a run of the
 * live copy is never refused.
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
// The plan-gate tests hand in their own row (with a non-enumerable live copy,
// the way rowToAutomation does); everything else gets AUTOMATION.
let rowOverride = null;

// The capability resolver behind automation/licensedSteps.js: the ids in
// `plan.granted` are granted, everything else is outside the plan.
const plan = { granted: new Set(), asked: [] };
mock(path.join(SERVER, 'core/entitlements/entitlements'), {
    registry: { getCapability: (id) => ({ id, kind: 'beta' }) },
    resolveCapabilitySet: async (who) => {
        plan.asked.push(who);
        return { degraded: false, snapshot: { ceiling: { beta: [] } }, has: (id) => plan.granted.has(id) };
    },
});

mock(path.join(SERVER, 'stores/automationStore'), {
    getAutomation: async (id) => { touched.push({ what: 'getAutomation', args: [id] }); return rowOverride ? rowOverride() : { ...AUTOMATION }; },
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

test.beforeEach(() => {
    touched.length = 0;
    rowOverride = null;
    plan.granted.clear();
    plan.asked.length = 0;
});

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

// ═══ The plan gate on runs of the working copy ═════════════════════

const GUARDED = {
    trigger: { id: 'trg', kind: 'manual' },
    steps: [{ id: 'g1', type: 'guard', sourceRef: 'trigger.output.text', label: 'Scan it' }, { id: 'w1', type: 'wait', seconds: 1 }],
    edges: [{ from: 'trg', to: 'g1' }, { from: 'g1', to: 'w1', label: 'then' }],
};
const REVEALING = {
    trigger: { id: 'trg', kind: 'manual' },
    steps: [{ id: 'u1', type: 'untokenize', sourceRef: 'trigger.output.text' }],
    edges: [{ from: 'trg', to: 'u1' }],
};

/** A store row: `live` rides non-enumerable, as rowToAutomation hands it out. */
function useRow(definition, live = null) {
    rowOverride = () => {
        const a = { id: 'a1', userId: 'u1', organizationId: 'org1', kind: 'automation', version: 3, liveVersion: live ? 2 : null, definition };
        Object.defineProperty(a, 'liveDefinition', { value: live, enumerable: false });
        return a;
    };
}

const ran = () => touched.some((t) => t.what === 'executeAutomation' || t.what === 'runPartial');

test('plan gate: a Test run of a draft with a new Privacy Shield step is refused in words, and nothing runs', async () => {
    useRow(GUARDED, { trigger: { id: 'trg', kind: 'manual' }, steps: [], edges: [] });
    const res = await dispatch({ method: 'POST', url: '/a1/run', body: { test: true } });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'feature_locked');
    assert.strictEqual(res.body.feature, 'automation_privacy_steps');
    assert.match(res.body.error, /cannot run/);
    assert.match(res.body.error, /"Scan it" is a Privacy Shield step/, 'the screen that shows only `error` still names the step');
    assert.match(res.body.details[0].message, /"Scan it" is a Privacy Shield step/);
    assert.ok(!ran(), 'the runner is never reached');
    assert.strictEqual(plan.asked[0].userId, 'u1', 'the owner is asked');
});

test('plan gate: with the capability the Test run starts', async () => {
    useRow(GUARDED);
    plan.granted.add('automation_privacy_steps');
    const res = await dispatch({ method: 'POST', url: '/a1/run', body: { test: true } });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.ok(ran());
});

test('plan gate: a run of the LIVE copy is never refused, even with the step and no plan', async () => {
    useRow({ ...GUARDED, steps: [...GUARDED.steps, { id: 't_new', type: 'tokenize', sourceRef: 'trigger.output.text' }] }, GUARDED);
    const res = await dispatch({ method: 'POST', url: '/a1/run', body: {} });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.ok(ran());
    assert.strictEqual(plan.asked.length, 0, 'the plan is not even asked');
});

test('plan gate: a dry run and a from-here step run of the draft are refused the same way', async () => {
    useRow(GUARDED);
    const dry = await dispatch({ method: 'POST', url: '/a1/dry-run', body: {} });
    assert.strictEqual(dry.statusCode, 403);
    const from = await dispatch({ method: 'POST', url: '/a1/steps/g1/run', body: { mode: 'from' } });
    assert.strictEqual(from.statusCode, 403);
    assert.ok(!ran());
});

test('plan gate: running ONE other step of that draft is not refused', async () => {
    useRow(GUARDED);
    const res = await dispatch({ method: 'POST', url: '/a1/steps/w1/run', body: { mode: 'only' } });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.ok(ran());
});

test('plan gate: Show real values again never needs the plan', async () => {
    useRow(REVEALING);
    const res = await dispatch({ method: 'POST', url: '/a1/run', body: { test: true } });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(plan.asked.length, 0);
});
