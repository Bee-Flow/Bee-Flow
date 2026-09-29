/**
 * Unit tests for the custom-node contract.
 *
 * Two things are being pinned here, and both are failures this product has
 * had before.
 *
 * 1. DECLARED OUTPUTS ARE MANDATORY. validate/graph.js only warns about a
 *    layer without a layer_output, because such a layer still runs. A custom
 *    node is different: it is picked from a palette and bound to BY FIELD
 *    NAME, so a node that declares nothing gives the binding picker no rows,
 *    resolves every downstream `steps.<id>.output.<field>` to undefined, and
 *    saves and runs green while writing nothing.
 *
 * 2. THE CAPABILITY MANIFEST IS THE SANDBOX'S ALLOWLIST. A code body reaches
 *    Gmail through `ctx.integrations.gmail_send(...)` — a tool name inside a
 *    string — so no walk of the graph can see it and the palette would offer
 *    the node to everyone. The manifest is that answer, declared; the last
 *    test in this file runs the real isolate to show it is the same list
 *    codeSandbox enforces, not a description of one.
 *
 * Pure module apart from that last test (which needs isolated-vm). No DB, no
 * network.
 *
 * Run: cd server && node --test --test-force-exit automation/customNode.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
    CAPABILITY_KINDS,
    CAPABILITY_BRIDGES,
    GRANTABLE_CAPABILITY_KINDS,
    parseCapability,
    declaredCapabilities,
    capabilityToolNames,
    sandboxAllowedTools,
    customNodeBody,
    isCustomNodeDefinition,
    customNodeContract,
    validateCustomNode,
} = require('./customNode');

// A custom node: the Step contract (layer_input params + layer_output
// fields) plus a code body and the manifest of what that body may reach.
function nodeDef(overrides = {}) {
    return {
        trigger: {
            id: 'trg', type: 'trigger', kind: 'layer_input',
            params: [{ name: 'to', type: 'string', required: true }],
        },
        steps: [
            { id: 'body', type: 'code', code: 'return 1;', allowedTools: ['gmail_send'] },
            { id: 'out', type: 'layer_output', fields: { sent: { kind: 'ref', path: 'steps.body.output.result' } } },
        ],
        edges: [{ from: 'trg', to: 'body' }, { from: 'body', to: 'out' }],
        capabilities: ['tool:gmail_send'],
        ...overrides,
    };
}

const codesOf = (issues) => issues.map(i => i.code);
// Replace the body's step, keeping the rest of the node intact.
const withBody = (body) => nodeDef({ steps: [body, { id: 'out', type: 'layer_output', fields: { sent: { kind: 'literal', value: 1 } } }] });

// ── The contract ────────────────────────────────────────────────────────

test('customNodeContract reads params, outputs, manifest and body in one call', () => {
    const c = customNodeContract(nodeDef());
    assert.deepStrictEqual(c.params, [{ name: 'to', type: 'string', required: true, description: '' }]);
    assert.deepStrictEqual(c.outputFields, ['sent']);
    assert.deepStrictEqual(c.capabilities, ['tool:gmail_send']);
    assert.deepStrictEqual(c.toolNames, ['gmail_send']);
    assert.strictEqual(c.bodyStepId, 'body');
});

test('a code body is what makes a Step a custom node', () => {
    assert.strictEqual(isCustomNodeDefinition(nodeDef()), true);
    // A plain Step: its reach is readable from the graph, so it needs none of
    // this.
    const plain = nodeDef({ steps: [{ id: 's1', type: 'integration_action', tool: 'gmail_send' }, { id: 'out', type: 'layer_output', fields: { x: { kind: 'literal', value: 1 } } }] });
    assert.strictEqual(isCustomNodeDefinition(plain), false);
    assert.strictEqual(isCustomNodeDefinition(null), false);
    assert.strictEqual(customNodeBody(nodeDef()).id, 'body');
});

test('a well-formed custom node validates clean', () => {
    assert.deepStrictEqual(validateCustomNode(nodeDef()), []);
    // A node that reaches nothing declares nothing — an empty manifest is a
    // complete manifest, not a missing one.
    const pure = nodeDef({ steps: [{ id: 'body', type: 'code', code: 'return inputs.to.length;', allowedTools: [] }, { id: 'out', type: 'layer_output', fields: { n: { kind: 'literal', value: 1 } } }], capabilities: [] });
    assert.deepStrictEqual(validateCustomNode(pure), []);
});

// ── 1. Declared outputs are REQUIRED ────────────────────────────────────

test('a node with no layer_output is refused', () => {
    const def = nodeDef({ steps: [{ id: 'body', type: 'code', code: 'return 1;', allowedTools: ['gmail_send'] }] });
    assert.ok(codesOf(validateCustomNode(def)).includes('outputs_missing'));
});

test('a layer_output that declares no fields is refused — this is the "saved nothing" case', () => {
    const empty = nodeDef({ steps: [{ id: 'body', type: 'code', code: 'return 1;', allowedTools: ['gmail_send'] }, { id: 'out', type: 'layer_output', fields: {} }] });
    assert.ok(codesOf(validateCustomNode(empty)).includes('outputs_empty'));
    // No `fields` at all, and a malformed one, are the same story: nothing is
    // declared. The SHAPE message belongs to dataShapingRules, so there is
    // exactly one issue here, not two.
    const missing = nodeDef({ steps: [{ id: 'body', type: 'code', code: 'return 1;', allowedTools: ['gmail_send'] }, { id: 'out', type: 'layer_output' }] });
    assert.deepStrictEqual(codesOf(validateCustomNode(missing)), ['outputs_empty']);
    const malformed = nodeDef({ steps: [{ id: 'body', type: 'code', code: 'return 1;', allowedTools: ['gmail_send'] }, { id: 'out', type: 'layer_output', fields: ['sent'] }] });
    assert.deepStrictEqual(codesOf(validateCustomNode(malformed)), ['outputs_empty']);
});

test('the outputs refusal is an error record with a path and a hint, not a bare code', () => {
    const def = nodeDef({ steps: [{ id: 'body', type: 'code', code: 'return 1;', allowedTools: ['gmail_send'] }] });
    const issue = validateCustomNode(def).find(i => i.code === 'outputs_missing');
    assert.ok(issue, 'expected outputs_missing');
    assert.strictEqual(issue.path, 'steps');
    assert.ok(issue.message && issue.hint, 'an author needs to be told what to do about it');
});

// ── 2. The capability vocabulary ────────────────────────────────────────

test('parseCapability accepts exactly the sandbox vocabulary', () => {
    assert.deepStrictEqual(parseCapability('tool:gmail_send'), { kind: 'tool', tool: 'gmail_send' });
    assert.deepStrictEqual(parseCapability(' http '), { kind: 'http', tool: null });
    assert.deepStrictEqual(parseCapability('db'), { kind: 'db', tool: null });
    assert.deepStrictEqual(parseCapability('secrets'), { kind: 'secrets', tool: null });
    // A bare `tool` names no tool. The sandbox gates per NAME, so accepting
    // it would store a manifest entry that reads like "every tool" and gates
    // nothing at all.
    assert.strictEqual(parseCapability('tool'), null);
    assert.strictEqual(parseCapability('tool:'), null);
    assert.strictEqual(parseCapability('filesystem'), null);
    assert.strictEqual(parseCapability(''), null);
    assert.strictEqual(parseCapability(42), null);
    assert.strictEqual(parseCapability(null), null);
});

test('declaredCapabilities normalizes: junk dropped, duplicates collapsed, order kept', () => {
    const def = nodeDef({ capabilities: ['tool:gmail_send', 'http', 'tool:gmail_send', 'nonsense', 7, 'tool:gmail_send '] });
    assert.deepStrictEqual(declaredCapabilities(def).map(c => c.id), ['tool:gmail_send', 'http']);
    assert.deepStrictEqual(declaredCapabilities({}), []);
    assert.deepStrictEqual(declaredCapabilities(nodeDef({ capabilities: 'tool:gmail_send' })), []);
});

test('capabilities that are not a list, or not capabilities, are refused', () => {
    assert.ok(codesOf(validateCustomNode(nodeDef({ capabilities: 'tool:gmail_send' }))).includes('capabilities_shape'));
    const unknown = validateCustomNode(nodeDef({ capabilities: ['tool:gmail_send', 'filesystem'] }));
    const issue = unknown.find(i => i.code === 'capability_unknown');
    assert.ok(issue, `expected capability_unknown, got ${JSON.stringify(codesOf(unknown))}`);
    assert.strictEqual(issue.path, 'capabilities[1]');
});

test('a capability the sandbox would refuse is a validation error, not a run-time surprise', () => {
    // ctx.secrets throws for every caller. The refusal reads the sandbox's
    // own wording rather than a second copy of it — codeSandbox's header says
    // why there is exactly one.
    const { SECRETS_NOT_CONFIGURED_MESSAGE } = require('./codeSandbox');
    const secrets = validateCustomNode(nodeDef({ capabilities: ['tool:gmail_send', 'secrets'] }));
    const refused = secrets.find(i => i.code === 'capability_refused');
    assert.ok(refused, `expected capability_refused, got ${JSON.stringify(codesOf(secrets))}`);
    assert.ok(refused.message.includes(SECRETS_NOT_CONFIGURED_MESSAGE), 'the refusal must be the sandbox\'s own sentence');

    // ctx.db exists only when the host passes a db bridge; the automation
    // runner passes none, so the call would die partway through a live run.
    const db = validateCustomNode(nodeDef({ capabilities: ['tool:gmail_send', 'db'] }));
    assert.ok(codesOf(db).includes('capability_unavailable'), `expected capability_unavailable, got ${JSON.stringify(codesOf(db))}`);

    // Both are still WORDS the vocabulary knows — an author who declares one
    // is told why they cannot have it, not that it does not exist.
    assert.ok(CAPABILITY_KINDS.includes('secrets') && CAPABILITY_KINDS.includes('db'));
    assert.deepStrictEqual(GRANTABLE_CAPABILITY_KINDS, ['tool', 'http']);
});

// ── 3. The manifest and the allowlist are one list said twice ───────────

test('a tool the body may call but the manifest does not declare is refused', () => {
    const def = nodeDef({ steps: [{ id: 'body', type: 'code', code: 'return 1;', allowedTools: ['gmail_send', 'slack_post'] }, { id: 'out', type: 'layer_output', fields: { sent: { kind: 'literal', value: 1 } } }] });
    const issues = validateCustomNode(def);
    const issue = issues.find(i => i.code === 'capability_undeclared');
    assert.ok(issue, `expected capability_undeclared, got ${JSON.stringify(codesOf(issues))}`);
    assert.ok(issue.message.includes('slack_post'), 'the author needs the name to fix it');
});

test('a tool the manifest declares but the body may not call is refused', () => {
    const def = nodeDef({ capabilities: ['tool:gmail_send', 'tool:slack_post'] });
    const issues = validateCustomNode(def);
    assert.ok(codesOf(issues).includes('capability_not_granted'), `got ${JSON.stringify(codesOf(issues))}`);
});

test('a malformed allowedTools is not read as "the body declares none"', () => {
    // `code.allowed_tools_shape` is dataShapingRules' message. Turning a
    // shape bug into a false capability_undeclared would send the author
    // editing the manifest over a mistake in the body.
    const def = withBody({ id: 'body', type: 'code', code: 'return 1;', allowedTools: 'gmail_send' });
    const codes = codesOf(validateCustomNode(def));
    assert.ok(!codes.includes('capability_undeclared'), `got ${JSON.stringify(codes)}`);
    assert.ok(!codes.includes('capability_not_granted'), `got ${JSON.stringify(codes)}`);
});

test('one node, one body', () => {
    const none = nodeDef({ steps: [{ id: 'out', type: 'layer_output', fields: { x: { kind: 'literal', value: 1 } } }], capabilities: [] });
    assert.ok(codesOf(validateCustomNode(none)).includes('body_missing'));

    const two = nodeDef({
        steps: [
            { id: 'b1', type: 'code', code: 'return 1;', allowedTools: ['gmail_send'] },
            { id: 'b2', type: 'code', code: 'return 2;', allowedTools: ['gmail_send'] },
            { id: 'out', type: 'layer_output', fields: { x: { kind: 'literal', value: 1 } } },
        ],
    });
    assert.ok(codesOf(validateCustomNode(two)).includes('body_ambiguous'));
    assert.strictEqual(customNodeBody(two), null);
});

test('validateCustomNode says so about a non-definition instead of throwing', () => {
    assert.deepStrictEqual(codesOf(validateCustomNode(null)), ['node_shape']);
    assert.deepStrictEqual(codesOf(validateCustomNode('nope')), ['node_shape']);
});

// ── 4. Lockstep with what codeSandbox actually gates ────────────────────

test('every capability kind names a bridge codeSandbox really builds', () => {
    // testBridges() returns the outward surface the sandbox stubs for a test
    // run — i.e. the bridges that exist. Deriving the check from that object
    // rather than from a list typed here is the point: a fifth outward bridge
    // added to codeSandbox fails this test instead of quietly becoming
    // something no manifest can declare and no palette can gate.
    const { testBridges } = require('./codeSandbox');
    const outward = new Set(Object.keys(testBridges({ db: async () => ({}) }).bridges));
    for (const kind of CAPABILITY_KINDS) {
        const bridge = CAPABILITY_BRIDGES[kind];
        if (bridge === null) continue; // secrets: refused, deliberately bridgeless
        assert.ok(outward.has(bridge), `capability "${kind}" claims bridge "${bridge}", which codeSandbox does not build`);
        outward.delete(bridge);
    }
    assert.deepStrictEqual([...outward], [], 'codeSandbox builds an outward bridge no capability declares');
});

test('sandboxAllowedTools is the manifest, in the shape bridges.allowedTools wants', () => {
    const set = sandboxAllowedTools(nodeDef({ capabilities: ['tool:gmail_send', 'http', 'tool:gmail_send'] }));
    assert.ok(set instanceof Set, 'codeSandbox only honours a real Set — anything else disables the gate entirely');
    assert.deepStrictEqual([...set], ['gmail_send']);
    assert.deepStrictEqual([...sandboxAllowedTools({})], []);
    assert.deepStrictEqual(capabilityToolNames(nodeDef({ capabilities: ['tool:b_tool', 'tool:a_tool'] })), ['a_tool', 'b_tool']);
});

test('the sandbox enforces exactly the manifest — the real isolate, not a description of one', async () => {
    const sandbox = require('./codeSandbox');
    assert.ok(sandbox.isAvailable(), sandbox.loadError() || 'expected the sandbox to be available');
    const def = nodeDef();
    const called = [];
    const { result } = await sandbox.runCode({
        code: `
            async function main(inputs, ctx) {
                const declared = await ctx.integrations.gmail_send({ to: inputs.to });
                const undeclared = await ctx.integrations.slack_post({ text: 'hi' });
                return { declared, undeclared };
            }
        `,
        inputs: { to: 'someone@example.org' },
        bridges: {
            allowedTools: sandboxAllowedTools(def),
            executeTool: async (name) => { called.push(name); return { ok: name }; },
        },
    });
    assert.deepStrictEqual(result.declared, { ok: 'gmail_send' });
    assert.deepStrictEqual(called, ['gmail_send'], 'an undeclared tool must not reach the host bridge at all');
    assert.match(result.undeclared.error, /slack_post/);
});
