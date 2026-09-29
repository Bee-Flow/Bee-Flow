/**
 * Unit tests for the pure Step-contract helpers.
 *
 * Run: node --test automation/stepContract.test.js
 *
 * Pure module — stepContract reads the trigger.params + layer_output fields,
 * requiredIntegrations resolves integration_action tools (the real
 * integrationToolMap is dependency-light and load-safe), and walkSteps
 * descends into loop bodies / parallel branches. No DB/network.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { stepContract, requiredIntegrations, walkSteps, stepParams, stepOutputFields } = require('./stepContract');

// A Step definition: layer_input trigger declaring params + a layer_output
// step declaring its returned fields.
function stepDef(overrides = {}) {
    return {
        trigger: {
            id: 'trg',
            type: 'trigger',
            kind: 'layer_input',
            params: [
                { name: 'email', type: 'string', required: true },
                { name: 'limit', type: 'number' },
            ],
        },
        steps: [
            { id: 's1', type: 'ai_step', prompt: 'enrich' },
            { id: 'out', type: 'layer_output', fields: { score: { kind: 'literal', value: 1 }, summary: { kind: 'ref', path: 'steps.s1.output.text' } } },
        ],
        edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 'out' }],
        ...overrides,
    };
}

// ── stepContract: params from the trigger + output field keys ────────────
test('stepContract returns params and outputFields from the contract', () => {
    const c = stepContract(stepDef());
    assert.deepStrictEqual(c.params, [
        { name: 'email', type: 'string', required: true, description: '' },
        { name: 'limit', type: 'number', required: false, description: '' },
    ]);
    assert.deepStrictEqual(c.outputFields, ['score', 'summary']);
});

test('stepContract defaults gracefully on an empty / malformed definition', () => {
    assert.deepStrictEqual(stepContract({}), { params: [], outputFields: [] });
    assert.deepStrictEqual(stepContract(null), { params: [], outputFields: [] });
    // params that aren't objects, or lack a name, are dropped.
    const def = { trigger: { params: ['nope', { type: 'string' }, { name: 'ok' }] }, steps: [] };
    assert.deepStrictEqual(stepParams(def), [{ name: 'ok', type: 'string', required: false, description: '' }]);
    assert.deepStrictEqual(stepOutputFields(def), []);
});

// ── requiredIntegrations: walk integration_action steps → integration ids ─
test('requiredIntegrations resolves an integration_action tool to its integration id', () => {
    const def = stepDef({
        steps: [
            { id: 's1', type: 'integration_action', tool: 'gmail_send' },
            { id: 'out', type: 'layer_output', fields: {} },
        ],
    });
    const ids = requiredIntegrations(def);
    assert.ok(Array.isArray(ids), 'returns an array');
    assert.ok(ids.includes('gmail'), `expected 'gmail', got ${JSON.stringify(ids)}`);
});

test('requiredIntegrations returns a sorted unique array and ignores non-integration steps', () => {
    const def = stepDef({
        steps: [
            { id: 's1', type: 'integration_action', tool: 'gmail_send' },
            { id: 's2', type: 'integration_action', tool: 'gmail_read' },
            { id: 's3', type: 'ai_step', prompt: 'no integration here' },
            { id: 'out', type: 'layer_output', fields: {} },
        ],
    });
    const ids = requiredIntegrations(def);
    // Two gmail tools dedupe to one 'gmail'.
    assert.deepStrictEqual(ids, ['gmail']);
    // sorted-unique invariant: a copy sorted equals the original.
    assert.deepStrictEqual([...ids].sort(), ids);
});

test('requiredIntegrations descends into nested layers', () => {
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [{ id: 'cl', type: 'call_layer', layerKey: 'enrich', inputs: {} }],
        edges: [],
        layers: {
            enrich: {
                trigger: { id: 'lt', kind: 'layer_input', params: [] },
                steps: [{ id: 'ls', type: 'integration_action', tool: 'gmail_send' }],
                edges: [],
            },
        },
    };
    assert.deepStrictEqual(requiredIntegrations(def), ['gmail']);
});

test('requiredIntegrations returns [] for a non-object definition', () => {
    assert.deepStrictEqual(requiredIntegrations(null), []);
    assert.deepStrictEqual(requiredIntegrations('nope'), []);
});

// ── requiredIntegrations: the reach of a CODE body ───────────────────────
//
// The gate exists so the palette can hide a Step whose integrations the
// caller lacks. A code body reaches out through `ctx.integrations.<tool>()`,
// a tool name inside a string, so the walk above sees nothing and the Step
// was offered to everyone — the refusal then arrived as `tool "gmail_send"
// not allowed for this step` from inside an isolate, mid-run. Both declared
// forms are read: the list codeSandbox enforces (step.allowedTools) and the
// custom-node capability manifest.

test('requiredIntegrations reads the tools a code body is allowed to call', () => {
    const def = stepDef({
        steps: [
            { id: 'body', type: 'code', code: 'return 1;', allowedTools: ['gmail_send'] },
            { id: 'out', type: 'layer_output', fields: {} },
        ],
    });
    assert.deepStrictEqual(requiredIntegrations(def), ['gmail']);
});

test('requiredIntegrations reads a custom node\'s declared capability manifest', () => {
    // No allowedTools at all: the manifest is the only statement of reach,
    // and a node that declares Gmail must not be offered to someone without
    // it just because the body kept its allowlist somewhere else.
    const def = stepDef({
        steps: [
            { id: 'body', type: 'code', code: 'return 1;' },
            { id: 'out', type: 'layer_output', fields: {} },
        ],
        capabilities: ['tool:gmail_send', 'http', 'secrets'],
    });
    // http/secrets name no integration — only tool capabilities can gate one.
    assert.deepStrictEqual(requiredIntegrations(def), ['gmail']);
});

test('requiredIntegrations folds code reach in with the rest, sorted and unique', () => {
    const def = stepDef({
        steps: [
            { id: 's1', type: 'integration_action', tool: 'gmail_send' },
            { id: 'body', type: 'code', code: 'return 1;', allowedTools: ['gmail_read', 'drive_list'] },
            { id: 'out', type: 'layer_output', fields: {} },
        ],
        capabilities: ['tool:gmail_send'],
    });
    const ids = requiredIntegrations(def);
    assert.deepStrictEqual(ids, ['gmail', 'google_drive']);
    assert.deepStrictEqual([...ids].sort(), ids);
});

test('requiredIntegrations descends into loop bodies and layers for code steps too', () => {
    const def = stepDef({
        steps: [
            { id: 'lp', type: 'loop', body: [{ id: 'body', type: 'code', code: 'return 1;', allowedTools: ['gmail_send'] }] },
            { id: 'out', type: 'layer_output', fields: {} },
        ],
        layers: {
            enrich: {
                trigger: { id: 'lt', kind: 'layer_input', params: [] },
                steps: [{ id: 'lc', type: 'code', code: 'return 2;', allowedTools: ['drive_list'] }],
                edges: [],
            },
        },
    });
    assert.deepStrictEqual(requiredIntegrations(def), ['gmail', 'google_drive']);
});

test('a code tool the resolver does not know still hides the Step', () => {
    // Fail closed: an unresolvable name contributes its coarse id, so a
    // caller who cannot have it does not get offered the Step. Offering one
    // nobody can run is the worse of the two mistakes.
    const def = stepDef({
        steps: [
            { id: 'body', type: 'code', code: 'return 1;', allowedTools: ['acme_sync'] },
            { id: 'out', type: 'layer_output', fields: {} },
        ],
    });
    assert.deepStrictEqual(requiredIntegrations(def), ['acme']);
});

test('a code step that declares no reach adds nothing', () => {
    const def = stepDef({
        steps: [
            { id: 'body', type: 'code', code: 'return inputs.email.length;', allowedTools: [] },
            { id: 'out', type: 'layer_output', fields: {} },
        ],
    });
    assert.deepStrictEqual(requiredIntegrations(def), []);
    // A malformed allowlist is dataShapingRules' error to report; here it
    // simply contributes nothing rather than throwing on a .map of a string.
    const bad = stepDef({ steps: [{ id: 'body', type: 'code', allowedTools: 'gmail_send' }, { id: 'out', type: 'layer_output', fields: {} }] });
    assert.deepStrictEqual(requiredIntegrations(bad), []);
});

// ── walkSteps: flat steps + descend into loop bodies and parallel branches ─
test('walkSteps descends into loop bodies and parallel branches', () => {
    const steps = [
        { id: 'a', type: 'ai_step' },
        {
            id: 'lp', type: 'loop',
            body: [
                { id: 'b', type: 'ai_step' },
                {
                    id: 'par', type: 'parallel',
                    branches: [
                        [{ id: 'c', type: 'ai_step' }],
                        [{ id: 'd', type: 'ai_step' }],
                    ],
                },
            ],
        },
    ];
    const seen = [];
    walkSteps(steps, (s) => seen.push(s.id));
    assert.deepStrictEqual(seen, ['a', 'lp', 'b', 'par', 'c', 'd']);
});

test('walkSteps is a no-op on a non-array', () => {
    let called = 0;
    walkSteps(undefined, () => { called++; });
    walkSteps(null, () => { called++; });
    assert.strictEqual(called, 0);
});
