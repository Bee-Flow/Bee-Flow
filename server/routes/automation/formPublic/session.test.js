'use strict';

/**
 * The visitor's session (formPublic/session.js): the poll, its progress trail,
 * and the download of a document the journey produced.
 *
 * Harness: formPublic.testkit.js (mocks first, then the real router).
 *
 * Run: node --test routes/automation/formPublic/session.test.js
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const {
    OTHER_TOKEN,
    FORM,
    PAGE_2,
    state,
    resetState,
    putRun,
    getSession,
    getDownload,
    makeRes,
    makeReq,
    startSession,
    awaitingRun,
    putFile,
} = require('./formPublic.testkit');

beforeEach(resetState);

// ── Multi-page: session poll + resume ─────────────────────────────────────
//
// After the first submission the browser stays on the same /f/<token> URL and
// polls its session. The session carries no status of its own — everything is
// derived from the run row, so these tests drive the run state directly.

test('a submission hands back a session id the browser can poll', async () => {
    const sid = await startSession();
    assert.match(sid, /^[a-f0-9]{24,64}$/, 'the session id is a credential, not a counter');
    // …and it is pointed at the run the queue produced.
    assert.strictEqual(state.sessions.get(sid).runId, 'run1');
});

test('polling reports working, then the next page, then done', async () => {
    state.runQueue = [{ id: 'runA' }];
    const sid = await startSession();

    // Still executing.
    putRun('runA', 'running');
    let res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'working');

    // Paused on page two.
    awaitingRun('runA', 'fp1', PAGE_2);
    res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'form');
    assert.strictEqual(res.body.stepId, 'fp1');
    assert.strictEqual(res.body.form.title, 'Nearly there');
    assert.ok(res.body.csrf, 'a fresh CSRF for this page');
    assert.ok(res.body.issuedAt);

    // Finished, with a closing summary.
    putRun('runA', 'success', {
        steps: [
            { stepId: 'fp1', status: 'success', output: { address: 'Main St 1' } },
            { stepId: 'bye', status: 'success', output: { mode: 'ending', form: { title: 'All done', description: 'Ticket T-9' } } },
        ],
    });
    res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'done');
    assert.strictEqual(res.body.ending.title, 'All done');
    assert.strictEqual(res.body.ending.description, 'Ticket T-9');
});

test('a finished run with no closing page still reports done, with no ending', async () => {
    state.runQueue = [{ id: 'runB' }];
    const sid = await startSession();
    putRun('runB', 'success', { steps: [{ stepId: 's1', status: 'success', output: { ok: true } }] });
    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'done');
    assert.strictEqual(res.body.ending, null);
});

test('a failed run never leaks the internal error to the visitor', async () => {
    state.runQueue = [{ id: 'runC' }];
    const sid = await startSession();
    state.runs.set('runC', {
        id: 'runC', status: 'error', automationId: 'auto1',
        error: 'ECONNREFUSED 10.0.0.5:5432 while calling internal-billing',
    });
    state.runSteps.set('runC', []);
    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'error');
    const json = JSON.stringify(res.body);
    assert.strictEqual(json.includes('10.0.0.5'), false);
    assert.strictEqual(json.includes('billing'), false);
});

test('an approval gate reads as "still working" — the visitor cannot act on it', async () => {
    state.runQueue = [{ id: 'runD' }];
    const sid = await startSession();
    putRun('runD', 'awaiting_approval', { awaitingStepId: 'gate' });
    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'working');
});

test('an unknown session, and one minted on another form, are both a plain 404', async () => {
    const sid = await startSession();
    let res = makeRes();
    await getSession(makeReq({ sid: 'd'.repeat(48) }), res);
    assert.strictEqual(res.statusCode, 404);
    // Real id, wrong form token — getFormSession is scoped to the page.
    state.sessions.get(sid).formPageId = OTHER_TOKEN;
    res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.statusCode, 404);
});

test('an expired session says so instead of pretending to work', async () => {
    const sid = await startSession();
    state.sessions.get(sid).expiresAt = new Date(Date.now() - 1000).toISOString();
    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'expired');
});

// ── "Just a moment…" should say WHICH moment ─────────────────────────────────
//
// A visitor who answered a question waits out whatever comes next — a web
// search, a model call, a document being written. A bare spinner for ninety
// seconds reads as broken. The poll now names the step, including the flowlet
// it stepped into, and nothing else: labels on the path, no ids, no step
// types, no tool names, no outputs.

const PROGRESS_DEF = {
    trigger: { id: 'trg', type: 'trigger', kind: 'form' },
    steps: [
        { id: 'set1', type: 'set', label: '1. Merkprofiel laden' },
        { id: 'cl1', type: 'call_layer', layerKey: 'research', label: '7. Wat scoort er al' },
        { id: 'cl2', type: 'call_layer', layerKey: 'plain', label: '8. Iets anders' },
        { id: 'nolabel', type: 'set' },
    ],
    layers: {
        research: {
            title: 'Wat scoort er al',
            description: 'Searches Google for a given term and lets AI analyse top-ranking pages.',
            steps: [
                { id: 'a1', type: 'integration_action', label: 'Google-resultaten ophalen' },
                { id: 'out', type: 'layer_output', label: 'Return' },
            ],
        },
        plain: {
            title: 'Iets anders',
            steps: [{ id: 'b1', type: 'set', label: 'Een stap' }],
        },
    },
};

function runningRun(id, stepId) {
    state.definitionOverride = PROGRESS_DEF;
    putRun(id, 'running', {
        steps: [
            { stepId: 'set1', status: 'success', output: {} },
            { stepId, status: 'running', output: null },
        ],
    });
}

test('while working, the poll names the step — flowlet first, then the node inside it', async () => {
    const sid = await startSession();
    runningRun('run1', 'cl1/a1');

    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'working');
    assert.deepStrictEqual(res.body.progress, ['7. Wat scoort er al', 'Google-resultaten ophalen'],
        'the trail is the flowlet the run stepped into, then the node it is on');
});

// A step's NAME says where the automation is; the flowlet's DESCRIPTION says what
// it is doing. That is the difference between a wait that reads as work and one
// that reads as a hang, so it rides along with the trail.

test('the running flowlet sends its description along with the trail', async () => {
    const sid = await startSession();
    runningRun('run1', 'cl1/a1');

    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(
        res.body.progressNote,
        'Searches Google for a given term and lets AI analyse top-ranking pages.',
    );
});

test('a flowlet without a description sends no note rather than an empty one', async () => {
    const sid = await startSession();
    runningRun('run1', 'cl2/b1');

    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.deepStrictEqual(res.body.progress, ['8. Iets anders', 'Een stap']);
    assert.strictEqual(res.body.progressNote, undefined);
});

test('a step outside any flowlet has no description to send', async () => {
    const sid = await startSession();
    runningRun('run1', 'set1');

    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.progressNote, undefined);
});

test('the description is capped — this is a public endpoint and nothing upstream caps it', async () => {
    const sid = await startSession();
    state.definitionOverride = {
        ...PROGRESS_DEF,
        layers: { ...PROGRESS_DEF.layers, research: { ...PROGRESS_DEF.layers.research, description: 'x'.repeat(5000) } },
    };
    putRun('run1', 'running', {
        steps: [{ stepId: 'cl1/a1', status: 'running', output: null }],
    });

    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.progressNote.length, 400);
});

test('a top-level step is its own one-line trail', async () => {
    const sid = await startSession();
    runningRun('run1', 'set1');

    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.deepStrictEqual(res.body.progress, ['1. Merkprofiel laden']);
});

test('the trail carries titles only — never ids, types or tool names', async () => {
    const sid = await startSession();
    runningRun('run1', 'cl1/a1');

    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    const flat = JSON.stringify(res.body);
    for (const leak of ['cl1', 'a1', 'call_layer', 'integration_action', 'research']) {
        assert.ok(!flat.includes(leak), `the visitor must not see "${leak}"`);
    }
});

test('an unnamed step reports no progress rather than leaking what it is', async () => {
    const sid = await startSession();
    runningRun('run1', 'nolabel');

    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'working');
    assert.strictEqual(res.body.progress, undefined, 'no label, nothing to say');
});

test('a paused or queued run reports no step at all', async () => {
    // awaiting_approval is a gate the visitor cannot act on; naming the step
    // would tell them the automation is waiting on someone. Queued has not
    // started. Neither should describe itself.
    const sid = await startSession();
    state.definitionOverride = PROGRESS_DEF;
    putRun('run1', 'awaiting_approval', { steps: [{ stepId: 'set1', status: 'running', output: null }] });

    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'working');
    assert.strictEqual(res.body.progress, undefined);
});

// The bug the trail tests above could NOT see: they put the running run under
// the session's own pointer, which is a state production never reaches.
//
// A resume starts a CHILD run and the parent is only closed out — and the
// session only re-pointed — once that child has finished. So for the whole
// stretch a visitor is actually waiting, the session pointed at a parent that
// was `awaiting_form` with its step pointer cleared, and the poll answered a
// bare `{state:'working'}`. Every branch that can carry a trail was
// unreachable, and the feature never once appeared on screen.
//
// The poll therefore reads the newest leg of the JOURNEY, not the row the
// session happens to name.

test('the trail comes from the leg that is running, not the parent the session names', async () => {
    const sid = await startSession();
    state.definitionOverride = PROGRESS_DEF;
    // Exactly the mid-resume shape: parent answered (pointer cleared, status
    // untouched), child running one level inside a flowlet, session still on
    // the parent because resumeFromStep has not returned.
    putRun('parentJ', 'awaiting_form', { awaitingStepId: null, steps: [{ stepId: 'fp1', status: 'awaiting_form', output: {} }] });
    putRun('childJ', 'running', {
        rootRunId: 'parentJ',
        steps: [{ stepId: 'cl1/a1', status: 'running', output: null }],
    });
    state.sessions.get(sid).runId = 'parentJ';

    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'working');
    assert.deepStrictEqual(res.body.progress, ['7. Wat scoort er al', 'Google-resultaten ophalen'],
        'the visitor sees where the automation actually is');
});

test('the next page is served from the leg that paused, not from the stale parent', async () => {
    const sid = await startSession();
    putRun('parentJ2', 'awaiting_form', { awaitingStepId: null, steps: [] });
    putRun('childJ2', 'awaiting_form', {
        rootRunId: 'parentJ2',
        awaitingStepId: 'fp2',
        steps: [{ stepId: 'fp2', status: 'awaiting_form', output: { form: { ...FORM, title: 'Page two' } } }],
    });
    state.sessions.get(sid).runId = 'parentJ2';

    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'form');
    assert.strictEqual(res.body.form.title, 'Page two');
});

test('a journey continued outside the form does not report done early', async () => {
    // An owner approving a paused step from the run history spawns a child and
    // finalises the parent to 'success'. The session never hears about it, so
    // reading its own run would end the visitor's journey mid-automation.
    const sid = await startSession();
    state.definitionOverride = PROGRESS_DEF;
    putRun('parentJ3', 'success', { steps: [] });
    putRun('childJ3', 'running', { rootRunId: 'parentJ3', steps: [{ stepId: 'set1', status: 'running', output: null }] });
    state.sessions.get(sid).runId = 'parentJ3';

    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'working', 'still going — the visitor keeps waiting');
});

test('a run that lost the race reads as working, not as a failure', async () => {
    // runQueued backs off and tries again. Telling the visitor "something went
    // wrong" would end a journey over a collision they never caused.
    const sid = await startSession();
    const row = putRun('run1', 'cancelled', { steps: [] });
    row.error = 'Skipped: automation already running';
    state.sessions.get(sid).runId = 'run1';

    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'working');
});

// ── Downloading a document the run produced ──────────────────────────────────
//
// A `generate_document` step returns a bare fileId, never a URL. The ONLY way
// to the bytes is through a session that owns the journey which made them, so
// these tests are mostly about who is refused.

test('a visitor can download the document their own journey produced', async () => {
    const sid = await startSession();
    putRun('run1', 'success', { steps: [] });
    state.sessions.get(sid).runId = 'run1';
    putFile('f1', 'run1');

    const res = makeRes();
    await getDownload(makeReq({ sid, params: { fileId: 'f1' } }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['content-type'], 'application/pdf');
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    assert.match(res.headers['content-disposition'], /^attachment; filename="offerte\.pdf"/);
    assert.deepStrictEqual(state.streamed, ['automation-forms/owner1/auto1/f1']);
    // pipe() finishes after the handler returns, so wait for the write to land.
    await new Promise(r => res.on('finish', r));
    assert.strictEqual(res.bytes().toString(), '%PDF-1.7 fake', 'the bytes really reach the visitor');
});

test('a file made by a LATER leg of the same journey is still reachable', async () => {
    // The document is usually produced after a form pause, i.e. on a child run.
    const sid = await startSession();
    putRun('parentD', 'success', { steps: [] });
    putRun('childD', 'success', { rootRunId: 'parentD', steps: [] });
    state.sessions.get(sid).runId = 'parentD';
    putFile('f2', 'childD');

    const res = makeRes();
    await getDownload(makeReq({ sid, params: { fileId: 'f2' } }), res);
    assert.strictEqual(res.statusCode, 200);
});

test("someone else's file is a 404 — holding the id proves nothing", async () => {
    const sid = await startSession();
    putRun('mine', 'success', { steps: [] });
    state.sessions.get(sid).runId = 'mine';
    putFile('theirs', 'a-run-from-another-visitor');

    const res = makeRes();
    await getDownload(makeReq({ sid, params: { fileId: 'theirs' } }), res);
    // 404 and not 403: a wrong id and someone else's file must be
    // indistinguishable, or the endpoint confirms which ids exist.
    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(state.streamed, [], 'nothing was read from storage');
});

test('an unknown file id is a 404', async () => {
    const sid = await startSession();
    putRun('run1', 'success', { steps: [] });
    state.sessions.get(sid).runId = 'run1';

    const res = makeRes();
    await getDownload(makeReq({ sid, params: { fileId: 'nope' } }), res);
    assert.strictEqual(res.statusCode, 404);
});

test('a ledger row whose bytes are already reaped is a 404, not a 500', async () => {
    // The reaper deletes the blob first and the row second, so this window is
    // normal rather than a fault.
    const sid = await startSession();
    putRun('run1', 'success', { steps: [] });
    state.sessions.get(sid).runId = 'run1';
    putFile('gone', 'run1');
    state.storageMissing = true;

    const res = makeRes();
    await getDownload(makeReq({ sid, params: { fileId: 'gone' } }), res);
    state.storageMissing = false;
    assert.strictEqual(res.statusCode, 404);
});

test('a filename with accents or quotes cannot break the header', async () => {
    const sid = await startSession();
    putRun('run1', 'success', { steps: [] });
    state.sessions.get(sid).runId = 'run1';
    putFile('f3', 'run1', { filename: 'Beoordeling "café" — señor.pdf' });

    const res = makeRes();
    await getDownload(makeReq({ sid, params: { fileId: 'f3' } }), res);
    const cd = res.headers['content-disposition'];
    // The quoted ASCII part must contain no quote or backslash that could end
    // it early; the real name rides in filename* instead.
    const ascii = /filename="([^"]*)"/.exec(cd)[1];
    assert.ok(!ascii.includes('"') && !ascii.includes(String.fromCharCode(92)), `unsafe ascii fallback: ${ascii}`);
    assert.match(cd, /filename\*=UTF-8''/);
    assert.ok(cd.includes(encodeURIComponent('Beoordeling "café" — señor.pdf')));
});

test('a download field on the served page carries the real file details', async () => {
    const sid = await startSession();
    putRun('run1', 'awaiting_form', {
        awaitingStepId: 'fp1',
        steps: [{
            stepId: 'fp1',
            status: 'awaiting_form',
            output: { form: { ...FORM, fields: [{ name: 'doc', type: 'download', label: 'Je offerte', fileId: 'f9' }] } },
        }],
    });
    state.sessions.get(sid).runId = 'run1';
    putFile('f9', 'run1', { filename: 'offerte-2026.pdf', size: 4242 });

    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'form');
    const field = res.body.form.fields.find(f => f.type === 'download');
    assert.strictEqual(field.filename, 'offerte-2026.pdf');
    assert.strictEqual(field.size, 4242);
    assert.strictEqual(field.required, false, 'a display field can never block a submit');
    assert.strictEqual(field.storageKey, undefined, 'the visitor never sees where it is stored');
});

test('a download whose file is gone is dropped, not rendered as a dead button', async () => {
    const sid = await startSession();
    putRun('run1', 'awaiting_form', {
        awaitingStepId: 'fp1',
        steps: [{
            stepId: 'fp1',
            status: 'awaiting_form',
            output: { form: { ...FORM, fields: [{ name: 'doc', type: 'download', label: 'Weg', fileId: 'expired' }] } },
        }],
    });
    state.sessions.get(sid).runId = 'run1';

    const res = makeRes();
    await getSession(makeReq({ sid }), res);
    assert.strictEqual(res.body.state, 'form');
    assert.strictEqual(res.body.form.fields.length, 0, 'the page renders without it');
});
