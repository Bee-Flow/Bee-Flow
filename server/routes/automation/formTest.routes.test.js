/**
 * The builder's form test (routes/automation/formTest.js): page one goes
 * through the real submission path (automation/formSubmission.mts), so the run
 * gets typed answers, trigger.headers and a test session exactly like a
 * visitor's, and the route answers 202 { runId } at once for the overlay to
 * follow. Only an editor may; the upload is gated before the file is parsed.
 *
 * A real express app (testUtils/routeHarness.js serve) around the router, with
 * the store, the access check, the runner and the upload guard handed in
 * (no module mocks).
 * Run: cd server && node --test routes/automation/formTest.routes.test.js
 */

'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const h = require('../../testUtils/routeHarness');
const { makeFormTestRouter } = require('./formTest');
const realSubmission = require('../../automation/formSubmission.mts');
const { createFormWork } = require('../../automation/formQueueWork');
const { coerceSubmission, formTriggerFields } = require('../../automation/formTriggerContract');

const EDITOR = { id: 'ed1', organizationId: 'org1' };
const FORM = { fields: [{ name: 'email', type: 'email', label: 'Your email', required: true }, { name: 'count', type: 'number', label: 'How many' }] };
const AUTOMATIONS = {
    au1: { id: 'au1', userId: 'owner1', organizationId: 'org1', definition: { trigger: { id: 't', kind: 'form', form: FORM } } },
    files: { id: 'files', userId: 'owner1', organizationId: 'org1', definition: { trigger: { id: 't', kind: 'form', form: { fields: [{ name: 'doc', type: 'file', label: 'Doc', maxSizeMb: 5 }] } } } },
    manual: { id: 'manual', userId: 'owner1', organizationId: 'org1', definition: { trigger: { id: 't', kind: 'manual' } } },
};

let w;
beforeEach(() => { w = { runs: [], sessions: [], recorded: 0, touched: 0, uploadsParsed: 0 }; });

const store = {
    getAutomation: async (id) => AUTOMATIONS[id] || null,
    ensureFormPage: async (automationId, triggerStepId) => ({ id: `page-${automationId}`.padEnd(48, '0'), automationId, triggerStepId }),
    getRunSteps: async () => [{ stepId: 't', status: 'success' }],
    claimFormUpload: async () => null,
    touchFormPage: async () => { w.touched += 1; },
    createFormSession: async (pageId, automationId, opts) => { const s = { id: `s${w.sessions.length + 1}`, pageId, automationId, ...opts }; w.sessions.push(s); return s; },
    attachFormSessionRun: async () => {},
    updateRun: async () => true,
};
const access = {
    guard: async (req, res, _a, need) => {
        if (req.session.user.id === EDITOR.id) return { role: 'edit' };
        res.status(403).json({ error: 'Forbidden', code: 'automation_forbidden', need });
        return null;
    },
};
const runner = {
    executeAutomation: async (automation, opts) => {
        w.runs.push({ automation, opts });
        await opts.onRunCreated({ id: `run${w.runs.length}` });
        return { id: `run${w.runs.length}`, status: 'success' };
    },
};
const deps = {
    store, formTriggerFields, coerceSubmission,
    describeClaimedUpload: async (c) => c,
    assertFormStartAllowed: async () => {},
    collectEnabled: () => true,
    recordSubmission: async () => { w.recorded += 1; return { rowId: 'r', datatableId: 'd' }; },
    bestEffort: () => {},
    now: () => new Date(),
};
const formWork = createFormWork({ automationStore: store, runner: () => runner, formAnswers: () => ({}) });
const submission = {
    ...realSubmission,
    acceptSubmission: (found, body, caller, profile) => realSubmission.acceptSubmission(found, body, caller, profile, deps),
    startSubmission: (found, accepted, onRunCreated) => realSubmission.startSubmission(found, accepted, onRunCreated, formWork),
};
const pass = (_req, _res, next) => next();
const upload = (req, _res, next) => {
    w.uploadsParsed += 1;
    req.file = { buffer: Buffer.from('%PDF-1.4'), size: 8, mimetype: 'application/pdf', originalname: 'a.pdf' };
    next();
};

