'use strict';

/**
 * Testing a form journey from the builder — GET/POST /runs/:runId/form and
 * POST /:id/form-pick.
 *
 * These exist because a form-triggered automation is the one kind that cannot be
 * tested by pressing Run: its trigger IS a page, and its public page 404s while
 * the automation is still a draft. What is pinned here is that they are RUN
 * OPERATIONS and not a second public form surface — owner-only, no token, no
 * session, no anonymous path — and that continuing a paused run coerces the
 * answers against the page the run is ACTUALLY waiting on.
 *
 * Route handlers invoked directly — same Module-mock + findHandler technique as
 * webhooksAndRunOps.runApprove.test.js.
 *
 * Run: node --test --test-force-exit routes/automation/webhooksAndRunOps.runForm.test.js
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

const PAGE_TWO = {
    title: 'Nearly there',
    fields: [
        { name: 'address', type: 'text', label: 'Your address', required: true, placeholder: '', help: '' },
        { name: 'call', type: 'app_pick', label: 'Which call?', source: 'fireflies_transcript', required: false, placeholder: '', help: '' },
    ],
};

let RUNS = {};
let STEPS = {};
let AUTOMATIONS = {};
const calls = { updateRun: [], resume: [], described: [], searched: [] };

function reset() {
    RUNS = {
        run1: { id: 'run1', userId: 'user1', automationId: 'a1', status: 'awaiting_form', awaitingStepId: 'fp_2', rootRunId: 'run1' },
    };
    STEPS = { run1: [{ stepId: 'fp_2', status: 'awaiting_form', output: { form: PAGE_TWO } }] };
    AUTOMATIONS = { a1: { id: 'a1', userId: 'user1', definition: { steps: [] } } };
    calls.updateRun.length = 0;
    calls.resume.length = 0;
    calls.described.length = 0;
    calls.searched.length = 0;
}

mock(path.join(SERVER, 'stores/automationStore'), {
    getRun: async (id) => (RUNS[id] ? { ...RUNS[id] } : null),
    getAutomation: async (id) => (AUTOMATIONS[id] ? { ...AUTOMATIONS[id] } : null),
    getRunSteps: async (id) => (STEPS[id] || []).map(s => ({ ...s })),
    getLatestRunInChain: async (id) => (RUNS[id] ? { ...RUNS[id] } : null),
    updateRun: async (id, updates) => {
        calls.updateRun.push({ id, updates });
        if (RUNS[id]) Object.assign(RUNS[id], updates);
        return true;
    },
});
mock(path.join(SERVER, 'core/automationRunner'), {
    resumeFromStep: async (runId, stepId, opts) => {
        calls.resume.push({ runId, stepId, opts });
        RUNS.run2 = { id: 'run2', userId: 'user1', automationId: 'a1', status: 'success', rootRunId: 'run1' };
        STEPS.run2 = [];
        return { id: 'run2', status: 'success' };
    },
    executeAutomation: async () => ({ id: 'run9' }),
    requestCancel: async () => null,
});
mock(path.join(SERVER, 'automation/formPickRecord'), {
    describePick: async (pick, opts) => {
        calls.described.push({ pick, withText: opts?.withText, callerId: opts?.caller?.userId || null });
        return { ...pick, text: `the text of ${pick.recordId}` };
    },
    searchRecords: async (source, query, caller, opts) => {
        calls.searched.push({ source, query, callerId: caller?.userId || null, opts });
        return { results: [{ id: 'tr_1', title: 'Kickoff' }] };
    },
});
mock(path.join(SERVER, 'routes/transcriptions/shared'), {
    resolveAccessContext: async () => ({ orgIds: ['org1'], userGroupIds: ['g1'], isSuperAdmin: false }),
});
mock(path.join(SERVER, 'automation/publicUrl'), {
    webhookUrlForSlug: (slug) => `https://example.test/wh/${slug}`,
    formUrlForToken: (t) => `https://example.test/f/${t}`,
});
mock(path.join(SERVER, 'utils/perUserRateLimit'), { perUserRateLimit: () => (req, res, next) => next() });

const router = require('./webhooksAndRunOps');

function findHandler(method, routePath) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
            return layer.route.stack[layer.route.stack.length - 1].handle;
        }
    }
    throw new Error(`route not found: ${method} ${routePath}`);
}
function makeRes() {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}
const getForm = findHandler('get', '/runs/:runId/form');
const postForm = findHandler('post', '/runs/:runId/form');
const postPick = findHandler('post', '/:id/form-pick');

const req = (params, body = {}, userId = 'user1') => ({
    params, body, session: { user: { id: userId, organizationId: 'org1' } },
});

// ── Which page is the run waiting on? ─────────────────────────────────────

test('GET reports the page the run is paused on, as the runner rendered it', async () => {
    reset();
    const res = makeRes();
    await getForm(req({ runId: 'run1' }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.waiting, true);
    assert.strictEqual(res.body.stepId, 'fp_2');
    // Straight off the awaiting step's row: labels already interpolated against
    // the run that produced them, so the builder shows the visitor's words.
    assert.strictEqual(res.body.form.title, 'Nearly there');
});

test('GET says "not waiting" for a run that is simply going, or finished', async () => {
    reset();
    RUNS.run1.status = 'running';
    RUNS.run1.awaitingStepId = null;
    const res = makeRes();
    await getForm(req({ runId: 'run1' }), res);
    assert.strictEqual(res.body.waiting, false);
    assert.strictEqual(res.body.status, 'running');
});

test('a run belonging to somebody else is refused, and an unknown one is a 404', async () => {
    reset();
    const mine = makeRes();
    await getForm(req({ runId: 'run1' }, {}, 'someone_else'), mine);
    assert.strictEqual(mine.statusCode, 403);

    const gone = makeRes();
    await getForm(req({ runId: 'nope' }), gone);
    assert.strictEqual(gone.statusCode, 404);
});

// ── Answering it ──────────────────────────────────────────────────────────

test('answering the page continues the run and closes the parent out', async () => {
    reset();
    const res = makeRes();
    await postForm(req({ runId: 'run1' }, { stepId: 'fp_2', values: { address: 'Dorpsstraat 1' } }), res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.run.id, 'run2');
    assert.strictEqual(calls.resume.length, 1);
    assert.deepStrictEqual(calls.resume[0].opts.decision, { address: 'Dorpsstraat 1', call: null });
    assert.strictEqual(calls.resume[0].opts.userId, 'user1');

    // The parent must not be left in awaiting_form: the reaper would later flip
    // a page that WAS answered to a "FormExpired" error.
    const finalise = calls.updateRun.find(u => u.id === 'run1');
    assert.ok(finalise, 'the parent run was never closed out');
    assert.strictEqual(finalise.updates.status, 'success');
    assert.match(finalise.updates.summary, /run2/);
});

test('answers are coerced against the declaration — a bad one is refused, nothing resumes', async () => {
    reset();
    const res = makeRes();
    await postForm(req({ runId: 'run1' }, { stepId: 'fp_2', values: { address: '' } }), res);
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.fields[0].message, /required/);
    assert.strictEqual(calls.resume.length, 0);
});

test('a stale overlay answering the wrong page is refused, not coerced against it', async () => {
    reset();
    const res = makeRes();
    await postForm(req({ runId: 'run1' }, { stepId: 'fp_9', values: { address: 'x' } }), res);
    assert.strictEqual(res.statusCode, 409);
    assert.match(res.body.error, /already been answered/);
    assert.strictEqual(calls.resume.length, 0);
});

test('a run that is not waiting for a form cannot be answered', async () => {
    reset();
    RUNS.run1.status = 'success';
    const res = makeRes();
    await postForm(req({ runId: 'run1' }, { stepId: 'fp_2', values: { address: 'x' } }), res);
    assert.strictEqual(res.statusCode, 409);
    assert.match(res.body.error, /not awaiting_form/);
    assert.strictEqual(calls.resume.length, 0);
});

test('a picked record is read as the person testing, before the run continues', async () => {
    reset();
    const res = makeRes();
    await postForm(req({ runId: 'run1' }, {
        stepId: 'fp_2',
        values: { address: 'Dorpsstraat 1', call: { kind: 'app_pick', recordId: 'tr_1', title: 'Kickoff' } },
    }), res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(calls.described.length, 1);
    assert.strictEqual(calls.described[0].callerId, 'user1');
    // The run gets what the SERVER read, never what the body claimed.
    assert.strictEqual(calls.resume[0].opts.decision.call.text, 'the text of tr_1');
});

// ── The picker, while the automation is still a draft ────────────────────────

test('the builder picker searches by SOURCE, as the owner', async () => {
    reset();
    const res = makeRes();
    await postPick(req({ id: 'a1' }, { source: 'fireflies_transcript', query: 'kickoff' }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.results.map(r => r.id), ['tr_1']);
    assert.strictEqual(calls.searched[0].source, 'fireflies_transcript');
    assert.strictEqual(calls.searched[0].callerId, 'user1');
});

test('the builder picker is owner-only', async () => {
    reset();
    const res = makeRes();
    await postPick(req({ id: 'a1' }, { source: 'fireflies_transcript' }, 'someone_else'), res);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(calls.searched.length, 0);
});
