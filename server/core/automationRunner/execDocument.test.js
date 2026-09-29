/**
 * generate_document — what the run log says about the EU AI Act Art. 50(2)
 * marking.
 *
 * The run history of a routine is the evidence an Art. 50(2) audit reads: the
 * AIA-Art50-content-marking check asserts that every routine whose document
 * draws on a model ships a marked file, and a human auditor opens the run to
 * see it. So the one thing this step must never do is record a document as
 * AI-marked when the bytes carry no marking.
 *
 * Two ways that happens, both from documentRenderer's own contract:
 *   - it DROPS the marking when the footer line is empty (or switched off) and
 *     returns `marking: null` — nothing was printed, nothing was stamped;
 *   - it returns `metadata: false` when pdf-lib cannot be loaded — the visible
 *     line shipped, the machine-readable half did not.
 * In both cases the marking object the step resolved is still truthy, so the
 * report has to come from the render RESULT.
 *
 * Run: cd server && node --test --test-force-exit core/automationRunner/execDocument.test.js
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

// ── doubles ────────────────────────────────────────────────────────────────
// The renderer is the subject's oracle: each case sets what it returns.
const renderer = {
    calls: [],
    result: null,
    FORMATS: ['pdf', 'docx'],
    CONTENT_TYPES: { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    async renderDocument(opts) {
        renderer.calls.push(opts);
        return renderer.result;
    },
};

const storage = {
    uploads: [],
    isAvailable: () => true,
    buildAutomationFileKey: (userId, automationId, sha) => `auto/${automationId}/${sha}`,
    async uploadFile(key, buffer, contentType) { storage.uploads.push({ key, size: buffer.length, contentType }); },
};

const automationStore = {
    async getAutomation() { return null; },
    async recordGeneratedFile() { return { id: 'file-1' }; },
};

const restore = installResolveStub({
    '../../services/documentRenderer': renderer,
    '../../stores/storageStore': storage,
    '../../stores/automationStore': automationStore,
});
const execDocument = require('./execDocument');
const port = require('./documentMarking');
after(() => { restore(); port.setMarkingResolver(null); });

// ── fixtures ───────────────────────────────────────────────────────────────

// A resolved marking is what the compliance feature hands back: it carries the
// org name and the footer sentence, and neither may reach the run log.
const ORG_NAME = 'Acme BV';
const FOOTER = 'Gegenereerd met AI — Acme BV';
const MARKING = {
    enabled: true,
    org_name: ORG_NAME,
    provider: 'claude',
    generated_at: '2026-09-14T09:00:00.000Z',
    automation_id: 'auto-7',
    ai_step_ids: ['ai_1'],
    footer_text: FOOTER,
    locale: 'nl',
};

const STEP = { id: 'doc_1', type: 'generate_document', content: 'Beste lezer,\n\nhier is het rapport.', title: 'Rapport', format: 'pdf' };
const DEFINITION = { steps: [{ id: 'ai_1', type: 'ai_step', model: 'claude-opus-5' }, STEP] };
const CTX = { orgId: 'org-1', userId: 'user-1', automationId: 'auto-7', runId: 'run-1', definition: DEFINITION };
const RUN_STATE = { steps: { ai_1: { status: 'success', output: { text: 'body' } } } };

function pdfResult(marking) {
    return { buffer: Buffer.from('%PDF-1.7 bytes'), contentType: 'application/pdf', degraded: false, marking };
}

/** Run the step with the renderer returning `marking`, capturing console.warn. */
async function run(markingResult, { resolver = async () => MARKING, ctx = CTX, step = STEP } = {}) {
    renderer.result = pdfResult(markingResult);
    port.setMarkingResolver(resolver);
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
        const out = await execDocument.execGenerateDocument(step, ctx, RUN_STATE, 'live');
        return { output: out.output, warnings };
    } finally {
        console.warn = realWarn;
    }
}

beforeEach(() => { renderer.calls.length = 0; storage.uploads.length = 0; });

// ── the fix ────────────────────────────────────────────────────────────────

test('a fully marked file is recorded as marked, both halves true', async () => {
    const { output, warnings } = await run({ visible: true, metadata: true });
    assert.strictEqual(output.marked, true);
    assert.deepStrictEqual(output.marking, { requested: true, visible: true, metadata: true });
    assert.deepStrictEqual(warnings, [], 'nothing degraded, nothing to warn about');
    // The marking really was asked for: the renderer got the resolved object.
    assert.strictEqual(renderer.calls[0].marking, MARKING);
});

test('renderer DROPPED the marking (empty footer line) → the run log must not claim marked', async () => {
    const { output, warnings } = await run(null);
    assert.strictEqual(output.marked, false, 'a document with no footer and no metadata is not an AI-marked document');
    assert.deepStrictEqual(output.marking, { requested: true, visible: false, metadata: false });
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /doc_1: AI content marking was resolved but the renderer printed no marking line/);
});

