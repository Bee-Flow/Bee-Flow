// @typecheck
/**
 * The automation module's half of documentMarking.test.js: the document runner
 * (execDocument) asks the marking port, carrying the AI steps the document actually
 * drew on, and renders unmarked when nothing answers or the answer throws.
 *
 * Run: cd server && node --test --test-force-exit core/automationRunner/documentMarking.automation.test.js
 */
const { test } = require('node:test');
// The runner reaches automation/, integrations/ and services/ through
// core/automationRunner/featurePorts.js; boot registers these for the server.
require('../../automation/runnerPorts');
require('../../integrations/runnerPorts');
require('../../services/runnerPorts');
const assert = require('node:assert');

const port = require('./documentMarking');
const { resolveDocumentMarking, markingOutcome } = require('./execDocument');

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
