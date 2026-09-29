/**
 * Multi-page forms — the pause/resume half.
 *
 * A `form_page` step with mode 'input' suspends the run the same way an
 * approval does (thrown sentinel → awaiting_* run row → resumeFromStep replays
 * and injects a synthetic output). What makes it a FORM rather than an
 * approval is that the injected output is the visitor's coerced answers, so
 * downstream steps bind `steps.<id>.output.<fieldName>`.
 *
 * Covered here:
 *   - execFormPage: input throws with a fully rendered page; ending does not
 *     throw; dry_run synthesises blanks; secrets never reach the visitor.
 *   - executeAutomation: status 'awaiting_form', the awaiting step id and a
 *     deadline persist, and the run row does not read as a failure.
 *   - resumeFromStep: answers land as the step's output; rootStepId and
 *     triggerHeaders survive; THREE pages work (the second resume must still
 *     see page one's answers, which runDag does not re-record).
 *
 * Heavy deps pre-mocked via the require cache. No DB / external services.
 *
 * Run: node --test core/automationRunner.formPause.test.js
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');

// ── In-memory store stub ───────────────────────────────────────────────────
const runs = new Map();
const stepsByRun = new Map();   // runId → [recordRunStep args]
let runSeq = 0;
const updateRunCalls = [];
let AUTOMATION = null;          // what getAutomation hands back to resumeFromStep
// The kept full copies of truncated outputs (automation_run_full_outputs),
// keyed `runId|stepId|attempts`.
const FULL_COPIES = new Map();

function makeRun({ automationId, version, userId, triggerKind, triggerPayload, mode, parentRunId, rootRunId }) {
    const id = `run-${++runSeq}`;
    const row = {
        id, automationId, version, userId, triggerKind,
        triggerPayload: triggerPayload || null, mode, status: 'queued',
        startedAt: new Date().toISOString(), finishedAt: null, durationMs: null,
        // The journey: a run is its own root unless it CONTINUES a paused one.
        // Mirrors createRun's COALESCE($rootRunId, id).
        error: null, summary: null, parentRunId: parentRunId ?? null, rootRunId: rootRunId ?? id,
        cancelRequested: false, awaitingStepId: null, approvalToken: null,
        awaitingStepExpiresAt: null, errorClass: null, handledErrorCount: 0,
    };
    runs.set(id, row);
    stepsByRun.set(id, []);
    return row;
}

const storeStub = {
    initDB: async () => {},
    createRun: async (args) => makeRun(args),
    getRun: async (id) => runs.get(id) || null,
    updateRun: async (id, updates) => {
        updateRunCalls.push({ id, updates: { ...updates } });
        const r = runs.get(id);
        if (!r) return false;
        Object.assign(r, updates);
        return true;
    },
    getRunsForAutomation: async () => [],
    getRunSteps: async (id) => (stepsByRun.get(id) || []).map(s => ({ ...s })),
    // Upsert on (runId, stepId, attempts), exactly like the real store's
    // ON CONFLICT clause. The runner writes a 'running' row when a step starts
    // and the real row when it lands; a stub that merely appended kept both,
    // so a lookup by stepId found the placeholder instead of the result.
    recordRunStep: async (row) => {
        const rows = stepsByRun.get(row.runId) || [];
        const i = rows.findIndex(r => r.stepId === row.stepId && r.attempts === row.attempts);
        if (i >= 0) rows[i] = { ...row }; else rows.push({ ...row });
    },
    markRunning: async () => true,
    releaseAutomation: async () => {},
    resetAttempts: async () => {},
    updateAutomation: async () => true,
    touchRunHeartbeat: async () => {},
    requestCancelRun: async () => null,
    getAutomation: async () => AUTOMATION,
    getRunFullOutput: async (runId, stepId, attempts = 1) => FULL_COPIES.get(`${runId}|${stepId}|${attempts}`) ?? null,
};

function stub(modPath, exportsObj) {
    const resolved = require.resolve(modPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

stub('../stores/automationStore', storeStub);
stub('../stores/userStore', { getUser: async () => null, getOrganization: async () => null });
stub('../stores/configStore', { getConfig: async () => null, setConfig: async () => {} });
stub('../stores/notificationStore', { createNotification: async () => {} });

process.env.ROUTINE_AUTH_LEGACY = '0';
process.env.NODE_ENV = 'test';

const runner = require('./automationRunner');
const { execFormPage, FormInputRequiredError } = runner;

after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });

beforeEach(() => {
    runs.clear();
    stepsByRun.clear();
    runSeq = 0;
    updateRunCalls.length = 0;
    AUTOMATION = null;
    FULL_COPIES.clear();
});

const noLayers = { layerStack: [] };
const blankState = { trigger: { output: {} }, steps: {}, vars: {}, secrets: {} };

const inputPage = (extra = {}) => ({
    id: 'fp1', type: 'form_page', mode: 'input',
    form: {
        title: 'One more thing',
        submitLabel: 'Continue',
        fields: [{ name: 'address', type: 'text', label: 'Your address', required: true }],
    },
    ...extra,
});

// ── execFormPage ───────────────────────────────────────────────────────────

test('an input page pauses the run and carries the rendered page with it', async () => {
    const before = Date.now();
    await assert.rejects(
        () => execFormPage(inputPage(), noLayers, blankState, 'live'),
        (err) => {
            assert.ok(err instanceof FormInputRequiredError);
            assert.strictEqual(err.stepId, 'fp1');
            // The page travels ON the error: it cannot be re-derived later,
            // because the run state its templates read is gone by then.
            assert.strictEqual(err.form.title, 'One more thing');
            assert.strictEqual(err.form.submitLabel, 'Continue');
            assert.deepEqual(err.form.fields.map(f => f.name), ['address']);
            // Default wait is one hour.
            const delta = Date.parse(err.expiresAt) - before;
            assert.ok(delta > 3600_000 - 60_000 && delta < 3600_000 + 60_000, `~1h (delta=${delta})`);
            return true;
        },
    );
});

test('waitSeconds moves the deadline and is clamped to [1 minute, 7 days]', async () => {
    const deadlineFor = async (waitSeconds) => {
        const before = Date.now();
        try { await execFormPage(inputPage({ waitSeconds }), noLayers, blankState, 'live'); }
        catch (e) { return Date.parse(e.expiresAt) - before; }
        throw new Error('expected a pause');
    };
    const near = (actual, expected) => Math.abs(actual - expected) < 60_000;
    assert.ok(near(await deadlineFor(900), 900_000), '15 minutes honoured');
    assert.ok(near(await deadlineFor(1), 60_000), 'below the floor clamps up to 1 minute');
    assert.ok(near(await deadlineFor(999 * 24 * 3600), 7 * 24 * 3600_000), 'above the ceiling clamps to 7 days');
    assert.ok(near(await deadlineFor(0), 3600_000), 'zero falls back to the default');
});

test('an ending page renders but never pauses — work after it still runs', async () => {
    const step = {
        id: 'fpEnd', type: 'form_page', mode: 'ending',
        form: { title: 'All done', description: 'We created ticket {{steps.t.output.number}}.' },
    };
    const state = { ...blankState, steps: { t: { output: { number: 'T-42' } } } };
    const r = await execFormPage(step, noLayers, state, 'live');
    assert.strictEqual(r.output.mode, 'ending');
    assert.strictEqual(r.output.form.title, 'All done');
    assert.strictEqual(r.output.form.description, 'We created ticket T-42.');
});

test('the page text is templated against the run — that is how a summary works', async () => {
    const step = {
        id: 'fp1', type: 'form_page', mode: 'input',
        form: {
            title: 'Thanks {{trigger.output.name}}',
            description: 'We found {{steps.search.output.count}} results.',
            fields: [{ name: 'ok', type: 'checkbox', label: 'Send these to {{trigger.output.name}}?' }],
        },
    };
    const state = {
        trigger: { output: { name: 'Ada' } },
        steps: { search: { output: { count: 3 } } },
        vars: {}, secrets: {},
    };
    await assert.rejects(() => execFormPage(step, noLayers, state, 'live'), (err) => {
        assert.strictEqual(err.form.title, 'Thanks Ada');
        assert.strictEqual(err.form.description, 'We found 3 results.');
        assert.strictEqual(err.form.fields[0].label, 'Send these to Ada?');
        return true;
    });
});

test('a secret can never reach the visitor through a page template', async () => {
    // This config is served to an ANONYMOUS browser. resolveValue's
    // allowSecrets:false idiom is what keeps {{secrets.*}} out of it.
    const step = {
        id: 'fp1', type: 'form_page', mode: 'input',
        form: {
            title: 'Key is {{secrets.apiKey}}',
            description: 'and {{secrets.apiKey}}',
            fields: [{ name: 'x', type: 'text', label: 'Also {{secrets.apiKey}}' }],
        },
    };
    const state = { ...blankState, secrets: { apiKey: 'sk-live-DO-NOT-LEAK' } };
    await assert.rejects(() => execFormPage(step, noLayers, state, 'live'), (err) => {
        const json = JSON.stringify(err.form);
        assert.ok(!json.includes('sk-live-DO-NOT-LEAK'), `secret leaked into ${json}`);
        assert.strictEqual(err.form.title, 'Key is');
        return true;
    });
});

test('a page with no theme of its own inherits the trigger theme', async () => {
    const base = { primary: '#1D4ED8', radius: 'sm', density: 'compact', fontScale: 'sm', appearance: 'light' };
    await assert.rejects(
        () => execFormPage(inputPage(), { layerStack: [], formBaseTheme: base }, blankState, 'live'),
        (err) => { assert.deepEqual(err.form.theme, base); return true; },
    );
});

test('dry_run synthesises blank answers instead of pausing a run nobody is watching', async () => {
    const step = {
        id: 'fp1', type: 'form_page', mode: 'input',
        form: {
            fields: [
                { name: 'address', type: 'text' },
                { name: 'agree', type: 'checkbox' },
                { name: 'proof', type: 'file' },
            ],
        },
    };
    const r = await execFormPage(step, noLayers, blankState, 'dry_run');
    assert.strictEqual(r.output.address, '');
    assert.strictEqual(r.output.agree, false);
    assert.strictEqual(r.output.proof, null);
    assert.strictEqual(r.output._dryRun, true);
});

test('a form page inside a layer is refused at runtime — a pause there has no resumable address', async () => {
    await assert.rejects(
        () => execFormPage(inputPage(), { layerStack: ['cl1'] }, blankState, 'live'),
        /not supported inside layers/,
    );
});

// ── executeAutomation pause + resumeFromStep ───────────────────────────────

/** trigger → fp1 (form page) → echo (binds the answer). */
function formAutomation(pages = 1) {
    const steps = [];
    const edges = [];
    let prev = 'trig';
    for (let i = 1; i <= pages; i++) {
        const id = `fp${i}`;
        steps.push({
            id, type: 'form_page', mode: 'input',
            form: { title: `Page ${i}`, fields: [{ name: `answer${i}`, type: 'text', label: `Answer ${i}` }] },
        });
        edges.push({ from: prev, to: id });
        prev = id;
    }
    steps.push({
        id: 'echo', type: 'set',
        fields: Object.fromEntries(
            Array.from({ length: pages }, (_, i) => [`got${i + 1}`, { kind: 'ref', path: `steps.fp${i + 1}.output.answer${i + 1}` }]),
        ),
    });
    edges.push({ from: prev, to: 'echo' });

    return {
        id: 'auto-form', version: 1, userId: 'user-1', organizationId: null,
        title: 'Multi-page form', triggerType: 'form',
        definition: {
            trigger: {
                id: 'trig', type: 'trigger', kind: 'form',
                form: { title: 'Start', fields: [{ name: 'name', type: 'text' }], theme: { primary: '#C2410C' } },
            },
            steps, edges,
        },
    };
}