const api = h.serve('/api/automation', makeFormTestRouter({ store, access, submission, limiter: pass, upload }), { user: EDITOR });
after(api.close);

test('a dry form test answers 202 { runId } at once and runs the real submission path as a dry run that pauses', async () => {
    const res = await api.call('POST', '/api/automation/au1/form-test', { body: { values: { email: 'a@b.nl', count: '4' }, respond: 'created' } });
    assert.strictEqual(res.status, 202, res.text);
    assert.strictEqual(res.body.runId, 'run1');
    assert.strictEqual(res.body.sessionId, 's1');
    const { opts } = w.runs[0];
    assert.strictEqual(opts.mode, 'dry_run');
    assert.strictEqual(opts.pausesRequested, true);
    assert.strictEqual(opts.origin, 'builder');
    assert.strictEqual(opts.triggerKind, 'form');
    assert.strictEqual(opts.startedByUserId, 'ed1', 'the tester holds the sandbox seat');
    assert.strictEqual(opts.triggerPayload.count, 4, 'typed like a real submission');
    assert.strictEqual(opts.triggerHeaders.test, true);
    assert.ok(opts.triggerHeaders.submitted_at && opts.triggerHeaders.form_page_id);
    assert.strictEqual(w.sessions[0].isTest, true, 'the builder may answer its own later pages');
    assert.strictEqual(w.recorded, 0, 'no answers row');
    assert.strictEqual(w.touched, 0, 'no submission counted');
});

test('a live form test is a test run of the builder; without respond it answers the finished run', async () => {
    const res = await api.call('POST', '/api/automation/au1/form-test', { body: { values: { email: 'a@b.nl' }, mode: 'live' } });
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.run.id, 'run1');
    assert.ok(Array.isArray(res.body.steps));
    const { opts } = w.runs[0];
    assert.strictEqual(opts.isTest, true);
    assert.strictEqual(opts.origin, 'builder');
    assert.strictEqual(opts.mode, undefined);
});

test('answers that need attention come back as fields; a trigger that is no form is a 409; nothing runs', async () => {
    const bad = await api.call('POST', '/api/automation/au1/form-test', { body: { values: { count: 'x' } } });
    assert.strictEqual(bad.status, 400);
    assert.ok(bad.body.fields.some((f) => f.field === 'email'));
    const manual = await api.call('POST', '/api/automation/manual/form-test', { body: {} });
    assert.strictEqual(manual.status, 409);
    assert.strictEqual(manual.body.code, 'not_a_form');
    const unknown = await api.call('POST', '/api/automation/au1/form-test', { body: { triggerStepId: 'nope' } });
    assert.strictEqual(unknown.status, 400);
    assert.strictEqual(w.runs.length, 0);
});

test('without edit: 403 on the test and on the upload, before any file is parsed', async () => {
    const viewer = { id: 'viewer1', organizationId: 'org1' };
    const res = await api.call('POST', '/api/automation/au1/form-test', { user: viewer, body: { values: { email: 'a@b.nl' } } });
    assert.strictEqual(res.status, 403);
    const up = await api.call('POST', '/api/automation/files/form-test/upload', { user: viewer, body: { field: 'doc' } });
    assert.strictEqual(up.status, 403);
    assert.strictEqual(w.uploadsParsed, 0);
    assert.strictEqual(w.runs.length, 0);
    assert.strictEqual((await api.call('POST', '/api/automation/nope/form-test', { body: {} })).status, 404);
});

test('an editor\'s upload goes through the form\'s own upload path (its file question, its checks)', async () => {
    const none = await api.call('POST', '/api/automation/au1/form-test/upload', { body: { field: 'doc' } });
    assert.strictEqual(none.status, 400);
    assert.match(none.body.error, /does not accept files/);
    assert.strictEqual(w.uploadsParsed, 1);
});
