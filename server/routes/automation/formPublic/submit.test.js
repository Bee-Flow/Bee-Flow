'use strict';

/**
 * Answers coming in (formPublic/submit.js): the first submission, a later
 * page's answers resuming the paused run, the queue both go through, and
 * picked records reaching the run.
 *
 * Harness: formPublic.testkit.js (mocks first, then the real router).
 *
 * Run: node --test routes/automation/formPublic/submit.test.js
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const {
    SERVER,
    TOKEN,
    OTHER_TOKEN,
    PAGE_2,
    state,
    resetState,
    putRun,
    router,
    issueCsrf,
    MIN_FORM_AGE_MS,
    HONEYPOT_FIELD,
    MAX_SUBMISSION_BYTES,
    QUEUE_DEPTH,
    postUpload,
    postSubmit,
    postPick,
    getSession,
    postSession,
    makeRes,
    makeReq,
    flushAsync,
    submissionBody,
    uploadReq,
    startSession,
    awaitingRun,
    withPickForm,
} = require('./formPublic.testkit');

beforeEach(resetState);

// ── submit ────────────────────────────────────────────

test('a valid submission starts exactly one run with the answers on trigger.output', async () => {
    const res = makeRes();
    await postSubmit(makeReq({ body: submissionBody() }), res);
    await flushAsync();
    assert.strictEqual(res.statusCode, 202);
    assert.strictEqual(state.executions.length, 1);
    const { opts } = state.executions[0];
    assert.strictEqual(opts.triggerKind, 'form');
    assert.strictEqual(opts.triggerPayload.email, 'a@b.nl');
    assert.strictEqual(opts.triggerPayload.topic, 'Sales');
    assert.strictEqual(state.touched, 1);
});

test('submission metadata rides on trigger.headers, never inside trigger.output', async () => {
    // A form with a field called `submitted_at` must not be shadowed by ours.
    await postSubmit(makeReq({ body: submissionBody() }), makeRes());
    await flushAsync();
    const { opts } = state.executions[0];
    assert.strictEqual(opts.triggerHeaders.form_page_id, TOKEN);
    assert.ok(opts.triggerHeaders.submitted_at);
    assert.strictEqual(opts.triggerPayload.submitted_at, undefined);
    assert.strictEqual(opts.triggerPayload.form_page_id, undefined);
});

test('a bad or missing CSRF token is refused', async () => {
    const missing = makeRes();
    await postSubmit(makeReq({ body: { email: 'a@b.nl' } }), missing);
    assert.strictEqual(missing.statusCode, 403);

    const wrongForm = makeRes();
    await postSubmit(makeReq({ body: submissionBody({ csrf: issueCsrf(OTHER_TOKEN) }) }), wrongForm);
    assert.strictEqual(wrongForm.statusCode, 403);
    assert.strictEqual(state.executions.length, 0);
});

test('the honeypot answers 200 and runs nothing — the bot learns no difference', async () => {
    const res = makeRes();
    await postSubmit(makeReq({ body: submissionBody({ [HONEYPOT_FIELD]: 'http://spam' }) }), res);
    await flushAsync();
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { accepted: true });
    assert.strictEqual(state.executions.length, 0);
});

test('a submission posted faster than a human could type is silently dropped', async () => {
    const res = makeRes();
    await postSubmit(makeReq({ body: submissionBody({ issuedAt: Date.now() }) }), res);
    await flushAsync();
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(state.executions.length, 0);
});

test('every missing/invalid answer comes back per field, with no run', async () => {
    const res = makeRes();
    await postSubmit(makeReq({ body: submissionBody({ email: '', topic: 'Billing' }) }), res);
    await flushAsync();
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.body.fields.map(f => f.field).sort(), ['email', 'topic']);
    assert.strictEqual(state.executions.length, 0);
});

test('a replayed nonce is accepted but does NOT run a second time', async () => {
    const body = submissionBody({ nonce: 'abcd1234' });
    const first = makeRes();
    await postSubmit(makeReq({ body }), first);
    await flushAsync();
    assert.strictEqual(first.statusCode, 202);

    const second = makeRes();
    await postSubmit(makeReq({ body: { ...body, issuedAt: body.issuedAt } }), second);
    await flushAsync();
    assert.strictEqual(second.statusCode, 200);
    assert.strictEqual(second.body.duplicate, true);
    assert.strictEqual(state.executions.length, 1);
});

test('an oversized body is refused before it is looked at', async () => {
    const guard = router.stack
        .find(l => l.route?.path === '/form/:token' && l.route.methods.post)
        .route.stack.map(s => s.handle)
        .find(h => h.name === 'contentLengthGuard');
    const res = makeRes();
    let nexted = false;
    guard(makeReq({ headers: { 'content-length': String(MAX_SUBMISSION_BYTES + 1) } }), res, () => { nexted = true; });
    assert.strictEqual(res.statusCode, 413);
    assert.strictEqual(nexted, false);
});

test('concurrent submissions all run — the runner would have cancelled the second', async () => {
    // automationRunner single-flights live runs, so without the FIFO the second
    // visitor's answer is silently thrown away.
    let release;
    const gate = new Promise(r => { release = r; });
    state.resolveRun = () => gate;

    const r1 = makeRes(); const r2 = makeRes(); const r3 = makeRes();
    await postSubmit(makeReq({ body: submissionBody({ nonce: 'n1', email: 'one@b.nl' }) }), r1);
    await postSubmit(makeReq({ body: submissionBody({ nonce: 'n2', email: 'two@b.nl' }) }), r2);
    await postSubmit(makeReq({ body: submissionBody({ nonce: 'n3', email: 'three@b.nl' }) }), r3);
    assert.deepStrictEqual([r1.statusCode, r2.statusCode, r3.statusCode], [202, 202, 202]);
    // Serialised: only the first is in flight while the gate is shut.
    await flushAsync();
    assert.strictEqual(state.executions.length, 1);

    state.resolveRun = null;
    release();
    await flushAsync();
    await flushAsync();
    assert.strictEqual(state.executions.length, 3);
    assert.deepStrictEqual(
        state.executions.map(e => e.opts.triggerPayload.email),
        ['one@b.nl', 'two@b.nl', 'three@b.nl'],
    );
});

test('a full queue answers 503 rather than dropping the submission silently', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    state.resolveRun = () => gate;
    for (let i = 0; i < QUEUE_DEPTH + 1; i += 1) {
        await postSubmit(makeReq({ body: submissionBody({ nonce: `q${i}` }) }), makeRes());
    }
    const overflow = makeRes();
    // The handler throws; the terminal handler turns it into the 503 body.
    await assert.rejects(
        postSubmit(makeReq({ body: submissionBody({ nonce: 'overflow' }) }), overflow),
        (e) => e.status === 503 && e.code === 'form_busy' && /busy right now/.test(e.message),
    );
    assert.strictEqual(overflow.statusCode, 200, 'nothing was answered directly');
    state.resolveRun = null;
    release();
    await flushAsync();
});

test('a submission claims its upload exactly once and carries a descriptor, never bytes', async () => {
    const up = makeRes();
    await postUpload(uploadReq(), up);
    const { fileId } = up.body;

    const res = makeRes();
    await postSubmit(makeReq({ body: submissionBody({ nonce: 'f1', attachment: { kind: 'form_upload', fileId } }) }), res);
    await flushAsync();
    assert.strictEqual(res.statusCode, 202);
    const value = state.executions[0].opts.triggerPayload.attachment;
    assert.strictEqual(value.kind, 'form_upload');
    assert.strictEqual(value.filename, 'note.pdf');
    assert.strictEqual(value.buffer, undefined);

    // A second submission cannot re-claim the same file.
    const again = makeRes();
    await postSubmit(makeReq({ body: submissionBody({ nonce: 'f2', attachment: { kind: 'form_upload', fileId } }) }), again);
    await flushAsync();
    assert.strictEqual(again.statusCode, 400);
    assert.strictEqual(again.body.fields[0].field, 'attachment');
    assert.strictEqual(state.executions.length, 1);
});

test('a file id from another form cannot be attached here', async () => {
    state.uploads.set('foreign', { id: 'foreign', formPageId: OTHER_TOKEN, filename: 'x', claimedAt: null });
    const res = makeRes();
    await postSubmit(makeReq({ body: submissionBody({ nonce: 'x1', attachment: { kind: 'form_upload', fileId: 'foreign' } }) }), res);
    await flushAsync();
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(state.executions.length, 0);
});

test('answering page two resumes the paused run with the coerced answers', async () => {
    state.runQueue = [{ id: 'runE' }];
    const sid = await startSession();
    awaitingRun('runE', 'fp1', PAGE_2);

    state.runQueue = [{ id: 'runE2' }];
    const res = makeRes();
    await postSession(makeReq({
        sid,
        body: { csrf: issueCsrf(`${TOKEN}:${sid}`), nonce: 'p2a', address: 'Main Street 1', ignored: 'nope' },
    }), res);
    await flushAsync();

    assert.strictEqual(res.statusCode, 202);
    assert.strictEqual(state.resumes.length, 1);
    const [resume] = state.resumes;
    assert.strictEqual(resume.runId, 'runE');
    assert.strictEqual(resume.stepId, 'fp1');
    assert.deepEqual({ ...resume.opts.decision }, { address: 'Main Street 1', proof: null });
    // Undeclared keys never reach the flow.
    assert.strictEqual('ignored' in resume.opts.decision, false);
    // The session follows the CHILD run, so the next poll watches the right one.
    assert.strictEqual(state.sessions.get(sid).runId, 'runE2');
});

test('the resume carries rootStepId and triggerHeaders back into the run', async () => {
    // Neither survives on the run row; without them a form on a secondary
    // trigger resumes from the wrong node and trigger.headers.* goes blank.
    state.runQueue = [{ id: 'runF' }];
    const sid = await startSession();
    awaitingRun('runF', 'fp1', PAGE_2);

    const res = makeRes();
    await postSession(makeReq({ sid, body: { csrf: issueCsrf(`${TOKEN}:${sid}`), nonce: 'p2b', address: 'x' } }), res);
    await flushAsync();

    const { opts } = state.resumes[0];
    assert.strictEqual(opts.rootStepId, null);
    assert.strictEqual(opts.triggerHeaders.form_page_id, TOKEN);
    assert.ok(opts.triggerHeaders.submitted_at);
});

test('a missing required answer is rejected per field and the run stays paused', async () => {
    state.runQueue = [{ id: 'runG' }];
    const sid = await startSession();
    awaitingRun('runG', 'fp1', PAGE_2);

    const res = makeRes();
    await postSession(makeReq({ sid, body: { csrf: issueCsrf(`${TOKEN}:${sid}`), nonce: 'p2c', address: '' } }), res);
    await flushAsync();

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.fields[0].field, 'address');
    assert.strictEqual(state.resumes.length, 0, 'the run is still waiting for a real answer');
});

test('page two CSRF is bound to the session, so page one\'s token is not enough', async () => {
    state.runQueue = [{ id: 'runH' }];
    const sid = await startSession();
    awaitingRun('runH', 'fp1', PAGE_2);

    const res = makeRes();
    await postSession(makeReq({ sid, body: { csrf: issueCsrf(TOKEN), nonce: 'p2d', address: 'x' } }), res);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(state.resumes.length, 0);
});

test('a double-clicked page two resumes exactly once', async () => {
    state.runQueue = [{ id: 'runI' }];
    const sid = await startSession();
    awaitingRun('runI', 'fp1', PAGE_2);

    const body = { csrf: issueCsrf(`${TOKEN}:${sid}`), nonce: 'samenonce', address: 'x' };
    const first = makeRes();
    await postSession(makeReq({ sid, body }), first);
    await flushAsync();
    const second = makeRes();
    await postSession(makeReq({ sid, body }), second);
    await flushAsync();

    assert.strictEqual(first.statusCode, 202);
    assert.strictEqual(second.body.duplicate, true);
    assert.strictEqual(state.resumes.length, 1);
});

test('answering a run that is not paused is a 404, not a crash', async () => {
    state.runQueue = [{ id: 'runJ' }];
    const sid = await startSession();
    putRun('runJ', 'success');
    const res = makeRes();
    await postSession(makeReq({ sid, body: { csrf: issueCsrf(`${TOKEN}:${sid}`), address: 'x' } }), res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(state.resumes.length, 0);
});

test('resumes go through the SAME queue as first submissions — two visitors, no lost answers', async () => {
    // Without this the second unit of work races the first, the runner replies
    // "Skipped: automation already running", and a real person's answer is gone.
    let release;
    const gate = new Promise(r => { release = r; });
    state.resolveRun = () => gate;

    state.runQueue = [{ id: 'runL' }, { id: 'runM' }];
    const a = makeRes();
    await postSubmit(makeReq({ body: submissionBody({ nonce: 'q1' }) }), a);
    const b = makeRes();
    await postSubmit(makeReq({ body: submissionBody({ nonce: 'q2' }) }), b);
    await flushAsync();

    assert.strictEqual(a.statusCode, 202);
    assert.strictEqual(b.statusCode, 202);
    assert.strictEqual(state.executions.length, 1, 'the second waits its turn rather than racing');

    release();
    state.resolveRun = null;
    await flushAsync();
    await flushAsync();
    assert.strictEqual(state.executions.length, 2, 'and then it runs');
});

test('a run cancelled by another pod is retried instead of losing the answers', async () => {
    // Cross-pod: our in-memory queue cannot see theirs, so the runner hands
    // back a cancelled run. Backing off and retrying is the difference between
    // a slow form and a silently dropped submission.
    const { RETRY_DELAYS_MS } = router._constants;
    assert.ok(RETRY_DELAYS_MS.length >= 3, 'there is a real backoff ladder');

    state.runQueue = [
        { id: 'lost1', status: 'cancelled', error: 'Skipped: automation already running' },
        { id: 'won', status: 'success' },
    ];
    const sid = await startSession();

    // The first attempt lost the race; the queue keeps going in the background.
    await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[0] + 200));
    assert.strictEqual(state.executions.length, 2, 'it tried again');
    assert.strictEqual(state.sessions.get(sid).runId, 'won', 'and the session follows the run that stuck');
});

// ── W5-15: the PARENT run has to be closed out when a resume lands ──────────
//
// resumeFromStep starts a CHILD run and nothing finalised the parent, so it sat
// in 'awaiting_form' forever — until reapExpiredFormWaits flipped a form the
// visitor had actually COMPLETED to a "FormExpired" error and the owner's run
// history recorded a failure for a submission that worked. The approve-step
// endpoint has always closed its parent out this way.

test('completing a page finalises the parent run instead of leaving it awaiting_form', async () => {
    state.runQueue = [{ id: 'parent1' }, { id: 'child1' }];
    const sid = await startSession();
    awaitingRun('parent1', 'fp1', PAGE_2);

    const res = makeRes();
    await postSession(makeReq({
        sid,
        body: { csrf: issueCsrf(`${TOKEN}:${sid}`), nonce: 'p2', address: 'Main Street 1' },
    }), res);
    assert.strictEqual(res.statusCode, 202, JSON.stringify(res.body));
    await flushAsync();
    await flushAsync();

    assert.strictEqual(state.resumes.length, 1, 'the resume ran');
    const parent = state.runs.get('parent1');
    assert.strictEqual(parent.status, 'success',
        'the parent must not stay awaiting_form — the reaper would later call this a FormExpired failure');
    assert.strictEqual(parent.awaitingStepId, null, 'and it no longer advertises a step to resume from');
    assert.match(parent.summary, /child run child1/, 'the summary points at the run carrying the continuation');
});

test('the session follows the CHILD run before the parent is closed out', async () => {
    // Ordering matters: the poll reads session.runId. A parent flipped to
    // 'success' while the session still pointed at it would answer
    // `state: 'done'` and end the visitor's journey before the child had a
    // chance to serve the next page.
    state.runQueue = [{ id: 'parent2' }, { id: 'child2' }];
    const sid = await startSession();
    awaitingRun('parent2', 'fp1', PAGE_2);

    const res = makeRes();
    await postSession(makeReq({
        sid,
        body: { csrf: issueCsrf(`${TOKEN}:${sid}`), nonce: 'p3', address: 'Main Street 2' },
    }), res);
    await flushAsync();
    await flushAsync();

    assert.strictEqual(state.sessions.get(sid).runId, 'child2', 'the session now points at the child run');
    assert.strictEqual(state.runs.get('parent2').status, 'success');
});

test('a resume that LOST a cross-pod race leaves the parent paused for the retry', async () => {
    state.runQueue = [
        { id: 'parent3' },
        { id: 'lostChild', status: 'cancelled', error: 'Skipped: automation already running' },
        { id: 'child3' },
    ];
    const sid = await startSession();
    awaitingRun('parent3', 'fp1', PAGE_2);

    const res = makeRes();
    await postSession(makeReq({
        sid,
        body: { csrf: issueCsrf(`${TOKEN}:${sid}`), nonce: 'p4', address: 'Main Street 3' },
    }), res);
    assert.strictEqual(res.statusCode, 202);
    await flushAsync();

    assert.strictEqual(state.runs.get('parent3').status, 'awaiting_form',
        'finalising on a lost race would strand the answers the retry is about to deliver');

    const { RETRY_DELAYS_MS } = router._constants;
    await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[0] + 200));
    assert.strictEqual(state.resumes.length, 2, 'it tried again');
    assert.strictEqual(state.runs.get('parent3').status, 'success', 'and closed the parent out once it stuck');
});

// ── An ANSWERED page must not be served back while the resume is in flight ──
//
// The POST acks immediately and resumes in the background. Until the child run
// lands, the session still points at the parent — still `awaiting_form` on the
// step just answered — so the poll handed the same page straight back. The
// visitor answered it again, and every resubmission started ANOTHER child from
// the same parent: a two-question automation re-ran question one, and everything
// between the two questions, once per impatient click. On a slow step that
// window is tens of seconds wide, which is exactly when someone tries again.

test('the page just answered is not served again while the resume is still running', async () => {
    state.runQueue = [{ id: 'parentR' }, { id: 'childR' }];
    const sid = await startSession();
    awaitingRun('parentR', 'fp1', PAGE_2);

    // Hold the resume open, the way a 30-second research step would.
    let release;
    state.resolveRun = () => new Promise(r => { release = r; });

    const res = makeRes();
    await postSession(makeReq({
        sid,
        body: { csrf: issueCsrf(`${TOKEN}:${sid}`), nonce: 'race1', address: 'Main Street 9' },
    }), res);
    assert.strictEqual(res.statusCode, 202, JSON.stringify(res.body));
    await flushAsync();

    // Mid-flight: the run is still 'awaiting_form' and the session still points
    // at it. The visitor must be told to wait, not asked the same thing twice.
    const poll = makeRes();
    await getSession(makeReq({ sid }), poll);
    assert.strictEqual(poll.body.state, 'working',
        'the answered page must not come back — that is what made the visitor resubmit');

    release();
    state.resolveRun = null;
    await flushAsync();
    await flushAsync();
    assert.strictEqual(state.resumes.length, 1, 'exactly one resume, not one per poll');
});

test('a resume that never ran leaves the page answerable again', async () => {
    // The mirror image: clearing the pointer must not strand an answer on a run
    // nobody can reach. If resumeFromStep throws, the page goes back up.
    state.runQueue = [{ id: 'parentT' }];
    const sid = await startSession();
    awaitingRun('parentT', 'fp1', PAGE_2);

    state.resolveRun = async () => { throw new Error('runner exploded'); };

    const res = makeRes();
    await postSession(makeReq({
        sid,
        body: { csrf: issueCsrf(`${TOKEN}:${sid}`), nonce: 'race2', address: 'Main Street 10' },
    }), res);
    assert.strictEqual(res.statusCode, 202, JSON.stringify(res.body));
    await flushAsync();
    await flushAsync();
    state.resolveRun = null;

    assert.strictEqual(state.runs.get('parentT').awaitingStepId, 'fp1',
        'the visitor can answer again instead of being stuck on a silent failure');
});

// ── U3: accepted work survives a restart ─────────────────────────────────────
//
// The visitor is told 202 "received" before the run starts. The queue that
// held the work used to live only in this process's memory, so a deploy or a
// crash with submissions still waiting lost answers the visitor had already
// been thanked for. The work is now written onto the session row BEFORE the
// 202, and a sweep on any pod picks up work whose lease lapsed.

const formQueue = require(path.join(SERVER, 'automation/formQueue'));

/** Capture what the session rows held at the moment the 202 was sent. */
function ackSnapshot(res) {
    const status = res.status;
    res.atAck = null;
    res.status = (c) => {
        if (c === 202) res.atAck = [...state.sessions.values()].map(r => ({ id: r.id, pendingWork: r.pendingWork ? JSON.parse(JSON.stringify(r.pendingWork)) : null }));
        return status(c);
    };
    return res;
}

