/**
 * Unit tests for "make this reusable" — a code step promoted to a custom node.
 *
 * What is being pinned, and why each one is a failure rather than a
 * preference:
 *
 * 1. THE PROMOTION PRODUCES A NODE THAT PASSES ITS OWN CONTRACT. A node built
 *    here is stored, listed in the palette and called by other automations, and
 *    nobody typed a character of it — so a definition that validateCustomNode
 *    or the block scope of validateDefinition refuses is a row its owner
 *    cannot fix. Every happy path below ends by running both.
 *
 * 2. IT REFUSES RATHER THAN INVENTS. Declared outputs are mandatory
 *    (customNode.js's header says why: a node is bound to BY FIELD NAME, so
 *    one that declares nothing saves, runs green and writes nothing). A code
 *    step carries no such obligation, so promotion is regularly asked to make
 *    a node out of a body whose outputs nobody declared. Guessing a field
 *    name there is the "looks like it saved, saved nothing" bug with a new
 *    front door.
 *
 * 3. THE AUTOMATION IT CAME FROM KEEPS WORKING. `callInputs` are the original
 *    bindings, verbatim. Without them every `steps.x.output.y` the step read
 *    has to be retyped by hand into the call step, and the first one anybody
 *    forgets resolves to undefined.
 *
 * Pure module: no DB, no isolate (the one refusal that quotes codeSandbox's
 * wording requires it lazily, like customNode.js).
 *
 * Run: cd server && node --test --test-force-exit automation/customNodePromote.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { promoteCodeStep, declaredOutputNames, paramTypeOf, BODY_ID } = require('./customNodePromote');
const { validateCustomNode, sandboxAllowedTools, customNodeContract } = require('./customNode');
const { validateDefinition } = require('./validate');

// A code step as an automation stores one: a body, bound inputs, the tools it may
// reach, its own ceilings, and a declaration of what it returns.
function codeStep(overrides = {}) {
    return {
        id: 'c_1a2b', type: 'code', label: 'Normalise VAT',
        code: 'return { total: inputs.amount * 1.21, currency: inputs.currency };',
        inputs: {
            amount: { kind: 'ref', path: 'steps.extract.output.amount' },
            currency: { kind: 'literal', value: 'EUR' },
        },
        allowedTools: ['gmail_send'],
        limits: { wallMs: 8000 },
        outputSchema: { type: 'object', properties: { total: { type: 'number' }, currency: { type: 'string' } } },
        ...overrides,
    };
}

const codesOf = (r) => (r.issues || []).map(i => i.code);
const bodyOf = (def) => def.steps.find(s => s.type === 'code');
const outOf = (def) => def.steps.find(s => s.type === 'layer_output');

// ── 1. What it produces ─────────────────────────────────────────────────

test('a promoted code step is a custom node that passes both of its contracts', () => {
    const r = promoteCodeStep({ step: codeStep() });
    assert.strictEqual(r.ok, true, JSON.stringify(r.issues));
    assert.deepStrictEqual(validateCustomNode(r.definition), [], 'the node must satisfy the contract customNode.js enforces');
    const v = validateDefinition(r.definition, { scope: 'block' });
    assert.strictEqual(v.ok, true, `the Steps save path would refuse this: ${JSON.stringify(v.errors)}`);
    // The Step contract the palette reads is the one the promotion promised.
    const contract = customNodeContract(r.definition);
    assert.deepStrictEqual(contract.outputFields, ['total', 'currency']);
    assert.deepStrictEqual(contract.toolNames, ['gmail_send']);
    assert.strictEqual(contract.bodyStepId, BODY_ID);
});

test('the body reads its inputs from the caller, never from the automation it was promoted out of', () => {
    const { definition } = promoteCodeStep({ step: codeStep() });
    // Inside a layer, what the caller passed is `trigger.output.<param>`. A
    // body left bound to `steps.extract.output.amount` would resolve that
    // against the NODE's own (empty) step state and read undefined — one
    // input at a time, with nothing failing.
    assert.deepStrictEqual(bodyOf(definition).inputs, {
        amount: { kind: 'ref', path: 'trigger.output.amount' },
        currency: { kind: 'ref', path: 'trigger.output.currency' },
    });
    assert.deepStrictEqual(definition.trigger.params.map(p => p.name), ['amount', 'currency']);
    assert.ok(definition.trigger.params.every(p => p.required === true), 'the body was written assuming every input arrives');
});

test('the outputs are bound where execCode really writes the return value', () => {
    const { definition } = promoteCodeStep({ step: codeStep() });
    // execCode writes { result, logs, httpCalls } — a key the body returned
    // lives under `.output.result.<name>`, not `.output.<name>`. Bound one
    // level too high, every field of the node resolves to undefined and the
    // node returns nothing while running green.
    assert.deepStrictEqual(outOf(definition).fields, {
        total: { kind: 'ref', path: 'steps.body.output.result.total' },
        currency: { kind: 'ref', path: 'steps.body.output.result.currency' },
    });
});

test('callInputs are the original bindings, so the automation it left keeps behaving the same', () => {
    const step = codeStep();
    const r = promoteCodeStep({ step });
    assert.deepStrictEqual(r.callInputs, step.inputs, 'the call step must bind exactly what the code step bound');
    // And they are the step's own objects/values, not a re-typed paraphrase.
    assert.strictEqual(r.callInputs.amount.path, 'steps.extract.output.amount');
});

test('a literal input becomes a parameter — typed from its value, not hidden in the node', () => {
    const step = codeStep({
        inputs: {
            limit: { kind: 'literal', value: 10 },
            rate: { kind: 'literal', value: 1.21 },
            dryRun: { kind: 'literal', value: false },
            tags: { kind: 'literal', value: ['a'] },
            opts: { kind: 'literal', value: { a: 1 } },
            name: { kind: 'template', value: 'Hi {{trigger.output.who}}' },
            ref: { kind: 'ref', path: 'steps.x.output.y' },
        },
    });
    const { definition } = promoteCodeStep({ step });
    assert.deepStrictEqual(definition.trigger.params, [
        { name: 'limit', type: 'integer', required: true },
        { name: 'rate', type: 'number', required: true },
        { name: 'dryRun', type: 'boolean', required: true },
        { name: 'tags', type: 'array', required: true },
        { name: 'opts', type: 'object', required: true },
        { name: 'name', type: 'string', required: true },
        // A ref is answered at run time by a step that has not run, so there
        // is nothing to read: 'string', the same default the layer builder uses.
        { name: 'ref', type: 'string', required: true },
    ]);
    assert.strictEqual(paramTypeOf({ kind: 'expr', value: '1 + 1' }), 'string');
});

test('the body keeps the ceilings it was written for', () => {
    const { definition } = promoteCodeStep({ step: codeStep({ limits: { wallMs: 8000, cpuMs: 4000 } }) });
    // Re-defaulted to 5000ms, a body that needed eight seconds is simply not
    // what its author thinks it is, and nothing anywhere says so.
    assert.deepStrictEqual(bodyOf(definition).limits, { wallMs: 8000, cpuMs: 4000 });
});

test('a limit the sandbox would clamp is refused, not stored', () => {
    // The self-check earning its keep: validateDefinition's block scope
    // refuses this, and the only place that can be discovered is here —
    // afterwards it is a Steps row nobody can save and nobody typed.
    const r = promoteCodeStep({ step: codeStep({ limits: { wallMs: 999_999 } }) });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(codesOf(r), ['definition_code.limits_out_of_range']);
});

// ── 2. The manifest ─────────────────────────────────────────────────────

test('the capability manifest is derived from the body, and is the list the sandbox enforces', () => {
    const { definition } = promoteCodeStep({ step: codeStep({ allowedTools: ['gmail_send', 'nextcloud_list_files', 'gmail_send'] }) });
    assert.deepStrictEqual(definition.capabilities, ['tool:gmail_send', 'tool:nextcloud_list_files']);
    assert.deepStrictEqual([...sandboxAllowedTools(definition)], [...new Set(bodyOf(definition).allowedTools)],
        'the palette gate and the isolate must read the same list');
    // validateCustomNode refuses drift in either direction; a derived
    // manifest is how there is none to refuse.
    assert.deepStrictEqual(validateCustomNode(definition), []);
});

test('a body that reaches nothing declares nothing — an empty manifest is a complete one', () => {
    const { definition } = promoteCodeStep({ step: codeStep({ allowedTools: [] }) });
    assert.deepStrictEqual(definition.capabilities, []);
    assert.deepStrictEqual(bodyOf(definition).allowedTools, []);
    assert.deepStrictEqual(validateCustomNode(definition), []);
    const noneAtAll = promoteCodeStep({ step: codeStep({ allowedTools: undefined }) });
    assert.deepStrictEqual(noneAtAll.definition.capabilities, []);
});

test('a malformed allowedTools is refused, not turned into a manifest of letters', () => {
    // execCode does `new Set(step.allowedTools || [])`: a bare string is a set
    // of CHARACTERS. A manifest derived from that would be stored, shipped
    // and shown — ["tool:g","tool:m","tool:a",…].
    const r = promoteCodeStep({ step: codeStep({ allowedTools: 'gmail_send' }) });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(codesOf(r), ['allowed_tools_shape']);
    assert.strictEqual(r.definition, undefined);
    assert.strictEqual(promoteCodeStep({ step: codeStep({ allowedTools: ['', ' '] }) }).ok, false);
});

// ── 3. Declared outputs are the mandate ─────────────────────────────────

test('outputs come from the step\'s own declaration', () => {
    const r = promoteCodeStep({ step: codeStep() });
    assert.deepStrictEqual(Object.keys(outOf(r.definition).fields), ['total', 'currency']);
    // The same reading modelStepRules uses — properties, or the bare shape.
    assert.deepStrictEqual(declaredOutputNames({ outputSchema: { total: { type: 'number' } } }), ['total']);
    assert.strictEqual(declaredOutputNames({ outputSchema: { type: 'object', properties: {} } }), null);
    assert.strictEqual(declaredOutputNames({}), null);
});

test('an explicit list of outputs wins over the schema', () => {
    const r = promoteCodeStep({ step: codeStep(), outputs: ['total'] });
    assert.deepStrictEqual(Object.keys(outOf(r.definition).fields), ['total']);
    // Duplicates collapse rather than producing two identical bindings.
    const dup = promoteCodeStep({ step: codeStep(), outputs: ['total', 'total'] });
    assert.deepStrictEqual(Object.keys(outOf(dup.definition).fields), ['total']);
});

test('a body whose outputs nobody declared is REFUSED — never promoted with a guess', () => {
    const r = promoteCodeStep({ step: codeStep({ outputSchema: undefined }) });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'outputs_undeclared');
    assert.strictEqual(r.definition, undefined, 'a refusal must not hand back a node to store anyway');
    const issue = r.issues[0];
    // The refusal names what is missing and what to do about it — the whole
    // difference between a refusal and a dead end.
    assert.strictEqual(issue.path, 'outputSchema');
    assert.match(issue.message, /declare/i);
    assert.ok(issue.hint && issue.hint.length > 20, 'a refusal without a way forward is a dead end');
    // An empty explicit list is the same story, not an empty contract.
    assert.strictEqual(promoteCodeStep({ step: codeStep({ outputSchema: undefined }), outputs: [] }).reason, 'outputs_undeclared');
});

test('an output name the binding grammar cannot address is refused', () => {
    // `steps.node.output.total-vat` is a SUBTRACTION: the field would be
    // written and then unreachable from every step downstream.
    const r = promoteCodeStep({ step: codeStep({ outputSchema: undefined }), outputs: ['total-vat'] });
    assert.deepStrictEqual(codesOf(r), ['output_name_unbindable']);
    assert.deepStrictEqual(codesOf(promoteCodeStep({ step: codeStep({ outputSchema: undefined }), outputs: ['__proto__'] })), ['output_name_unbindable']);
    assert.deepStrictEqual(codesOf(promoteCodeStep({ step: codeStep({ outputSchema: undefined }), outputs: [''] })), ['output_name_invalid']);
});

test('an input name the binding grammar cannot address is refused', () => {
    const r = promoteCodeStep({ step: codeStep({ inputs: { 'my-input': { kind: 'literal', value: 1 } } }) });
    assert.deepStrictEqual(codesOf(r), ['input_name_unbindable']);
    assert.match(r.issues[0].message, /trigger\.output\.my-input/);
    assert.deepStrictEqual(codesOf(promoteCodeStep({ step: codeStep({ inputs: { 'two words': { kind: 'literal', value: 1 } } }) })), ['input_name_unbindable']);
    // Every bad name is reported, not just the first: renaming them one run
    // at a time is how a five-input step takes five refusals.
    const two = promoteCodeStep({ step: codeStep({ inputs: { 'a-b': { kind: 'literal', value: 1 }, 'c d': { kind: 'literal', value: 2 } } }) });
    assert.deepStrictEqual(codesOf(two), ['input_name_unbindable', 'input_name_unbindable']);
});

// ── 4. Steps that must not become nodes ─────────────────────────────────

test('a code step that can never run is not promoted into the palette', () => {
    // secretKeys is refused by execCode and by the validator: promoting it
    // would put a node in the palette that fails on its first call, from
    // inside someone else's automation.
    const { SECRETS_NOT_CONFIGURED_MESSAGE } = require('./codeSandbox');
    for (const inputs of [{ secretKeys: { kind: 'literal', value: ['stripe_key'] } }, { secretKeys: ['stripe_key'] }]) {
        const r = promoteCodeStep({ step: codeStep({ inputs }) });
        assert.strictEqual(r.reason, 'secret_keys_unsupported');
        assert.ok(r.issues[0].message.includes(SECRETS_NOT_CONFIGURED_MESSAGE), 'one wording for this refusal, imported from the module that raises it');
    }
});

test('a fan-out cannot be promoted as-is, and says why', () => {
    // A call_block is not in iterationRules' FOREACH_ALLOWED, so the step
    // that replaces this one cannot run once per item. Carrying the forEach
    // inside would strand the body's `loop.<itemVar>` refs on a loop that no
    // longer exists.
    const r = promoteCodeStep({ step: codeStep({ forEach: { overRef: 'steps.list.output.items', itemVar: 'f' } }) });
    assert.strictEqual(r.reason, 'for_each_unsupported');
    assert.match(r.issues[0].hint, /loop step/i);
});

test('only a code step, and only one with code in it', () => {
    assert.strictEqual(promoteCodeStep({ step: { id: 's', type: 'integration_action', tool: 'gmail_send' } }).reason, 'not_a_code_step');
    assert.strictEqual(promoteCodeStep({ step: null }).reason, 'not_a_code_step');
    assert.strictEqual(promoteCodeStep({}).reason, 'not_a_code_step');
    assert.strictEqual(promoteCodeStep({ step: codeStep({ code: '   ' }) }).reason, 'body_empty');
    assert.strictEqual(promoteCodeStep({ step: codeStep({ inputs: ['amount'] }) }).reason, 'inputs_shape');
});

test('a step with no inputs at all still promotes — a node may simply take none', () => {
    const r = promoteCodeStep({ step: codeStep({ inputs: undefined }) });
    assert.strictEqual(r.ok, true, JSON.stringify(r.issues));
    assert.deepStrictEqual(r.definition.trigger.params, []);
    assert.deepStrictEqual(r.callInputs, {});
    assert.deepStrictEqual(validateCustomNode(r.definition), []);
});
