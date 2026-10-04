'use strict';

/**
 * POST /api/automation/runs/:id/approve — the RUN-level first-run
 * confirmation gate (`awaiting_confirm`) is a real DECISION gate.
 *
 * The regression this pins: the route used to ignore the decision entirely.
 * It cleared `needsFirstRunConfirm` on the automation ABOVE any branching and
 * then executed the automation live — so the SPA's "Reject" button started the
 * run and removed the gate for every future run. A gate that disappears when
 * you refuse it is not a gate.
 *
 * What is pinned here:
 *   - reject closes the waiting row as `cancelled` and runs NOTHING, and the
 *     automation is not touched at all (the gate stays);
 *   - approve still does exactly what it always did;
 *   - a missing decision falls back to approve — the safe default, because
 *     every deployed caller that sends no body means approve;
 *   - an unknown decision is a 400 and has no side effects;
 *   - the owner/status guards still hold.
 *
 * Route handlers invoked directly — same require.cache Module mock +
 * findHandler technique as runs.triggerStepId.test.js.
 *
 * Run: node --test --test-force-exit routes/automation/webhooksAndRunOps.runApprove.test.js
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

let RUNS = {};
let AUTOMATIONS = {};
const calls = { updateRun: [], updateAutomation: [], execute: [] };

function reset() {
    RUNS = {
        run1: {
            id: 'run1',
            userId: 'user1',
            automationId: 'a1',
            status: 'awaiting_confirm',
            summary: null,
            finishedAt: null,
        },
    };
    AUTOMATIONS = { a1: { id: 'a1', userId: 'user1', needsFirstRunConfirm: true, definition: { steps: [] } } };
    calls.updateRun.length = 0;
    calls.updateAutomation.length = 0;
    calls.execute.length = 0;
}

mock(path.join(SERVER, 'stores/automationStore'), {
    getRun: async (id) => (RUNS[id] ? { ...RUNS[id] } : null),
    getAutomation: async (id) => (AUTOMATIONS[id] ? { ...AUTOMATIONS[id] } : null),
    updateRun: async (id, updates) => {
        calls.updateRun.push({ id, updates });
        if (RUNS[id]) Object.assign(RUNS[id], updates);
        return true;
    },
    updateAutomation: async (id, updates, userId) => {
        calls.updateAutomation.push({ id, updates, userId });
        if (AUTOMATIONS[id]) Object.assign(AUTOMATIONS[id], updates);
        return AUTOMATIONS[id] || null;
    },
    // Unused by this route, present so the module loads like the real store.
    getLatestRunInChain: async () => null,
    getRunSteps: async () => [],
});
mock(path.join(SERVER, 'core/automationRunner'), {
    executeAutomation: async (a, opts) => { calls.execute.push({ id: a.id, needsFirstRunConfirm: a.needsFirstRunConfirm, ...opts }); return { id: 'run2', status: 'success' }; },
    requestCancel: async () => null,
});
mock(path.join(SERVER, 'automation/publicUrl'), {
    webhookUrlForSlug: (slug) => `https://example.test/wh/${slug}`,
    formUrlForToken: (t) => `https://example.test/f/${t}`,
});
mock(path.join(SERVER, 'utils/perUserRateLimit'), { perUserRateLimit: () => (req, res, next) => next() });

const router = require('./webhooksAndRunOps');

/**
 * A route's WHOLE stack, not only its handler: `validate` sits in front of
 * this one now, and a schema refusal leaves as an error rather than as a
 * response — so the terminal handler has to be here too, or a 400 reads as
 * a crashed test.
 */
function findRoute(method, routePath) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
            return layer.route.stack.map(l => l.handle);
        }
    }
    throw new Error(`route not found: ${method} ${routePath}`);
}