const outputOf = (runId, stepId) => (stepsByRun.get(runId) || []).find(s => s.stepId === stepId)?.output;

test('a run pauses at a form page with awaiting_form, the step id and a deadline', async () => {
    AUTOMATION = formAutomation(1);
    const run = await runner.executeAutomation(AUTOMATION, {
        triggerKind: 'form', triggerPayload: { name: 'Ada' }, mode: 'live',
    });

    assert.strictEqual(run.status, 'awaiting_form');
    const terminal = updateRunCalls.find(c => c.updates.status === 'awaiting_form');
    assert.strictEqual(terminal.updates.awaitingStepId, 'fp1');
    assert.ok(terminal.updates.awaitingStepExpiresAt, 'a visitor is waiting — there is always a deadline');
    // Approvals mint a token; a form's credential is the session the browser holds.
    assert.strictEqual(terminal.updates.approvalToken, null);
    // A pause is not a failure — it must not read as one in the run list.
    assert.ok(!/^Failed/.test(terminal.updates.summary), `summary was "${terminal.updates.summary}"`);

    // The recorded step row carries the rendered page: this is what the public
    // poll endpoint serves to the waiting browser.
    const row = (stepsByRun.get(run.id) || []).find(s => s.stepId === 'fp1');
    assert.strictEqual(row.status, 'awaiting_form');
    assert.strictEqual(row.output.form.title, 'Page 1');
    assert.deepEqual(row.output.form.fields.map(f => f.name), ['answer1']);
    // …styled like the trigger's own page, without the author restyling it.
    assert.strictEqual(row.output.form.theme.primary, '#C2410C');

    // Nothing downstream ran.
    assert.strictEqual(outputOf(run.id, 'echo'), undefined);
});

