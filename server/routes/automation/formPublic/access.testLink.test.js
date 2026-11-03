'use strict';

/**
 * A form's TEST LINK on /f/<token> (formPublic/access.js loadTestForm) and the
 * "not live yet" answer for an editor (studio F9, F10):
 *
 *   - a person on the test link's audience gets the WORKING copy, while the
 *     automation is a draft, off, or live with unpublished questions;
 *   - everyone else, an expired link and a revoked one get the 404 an unknown
 *     token gets;
 *   - a submission through it is a TEST run started by the submitter, with
 *     headers.test, an is_test session and no submission counted;
 *   - the production link of a form that is not live answers its editor 409
 *     form_not_live, and everybody else the same 404 as before.
 *
 * Harness: formPublic.testkit.js (mocks first, then the real router).
 * Run: cd server && node --test routes/automation/formPublic/access.testLink.test.js
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const {
    OTHER_TOKEN, FORM, state, resetState, getForm, postSubmit, makeRes, makeReq, submissionBody, issueCsrf, flushAsync,
} = require('./formPublic.testkit');

const TEST = 'd'.repeat(48);
const TESTER = { user: { id: 'tester1', organizationId: 'org1' } };
const WORKING = { trigger: { id: 'trg', type: 'trigger', kind: 'form', form: { ...FORM, title: 'New questions' } } };
const LIVE = { trigger: { id: 'trg', type: 'trigger', kind: 'form', form: { ...FORM, title: 'Old questions' } } };

/** A test link for `tester1` (and, by the audience rule, the owner). */
function putTestLink(over = {}) {
    state.pages = {
        [TEST]: {
            id: TEST, automationId: 'auto1', triggerStepId: null, submissions: 0, isTest: true,
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            who: { userId: 'owner1', organizationId: 'org1', audience: 'restricted', sharedUserIds: ['tester1'], sharedGroups: [] },
            ...over,
        },
    };
}

beforeEach(() => { resetState(); putTestLink(); });

test('a tester gets the WORKING copy through the test link while the automation is a draft and off', async () => {
    state.active = false;
    state.draft = true;
    state.definitionOverride = WORKING;
    const res = makeRes();
    await getForm(makeReq({ token: TEST, session: TESTER }), res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.test, true, 'the page shows the Test banner');
    assert.strictEqual(res.body.form.title, 'New questions');
});

test('on a live automation the test link serves the working copy and the production link the live one', async () => {
    state.definitionOverride = WORKING;
    state.liveDefinition = LIVE;
    const viaTest = makeRes();
    await getForm(makeReq({ token: TEST, session: TESTER }), viaTest);
    assert.strictEqual(viaTest.body.form.title, 'New questions');
    const viaProduction = makeRes();
    await getForm(makeReq({ session: { user: { id: 'colleague1', organizationId: 'org1' } } }), viaProduction);
    assert.strictEqual(viaProduction.statusCode, 200);
    assert.strictEqual(viaProduction.body.form.title, 'Old questions');
    assert.strictEqual(viaProduction.body.test, undefined, 'the production page is no test');
});

test('somebody not on the test link, an outsider, an expired and a revoked link all get the unknown token\'s 404', async () => {
    const unknown = makeRes();
    await getForm(makeReq({ token: OTHER_TOKEN, session: TESTER }), unknown);
    assert.strictEqual(unknown.statusCode, 404);

    const colleague = makeRes();
    await getForm(makeReq({ token: TEST, session: { user: { id: 'colleague2', organizationId: 'org1' } } }), colleague);
    assert.strictEqual(colleague.statusCode, 404);
    assert.deepStrictEqual(colleague.body, unknown.body);

    const outsider = makeRes();
    await getForm(makeReq({ token: TEST, session: { user: { id: 'tester1', organizationId: 'other-org' } } }), outsider);
    assert.strictEqual(outsider.statusCode, 404, 'the organisation stays the outer wall');

    putTestLink({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const expired = makeRes();
    await getForm(makeReq({ token: TEST, session: TESTER }), expired);
    assert.strictEqual(expired.statusCode, 404);
    assert.deepStrictEqual(expired.body, unknown.body);

    state.pages = {};
    const revoked = makeRes();
    await getForm(makeReq({ token: TEST, session: TESTER }), revoked);
    assert.strictEqual(revoked.statusCode, 404);
});

test('a submission through the test link is a test run of the submitter: headers.test, an is_test session, no counter', async () => {
    state.active = false;
    const res = makeRes();
    await postSubmit(makeReq({ token: TEST, session: TESTER, body: { ...submissionBody(), csrf: issueCsrf(TEST), nonce: 'testlink1' } }), res);
    await flushAsync();
    assert.strictEqual(res.statusCode, 202, JSON.stringify(res.body));
    assert.ok(res.body.sessionId);
    assert.strictEqual(state.touched, 0, 'a test is not a submission');
    const session = state.sessions.get(res.body.sessionId);
    assert.strictEqual(session.isTest, true);
    assert.strictEqual(session.formPageId, TEST);
    assert.strictEqual(state.executions.length, 1);
    const { opts } = state.executions[0];
    assert.strictEqual(opts.isTest, true);
    assert.strictEqual(opts.origin, 'test_link');
    assert.strictEqual(opts.startedByUserId, 'tester1', 'the tester holds the sandbox seat');
    assert.strictEqual(opts.triggerKind, 'form');
    assert.strictEqual(opts.triggerHeaders.test, true);
    assert.strictEqual(opts.triggerHeaders.form_page_id, TEST);
    assert.strictEqual(opts.triggerPayload.email, 'a@b.nl', 'the same coercion as a real submission');
});

test('a production submission is unchanged: counted, no test header, a production run', async () => {
    const res = makeRes();
    await postSubmit(makeReq({ body: submissionBody({ nonce: 'prod1' }) }), res);
    await flushAsync();
    assert.strictEqual(res.statusCode, 202);
    assert.strictEqual(state.touched, 1);
    const { opts } = state.executions[0];
    assert.strictEqual(opts.isTest, undefined);
    assert.strictEqual(opts.origin, undefined);
    assert.strictEqual(opts.triggerHeaders.test, undefined);
    assert.strictEqual(state.sessions.get(res.body.sessionId).isTest, false);
});

test('the production link of a form that is not live: its editor is told so (409), anyone else gets the 404', async () => {
    state.active = false;
    const owner = makeRes();
    await getForm(makeReq({ session: { user: { id: 'owner1', organizationId: 'org1' } } }), owner);
    assert.strictEqual(owner.statusCode, 409);
    assert.strictEqual(owner.body.code, 'form_not_live');
    assert.strictEqual(owner.body.isActive, false);
    assert.strictEqual(owner.body.isDraft, false);

    const colleague = makeRes();
    await getForm(makeReq({ session: { user: { id: 'colleague1', organizationId: 'org1' } } }), colleague);
    assert.strictEqual(colleague.statusCode, 404);
    assert.deepStrictEqual(colleague.body, { error: 'Not found' });
});
