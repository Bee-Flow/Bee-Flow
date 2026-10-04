'use strict';

/**
 * What the webhook and run-operation routes accept, and what they say when
 * they refuse (routes/automation/webhooksAndRunOps.js).
 *
 * These routes read their bodies with `req.body?.x`, so a key nobody reads —
 * `reasson` on a rejection, `trigerStepId` on a webhook — was answered with a
 * 200 and quietly dropped. On an approval gate that is the worst place for it:
 * the person believes they recorded a reason, and the audit trail has none.
 * What this file pins is the part a caller can act on:
 *
 *   - the 400 NAMES the field (`body.decision`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the store is never reached, so a refused request changes nothing;
 *   - a POST with NO BODY still works, because that has always meant approve.
 *
 * Route stack invoked directly — same technique as the sister run-approve test.
 *
 * Run: cd server && node --test --test-force-exit routes/automation/webhooksAndRunOps.validation.test.js
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

// Every store call lands in `touched`. A refused request must leave it empty.
const touched = [];

const RUN = { id: 'run1', userId: 'u1', automationId: 'a1', status: 'awaiting_confirm', summary: null, finishedAt: null };
const AUTOMATION = {
    id: 'a1', userId: 'u1', isActive: true, needsFirstRunConfirm: true,
    definition: { trigger: { id: 'trg', kind: 'webhook' }, steps: [] },
};

mock(path.join(SERVER, 'stores/automationStore'), {
    getRun: async (id) => { touched.push({ what: 'getRun', args: [id] }); return { ...RUN }; },
    getAutomation: async (id) => { touched.push({ what: 'getAutomation', args: [id] }); return { ...AUTOMATION }; },
    getLatestRunInChain: async () => null,
    getRunSteps: async () => [],
    updateRun: async (...a) => { touched.push({ what: 'updateRun', args: a }); return true; },
    updateAutomation: async (...a) => { touched.push({ what: 'updateAutomation', args: a }); return { ...AUTOMATION }; },
    createWebhook: async (...a) => { touched.push({ what: 'createWebhook', args: a }); return { id: 'wh1' }; },
    getFormPagesForAutomation: async () => [],
    getRunFullOutput: async (...a) => {
        touched.push({ what: 'getRunFullOutput', args: a });
        return a[1] === 'http1' ? { items: [{ id: 'first-item' }] } : null;
    },
    createFormPage: async (...a) => { touched.push({ what: 'createFormPage', args: a }); return { id: 'page1' }; },
});
mock(path.join(SERVER, 'core/automationRunner'), {
    executeAutomation: async (...a) => { touched.push({ what: 'executeAutomation', args: a }); return { lastOutput: null }; },
    requestCancel: async () => null,
});
mock(path.join(SERVER, 'automation/publicUrl'), {
    webhookUrlForSlug: (slug) => `https://example.test/wh/${slug}`,
    formUrlForToken: (t) => `https://example.test/f/${t}`,
});
mock(path.join(SERVER, 'utils/perUserRateLimit'), { perUserRateLimit: () => (req, res, next) => next() });

const router = require('./webhooksAndRunOps');
const { terminalErrorHandler } = require(path.join(SERVER, 'core/http/terminalErrorHandler'));

function dispatch({ method, url, body, query = {} }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query, headers: {},
            session: { user: { id: 'u1' } }, get() { return undefined; }, setTimeout() {},
        };
        const res = {
            statusCode: 200, headersSent: false,
            set() { return this; }, setHeader() {}, setTimeout() {},
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

// ═══ A body that is not there ═══════════════════════════════════════

test('a POST with no body at all still means approve', async () => {
    // Express 5 leaves req.body undefined when a POST carries none, and the
    // deployed caller of this route sends exactly that.
    const res = await dispatch({ method: 'POST', url: '/runs/run1/approve', body: undefined });
    assert.notStrictEqual(res.statusCode, 400, JSON.stringify(res.body));
});

// ═══ POST /runs/:id/approve ═════════════════════════════════════════

test('a misspelled reason is refused rather than dropped from the audit trail', async () => {
    // `reasson` used to be answered with a 200: the run was rejected, and the
    // reason the person typed was nowhere.
    await refuses({ method: 'POST', url: '/runs/run1/approve', body: { decision: 'reject', reasson: 'te duur' } }, 'body');
});

test('a decision nobody implements is refused in words, and nothing runs', async () => {
    const res = await dispatch({ method: 'POST', url: '/runs/run1/approve', body: { decision: 'maybe' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'decision is "approve" or "reject".');
    assert.ok(res.body.details.some((d) => d.path === 'body.decision'));
    assert.deepStrictEqual(touched, []);
});

// ═══ POST /:id/webhook ══════════════════════════════════════════════

test('a numeric triggerStepId is refused by name, not compared against every trigger', async () => {
    await refuses({ method: 'POST', url: '/a1/webhook', body: { triggerStepId: 42 } }, 'body.triggerStepId');
});

test('a key the webhook route does not read is refused rather than answered with 200', async () => {
    await refuses({ method: 'POST', url: '/a1/webhook', body: { trigerStepId: 'trg' } }, 'body');
});

test('a webhook for the primary trigger still needs no body', async () => {
    const res = await dispatch({ method: 'POST', url: '/a1/webhook', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'createWebhook').args, ['a1', null]);
});

// ═══ POST /:id/agent-invoke ═════════════════════════════════════════

test('args that are not an object are refused by name, instead of silently becoming {}', async () => {
    // `(typeof req.body.args === 'object')` dropped a string, a number and a
    // boolean alike: the automation ran on an empty payload and said nothing.
    await refuses({ method: 'POST', url: '/a1/agent-invoke', body: { args: 'hello' } }, 'body.args');
});

// ═══ POST /:id/form-pick ════════════════════════════════════════════

test('a pick with no source is refused in words, before any app is searched', async () => {
    const res = await dispatch({ method: 'POST', url: '/a1/form-pick', body: { query: 'kickoff' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'source is the id of a pick source.');
    assert.ok(res.body.details.some((d) => d.path === 'body.source'));
});

// ═══ POST /runs/:runId/form ═════════════════════════════════════════

test('form answers must be a map of field ids, not a list', async () => {
    await refuses({ method: 'POST', url: '/runs/run1/form', body: { values: ['ja'] } }, 'body.values');
});

// ═══ GET /runs/:id/steps/:stepId/full-output ═══════════════════════════

test('an attempt number that is not a whole number from 1 is refused by name', async () => {
    for (const attempts of ['0', 'two', '1.5']) {
        await refuses({ method: 'GET', url: '/runs/run1/steps/http1/full-output', query: { attempts } }, 'query.attempts');
    }
});

test('a query key the route does not read is refused rather than ignored', async () => {
    await refuses({ method: 'GET', url: '/runs/run1/steps/http1/full-output', query: { attempt: '2' } }, 'query');
});

test('the kept full copy is served to the run\'s owner, for the first attempt by default', async () => {
    const res = await dispatch({ method: 'GET', url: '/runs/run1/steps/http1/full-output' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { output: { items: [{ id: 'first-item' }] } });
    assert.deepStrictEqual(touched.find((t) => t.what === 'getRunFullOutput').args, ['run1', 'http1', 1]);
});

test('a step with no kept copy is a 404, not an empty 200', async () => {
    const res = await dispatch({ method: 'GET', url: '/runs/run1/steps/small/full-output', query: { attempts: '2' } });
    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(touched.find((t) => t.what === 'getRunFullOutput').args, ['run1', 'small', 2]);
});
