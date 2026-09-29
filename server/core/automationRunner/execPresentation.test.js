/**
 * slide + presentation — the routine pair.
 *
 * What is pinned: the sole-token rule (a `{{path}}` bound into `slides`
 * keeps its real type, so a list of slide references is a list of slide
 * OBJECTS, never JSON strings), the three input shapes reaching one deck,
 * the dry-run shape (identical keys to the live one), the marking report,
 * the `sourceHandle` every file-producing step now carries, and that a slide
 * step never touches storage.
 *
 * The renderer, storage and ledger are doubles; the deck model runs for real.
 *
 * Run: cd server && node --test --test-force-exit core/automationRunner/execPresentation.test.js
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

const renderer = {
    calls: [],
    result: null,
    async renderPresentation(opts) {
        renderer.calls.push(opts);
        return renderer.result;
    },
    makeUserImageResolver: (_userId) => async () => null,
};
const storage = {
    uploads: [],
    available: true,
    isAvailable: () => storage.available,
    buildAutomationFileKey: (userId, automationId, sha) => `auto/${automationId}/${sha}`,
    async uploadFile(key, buffer, contentType) { storage.uploads.push({ key, size: buffer.length, contentType }); },
};
const automationStore = {
    records: [],
    async getAutomation() { return null; },
    async recordGeneratedFile(row) { automationStore.records.push(row); return { id: `file-${automationStore.records.length}` }; },
};
const library = { created: [] };
const restore = installResolveStub({
    '../../services/presentationRenderer': renderer,
    '../../stores/storageStore': storage,
    '../../stores/automationStore': automationStore,
    '../../stores/configStore': { getConfig: async () => null, setConfig: async () => {} },
    // Where saveCopy keeps the deck (core/documents/deckDocument.js).
    '../../stores/documentStore': { createDocument: async (input) => { library.created.push(input); return { id: `doc-${library.created.length}`, name: input.name, versionId: 'v1' }; } },
});
const { execSlide, execPresentation, _test } = require('./execPresentation');
const port = require('./documentMarking');
after(() => { restore(); port.setMarkingResolver(null); });

const CTX = { orgId: 'org-1', userId: 'user-1', automationId: 'auto-7', runId: 'run-1' };
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

function ok(overrides = {}) {
    return { buffer: Buffer.from('PK-fake'), contentType: PPTX, format: 'pptx', extension: 'pptx', slideCount: 3, warnings: [], degraded: false, marking: null, houseStyle: true, ...overrides };
}

beforeEach(() => {
    renderer.calls = [];
    renderer.result = ok();
    storage.uploads = [];
    storage.available = true;
    automationStore.records = [];
    port.setMarkingResolver(null);
});

// ── slide ───────────────────────────────────────────────────────────────

test('slide: a pure object — interpolated, layout inferred, lists rendered as bullets, no storage', async () => {
    const runState = { steps: { x: { output: { name: 'Omzet', points: ['a', 'b'], note: 'zeg dit' } } } };
    const res = await execSlide({ id: 's1', type: 'slide', title: '{{steps.x.output.name}}', content: 'Highlights: {{steps.x.output.points}}', notes: '{{steps.x.output.note}}' }, CTX, runState, 'live');
    assert.strictEqual(res.output.slide.title, 'Omzet');
    assert.strictEqual(res.output.slide.layout, 'bullets');
    assert.deepStrictEqual(res.output.slide.bullets.map((b) => b.text), ['a', 'b']);
    assert.match(res.output.slide.body, /Highlights:/);
    assert.strictEqual(res.output.slide.notes, 'zeg dit');
    assert.strictEqual(storage.uploads.length, 0);
    const dry = await execSlide({ id: 's1', type: 'slide', title: 'T', layout: 'section' }, CTX, runState, 'dry_run');
    assert.strictEqual(dry.output.slide.layout, 'section', 'dry run is the same run');
});

// ── the sole-token rule ─────────────────────────────────────────────────

test('resolveSlidesInput: a whole {{path}} keeps its real type, mixed text is interpolated, lists recurse', () => {
    const runState = { steps: { s1: { output: { slide: { title: 'A', bullets: [{ text: 'x', level: 0 }] } } }, n: { output: { count: 3 } } } };
    const out = _test.resolveSlidesInput(['{{steps.s1.output.slide}}', 'Slide {{steps.n.output.count}}', { title: '{{steps.s1.output.slide.title}}', content: '- y' }], runState);
    assert.strictEqual(typeof out[0], 'object');
    assert.strictEqual(out[0].title, 'A');
    assert.strictEqual(out[1], 'Slide 3');
    assert.strictEqual(out[2].title, 'A');
    assert.strictEqual(_test.resolveSlidesInput('{{steps.s1.output.slide}}', runState).title, 'A');
    assert.strictEqual(_test.resolveSlidesInput({ kind: 'ref', path: 'steps.n.output.count' }, runState), 3);
});

// ── presentation: the three shapes ──────────────────────────────────────

test('shape 1: the markdown an ai_step wrote becomes the deck, and its # title the cover', async () => {
    const runState = { steps: { write: { status: 'success', output: { text: '# Kwartaal\n\n## Omzet\n- a\n\n## Marge\n- b' } } } };
    const res = await execPresentation({ id: 'deck', type: 'presentation', slides: '{{steps.write.output.text}}' }, CTX, runState, 'live');
    const deck = renderer.calls[0].deck;
    assert.strictEqual(deck.title, 'Kwartaal');
    assert.deepStrictEqual(deck.slides.map((s) => s.title), ['Omzet', 'Marge']);
    assert.strictEqual(res.output.filename, 'Kwartaal.pptx');
    assert.strictEqual(res.output.mimeType, PPTX);
    assert.deepStrictEqual(res.output.sourceHandle, { kind: 'generated_file', fileId: 'file-1' });
    assert.strictEqual(storage.uploads.length, 1);
    assert.strictEqual(automationStore.records[0].stepId, 'deck');
});

test('shape 2: a list of slide-step references arrives as slide objects', async () => {
    const runState = { steps: {
        s1: { status: 'success', output: { slide: { title: 'One', bullets: [{ text: 'a', level: 0 }], layout: 'bullets' } } },
        s2: { status: 'success', output: { slide: { title: 'Two', quote: { text: 'q', attribution: null }, layout: 'quote' } } },
    } };
    await execPresentation({ id: 'deck', type: 'presentation', title: 'List', slides: ['{{steps.s1.output.slide}}', '{{steps.s2.output.slide}}'] }, CTX, runState, 'live');
    const deck = renderer.calls[0].deck;
    assert.strictEqual(deck.title, 'List');
    assert.deepStrictEqual(deck.slides.map((s) => [s.title, s.layout]), [['One', 'bullets'], ['Two', 'quote']]);
});

test('shape 3: a forEach / loop output is unwrapped through results[].output', async () => {
    const runState = { steps: { s: { status: 'success', output: { iterations: 2, results: [
        { index: 0, item: {}, output: { slide: { title: 'r1', bullets: [] } } },
        { index: 1, item: {}, output: { slide: { title: 'r2', bullets: [] } } },
    ] } } } };
    await execPresentation({ id: 'deck', type: 'presentation', title: 'Loop', slides: '{{steps.s.output}}' }, CTX, runState, 'live');
    assert.deepStrictEqual(renderer.calls[0].deck.slides.map((s) => s.title), ['r1', 'r2']);
    await execPresentation({ id: 'deck', type: 'presentation', title: 'Loop', slides: '{{steps.s.output.results[*].output.slide}}' }, CTX, runState, 'live');
    assert.deepStrictEqual(renderer.calls[1].deck.slides.map((s) => s.title), ['r1', 'r2']);
});

// ── dry run, format, options ────────────────────────────────────────────

test('dry run: same keys as the live shape, the deck IS collected, nothing rendered or stored', async () => {
    const runState = { steps: { write: { output: { text: '# T\n## A\n- a' } } } };
    const dry = await execPresentation({ id: 'deck', type: 'presentation', slides: '{{steps.write.output.text}}', format: 'pdf' }, CTX, runState, 'dry_run');
    assert.strictEqual(dry.dryRunSynthesised, true);
    assert.strictEqual(dry.output.fileId, 'dry-run');
    assert.strictEqual(dry.output.filename, 'T.pdf');
    assert.strictEqual(dry.output.mimeType, 'application/pdf');
    assert.strictEqual(dry.output.slideCount, 2);
    assert.strictEqual(renderer.calls.length, 0);
    assert.strictEqual(storage.uploads.length, 0);
    const live = await execPresentation({ id: 'deck', type: 'presentation', slides: '{{steps.write.output.text}}', format: 'pdf' }, CTX, runState, 'live');
    const liveKeys = Object.keys(live.output).sort();
    const dryKeys = Object.keys(dry.output).filter((k) => k !== '_dryRun').sort();
    assert.deepStrictEqual(dryKeys, liveKeys);
    await assert.rejects(execPresentation({ id: 'deck', type: 'presentation', slides: '' }, CTX, runState, 'dry_run'), (e) => e.errorClass === 'presentation_empty');
});

test('format, houseStyle, fileName and title reach the renderer; expiresInDays is clamped into the ledger', async () => {
    const runState = { steps: { write: { output: { text: '## A\n- a' } } } };
    const res = await execPresentation({
        id: 'deck', type: 'presentation', slides: '{{steps.write.output.text}}', title: 'Board', fileName: 'board-deck', format: 'pdf', houseStyle: false, expiresInDays: 500,
    }, CTX, runState, 'live');
    const call = renderer.calls[0];
    assert.strictEqual(call.format, 'pdf');
    assert.strictEqual(call.houseStyle, false);
    assert.strictEqual(call.title, 'Board');
    assert.strictEqual(call.orgId, 'org-1');
    assert.strictEqual(res.output.filename, 'board-deck.pdf');
    assert.strictEqual(automationStore.records[0].ttlMs, 90 * 24 * 60 * 60 * 1000);
});

// ── marking ─────────────────────────────────────────────────────────────

test('marking: the run log records what the renderer reports, never what was asked', async () => {
    const definition = { steps: [{ id: 'ai_1', type: 'ai_step', model: 'claude-opus-5' }, { id: 'deck', type: 'presentation', slides: '{{steps.ai_1.output.text}}' }] };
    const ctx = { ...CTX, definition };
    const runState = { steps: { ai_1: { status: 'success', output: { text: '# T\n## A\n- a' } } } };
    const marking = { enabled: true, org_name: 'Acme', provider: 'claude', generated_at: '2026-09-18T00:00:00Z', automation_id: 'auto-7', ai_step_ids: ['ai_1'], footer_text: 'Generated with AI — Acme', locale: 'nl' };
    port.setMarkingResolver(async () => marking);

    renderer.result = ok({ marking: { visible: true, metadata: true } });
    const marked = await execPresentation(definition.steps[1], ctx, runState, 'live');
    assert.strictEqual(renderer.calls[0].marking, marking, 'the resolved marking is handed to the renderer');
    assert.deepStrictEqual(marked.output.marking, { requested: true, visible: true, metadata: true });
    assert.strictEqual(marked.output.marked, true);

    renderer.result = ok({ marking: null });
    const unmarked = await execPresentation(definition.steps[1], ctx, runState, 'live');
    assert.deepStrictEqual(unmarked.output.marking, { requested: true, visible: false, metadata: false });
    assert.strictEqual(unmarked.output.marked, false);
});

test('storage unavailable is a routable error; an empty resolution is presentation_empty', async () => {
    const runState = { steps: { write: { output: { text: '## A' } } } };
    storage.available = false;
    await assert.rejects(execPresentation({ id: 'deck', type: 'presentation', slides: '{{steps.write.output.text}}' }, CTX, runState, 'live'), (e) => e.errorClass === 'storage_unavailable');
    storage.available = true;
    await assert.rejects(execPresentation({ id: 'deck', type: 'presentation', slides: '{{steps.missing.output.text}}' }, CTX, runState, 'live'), (e) => e.errorClass === 'presentation_empty');
});

// ── visuals & look (round 3) ────────────────────────────────────────────

test('slide: chart.data bound as a whole reference stays rows and becomes a chart with auto-detected columns', async () => {
    const runState = { steps: { q: { output: { rows: [{ maand: 'jan', omzet: '€ 12', kosten: 3 }, { maand: 'feb', omzet: 15, kosten: 4 }] } } } };
    const res = await execSlide({ id: 's', type: 'slide', title: 'Omzet', chart: { type: 'line', data: '{{steps.q.output.rows}}', values: 'omzet' } }, CTX, runState);
    const { slide } = res.output;
    assert.strictEqual(slide.layout, 'chart');
    assert.strictEqual(slide.chart.type, 'line');
    assert.deepStrictEqual(slide.chart.labels, ['jan', 'feb']);
    assert.deepStrictEqual(slide.chart.series, [{ name: 'omzet', values: [12, 15] }]);
    // A chart type alone charts the table in the content
    const tbl = await execSlide({ id: 't', type: 'slide', title: 'Regio', content: '| Regio | Omzet |\n|---|---|\n| N | 1 |\n| Z | 3 |', chart: { type: 'pie' } }, CTX, runState);
    assert.strictEqual(tbl.output.slide.layout, 'chart');
    assert.strictEqual(tbl.output.slide.table, null, 'the table became the chart');
    assert.deepStrictEqual(tbl.output.slide.chart.labels, ['N', 'Z']);
});

test('slide: stats lines with templates, a timeline from bullets, an accent style — and a chart without numbers degrades with a warning', async () => {
    const runState = { steps: { t: { output: { total: '€ 1,2M', n: 48, rows: [{ a: 'x' }] } } } };
    const st = await execSlide({ id: 's', type: 'slide', title: 'KPI', stats: '{{steps.t.output.total}} | Omzet | +12%\n{{steps.t.output.n}} | Klanten', style: 'accent' }, CTX, runState);
    assert.strictEqual(st.output.slide.layout, 'stats');
    assert.deepStrictEqual(st.output.slide.stats, [{ value: '€ 1,2M', label: 'Omzet', delta: '+12%', icon: null }, { value: '48', label: 'Klanten', delta: null, icon: null }]);
    assert.strictEqual(st.output.slide.style, 'accent');
    const tl = await execSlide({ id: 'p', type: 'slide', title: 'Plan', content: '- Kick-off — start\n- Live', layout: 'timeline' }, CTX, runState);
    assert.strictEqual(tl.output.slide.layout, 'timeline');
    assert.deepStrictEqual(tl.output.slide.steps, [{ title: 'Kick-off', text: 'start' }, { title: 'Live', text: null }]);
    const bad = await execSlide({ id: 'b', type: 'slide', title: 'No numbers', content: '- a', chart: { type: 'bar', data: '{{steps.t.output.rows}}' } }, CTX, runState);
    assert.strictEqual(bad.output.slide.layout, 'bullets');
    assert.strictEqual(bad.output.slide.chart, null);
    assert.ok(bad.output.warnings.some((w) => /no numbers/.test(w)));
});

test('presentation: every Look field reaches the renderer as a theme override; templates resolve; "none" switches the logo off', async () => {
    const runState = { steps: { write: { output: { text: '## A\n- a' } }, brand: { output: { colour: '#AA0000', logo: 'users/user-1/images/logo.png' } } } };
    await execPresentation({
        id: 'deck', type: 'presentation', slides: '{{steps.write.output.text}}',
        preset: 'dark', accent: '{{steps.brand.output.colour}}', background: '#16191F', font: 'Georgia', titleFont: 'Arial',
        coverStyle: 'split', tableStyle: 'lines', logo: '{{steps.brand.output.logo}}', logoPlacement: 'corner', footerText: 'Vertrouwelijk', slideNumbers: false,
    }, CTX, runState, 'live');
    assert.deepStrictEqual(renderer.calls[0].theme, {
        preset: 'dark', font: 'Georgia', titleFont: 'Arial', coverStyle: 'split', tableStyle: 'lines', logoPlacement: 'corner',
        accent: '#AA0000', background: '#16191F', logo: 'users/user-1/images/logo.png', footerText: 'Vertrouwelijk', slideNumbers: false,
    });
    await execPresentation({ id: 'deck2', type: 'presentation', slides: '{{steps.write.output.text}}', logo: 'none' }, CTX, runState, 'live');
    assert.deepStrictEqual(renderer.calls[1].theme, { logo: 'none' });
    await execPresentation({ id: 'deck3', type: 'presentation', slides: '{{steps.write.output.text}}', accent: '', logo: '  ' }, CTX, runState, 'live');
    assert.strictEqual(renderer.calls[2].theme, null, 'blank look fields leave the house style in charge');
});

test('presentation: saveCopy keeps the deck in Studio → Documents as a presentation, with the node\'s look; off by default', async () => {
    library.created.length = 0;
    const runState = { steps: { write: { output: { text: '# Cijfers\n\n## A\n- a\n\n## B\n- b' } }, t: { output: { q: 'Q3' } } } };
    const plain = await execPresentation({ id: 'deck', type: 'presentation', slides: '{{steps.write.output.text}}' }, CTX, runState, 'live');
    assert.strictEqual(plain.output.savedDocumentId, undefined);
    assert.strictEqual(library.created.length, 0);
    const kept = await execPresentation({ id: 'deck', type: 'presentation', slides: '{{steps.write.output.text}}', preset: 'bold', saveCopy: true, copyName: 'Cijfers {{steps.t.output.q}}' }, CTX, runState, 'live');
    assert.strictEqual(kept.output.savedDocumentId, 'doc-1');
    assert.strictEqual(kept.output.savedDocumentUrl, '/app/studio/documents/doc-1');
    const doc = library.created[0];
    assert.strictEqual(doc.name, 'Cijfers Q3');
    assert.strictEqual(doc.docType, 'presentation');
    assert.strictEqual(doc.userId, 'user-1');
    assert.match(doc.bodyHtml, /^# Cijfers\n\n## A\n- a\n\n## B\n- b/);
    assert.deepStrictEqual(doc.settings.deck, { preset: 'bold' });
    assert.strictEqual(doc.settings.generatedFrom.source, 'routine');
    // A dry run keeps nothing.
    await execPresentation({ id: 'deck', type: 'presentation', slides: '{{steps.write.output.text}}', saveCopy: true }, CTX, runState, 'dry_run');
    assert.strictEqual(library.created.length, 1);
});
