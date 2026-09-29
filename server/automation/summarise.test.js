/**
 * Tests for the automation summarisers.
 *
 * Run: node --test automation/summarise.test.js
 *
 * No DB / network — pure functions over an in-memory definition.
 */

const { test } = require('node:test');
const assert = require('assert');
const { summariseDefinition, renderAgentDraftState } = require('./summarise');

const DEF = {
    trigger: { id: 'trg', kind: 'manual' },
    steps: [
        { id: 'a_search', type: 'integration_action', tool: 'gmail_search', label: 'Search', inputs: { q: { kind: 'literal', value: 'label:invoices' } } },
        { id: 'a_read', type: 'integration_action', tool: 'gmail_read', forEach: { overRef: 'steps.a_search.output.messages', itemVar: 'email' }, inputs: { messageId: { kind: 'ref', path: 'loop.email.id' } } },
    ],
    edges: [{ from: 'trg', to: 'a_search' }, { from: 'a_search', to: 'a_read' }],
    layers: {
        enrich: {
            title: 'Enrich',
            trigger: { id: 'trg', kind: 'layer_input', params: [{ name: 'supplierName' }] },
            steps: [
                { id: 'out', type: 'layer_output', fields: { invoices: { kind: 'ref', path: 'steps.set1.output.invoices' } } },
                { id: 'set1', type: 'set', fields: { invoices: { kind: 'ref', path: 'steps.agg.output.values' } } },
            ],
            edges: [{ from: 'trg', to: 'set1' }, { from: 'set1', to: 'out' }],
        },
    },
};

test('renderAgentDraftState exposes real step IDs, settings, bindings + layers', () => {
    const s = renderAgentDraftState(DEF);
    // Real step ids (not 1./2. numbering) for the main flow.
    assert.ok(s.includes('`a_search`') && s.includes('`a_read`'), 'root step ids present');
    // Tool + its input binding (the mapping between steps).
    assert.ok(s.includes('gmail_read') && s.includes('messageId=`loop.email.id`'), 'tool + input binding shown');
    // Per-step forEach iteration is surfaced.
    assert.ok(/forEach over `steps\.a_search\.output\.messages` as loop\.email/.test(s), 'forEach iteration shown');
    // Layers are rendered (summariseDefinition ignores them — this is the fix).
    assert.ok(s.includes('FLOWLET `enrich`') && s.includes('supplierName'), 'flowlet + its declared input shown');
    assert.ok(s.includes('returns=') && s.includes('steps.set1.output.invoices'), 'layer_output return binding shown');
    // Edge wiring (order/mapping) for both graphs.
    assert.ok(s.includes('wiring: trg→a_search'), 'main-flow edges shown');
    assert.ok(s.includes('wiring: trg→set1'), 'layer edges shown');
});

test('renderAgentDraftState handles an empty / missing draft', () => {
    assert.strictEqual(renderAgentDraftState(null), '_(empty draft)_');
    const s = renderAgentDraftState({ trigger: { id: 'trg', kind: 'manual' }, steps: [], edges: [] });
    assert.ok(s.startsWith('MAIN FLOW:'), 'renders the main-flow header even with no steps');
});

test('summariseDefinition stays human-readable (no raw step IDs)', () => {
    const { summary } = summariseDefinition(DEF);
    assert.ok(summary.includes('**Trigger:**'), 'human summary keeps its prose shape');
    assert.ok(!summary.includes('`a_search`'), 'human summary does not leak raw step ids');
});