test('a submission is on its session row before the visitor is told it was received', async () => {
    const res = ackSnapshot(makeRes());
    await postSubmit(makeReq({ body: submissionBody({ nonce: 'persist1' }) }), res);
    assert.strictEqual(res.statusCode, 202, JSON.stringify(res.body));
    const row = res.atAck.find(r => r.id === res.body.sessionId);
    assert.ok(row?.pendingWork, 'the 202 went out with nothing a restart could recover');
    assert.strictEqual(row.pendingWork.kind, 'submit');
    assert.strictEqual(row.pendingWork.payload.email, 'a@b.nl');
    assert.strictEqual(row.pendingWork.submitterId, 'colleague1');

    await flushAsync();
    await flushAsync();
    assert.strictEqual(state.sessions.get(res.body.sessionId).pendingWork, null,
        'once its run exists the answers are not kept on the session as well');
});

test('a later page\'s answers are on the session row before the 202 as well', async () => {
    state.runQueue = [{ id: 'parentP' }, { id: 'childP' }];
    const sid = await startSession();
    awaitingRun('parentP', 'fp1', PAGE_2);

    let release;
    state.resolveRun = () => new Promise(r => { release = r; });
    const res = ackSnapshot(makeRes());
    await postSession(makeReq({
        sid,
        body: { csrf: issueCsrf(`${TOKEN}:${sid}`), nonce: 'persist2', address: 'Main Street 4' },
    }), res);
    assert.strictEqual(res.statusCode, 202, JSON.stringify(res.body));
    const row = res.atAck.find(r => r.id === sid);
    assert.deepStrictEqual(
        { kind: row.pendingWork.kind, parentRunId: row.pendingWork.parentRunId, stepId: row.pendingWork.stepId, address: row.pendingWork.values.address },
        { kind: 'resume', parentRunId: 'parentP', stepId: 'fp1', address: 'Main Street 4' },
    );
    await flushAsync();
    release();
    state.resolveRun = null;
    await flushAsync();
    await flushAsync();
});