function runRoute(handles) {
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
function makeRes() {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}
const approve = runRoute(findRoute('post', '/runs/:id/approve'));

const req = (id, body, userId = 'user1') => ({ params: { id }, session: { user: { id: userId } }, body });

/**
 * The approve branch fires the runner from a setImmediate, so the response is
 * sent before it starts. Two turns of the immediate queue: one for the
 * handler's own callback, one to let its awaited body settle.
 */
async function drainImmediates() {
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
}

test('reject closes the waiting run as cancelled and runs nothing', async () => {
    reset();
    const res = makeRes();
    await approve(req('run1', { decision: 'reject' }), res);
    await drainImmediates();

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.accepted, true);
    assert.strictEqual(res.body.decision, 'reject');

    // Nothing was executed — not now, not on the immediate queue.
    assert.deepStrictEqual(calls.execute, [], 'reject must not execute the automation');

    // The waiting row got a terminal status, a reason-carrying summary and an end time.
    assert.strictEqual(calls.updateRun.length, 1);
    const { id, updates } = calls.updateRun[0];
    assert.strictEqual(id, 'run1');
    assert.strictEqual(updates.status, 'cancelled');
    assert.match(updates.summary, /First-run confirmation declined/);
    assert.ok(updates.finishedAt && !Number.isNaN(Date.parse(updates.finishedAt)), 'finishedAt must be an ISO timestamp');

    // The response carries the fresh row so the client has the new status.
    assert.strictEqual(res.body.run.id, 'run1');
    assert.strictEqual(res.body.run.status, 'cancelled');
});

test('reject leaves the gate standing — needsFirstRunConfirm is not touched', async () => {
    reset();
    const res = makeRes();
    await approve(req('run1', { decision: 'reject' }), res);
    await drainImmediates();

    // This is the half of the defect that was easiest to miss: the clearing of
    // the gate used to sit ABOVE the branch, so refusing removed it forever.
    assert.deepStrictEqual(calls.updateAutomation, [], 'reject must not write to the automation at all');
    assert.strictEqual(AUTOMATIONS.a1.needsFirstRunConfirm, true, 'the gate must survive a rejection');
});

test('reject carries an optional reason into the summary, and works without one', async () => {
    reset();
    const withReason = makeRes();
    await approve(req('run1', { decision: 'reject', reason: '  looked at the wrong mailbox  ' }), withReason);
    assert.strictEqual(withReason.statusCode, 200, JSON.stringify(withReason.body));
    assert.strictEqual(calls.updateRun[0].updates.summary, 'First-run confirmation declined: looked at the wrong mailbox');

    // Reason is optional on purpose: the shipped ExecutionBar has no field for
    // it, so demanding one would 400 the button this change repairs.
    reset();
    const noReason = makeRes();
    await approve(req('run1', { decision: 'reject' }), noReason);
    assert.strictEqual(noReason.statusCode, 200, JSON.stringify(noReason.body));
    assert.strictEqual(
        calls.updateRun[0].updates.summary,
        'First-run confirmation declined — the automation was not run live.',
    );
});

test('approve still does what it always did: clears the gate and runs live', async () => {
    reset();
    const res = makeRes();
    await approve(req('run1', { decision: 'approve' }), res);
    await drainImmediates();

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.accepted, true);
    assert.strictEqual(res.body.decision, 'approve');
    assert.deepStrictEqual(calls.updateAutomation, [{ id: 'a1', updates: { needsFirstRunConfirm: false }, userId: 'user1' }]);
    assert.strictEqual(calls.execute.length, 1);
    assert.deepStrictEqual(calls.execute[0], {
        id: 'a1', needsFirstRunConfirm: false, triggerKind: 'manual', mode: 'live', confirmFirstRun: true,
        // Handoff 5: the person who approved started this run.
        startedByUserId: 'user1',
    });
    // The historical row is left as-is by approve — it stays awaiting_confirm.
    assert.deepStrictEqual(calls.updateRun, []);
});