test('resuming injects the answers as the step output, and downstream binds them', async () => {
    AUTOMATION = formAutomation(1);
    const paused = await runner.executeAutomation(AUTOMATION, { triggerKind: 'form', triggerPayload: { name: 'Ada' }, mode: 'live' });

    const resumed = await runner.resumeFromStep(paused.id, 'fp1', {
        decision: { answer1: 'Main Street 1' },
    });

    assert.strictEqual(resumed.status, 'success');
    assert.strictEqual(resumed.parentRunId, paused.id, 'the chain is linked');
    assert.strictEqual(resumed.rootRunId, paused.id,
        'and it is the SAME journey — the history shows one run, not one per answer');
    assert.deepEqual(outputOf(resumed.id, 'echo'), { got1: 'Main Street 1' });
});

test('rootStepId and triggerHeaders survive the resume', async () => {
    // Neither is stored on the run row, so without the pass-through a form on a
    // secondary trigger would resume from the wrong node and every
    // trigger.headers.* binding would go blank.
    AUTOMATION = formAutomation(1);
    AUTOMATION.definition.steps.push({
        id: 'meta', type: 'set',
        fields: { page: { kind: 'ref', path: 'trigger.headers.form_page_id' } },
    });
    AUTOMATION.definition.edges.push({ from: 'echo', to: 'meta' });

    const paused = await runner.executeAutomation(AUTOMATION, {
        triggerKind: 'form', triggerPayload: { name: 'Ada' },
        triggerHeaders: { form_page_id: 'tok-abc' }, mode: 'live', rootStepId: 'trig',
    });
    const resumed = await runner.resumeFromStep(paused.id, 'fp1', {
        decision: { answer1: 'x' },
        rootStepId: 'trig',
        triggerHeaders: { form_page_id: 'tok-abc' },
    });

    assert.strictEqual(resumed.status, 'success');
    assert.deepEqual(outputOf(resumed.id, 'meta'), { page: 'tok-abc' });
});