test('submissions still queued when the pod died are run after the restart, and only those', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    state.resolveRun = () => gate;

    const a = makeRes();
    await postSubmit(makeReq({ body: submissionBody({ nonce: 'crash1', email: 'first@x.nl' }) }), a);
    const b = makeRes();
    await postSubmit(makeReq({ body: submissionBody({ nonce: 'crash2', email: 'second@x.nl' }) }), b);
    await flushAsync();
    assert.strictEqual(b.statusCode, 202, 'the second visitor was told their submission was received');
    assert.strictEqual(state.executions.length, 1, 'the second is still waiting in the queue');

    // The first one's run row exists (the runner created it before the pod went).
    putRun('runFirst', 'running');
    state.sessions.get(a.body.sessionId).runId = 'runFirst';

    // The pod dies: its memory is gone and its leases lapse.
    formQueue._reset();
    for (const row of state.sessions.values()) if (row.pendingWork) row.leaseUntil = 0;
    state.resolveRun = null;
    state.runQueue = [{ id: 'runSecond' }];

    const recovered = await formQueue.recoverPending();
    await flushAsync();
    await flushAsync();

    assert.strictEqual(recovered, 1, 'only the submission that never got a run is queued again');
    assert.strictEqual(state.executions.length, 2);
    const again = state.executions[1].opts;
    assert.strictEqual(again.triggerKind, 'form');
    assert.strictEqual(again.triggerPayload.email, 'second@x.nl', 'the run gets the answers the visitor sent');
    assert.strictEqual(again.triggerHeaders.form_page_id, TOKEN);
    assert.strictEqual(state.sessions.get(b.body.sessionId).runId, 'runSecond', 'and the visitor\'s poll follows it');
    assert.strictEqual(state.sessions.get(b.body.sessionId).pendingWork, null);
    assert.strictEqual(state.sessions.get(a.body.sessionId).pendingWork, null, 'the one that already ran is only cleared');

    release();
    await flushAsync();
});

