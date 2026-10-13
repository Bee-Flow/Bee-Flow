'use strict';

/**
 * Who may open a hosted form (formPublic/access.js): signed-in members of the
 * owning organisation and the form's audience only, and every miss the same 404.
 *
 * Harness: formPublic.testkit.js (mocks first, then the real router).
 *
 * Run: node --test routes/automation/formPublic/access.test.js
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const {
    OTHER_TOKEN,
    state,
    resetState,
    getForm,
    postSubmit,
    makeRes,
    makeReq,
    submissionBody,
} = require('./formPublic.testkit');

beforeEach(resetState);

// ── signed-in only ────────────────────────────────────
//
// The form used to be open to whoever held the link. It is now reachable only
// from inside the workspace, by a signed-in member of the organisation that
// owns it (PUBLIC_FORMS_ENABLED in formPublic.js). Everything below answers
// 404 rather than 403 — the same answer an unknown token gets, so probing
// cannot tell "not yours" from "does not exist".

test('an anonymous visitor holding the link gets nothing', async () => {
    const res = makeRes();
    await getForm(makeReq({ session: null }), res);
    assert.strictEqual(res.statusCode, 404);
});

test('a signed-in user from another organisation gets nothing either', async () => {
    const res = makeRes();
    await getForm(makeReq({ session: { user: { id: 'outsider', organizationId: 'other-org' } } }), res);
    assert.strictEqual(res.statusCode, 404);
});

test('a colleague in the owning organisation may open it', async () => {
    // Org membership is the boundary: if you can see the form in the Forms
    // menu, you can open it — you need not be the one who built it.
    const res = makeRes();
    await getForm(makeReq({ session: { user: { id: 'colleague2', organizationId: 'org1' } } }), res);
    assert.strictEqual(res.statusCode, 200);
});

test('with no organisation on the owner, only the owner may open it', async () => {
    // Matching "no org" to "no org" would let every orgless account on a
    // shared install open each other's forms.
    state.audience = { userId: 'owner1', organizationId: null };
    const stranger = makeRes();
    await getForm(makeReq({ session: { user: { id: 'someone', organizationId: null } } }), stranger);
    assert.strictEqual(stranger.statusCode, 404);

    const owner = makeRes();
    await getForm(makeReq({ session: { user: { id: 'owner1', organizationId: null } } }), owner);
    assert.strictEqual(owner.statusCode, 200);
});

test('a RESTRICTED form opens for the owner, the people listed and the members of a listed group — and for nobody else in the organisation', async () => {
    state.audience = { userId: 'owner1', organizationId: 'org1', audience: 'restricted', sharedUserIds: ['pat'], sharedGroups: ['grp-finance'] };
    state.groupsOf = { sam: ['grp-finance'], colleague2: ['grp-sales'] };

    const listed = makeRes();
    await getForm(makeReq({ session: { user: { id: 'pat', organizationId: 'org1' } } }), listed);
    assert.strictEqual(listed.statusCode, 200);
    // a person listed by id never needs a group read
    assert.strictEqual(state.groupReads, 0);

    const member = makeRes();
    await getForm(makeReq({ session: { user: { id: 'sam', organizationId: 'org1' } } }), member);
    assert.strictEqual(member.statusCode, 200);
    assert.strictEqual(state.groupReads, 1);

    const other = makeRes();
    await getForm(makeReq({ session: { user: { id: 'colleague2', organizationId: 'org1' } } }), other);
    // same answer an unknown token gets — no "not yours" to probe for
    assert.strictEqual(other.statusCode, 404);

    const owner = makeRes();
    await getForm(makeReq({ session: { user: { id: 'owner1', organizationId: 'org1' } } }), owner);
    assert.strictEqual(owner.statusCode, 200);

    // outside the organisation the list does not matter
    state.groupsOf.outsider = ['grp-finance'];
    const outsider = makeRes();
    await getForm(makeReq({ session: { user: { id: 'outsider', organizationId: 'other-org' } } }), outsider);
    assert.strictEqual(outsider.statusCode, 404);
});

test('a restricted form with nobody on it is the owner\'s alone', async () => {
    state.audience = { userId: 'owner1', organizationId: 'org1', audience: 'restricted', sharedUserIds: [], sharedGroups: [] };
    const res = makeRes();
    await getForm(makeReq({ session: { user: { id: 'colleague2', organizationId: 'org1' } } }), res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(state.groupReads, 0);
});

test('submitting is gated too, not just rendering', async () => {
    // The gate lives in loadForm, so every endpoint inherits it — a caller who
    // cannot render the form cannot post to it either.
    const res = makeRes();
    await postSubmit(makeReq({ body: submissionBody(), session: { user: { id: 'outsider', organizationId: 'other-org' } } }), res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(state.executions.length, 0, 'no run started');
});

test('an unknown token, a paused automation and a non-form trigger are all the SAME 404', async () => {
    // Distinguishing them would turn the endpoint into an oracle for "does this
    // token exist".
    const unknown = makeRes();
    await getForm(makeReq({ token: OTHER_TOKEN }), unknown);
    assert.strictEqual(unknown.statusCode, 404);

    state.active = false;
    const paused = makeRes();
    await getForm(makeReq(), paused);
    assert.strictEqual(paused.statusCode, 404);
    assert.deepStrictEqual(paused.body, unknown.body);

    state.active = true;
    state.triggerKind = 'webhook';
    const wrongKind = makeRes();
    await getForm(makeReq(), wrongKind);
    assert.strictEqual(wrongKind.statusCode, 404);
    assert.deepStrictEqual(wrongKind.body, unknown.body);
});

test('a malformed token never reaches the database', async () => {
    const res = makeRes();
    await getForm(makeReq({ token: '../../etc/passwd' }), res);
    assert.strictEqual(res.statusCode, 404);
});
