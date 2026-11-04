/**
 * acceptSubmission: one path for page one, whoever submits it (critic gap 3).
 * A public submission, a test link's and the builder's go through the same
 * coercion, upload claim, picks and headers; only the profile decides whether
 * the answers table and the counter hear of it, and what kind of run starts.
 * Every dependency is injected (no module mocks).
 * Run: cd server && node --test automation/formSubmission.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
    acceptSubmission, startSubmission, stoppingAfter, profileForFound,
    PUBLIC_SUBMISSION, TEST_LINK_SUBMISSION, BUILDER_DRY_SUBMISSION, BUILDER_LIVE_SUBMISSION,
} from './formSubmission.mts';

const require = createRequire(import.meta.url);
const { createFormWork } = require('./formQueueWork');
const { coerceSubmission, formTriggerFields } = require('./formTriggerContract');

const FORM = {
    fields: [
        { name: 'email', type: 'email', label: 'Your email', required: true },
        { name: 'count', type: 'number', label: 'How many' },
        { name: 'attachment', type: 'file', label: 'Attachment', maxSizeMb: 5 },
    ],
};
const found = (over = {}) => ({
    token: 'tok1', page: { triggerStepId: null }, automation: { id: 'auto1', userId: 'owner1' },
    definition: { trigger: { id: 'trg', kind: 'form', form: { ...FORM, collect: true } } }, ...over,
});

function world() {
    const log = { touched: 0, recorded: [], sessions: [], notices: [], claims: [], picks: 0 };
    const store = {
        claimFormUpload: async (id, pageId) => { log.claims.push([id, pageId]); return id === 'gone' ? null : { id, storageKey: `k/${id}` }; },
        touchFormPage: async () => { log.touched += 1; },
        createFormSession: async (pageId, automationId, opts) => { const s = { id: `s${log.sessions.length + 1}`, pageId, automationId, ...opts }; log.sessions.push(s); return s; },
    };
    const deps = {
        store,
        formTriggerFields,
        coerceSubmission,
        describeClaimedUpload: async (claimed) => ({ fileId: claimed.id, text: 'the file text' }),
        assertFormStartAllowed: async (args) => { log.notices.push(args.submitterId); },
        collectEnabled: () => true,
        recordSubmission: async (args) => { log.recorded.push(args); return { rowId: 'row1', datatableId: 'dt1' }; },
        bestEffort: () => {},
        now: () => new Date('2026-11-03T10:00:00Z'),
    };
    const caller = { userId: 'u1', userAgent: 'ua', publicForm: false, readPicks: async () => { log.picks += 1; } };
    return { log, deps, caller };
}

const BODY = { email: 'a@b.nl', count: '3', attachment: { kind: 'form_upload', fileId: 'f1' } };

test('public and test: the same typed answers, the same claimed file, the same picks read', async () => {
    const pub = world();
    const a = await acceptSubmission(found(), { ...BODY }, pub.caller, PUBLIC_SUBMISSION, pub.deps);
    const tst = world();
    const b = await acceptSubmission(found({ test: true }), { ...BODY }, tst.caller, TEST_LINK_SUBMISSION, tst.deps);
    assert.ok(a.ok && b.ok);
    assert.deepEqual(a.work.payload, b.work.payload);
    assert.equal(a.work.payload.count, 3, 'typed');
    assert.deepEqual(a.work.payload.attachment, { fileId: 'f1', text: 'the file text' });
    assert.deepEqual(pub.log.claims, [['f1', 'tok1']]);
    assert.deepEqual(tst.log.claims, [['f1', 'tok1']]);
    assert.equal(pub.log.picks, 1);
    assert.equal(tst.log.picks, 1);
    const pubHeaders = a.session.triggerHeaders;
    const testHeaders = b.session.triggerHeaders;
    assert.equal(pubHeaders.submitted_at, testHeaders.submitted_at);
    assert.equal(pubHeaders.form_page_id, 'tok1');
    assert.equal(testHeaders.form_page_id, 'tok1');
    assert.equal(pubHeaders.user_agent, testHeaders.user_agent);
});

test('production: counted, an answers row, its id on the headers, a production run', async () => {
    const { log, deps, caller } = world();
    const out = await acceptSubmission(found(), { ...BODY }, caller, PUBLIC_SUBMISSION, deps);
    assert.equal(log.touched, 1);
    assert.equal(log.recorded.length, 1);
    assert.equal(out.session.triggerHeaders.answers_row_id, 'row1');
    assert.equal(out.session.triggerHeaders.test, undefined);
    assert.equal(out.session.isTest, false);
    assert.deepEqual(out.work, { kind: 'submit', payload: out.work.payload, submitterId: 'u1', publicForm: false });
});

test('a test link: no answers row, no counter, headers.test, an is_test session, a test run from the link', async () => {
    const { log, deps, caller } = world();
    const out = await acceptSubmission(found({ test: true }), { ...BODY }, caller, profileForFound({ test: true }), deps);
    assert.equal(log.touched, 0);
    assert.equal(log.recorded.length, 0);
    assert.equal(out.session.triggerHeaders.test, true);
    assert.equal(out.session.triggerHeaders.answers_row_id, undefined);
    assert.equal(out.session.isTest, true);
    assert.equal(out.work.isTest, true);
    assert.equal(out.work.origin, 'test_link');
    assert.equal(out.work.mode, undefined);
    assert.deepEqual(log.notices, ['u1'], 'the tester meets the caller notice a real submitter meets');
});

test('the builder: a dry run that pauses for real, or a live test, both started by the tester', async () => {
    const dry = world();
    const d = await acceptSubmission(found({ test: true }), { ...BODY }, dry.caller, BUILDER_DRY_SUBMISSION, dry.deps);
    assert.equal(d.work.mode, 'dry_run');
    assert.equal(d.work.origin, 'builder');
    assert.equal(dry.log.recorded.length, 0);
    const live = world();
    const l = await acceptSubmission(found({ test: true }), { ...BODY }, live.caller, BUILDER_LIVE_SUBMISSION, live.deps);
    assert.equal(l.work.mode, undefined);
    assert.equal(l.work.isTest, true);
    assert.equal(l.work.origin, 'builder');
});

test('answers that need attention and a file that is gone are refused before anything is written', async () => {
    const { log, deps, caller } = world();
    const bad = await acceptSubmission(found(), { count: '3' }, caller, PUBLIC_SUBMISSION, deps);
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.fields[0].field, 'email');
    const gone = await acceptSubmission(found(), { ...BODY, attachment: { kind: 'form_upload', fileId: 'gone' } }, caller, PUBLIC_SUBMISSION, deps);
    assert.equal(gone.ok, false);
    assert.deepEqual(gone.body.fields.map((f) => f.field), ['attachment']);
    assert.equal(log.sessions.length, 0);
    assert.equal(log.recorded.length, 0);
    assert.equal(log.touched, 0);
});

test('a public form is a system start: no submitter on the notice gate or the run', async () => {
    const { log, deps, caller } = world();
    const out = await acceptSubmission(found(), { ...BODY }, { ...caller, publicForm: true }, PUBLIC_SUBMISSION, deps);
    assert.deepEqual(log.notices, [null]);
    assert.equal(out.work.publicForm, true);
    // a test is never a public start, whatever the caller says
    const t = world();
    const test2 = await acceptSubmission(found({ test: true }), { ...BODY }, { ...t.caller, publicForm: true }, TEST_LINK_SUBMISSION, t.deps);
    assert.equal(test2.work.publicForm, false);
    assert.deepEqual(t.log.notices, ['u1']);
});

test('startSubmission runs the queue\'s own submit call with the kind of run, and announces the run at once', async () => {
    const calls = [];
    const runner = { executeAutomation: async (automation, opts) => { calls.push(opts); await opts.onRunCreated({ id: 'run9' }); return { id: 'run9', status: 'success' }; } };
    const store = { attachFormSessionRun: async () => {}, updateRun: async () => true };
    const formWork = createFormWork({ automationStore: store, runner: () => runner, formAnswers: () => ({}) });
    const { deps, caller } = world();
    const f = found({ test: true });
    const dry = await acceptSubmission(f, { ...BODY }, caller, BUILDER_DRY_SUBMISSION, deps);
    const announced = [];
    const run = await startSubmission(f, dry, (r) => announced.push(r.id), formWork);
    assert.equal(run.id, 'run9');
    assert.deepEqual(announced, ['run9']);
    assert.equal(calls[0].mode, 'dry_run');
    assert.equal(calls[0].pausesRequested, true);
    assert.equal(calls[0].origin, 'builder');
    assert.equal(calls[0].triggerKind, 'form');
    assert.equal(calls[0].startedByUserId, 'u1');
    assert.equal(calls[0].triggerHeaders.test, true);

    const live = await acceptSubmission(f, { ...BODY }, caller, TEST_LINK_SUBMISSION, deps);
    await startSubmission(f, live, null, formWork);
    assert.equal(calls[1].isTest, true);
    assert.equal(calls[1].origin, 'test_link');
    assert.equal(calls[1].mode, undefined);
});

test('stoppingAfter bounds the run to one step (untilStepId + a root "up to" scope); no step leaves the work as it was', async () => {
    const calls = [];
    const runner = { executeAutomation: async (automation, opts) => { calls.push(opts); return { id: 'run1', status: 'success' }; } };
    const formWork = createFormWork({ automationStore: { attachFormSessionRun: async () => {}, updateRun: async () => true }, runner: () => runner, formAnswers: () => ({}) });
    const { deps, caller } = world();
    const f = found({ test: true });
    const dry = await acceptSubmission(f, { ...BODY }, caller, BUILDER_DRY_SUBMISSION, deps);
    assert.equal(stoppingAfter(dry, null), dry);
    const bounded = stoppingAfter(dry, 'step2');
    assert.equal(bounded.work.untilStepId, 'step2');
    assert.equal(dry.work.untilStepId, undefined, 'the accepted work itself is not changed');
    await startSubmission(f, bounded, null, formWork);
    assert.equal(calls[0].untilStepId, 'step2');
    assert.deepEqual(calls[0].partial, { mode: 'upTo', targetStepId: 'step2', scope: 'root' });
    assert.equal(calls[0].mode, 'dry_run');
    await startSubmission(f, dry, null, formWork);
    assert.equal(calls[1].untilStepId, undefined);
    assert.equal(calls[1].partial, undefined);
});