test('a page answer still queued when the pod died resumes the paused run after the restart', async () => {
    state.runQueue = [{ id: 'parentQ' }];
    const sid = await startSession();
    awaitingRun('parentQ', 'fp1', PAGE_2);

    // Another visitor's run holds the queue, so the answer waits behind it.
    let release;
    const gate = new Promise(r => { release = r; });
    state.resolveRun = () => gate;
    const other = makeRes();
    await postSubmit(makeReq({ body: submissionBody({ nonce: 'crash3' }) }), other);
    const res = makeRes();
    await postSession(makeReq({
        sid,
        body: { csrf: issueCsrf(`${TOKEN}:${sid}`), nonce: 'crash4', address: 'Main Street 5' },
    }), res);
    await flushAsync();
    assert.strictEqual(res.statusCode, 202);
    assert.strictEqual(state.resumes.length, 0);

    putRun('runOther', 'running');
    state.sessions.get(other.body.sessionId).runId = 'runOther';
    formQueue._reset();
    for (const row of state.sessions.values()) if (row.pendingWork) row.leaseUntil = 0;
    state.resolveRun = null;
    state.runQueue = [{ id: 'childQ' }];

    await formQueue.recoverPending();
    await flushAsync();
    await flushAsync();

    assert.strictEqual(state.resumes.length, 1, 'the answer was delivered after all');
    assert.strictEqual(state.resumes[0].runId, 'parentQ');
    assert.strictEqual(state.resumes[0].stepId, 'fp1');
    assert.strictEqual(state.resumes[0].opts.decision.address, 'Main Street 5');
    assert.strictEqual(state.sessions.get(sid).runId, 'childQ');
    assert.strictEqual(state.runs.get('parentQ').status, 'success');

    release();
    await flushAsync();
});

