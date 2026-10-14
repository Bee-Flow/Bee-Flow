'use strict';

/**
 * Before the first submission (formPublic/page.js): the render config, a
 * scanned upload (page one and a later page), and an `app_pick` search box.
 *
 * Harness: formPublic.testkit.js (mocks first, then the real router).
 *
 * Run: node --test routes/automation/formPublic/page.test.js
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const {
    TOKEN,
    OTHER_TOKEN,
    FORM,
    PAGE_2,
    state,
    resetState,
    issueCsrf,
    UPLOAD_QUOTA_FILES,
    getForm,
    postUpload,
    postPick,
    makeRes,
    makeReq,
    uploadReq,
    startSession,
    awaitingRun,
    withPickForm,
} = require('./formPublic.testkit');

beforeEach(resetState);

// ── GET ───────────────────────────────────────────────

test('GET returns the render config, a CSRF token and no-store headers', async () => {
    const res = makeRes();
    await getForm(makeReq(), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.form.title, 'Contact us');
    assert.deepStrictEqual(res.body.form.fields.map(f => f.name), ['email', 'topic', 'attachment']);
    assert.ok(res.body.csrf);
    assert.match(res.headers['cache-control'], /no-store/);
    assert.match(res.headers['x-robots-tag'], /noindex/);
});

// ── BFSF-437: multiPage must see a form_page inside a flowlet ────────────────
//
// A form_page can live inside definition.layers[key].steps (an inline flowlet
// reached from the trigger via call_layer), and the runtime dispatcher walks
// into layers and pauses there correctly. This route's multiPage flag used to
// scan only the top-level definition.steps, so a visitor never saw the flag
// flip — they got the single-page thank-you card while the run sat paused on
// the flowlet's form_page forever, with no way to resume it.

test('multiPage is true when the only form_page step lives inside a flowlet', async () => {
    state.definitionOverride = {
        trigger: { id: 'trg', type: 'trigger', kind: 'form', form: FORM },
        steps: [
            { id: 'cl1', type: 'call_layer', layerKey: 'followup' },
        ],
        layers: {
            followup: {
                steps: [
                    { id: 'fp1', type: 'form_page', form: PAGE_2 },
                ],
            },
        },
    };
    const res = makeRes();
    await getForm(makeReq(), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.form.multiPage, true,
        'a form_page nested in a call_layer flowlet must still flip the flag');
});

test('multiPage is false for a single-page form with no form_page step anywhere', async () => {
    // The default fixture definition (trigger only, no steps/layers) is the
    // baseline: nothing here is a form_page, on the trigger or off it.
    const res = makeRes();
    await getForm(makeReq(), res);
    assert.strictEqual(res.body.form.multiPage, false);
});

test('multiPage does not false-positive on the trigger itself', async () => {
    // walkAllSteps also visits triggers (isTrigger=true), but a trigger carries
    // `type: 'trigger'` with a separate `kind` field (e.g. 'form') — never
    // `type: 'form_page'` — so a form whose ONLY node is its trigger must read
    // as single-page.
    state.definitionOverride = { trigger: { id: 'trg', type: 'trigger', kind: 'form', form: FORM } };
    const res = makeRes();
    await getForm(makeReq(), res);
    assert.strictEqual(res.body.form.multiPage, false);
});

// ── uploads ───────────────────────────────────────────

test('a clean upload is stored and ledgered, and returns a fileId', async () => {
    const res = makeRes();
    await postUpload(uploadReq(), res);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.fileId);
    assert.strictEqual(res.body.filename, 'note.pdf');
    assert.strictEqual(state.uploaded.length, 1);
    // Owner-prefixed so anonymous bytes are attributed to the automation's owner.
    assert.match(state.uploaded[0], /^automation-forms\/owner1\/auto1\//);
});

test('a dirty scan deletes the blob, writes no ledger row and answers 422', async () => {
    state.scanClean = false;
    const res = makeRes();
    await postUpload(uploadReq(), res);
    assert.strictEqual(res.statusCode, 422);
    assert.strictEqual(state.uploads.size, 0);
    assert.strictEqual(state.deleted.length, 1);
    assert.strictEqual(state.deleted[0], state.uploaded[0]);
});

test('a file bigger than the field allows is refused', async () => {
    const res = makeRes();
    await postUpload(uploadReq({ file: { buffer: Buffer.alloc(8), size: 6 * 1024 * 1024, mimetype: 'application/pdf', originalname: 'big.pdf' } }), res);
    assert.strictEqual(res.statusCode, 413);
    assert.strictEqual(state.uploaded.length, 0);
});

test('the per-form quota stops an anonymous flood', async () => {
    state.usage = { files: UPLOAD_QUOTA_FILES, bytes: 0 };
    const res = makeRes();
    await postUpload(uploadReq(), res);
    assert.strictEqual(res.statusCode, 429);
    assert.strictEqual(state.uploaded.length, 0);
});

test('uploads need a valid CSRF token too', async () => {
    const res = makeRes();
    await postUpload(uploadReq({ body: { csrf: 'nope', field: 'attachment' } }), res);
    assert.strictEqual(res.statusCode, 403);
});

test('an upload on page two is checked against the PAGE fields, not the trigger fields', async () => {
    state.runQueue = [{ id: 'runK' }];
    const sid = await startSession();
    awaitingRun('runK', 'fp1', PAGE_2);

    const res = makeRes();
    await postUpload(makeReq({
        body: { csrf: issueCsrf(`${TOKEN}:${sid}`), sessionId: sid, field: 'proof' },
        file: { buffer: Buffer.from('pdf'), size: 3, mimetype: 'application/pdf', originalname: 'p.pdf' },
    }), res);

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.ok(res.body.fileId);

    // A session upload must carry the session-bound CSRF, not page one's.
    const wrong = makeRes();
    await postUpload(makeReq({
        body: { csrf: issueCsrf(TOKEN), sessionId: sid, field: 'proof' },
        file: { buffer: Buffer.from('pdf'), size: 3, mimetype: 'application/pdf', originalname: 'p.pdf' },
    }), wrong);
    assert.strictEqual(wrong.statusCode, 403);
});

// ── POST /pick — an app_pick question's search box ────

test('the browser names a QUESTION; which app that is comes from the declaration', async () => {
    // This is the difference between a picker and "run any integration tool as
    // me": nothing in the request body can steer the search at another app.
    withPickForm();
    const res = makeRes();
    await postPick(makeReq({ body: { csrf: issueCsrf(TOKEN), field: 'call', query: 'kickoff', source: 'gmail_message', tool: 'gmail_send_email' } }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.results.map(r => r.id), ['tr_1']);
    assert.strictEqual(state.pickSearches.length, 1);
    assert.strictEqual(state.pickSearches[0].source, 'fireflies_transcript', 'the declared source, not the body\'s');
    assert.strictEqual(state.pickSearches[0].query, 'kickoff');
});

test('the search runs as the signed-in FILLER, with their own org and groups', async () => {
    withPickForm();
    const res = makeRes();
    await postPick(makeReq({ body: { csrf: issueCsrf(TOKEN), field: 'call', query: '' } }), res);
    const { caller } = state.pickSearches[0];
    assert.strictEqual(caller.userId, 'colleague1', 'never the automation owner');
    assert.deepStrictEqual(caller.orgIds, ['org1']);
    assert.deepStrictEqual(caller.userGroupIds, ['g1']);
});

test('a question this page does not ask cannot be searched', async () => {
    withPickForm();
    for (const field of ['email', 'nope', '', undefined]) {
        const res = makeRes();
        await postPick(makeReq({ body: { csrf: issueCsrf(TOKEN), field, query: 'x' } }), res);
        assert.strictEqual(res.statusCode, 400, `field ${JSON.stringify(field)} should be refused`);
    }
    assert.strictEqual(state.pickSearches.length, 0);
});

test('a bad CSRF is refused, and a token that is not a form 404s', async () => {
    withPickForm();
    const bad = makeRes();
    await postPick(makeReq({ body: { csrf: 'nope', field: 'call' } }), bad);
    assert.strictEqual(bad.statusCode, 403);

    const missing = makeRes();
    await postPick(makeReq({ token: OTHER_TOKEN, body: { csrf: issueCsrf(OTHER_TOKEN), field: 'call' } }), missing);
    assert.strictEqual(missing.statusCode, 404);
    assert.strictEqual(state.pickSearches.length, 0);
});

test('someone who may not open the form may not search from it either', async () => {
    withPickForm();
    const res = makeRes();
    await postPick(makeReq({ body: { csrf: issueCsrf(TOKEN), field: 'call' }, session: { user: { id: 'outsider', organizationId: 'org2' } } }), res);
    // 404, like every other refusal on this surface: probing must not tell
    // "not yours" from "does not exist".
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(state.pickSearches.length, 0);
});

test('"that app is not connected for you" comes back as a reason, not a failure', async () => {
    // It is something the picker prints beside the search box; a 4xx would make
    // the client guess whether the form itself was broken.
    withPickForm();
    state.pickSearchError = 'Fireflies is not connected for your account.';
    const res = makeRes();
    await postPick(makeReq({ body: { csrf: issueCsrf(TOKEN), field: 'call' } }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.results, []);
    assert.match(res.body.error, /not connected/);
});
