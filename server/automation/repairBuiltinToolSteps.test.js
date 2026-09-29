const test = require('node:test');
const assert = require('node:assert');
const { repairBuiltinToolSteps, repairStep, repairAiStepPermissions } = require('./repairBuiltinToolSteps');
const { liftBinding } = require('./repairBuiltinToolSteps');

/** The exact shape the AI builder saved before applyAddAction refused it. */
function brokenHttpStep(extra = {}) {
    return {
        id: 'a_d3444d',
        icon: 'Send',
        tool: 'http_request',
        type: 'integration_action',
        label: 'Fetch events',
        inputs: {
            url: { kind: 'literal', value: 'https://example.org/api/events' },
            method: { kind: 'literal', value: 'GET' },
        },
        sideEffect: true,
        ...extra,
    };
}

test('repairs the observed integration_action/http_request step', () => {
    const fixed = repairStep(brokenHttpStep());
    assert.equal(fixed.type, 'http_request');
    assert.equal(fixed.url, 'https://example.org/api/events');
    assert.equal(fixed.method, 'GET');
    // The id must survive: every downstream {{steps.<id>.output}} depends on it.
    assert.equal(fixed.id, 'a_d3444d');
    assert.equal(fixed.label, 'Fetch events');
    assert.equal(fixed.icon, 'Send');
    // The integration-only fields are gone, or the runner still dispatches it
    // as an integration action.
    assert.equal(fixed.tool, undefined);
    assert.equal(fixed.inputs, undefined);
    assert.equal(fixed.sideEffect, undefined);
});

test('a repaired step carries the builder defaults a real one gets', () => {
    const fixed = repairStep(brokenHttpStep());
    assert.equal(fixed.blockPrivateTargets, true);
    assert.equal(fixed.timeoutMs, 10000);
    assert.deepEqual(fixed.headers, {});
});

test('ref bindings become templates, literals keep their type', () => {
    const fixed = repairStep(brokenHttpStep({
        inputs: {
            url: { kind: 'template', value: 'https://x/{{steps.s1.output.id}}' },
            method: { kind: 'literal', value: 'POST' },
            body: { kind: 'ref', path: 'steps.s1.output.payload' },
            headers: { kind: 'literal', value: { 'X-Key': 'v' } },
            timeoutMs: { kind: 'literal', value: 2500 },
        },
    }));
    assert.equal(fixed.url, 'https://x/{{steps.s1.output.id}}');
    assert.equal(fixed.body, '{{steps.s1.output.payload}}');
    assert.deepEqual(fixed.headers, { 'X-Key': 'v' });
    assert.equal(fixed.timeoutMs, 2500);
});

test('an expr binding has no template form, so the step is left alone', () => {
    assert.equal(liftBinding({ kind: 'expr', value: 'a > 1' }).ok, false);
    assert.equal(repairStep(brokenHttpStep({
        inputs: { url: { kind: 'expr', value: 'vars.base + "/x"' } },
    })), null);
});

test('a step with no url is left alone rather than half-built', () => {
    assert.equal(repairStep(brokenHttpStep({ inputs: {} })), null);
});

test('a real integration action is untouched', () => {
    assert.equal(repairStep({ id: 's1', type: 'integration_action', tool: 'gmail_send', inputs: {} }), null);
    // An MCP or custom tool whose name is not a step type must stay allowed.
    assert.equal(repairStep({ id: 's1', type: 'integration_action', tool: 'nextcloud_files_list' }), null);
});

test('carries retry, forEach and disabled across the repair', () => {
    const fixed = repairStep(brokenHttpStep({
        retry: { max: 3 }, disabled: true, forEach: { source: 'steps.s1.output.rows', itemVar: 'row' },
    }));
    assert.deepEqual(fixed.retry, { max: 3 });
    assert.equal(fixed.disabled, true);
    assert.deepEqual(fixed.forEach, { source: 'steps.s1.output.rows', itemVar: 'row' });
});

test('repairs inside flowlets and leaves edges alone', () => {
    const def = {
        steps: [brokenHttpStep()],
        edges: [{ from: 'trg', to: 'a_d3444d' }],
        layers: { fetch: { steps: [brokenHttpStep({ id: 'a_x1' })], edges: [] } },
    };
    const out = repairBuiltinToolSteps(def);
    assert.equal(out.steps[0].type, 'http_request');
    assert.equal(out.layers.fetch.steps[0].type, 'http_request');
    assert.equal(out.layers.fetch.steps[0].id, 'a_x1');
    assert.deepEqual(out.edges, def.edges);
});

test('returns the SAME object when nothing needs repair', () => {
    // rowToAutomation maps every row of every list query through this.
    const def = { steps: [{ id: 's1', type: 'ai_step' }], edges: [] };
    assert.strictEqual(repairBuiltinToolSteps(def), def);
    assert.strictEqual(repairBuiltinToolSteps(null), null);
});

test('the aliases a model reaches for repair too', () => {
    const fixed = repairStep(brokenHttpStep({ tool: 'webhook' }));
    assert.equal(fixed.type, 'http_request');
});


/**
 * The orphan-permissions repair. Every AI step the builder made before the fix
 * carries an all-false `agentPermissions` block and warns about it forever.
 */
const ALL_FALSE = { startAutomations: false, useKnowledge: false, useTools: false };

test('drops an all-false permission block from an agent-less ai_step', () => {
    const fixed = repairAiStepPermissions({
        id: 'ai_8f3690', type: 'ai_step', prompt: 'p', agentId: null, skillIds: [],
        agentPermissions: { ...ALL_FALSE },
    });
    assert.ok(!('agentPermissions' in fixed));
    // Everything else is untouched — this is a removal, not a rebuild.
    assert.equal(fixed.id, 'ai_8f3690');
    assert.equal(fixed.prompt, 'p');
    assert.equal(fixed.agentId, null);
});

test('keeps the block when the step names an agent', () => {
    assert.equal(repairAiStepPermissions({
        id: 's1', type: 'ai_step', agentId: 'agt_1', agentPermissions: { ...ALL_FALSE },
    }), null);
});

test('keeps a permission somebody actually granted, agent or not', () => {
    // Deleting this would delete intent, not a defect.
    assert.equal(repairAiStepPermissions({
        id: 's1', type: 'ai_step', agentId: null,
        agentPermissions: { ...ALL_FALSE, useTools: true },
    }), null);
});

test('leaves an unknown key for the validator to report', () => {
    assert.equal(repairAiStepPermissions({
        id: 's1', type: 'ai_step', agentId: null,
        agentPermissions: { ...ALL_FALSE, nope: false },
    }), null);
});

test('a step with no permission block is already right', () => {
    assert.equal(repairAiStepPermissions({ id: 's1', type: 'ai_step', prompt: 'p' }), null);
});

test('the definition walk repairs ai_steps alongside http steps', () => {
    const def = {
        steps: [
            brokenHttpStep(),
            { id: 'ai_1', type: 'ai_step', prompt: 'p', agentPermissions: { ...ALL_FALSE } },
        ],
        edges: [],
    };
    const out = repairBuiltinToolSteps(def);
    assert.equal(out.steps[0].type, 'http_request');
    assert.ok(!('agentPermissions' in out.steps[1]));
});