// ── A picked record reaching the run ──────────────────

test('a submitted pick is re-read on the server, and the run gets the record', async () => {
    withPickForm();
    const res = makeRes();
    await postPick(makeReq({ body: { csrf: issueCsrf(TOKEN), field: 'call' } }), res);   // warm, not required

    const submit = makeRes();
    await postSubmit(makeReq({
        body: {
            csrf: issueCsrf(TOKEN),
            issuedAt: Date.now() - MIN_FORM_AGE_MS - 1000,
            email: 'a@b.nl',
            // The browser sends a reference. Any `text` it invented is dropped
            // by the contract before this point.
            call: { kind: 'app_pick', recordId: 'tr_1', title: 'Kickoff met Acme', text: 'I typed this myself' },
        },
    }), submit);
    assert.strictEqual(submit.statusCode, 202);
    await flushAsync();

    assert.strictEqual(state.pickReads.length, 1);
    assert.strictEqual(state.pickReads[0].pick.recordId, 'tr_1');
    assert.strictEqual(state.pickReads[0].withText, true);
    assert.strictEqual(state.pickReads[0].callerId, 'colleague1', 'read as the person submitting');

    const payload = state.executions[0].opts.triggerPayload;
    assert.strictEqual(payload.call.text, 'the text of tr_1', 'the run gets what the SERVER read');
    assert.strictEqual(payload.call.source, 'fireflies_transcript');
});

test('a form with no pick on it reads nothing', async () => {
    const res = makeRes();
    await postSubmit(makeReq({ body: submissionBody() }), res);
    await flushAsync();
    assert.strictEqual(state.pickReads.length, 0);
});
