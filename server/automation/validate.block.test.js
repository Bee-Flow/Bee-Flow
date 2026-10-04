/**
 * Unit tests for the Step (kind='block') extensions to the validator.
 *
 * Run: node --test automation/validate.block.test.js
 *
 * Covers validateDefinition(def, { scope, availableBlocks }):
 *   - scope:'block' applies the contract rules (layer_input trigger, no nested
 *     call_block) at the document root.
 *   - call_block reference checks against an availableBlocks catalog.
 *   - the default scope:'root' path is unchanged (regression).
 *
 * Pure function — no DB/network, so no stubbing needed.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { validateDefinition } = require('./validate');

// A well-formed Step document: a layer_input trigger declaring params + a
// single layer_output step. Validated at the root with { scope:'block' }.
function blockDef(overrides = {}) {
    return {
        schemaVersion: 2,
        trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [{ name: 'email', type: 'string', required: true }] },
        steps: [{ id: 'out', type: 'layer_output', fields: { result: { kind: 'literal', value: 'x' } } }],
        edges: [],
        ...overrides,
    };
}

// ── A valid Step definition validates clean under scope:'block' ──────────
test('valid Step definition passes under scope:block', () => {
    const r = validateDefinition(blockDef(), { scope: 'block' });
    assert.strictEqual(r.ok, true, `expected ok, got errors ${JSON.stringify(r.errors)}`);
    assert.deepStrictEqual(r.errors, []);
});

// ── A Step trigger must be layer_input — any other kind is an error ──────
test('Step with a non-layer_input trigger kind → layer.trigger_kind', () => {
    const def = blockDef({
        trigger: { id: 'trg', type: 'trigger', kind: 'schedule', params: [] },
    });
    const r = validateDefinition(def, { scope: 'block' });
    assert.strictEqual(r.ok, false, 'schedule trigger must block under scope:block');
    assert.ok(r.errors.some(e => e.code === 'layer.trigger_kind'), 'expected layer.trigger_kind');
});

// ── A Step cannot contain another Step (call_block) in v1 ────────────────
test('Step containing a call_block → block.nested_call_forbidden', () => {
    const def = blockDef({
        steps: [
            { id: 'cb', type: 'call_block', blockId: 'b1', inputs: {} },
            { id: 'out', type: 'layer_output', fields: { result: { kind: 'literal', value: 'x' } } },
        ],
        edges: [{ from: 'trg', to: 'cb' }, { from: 'cb', to: 'out' }],
    });
    const r = validateDefinition(def, { scope: 'block' });
    assert.strictEqual(r.ok, false, 'nested call_block must block');
    assert.ok(r.errors.some(e => e.code === 'block.nested_call_forbidden'), 'expected block.nested_call_forbidden');
});

// ── A regular automation's call_block: required param must be bound ──────
test('call_block in an automation: required param unbound → call_block.param_missing', () => {
    const availableBlocks = { b1: { title: 'X', params: [{ name: 'email', required: true }], outputFields: ['r'] } };
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [{ id: 'cb', type: 'call_block', blockId: 'b1', inputs: {} }],
        edges: [{ from: 'trg', to: 'cb' }],
    };
    const r = validateDefinition(def, { availableBlocks });
    assert.strictEqual(r.ok, false, 'unbound required param must block');
    const rec = r.errors.find(e => e.code === 'call_block.param_missing');
    assert.ok(rec, 'expected call_block.param_missing');
    assert.ok(rec.path.endsWith('.email'), `param_missing on email, got path ${rec.path}`);
});

test('call_block in an automation: required param bound → ok', () => {
    const availableBlocks = { b1: { title: 'X', params: [{ name: 'email', required: true }], outputFields: ['r'] } };
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [{ id: 'cb', type: 'call_block', blockId: 'b1', inputs: { email: { kind: 'ref', path: 'trigger.output.email' } } }],
        edges: [{ from: 'trg', to: 'cb' }],
    };
    const r = validateDefinition(def, { availableBlocks });
    assert.strictEqual(r.ok, true, `bound required param should pass, got ${JSON.stringify(r.errors)}`);
});

// ── Unknown blockId (catalog provided) → call_block.unknown_block ────────
test('call_block with an unknown blockId → call_block.unknown_block', () => {
    const availableBlocks = { b1: { title: 'X', params: [], outputFields: ['r'] } };
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [{ id: 'cb', type: 'call_block', blockId: 'nope', inputs: {} }],
        edges: [{ from: 'trg', to: 'cb' }],
    };
    const r = validateDefinition(def, { availableBlocks });
    assert.strictEqual(r.ok, false, 'unknown blockId must block when catalog supplied');
    assert.ok(r.errors.some(e => e.code === 'call_block.unknown_block'), 'expected call_block.unknown_block');
});

// ── REGRESSION: a normal valid automation still validates with no opts ───
test('normal valid automation still passes with default scope (regression)', () => {
    const def = { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [], edges: [] };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, true, `empty manual automation should pass, got ${JSON.stringify(r.errors)}`);
    assert.deepStrictEqual(r.errors, []);
});

// ── A Step whose body is CODE answers to the custom-node contract ────────
//
// `automation/customNode.js` has said since it landed that a custom node's
// declared outputs are mandatory, and nothing called it: the validator was the
// one place that could refuse the save and it did not, so the whole contract
// was advice. The wiring lives in the `scope === 'block'` branch of
// validate/graph.js, next to the layer_output warning it deliberately does not
// replace.
test('a Step with a code body must declare its outputs — a layer still only gets a warning', () => {
    const body = { id: 'body', type: 'code', code: 'return { n: 1 };' };
    const noOut = {
        schemaVersion: 2,
        trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] },
        steps: [body],
        edges: [{ from: 'trg', to: 'body' }],
    };

    // Custom node: an ERROR, because it is bound to by field name. Nothing
    // declared means the picker has no rows, every downstream
    // `steps.<id>.output.<field>` is undefined, and the automation saves, runs
    // green and writes nothing.
    const node = validateDefinition(noOut, { scope: 'block' });
    assert.strictEqual(node.ok, false, JSON.stringify(node.errors));
    assert.ok(node.errors.some(e => e.code === 'custom_node.outputs_missing'),
        `expected custom_node.outputs_missing, got ${JSON.stringify(node.errors.map(e => e.code))}`);

    // The SAME shape without a code body is an ordinary Step and keeps the
    // warning it has always had. A plain Step never agreed to this error.
    const plain = validateDefinition(
        { ...noOut, steps: [{ id: 's', type: 'notification', title: 'x', body: 'y' }] },
        { scope: 'block' },
    );
    assert.ok(!plain.errors.some(e => String(e.code).startsWith('custom_node.')),
        `a Step without a code body is not a custom node: ${JSON.stringify(plain.errors.map(e => e.code))}`);
    assert.ok((plain.warnings || []).some(w => w.code === 'layer.no_output'));

    // And a code-bodied Step that DOES declare its outputs passes.
    const good = validateDefinition({
        ...noOut,
        steps: [body, { id: 'out', type: 'layer_output', fields: { n: { kind: 'ref', path: 'steps.body.output.n' } } }],
        edges: [{ from: 'trg', to: 'body' }, { from: 'body', to: 'out' }],
    }, { scope: 'block' });
    assert.ok(!good.errors.some(e => String(e.code).startsWith('custom_node.')),
        JSON.stringify(good.errors.map(e => e.code)));
});

test('the custom-node contract is a BLOCK-scope rule, never the root or a layer', () => {
    // At the root a code step is just a code step. Applying a Step's contract
    // to an ordinary automation would make every automation with a code step in
    // it unsaveable.
    const root = validateDefinition({
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [{ id: 'body', type: 'code', code: 'return { n: 1 };' }],
        edges: [{ from: 'trg', to: 'body' }],
    });
    assert.ok(!root.errors.some(e => String(e.code).startsWith('custom_node.')),
        JSON.stringify(root.errors.map(e => e.code)));
});