// ── note (BFSF-411) — a canvas annotation, not a step the routine runs ────
{
    const defWithNote = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [
            { id: 'n1', type: 'notification', title: 'hi' },
            { id: 'note_1', type: 'note', text: 'why this notification exists' },
            { id: 'n2', type: 'notification', title: 'bye' },
        ],
        edges: [{ from: 'trg', to: 'n1' }, { from: 'n1', to: 'n2' }],
    };

    test('summariseDefinition excludes a note from the numbered step list entirely', () => {
        const { summary } = summariseDefinition(defWithNote);
        // Two REAL steps, numbered 1. and 2. — the note took no number and
        // contributed no line of its own to the count.
        assert.ok(summary.includes('1. Send notification'), 'first real step is "1."');
        assert.ok(summary.includes('2. Send notification'), 'second real step is "2." — the note did not consume a number');
        assert.ok(!summary.includes('3.'), 'nothing numbered past the two real steps');
        assert.ok(!/note step/.test(summary), 'the note never falls through to the raw-type default line');
    });

    test('a definition with ONLY a note reports "no steps yet", not a phantom one', () => {
        const { summary } = summariseDefinition({
            trigger: { id: 'trg', kind: 'manual' },
            steps: [{ id: 'note_1', type: 'note', text: 'todo' }],
            edges: [],
        });
        assert.ok(summary.includes('_(no steps yet)_'));
    });

    test('renderAgentDraftState (the AGENT-facing view) still shows the note — the agent needs to see and edit it', () => {
        const s = renderAgentDraftState(defWithNote);
        assert.ok(s.includes('`note_1`'), 'the note is listed by id, unlike the human summary');
        assert.ok(/note_1.*note.*why this notification exists/.test(s), 'its text is shown so the agent knows what it says');
    });
}

// ── Code steps: the declared parameters (code step v2) ──────────────
const VAT_CODE = [
    '/**',
    ' * Adds VAT to an amount.',
    ' *',
    ' * @param {object} inputs',
    ' * @param {number} inputs.amount - The amount without VAT',
    ' * @param {number} [inputs.vatRate=21] - VAT percentage',
    ' * @param {string} [inputs.note] - A remark',
    ' */',
    'async function main(inputs, ctx) {',
    '  return { total: inputs.amount * (1 + inputs.vatRate / 100) };',
    '}',
].join('\n');

const CODE_DEF = {
    trigger: { id: 'trg', kind: 'manual' },
    steps: [{
        id: 'code_1', type: 'code', code: VAT_CODE, allowedTools: ['gmail_send'],
        inputs: { amount: { kind: 'ref', path: 'trigger.output.total' } },
    }],
    edges: [{ from: 'trg', to: 'code_1' }],
};

const VAT_PARAMS = [
    { name: 'amount', type: 'number', required: true, description: 'The amount without VAT' },
    { name: 'vatRate', type: 'number', required: false, default: 21, description: 'VAT percentage' },
    { name: 'note', type: 'string', required: false, description: 'A remark' },
];

test('renderAgentDraftState shows a code step\'s declared params, its tools and its input bindings', () => {
    const seen = [];
    const s = renderAgentDraftState(CODE_DEF, { codeParams: (code) => { seen.push(code); return VAT_PARAMS; } });
    const line = s.split('\n').find(l => l.includes('`code_1`'));
    assert.ok(line, 'the code step has a line');
    assert.match(line, /code \(\d+ chars\) params=\[amount\*, vatRate=21, note\]/, 'required marked *, default shown');
    assert.match(line, /tools=\[gmail_send\]/, 'the tools it may call');
    assert.match(line, /← inputs \{ amount=`trigger\.output\.total` \}/, 'what its inputs are bound to');
    assert.deepStrictEqual(seen, [VAT_CODE], 'the params are read from the step\'s own code');
});

test('a code step whose params cannot be read keeps the plain size line', () => {
    const none = renderAgentDraftState(CODE_DEF, { codeParams: () => null }).split('\n').find(l => l.includes('`code_1`'));
    assert.match(none, /code \(\d+ chars\) tools=/, 'no params list without params');
    const broken = renderAgentDraftState(CODE_DEF, { codeParams: () => { throw new Error('parser exploded'); } });
    assert.ok(broken.includes('`code_1` code ('), 'an analyser that throws never breaks the draft state');
});

test('with the real analyser, the params come from the JSDoc on main', (t) => {
    let analyzeCode;
    try { ({ analyzeCode } = require('./codeSafety')); } catch (_) { analyzeCode = null; }
    if (typeof analyzeCode !== 'function') { t.skip('automation/codeSafety is not in this tree yet'); return; }
    const line = renderAgentDraftState(CODE_DEF).split('\n').find(l => l.includes('`code_1`'));
    assert.match(line, /params=\[amount\*, vatRate=21, note\]/);
});