test('THREE pages work — the second resume still sees page one\'s answers', async () => {
    // Two mechanisms have to hold for this, and both were missing at first:
    //   1. the injected answers are RECORDED on the resuming run (runDag
    //      replays the boundary step without recording it, so otherwise the
    //      visitor's page-1 answers exist nowhere durable), and
    //   2. resumeFromStep reads the whole ancestor chain, because everything
    //      before the previous pause was replayed rather than re-recorded.
    // Drop either and `got1` comes back undefined.
    AUTOMATION = formAutomation(2);

    const p1 = await runner.executeAutomation(AUTOMATION, { triggerKind: 'form', triggerPayload: { name: 'Ada' }, mode: 'live' });
    assert.strictEqual(p1.status, 'awaiting_form');
    assert.strictEqual(runs.get(p1.id).awaitingStepId, 'fp1');

    const p2 = await runner.resumeFromStep(p1.id, 'fp1', { decision: { answer1: 'first' } });
    assert.strictEqual(p2.status, 'awaiting_form', 'the run pauses again at page two');
    assert.strictEqual(runs.get(p2.id).awaitingStepId, 'fp2');
    // Page one's answers are durable on the resuming run, not just in memory.
    assert.deepEqual(outputOf(p2.id, 'fp1'), { answer1: 'first' });

    const done = await runner.resumeFromStep(p2.id, 'fp2', { decision: { answer2: 'second' } });
    assert.strictEqual(done.status, 'success');
    assert.deepEqual(outputOf(done.id, 'echo'), { got1: 'first', got2: 'second' });

    // Three runs, one journey. The history collapses them onto the first, which
    // is the only row a person ever thought existed.
    assert.strictEqual(p2.rootRunId, p1.id);
    assert.strictEqual(done.rootRunId, p1.id);
});