test('a missing decision falls back to approve — the old, safe contract', async () => {
    // Every deployed caller of this route sends no body at all
    // (useAutomationApi.approveRun), and means approve by it. The default may
    // never be WIDER than an explicit approval; it is exactly one.
    for (const body of [undefined, {}, { decision: '' }, { decision: null }, { reason: 'ignored' }]) {
        reset();
        const res = makeRes();
        await approve(req('run1', body), res);
        await drainImmediates();
        const label = JSON.stringify(body ?? null);
        assert.strictEqual(res.statusCode, 200, `${label}: ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.accepted, true, label);
        assert.strictEqual(calls.execute.length, 1, `${label}: should have run live`);
        assert.strictEqual(calls.updateAutomation.length, 1, `${label}: should have cleared the gate`);
        assert.deepStrictEqual(calls.updateRun, [], `${label}: should not have closed the run`);
    }
});

test('DECISION is case-insensitive, matching the step gate', async () => {
    reset();
    const res = makeRes();
    await approve(req('run1', { decision: 'REJECT' }), res);
    await drainImmediates();
    assert.strictEqual(res.body.decision, 'reject');
    assert.deepStrictEqual(calls.execute, []);
    assert.strictEqual(AUTOMATIONS.a1.needsFirstRunConfirm, true);
});

test('an unknown decision is a 400 with no side effects — never a silent approve', async () => {
    for (const decision of ['maybe', 'aprove', 'confirm', ' approve ', 0.5, { yes: true }, ['approve', 'reject']]) {
        reset();
        const res = makeRes();
        await approve(req('run1', { decision }), res);
        await drainImmediates();
        const label = JSON.stringify(decision);
        assert.strictEqual(res.statusCode, 400, `${label}: ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.error, 'decision is "approve" or "reject".', label);
        assert.deepStrictEqual(calls.execute, [], `${label}: nothing may run`);
        assert.deepStrictEqual(calls.updateAutomation, [], `${label}: the gate must stay`);
        assert.deepStrictEqual(calls.updateRun, [], `${label}: the run must stay open`);
        assert.strictEqual(RUNS.run1.status, 'awaiting_confirm', label);
    }
});

test('the ownership check still holds — a stranger decides nothing, either way', async () => {
    for (const body of [{ decision: 'approve' }, { decision: 'reject' }, {}]) {
        reset();
        const res = makeRes();
        await approve(req('run1', body, 'intruder'), res);
        await drainImmediates();
        const label = JSON.stringify(body);
        assert.strictEqual(res.statusCode, 403, `${label}: ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.error, 'Forbidden', label);
        assert.deepStrictEqual(calls.execute, [], label);
        assert.deepStrictEqual(calls.updateAutomation, [], label);
        assert.deepStrictEqual(calls.updateRun, [], label);
        assert.strictEqual(RUNS.run1.status, 'awaiting_confirm', label);
    }
});

test('the status check still holds — only an awaiting_confirm run can be decided', async () => {
    for (const status of ['success', 'error', 'running', 'awaiting_approval', 'cancelled']) {
        reset();
        RUNS.run1.status = status;
        const res = makeRes();
        await approve(req('run1', { decision: 'reject' }), res);
        await drainImmediates();
        assert.strictEqual(res.statusCode, 400, `${status}: ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.error, 'Run is not awaiting confirmation', status);
        assert.deepStrictEqual(calls.updateRun, [], status);
        assert.deepStrictEqual(calls.execute, [], status);
    }
});

test('missing run and missing automation are still 404, before any decision is read', async () => {
    reset();
    const noRun = makeRes();
    await approve(req('nope', { decision: 'reject' }), noRun);
    assert.strictEqual(noRun.statusCode, 404);
    assert.strictEqual(noRun.body.error, 'Not found');

    reset();
    delete AUTOMATIONS.a1;
    const noAutomation = makeRes();
    await approve(req('run1', { decision: 'reject' }), noAutomation);
    await drainImmediates();
    assert.strictEqual(noAutomation.statusCode, 404, JSON.stringify(noAutomation.body));
    assert.strictEqual(noAutomation.body.error, 'Automation not found');
    assert.deepStrictEqual(calls.updateRun, [], 'no run may be closed when its automation is gone');
});
