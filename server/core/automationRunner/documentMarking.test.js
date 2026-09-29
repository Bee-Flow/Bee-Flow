/**
 * The marking port: core asks, the feature answers.
 *
 * The port must be inert when nothing has registered — a build without the
 * compliance module renders documents, it does not crash — and the document
 * runner must reach the org's policy through it, carrying the AI steps the
 * document actually drew on.
 *
 * ONE test here reads a file instead of running it, and it is the last one:
 * boot/startupTasks.js registering the resolver. The failure mode of
 * forgetting that line is silent — every generated document goes out unmarked
 * and everything else still passes — and the only caller of the registration
 * is `runStartupTasks()`, which also starts a dozen background jobs and opens
 * the DB. There is no seam to test it through: the claim is about that one
 * line existing in that one file, so the test says exactly that.
 *
 * "core must not require the compliance feature" is not restated here; it is
 * the layering rule in server/layering.test.js, enforced across every file.
 *
 * Run: cd server && node --test --test-force-exit core/automationRunner/documentMarking.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const port = require('./documentMarking');
const { resolveDocumentMarking, markingOutcome } = require('./execDocument');

test('no resolver registered → no marking, no throw', async () => {
    port.setMarkingResolver(null);
    assert.strictEqual(port.hasMarkingResolver(), false);
    assert.strictEqual(await port.resolveMarking('org1', { automationId: 'a1' }), null);
});

test('the registered resolver gets the org and the render info verbatim', async () => {
    const calls = [];
    port.setMarkingResolver(async (orgId, info) => { calls.push([orgId, info]); return { enabled: true, footer_text: 'x' }; });
    assert.strictEqual(port.hasMarkingResolver(), true);
    const info = { automationId: 'a1', aiStepIds: ['s1'], provider: 'anthropic' };
    const out = await port.resolveMarking('org7', info);
    assert.deepStrictEqual(out, { enabled: true, footer_text: 'x' });
    assert.deepStrictEqual(calls, [['org7', info]]);
    port.setMarkingResolver(null);
});

test('a non-function registration is refused rather than stored', async () => {
    port.setMarkingResolver(() => ({ enabled: true }));
    port.setMarkingResolver('nope');
    assert.strictEqual(port.hasMarkingResolver(), false);
});

// ── The document runner's side of the port ────────────────────────────

const AI_STEP = { id: 'ai1', type: 'ai_step', prompt: 'write the summary', provider: 'anthropic' };
const DOC_STEP = { id: 'doc1', type: 'generate_document', content: { kind: 'ref', path: 'steps.ai1.output.text' } };
const DEFINITION = { steps: [AI_STEP, DOC_STEP] };
const RAN_THE_AI_STEP = { steps: { ai1: { status: 'success', output: { text: 'hi' } } } };

test('a document drawing on an AI step asks the port, with the org and the steps it drew on', async (t) => {
    const calls = [];
    port.setMarkingResolver(async (orgId, info) => { calls.push({ orgId, info }); return { enabled: true, footer_text: 'Made with AI' }; });
    t.after(() => port.setMarkingResolver(null));

    const marking = await resolveDocumentMarking(
        DOC_STEP,
        { orgId: 'org7', automationId: 'a1', definition: DEFINITION },
        RAN_THE_AI_STEP,
        'generate_document',
    );

    assert.deepStrictEqual(marking, { enabled: true, footer_text: 'Made with AI' });
    assert.strictEqual(calls.length, 1, 'the runner must go through the port, not around it');
    assert.strictEqual(calls[0].orgId, 'org7');
    assert.deepStrictEqual(calls[0].info.aiStepIds, ['ai1']);
    assert.strictEqual(calls[0].info.automationId, 'a1');
    assert.strictEqual(calls[0].info.provider, 'anthropic');
});

test('a document with no AI upstream never asks at all', async (t) => {
    let asked = 0;
    port.setMarkingResolver(async () => { asked++; return { enabled: true }; });
    t.after(() => port.setMarkingResolver(null));

    const plainDoc = { id: 'doc1', type: 'generate_document', content: { kind: 'template', value: 'static text' } };
    const marking = await resolveDocumentMarking(
        plainDoc,
        { orgId: 'org7', automationId: 'a1', definition: { steps: [plainDoc] } },
        { steps: {} },
        'generate_document',
    );
    assert.strictEqual(marking, null);
    assert.strictEqual(asked, 0, 'a document with no model output in it is not an AI artefact');
});

test('a build without the compliance module renders unmarked instead of failing', async () => {
    port.setMarkingResolver(null);
    const marking = await resolveDocumentMarking(
        DOC_STEP,
        { orgId: 'org7', automationId: 'a1', definition: DEFINITION },
        RAN_THE_AI_STEP,
        'generate_document',
    );
    assert.strictEqual(marking, null);
});

test('a resolver that throws renders unmarked rather than failing the document', async (t) => {
    port.setMarkingResolver(async () => { throw new Error('policy store down'); });
    t.after(() => port.setMarkingResolver(null));

    const marking = await resolveDocumentMarking(
        DOC_STEP,
        { orgId: 'org7', automationId: 'a1', definition: DEFINITION },
        RAN_THE_AI_STEP,
        'generate_document',
    );
    assert.strictEqual(marking, null);
    // And the run log then records the truth: asked for, not delivered.
    assert.deepStrictEqual(markingOutcome(marking, null), { requested: false, visible: false, metadata: false });
});

test('the run log never records an unmarked file as marked', () => {
    // The renderer drops a marking with an empty footer, and reports
    // metadata:false when pdf-lib will not load. Both must survive into the
    // log as they happened — an Art. 50(2) audit reads this, not the request.
    assert.deepStrictEqual(markingOutcome({ enabled: true }, { visible: false, metadata: false }),
        { requested: true, visible: false, metadata: false });
    assert.deepStrictEqual(markingOutcome({ enabled: true }, { visible: true, metadata: true }),
        { requested: true, visible: true, metadata: true });
});

// ── Source-level, and why: see the file header ────────────────────────

test('boot wires the compliance resolver into the port', () => {
    // Genuinely textual — see the file header: no seam exists to call
    // runStartupTasks() for real without starting a dozen other background
    // jobs and opening the DB.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'boot', 'startupTasks.js'), 'utf8');
    assert.ok(/documentMarking'\)\s*\n?\s*\.setMarkingResolver/.test(src),
        'boot/startupTasks.js must call setMarkingResolver — without it every generated document is unmarked');
    assert.ok(/compliance\/marking'\)\.resolveMarking/.test(src),
        'the resolver boot registers must be compliance/marking.resolveMarking');
});