test('an ending page runs inline and leaves its rendered summary on the run', async () => {
    AUTOMATION = formAutomation(1);
    AUTOMATION.definition.steps.push({
        id: 'bye', type: 'form_page', mode: 'ending',
        form: { title: 'Thanks!', description: 'You told us: {{steps.fp1.output.answer1}}' },
    });
    AUTOMATION.definition.edges.push({ from: 'echo', to: 'bye' });

    const paused = await runner.executeAutomation(AUTOMATION, { triggerKind: 'form', triggerPayload: { name: 'Ada' }, mode: 'live' });
    const done = await runner.resumeFromStep(paused.id, 'fp1', { decision: { answer1: 'Main Street 1' } });

    assert.strictEqual(done.status, 'success', 'an ending page does not pause the run');
    const ending = outputOf(done.id, 'bye');
    assert.strictEqual(ending.mode, 'ending');
    assert.strictEqual(ending.form.title, 'Thanks!');
    assert.strictEqual(ending.form.description, 'You told us: Main Street 1');
});

test('a resume of a FINISHED run starts its own journey, so a retry keeps its own row', async () => {
    // parent_run_id alone cannot tell a continuation from a retry — retry-from-
    // step and "▶ Execute from here" set it too. The discriminator is whether
    // the run being resumed was still awaiting a human. Fold a retry into the
    // journey it replays and the history quietly loses the second attempt.
    AUTOMATION = formAutomation(1);
    const paused = await runner.executeAutomation(AUTOMATION, { triggerKind: 'form', triggerPayload: { name: 'Ada' }, mode: 'live' });
    const finished = await runner.resumeFromStep(paused.id, 'fp1', { decision: { answer1: 'x' } });
    assert.strictEqual(finished.status, 'success');

    const again = await runner.resumeFromStep(finished.id, 'fp1', { decision: { answer1: 'y' } });
    assert.strictEqual(again.parentRunId, finished.id, 'the lineage is still recorded');
    assert.strictEqual(again.rootRunId, again.id, 'but it is a new journey — its own line in the history');
});

// ── An output the run history truncated, before a pause (BFSF-435) ─────────
//
// The real store persists any output over 256 KB as a sentinel; this stub
// store keeps what it is given, so the tests below turn the recorded row into
// the sentinel the real one would have written — with or without the full
// copy (and the ref to it) that recordRunStep now keeps beside the row.

function bigThenForm({ readAfterPause = true } = {}) {
    return {
        id: 'auto-big', version: 1, userId: 'user-1', organizationId: null,
        title: 'Fetch, confirm, use', triggerType: 'form',
        definition: {
            trigger: { id: 'trig', type: 'trigger', kind: 'form', form: { title: 'Start', fields: [{ name: 'name', type: 'text' }] } },
            steps: [
                { id: 'fetch', type: 'set', fields: { total: { kind: 'literal', value: 1 } } },
                { id: 'fp1', type: 'form_page', mode: 'input', form: { title: 'Confirm', fields: [{ name: 'ok', type: 'text', label: 'OK?' }] } },
                {
                    id: 'use', type: 'set',
                    fields: readAfterPause
                        ? { total: { kind: 'ref', path: 'steps.fetch.output.total' }, first: { kind: 'ref', path: 'steps.fetch.output.items[0].id' } }
                        : { note: { kind: 'literal', value: 'done' } },
                },
            ],
            edges: [{ from: 'trig', to: 'fetch' }, { from: 'fetch', to: 'fp1' }, { from: 'fp1', to: 'use' }],
        },
    };
}