test('pdf-lib unavailable → visible line only; marked is false and the metadata half says so', async () => {
    const { output, warnings } = await run({ visible: true, metadata: false });
    assert.strictEqual(output.marked, false, 'Art. 50(2) wants the machine-readable half; a footer alone is not it');
    assert.deepStrictEqual(output.marking, { requested: true, visible: true, metadata: false });
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /file metadata could not be written/);
});

test('no marking policy (org switched off) → requested false, nothing claimed, no warning', async () => {
    const { output, warnings } = await run(null, { resolver: async () => null });
    assert.strictEqual(output.marked, false);
    assert.deepStrictEqual(output.marking, { requested: false, visible: false, metadata: false });
    assert.deepStrictEqual(warnings, []);
    assert.strictEqual(renderer.calls[0].marking, null, 'nothing to mark with');
});

test('a resolver that throws renders unmarked and the log says unmarked, not marked', async () => {
    const { output, warnings } = await run(null, { resolver: async () => { throw new Error('compliance store down'); } });
    assert.strictEqual(output.marked, false);
    assert.deepStrictEqual(output.marking, { requested: false, visible: false, metadata: false });
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /could not resolve AI content marking, rendering unmarked/);
});

test('a document with no AI upstream never asks and never claims', async () => {
    const plain = { steps: [STEP] };
    let asked = 0;
    const { output } = await run(null, {
        resolver: async () => { asked += 1; return MARKING; },
        ctx: { ...CTX, definition: plain },
    });
    assert.strictEqual(asked, 0, 'no AI step upstream, no marking question');
    assert.strictEqual(output.marked, false);
    assert.deepStrictEqual(output.marking, { requested: false, visible: false, metadata: false });
});

// ── BFSF-441: the run log is an allow-list of booleans ──────────────────────

test('the recorded marking is three booleans — no org name, no footer sentence, no ids', async () => {
    const { output } = await run({ visible: true, metadata: true });
    assert.deepStrictEqual(Object.keys(output.marking).sort(), ['metadata', 'requested', 'visible']);
    for (const v of Object.values(output.marking)) assert.strictEqual(typeof v, 'boolean');
    const serialised = JSON.stringify(output);
    assert.ok(!serialised.includes(ORG_NAME), 'the org name must not ride into the run log');
    assert.ok(!serialised.includes(FOOTER), 'the footer sentence must not ride into the run log');
    assert.ok(!serialised.includes('ai_1'), 'step ids of the AI upstream are not part of the file record');
});

test('the warnings name the step only — no org name, no footer sentence', async () => {
    const dropped = await run(null);
    const noMeta = await run({ visible: true, metadata: false });
    for (const line of [...dropped.warnings, ...noMeta.warnings]) {
        assert.ok(!line.includes(ORG_NAME), `org name in a log line: ${line}`);
        assert.ok(!line.includes(FOOTER), `footer sentence in a log line: ${line}`);
    }
});

// ── shape parity ───────────────────────────────────────────────────────────

test('dry run returns the live shape, so a binding on steps.doc_1.marking resolves either way', async () => {
    const dry = await execDocument.execGenerateDocument(STEP, CTX, RUN_STATE, 'dry_run');
    assert.strictEqual(renderer.calls.length, 0, 'a dry run renders nothing at all');
    const live = (await run({ visible: true, metadata: true })).output;
    const shapeOf = o => Object.keys(o).filter(k => !k.startsWith('_')).sort();
    assert.deepStrictEqual(shapeOf(dry.output), shapeOf(live));
    assert.strictEqual(dry.output.marked, false, 'a dry run rendered nothing, so it marked nothing');
    assert.deepStrictEqual(dry.output.marking, { requested: false, visible: false, metadata: false });
});

// ── the mapping itself ─────────────────────────────────────────────────────

test('markingOutcome reports the RESULT, never the request', () => {
    const { markingOutcome } = execDocument._marking;
    assert.deepStrictEqual(markingOutcome(MARKING, { visible: true, metadata: true }), { requested: true, visible: true, metadata: true });
    assert.deepStrictEqual(markingOutcome(MARKING, null), { requested: true, visible: false, metadata: false });
    assert.deepStrictEqual(markingOutcome(MARKING, { visible: true, metadata: false }), { requested: true, visible: true, metadata: false });
    assert.deepStrictEqual(markingOutcome(null, null), { requested: false, visible: false, metadata: false });
    // A renderer that reports nothing is not evidence of a marking.
    assert.deepStrictEqual(markingOutcome(MARKING, {}), { requested: true, visible: false, metadata: false });
});