/** Make `stepId`'s recorded row on `runId` the truncation sentinel. */
function truncateRecordedRow(runId, stepId, { full = null } = {}) {
    const row = (stepsByRun.get(runId) || []).find(r => r.stepId === stepId && r.status === 'success');
    assert.ok(row, `${stepId} recorded a row`);
    const attempts = row.attempts || 1;
    row.output = {
        __truncated__: true, originalBytes: 2_400_000, headSample: '{"total":',
        ...(full ? { fullOutputRef: { runId, stepId, attempts } } : {}),
    };
    if (full) FULL_COPIES.set(`${runId}|${stepId}|${attempts}`, full);
}

test('an output the history truncated comes back whole when the run resumes after a form page', async () => {
    AUTOMATION = bigThenForm();
    const paused = await runner.executeAutomation(AUTOMATION, { triggerKind: 'form', triggerPayload: { name: 'Ada' }, mode: 'live' });
    assert.strictEqual(paused.status, 'awaiting_form');
    const full = { total: 8000, items: [{ id: 'first-item' }, { id: 'second-item' }] };
    truncateRecordedRow(paused.id, 'fetch', { full });

    const resumed = await runner.resumeFromStep(paused.id, 'fp1', { decision: { ok: 'yes' } });

    assert.strictEqual(resumed.status, 'success');
    // Before the fix `use` bound against a hole: { total: undefined, … } under a green run.
    assert.deepEqual(outputOf(resumed.id, 'use'), { total: 8000, first: 'first-item' });
});

test('with no copy kept, a resume whose later steps read that output fails and names the step', async () => {
    AUTOMATION = bigThenForm();
    const paused = await runner.executeAutomation(AUTOMATION, { triggerKind: 'form', triggerPayload: { name: 'Ada' }, mode: 'live' });
    truncateRecordedRow(paused.id, 'fetch');   // a row from before copies were kept

    const resumed = await runner.resumeFromStep(paused.id, 'fp1', { decision: { ok: 'yes' } });

    assert.strictEqual(resumed.status, 'error', 'not green with empty data');
    assert.match(resumed.error, /step fetch \(2\.3 MB\)/);
    assert.strictEqual(outputOf(resumed.id, 'use'), undefined, 'the step that would have read nothing never ran');
    assert.strictEqual(outputOf(resumed.id, 'fetch'), undefined, 'and the truncated step was not dispatched again');
});

test('with no copy kept, a resume that never reads that output again carries on', async () => {
    AUTOMATION = bigThenForm({ readAfterPause: false });
    const paused = await runner.executeAutomation(AUTOMATION, { triggerKind: 'form', triggerPayload: { name: 'Ada' }, mode: 'live' });
    truncateRecordedRow(paused.id, 'fetch');

    const resumed = await runner.resumeFromStep(paused.id, 'fp1', { decision: { ok: 'yes' } });

    assert.strictEqual(resumed.status, 'success');
    assert.deepEqual(outputOf(resumed.id, 'use'), { note: 'done' });
});

test('a sentinel naming some OTHER row\'s copy is not followed', async () => {
    // An output under the cap is stored as whatever the step returned, so a
    // web response can be shaped exactly like a sentinel with a ref. Following
    // that ref would load another run's output into this one.
    AUTOMATION = bigThenForm();
    const paused = await runner.executeAutomation(AUTOMATION, { triggerKind: 'form', triggerPayload: { name: 'Ada' }, mode: 'live' });
    FULL_COPIES.set('run-elsewhere|fetch|1', { total: 666, items: [{ id: 'not-this-run' }] });
    const row = stepsByRun.get(paused.id).find(r => r.stepId === 'fetch' && r.status === 'success');
    row.output = {
        __truncated__: true, originalBytes: 2_400_000, headSample: '{',
        fullOutputRef: { runId: 'run-elsewhere', stepId: 'fetch', attempts: 1 },
    };

    const resumed = await runner.resumeFromStep(paused.id, 'fp1', { decision: { ok: 'yes' } });

    assert.strictEqual(resumed.status, 'error', 'treated as no copy at all');
    assert.strictEqual(outputOf(resumed.id, 'use'), undefined);
});
