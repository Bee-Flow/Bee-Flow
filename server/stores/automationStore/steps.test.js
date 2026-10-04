/**
 * The promotion path: one code step → one kind='block' Step row.
 *
 * Pure. (Requiring the module constructs the pg Pool but does not connect —
 * the same note builderSessions.test.js carries; run with --test-force-exit
 * like the rest of the suite.) The write is injected, which is the point:
 * what has to be provable without a database is the DECISION — refuse, or
 * store exactly this definition.
 *
 * Two failures are pinned here.
 *
 * 1. A REFUSAL WRITES NOTHING. The definition is built and both of its
 *    contracts are checked before the first await that touches Postgres. In
 *    the other order, a body with no declared outputs leaves a Steps row that
 *    the save path refuses and its owner cannot fix — nobody typed a
 *    character of it — while the palette offers it in the meantime.
 *
 * 2. WHAT IS STORED PASSES THE NODE CONTRACT. validateCustomNode makes
 *    declared outputs and a truthful capability manifest mandatory. A
 *    promotion that produced a node failing that contract would be the bug,
 *    not the feature, so the row handed to createStep is checked here against
 *    the same two validators the save path runs.
 *
 * Run: cd server && node --test --test-force-exit stores/automationStore/steps.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createStepFromCodeStep, promoteDeps } = require('./steps');
const { validateCustomNode } = require('../../automation/customNode');
const { validateDefinition } = require('../../automation/validate');

function codeStep(overrides = {}) {
    return {
        id: 'c_1a2b', type: 'code', label: 'Normalise VAT',
        code: 'return { total: inputs.amount * 1.21 };',
        inputs: { amount: { kind: 'ref', path: 'steps.extract.output.amount' } },
        allowedTools: ['gmail_send'],
        outputSchema: { type: 'object', properties: { total: { type: 'number' } } },
        ...overrides,
    };
}

// A createStep that records instead of writing, and a row shaped like the one
// getAutomation hands back.
function recordingCreate() {
    const calls = [];
    return {
        calls,
        createStep: async (args) => { calls.push(args); return { id: 'blk_1', kind: 'block', title: args.title }; },
    };
}

// A createStep nothing may reach: a refusal that touches it is a refusal that
// wrote a row.
const refuseToWrite = { createStep: async () => { throw new Error('createStep must not be called'); } };

test('a promoted code step becomes one kind=block Step, created for the caller', async () => {
    const rec = recordingCreate();
    const r = await createStepFromCodeStep({
        userId: 'u1', organizationId: 'org1', title: '  Normalise VAT  ', description: 'Adds 21% VAT',
        icon: 'calculator', category: 'Finance', step: codeStep(),
    }, promoteDeps({ createStep: rec.createStep }));

    assert.strictEqual(r.ok, true, JSON.stringify(r.issues));
    assert.strictEqual(rec.calls.length, 1, 'exactly one row');
    const written = rec.calls[0];
    assert.strictEqual(written.userId, 'u1');
    assert.strictEqual(written.organizationId, 'org1');
    assert.strictEqual(written.title, 'Normalise VAT', 'the title is trimmed before it is stored, not when it is displayed');
    assert.strictEqual(written.description, 'Adds 21% VAT');
    assert.strictEqual(written.icon, 'calculator');
    assert.strictEqual(written.category, 'Finance');
    assert.strictEqual(r.step.id, 'blk_1');
});

test('what is stored is a definition that passes both contracts the save path runs', async () => {
    const rec = recordingCreate();
    const r = await createStepFromCodeStep(
        { userId: 'u1', title: 'Normalise VAT', step: codeStep() },
        promoteDeps({ createStep: rec.createStep }),
    );
    const def = rec.calls[0].definition;
    assert.deepStrictEqual(validateCustomNode(def), [], 'a stored node must satisfy the custom-node contract');
    const v = validateDefinition(def, { scope: 'block' });
    assert.strictEqual(v.ok, true, `routes/step.js would refuse this row: ${JSON.stringify(v.errors)}`);
    // The row and the result describe the same definition — a caller that
    // opens the Step and a caller that reads the response see one thing.
    assert.strictEqual(r.definition, def);
    assert.deepStrictEqual(def.capabilities, ['tool:gmail_send']);
    assert.deepStrictEqual(def.trigger.params, [{ name: 'amount', type: 'string', required: true }]);
});

test('the caller is handed what the call step must bind, so the old automation keeps working', async () => {
    const rec = recordingCreate();
    const step = codeStep();
    const r = await createStepFromCodeStep(
        { userId: 'u1', title: 'Normalise VAT', step },
        promoteDeps({ createStep: rec.createStep }),
    );
    // Without these, every `steps.x.output.y` the code step read has to be
    // retyped by hand into the call_block that replaces it, and the first one
    // anybody forgets resolves to undefined and writes nothing.
    assert.deepStrictEqual(r.callInputs, { amount: { kind: 'ref', path: 'steps.extract.output.amount' } });
    assert.deepStrictEqual(r.contract.outputFields, ['total']);
    assert.deepStrictEqual(r.contract.capabilities, ['tool:gmail_send']);
});

test('a body whose outputs nobody declared is refused BEFORE anything is written', async () => {
    const r = await createStepFromCodeStep(
        { userId: 'u1', title: 'Normalise VAT', step: codeStep({ outputSchema: undefined }) },
        promoteDeps(refuseToWrite),
    );
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'outputs_undeclared');
    assert.strictEqual(r.step, undefined, 'a refusal has no Step to show');
    assert.ok(r.issues[0].hint, 'and says what would make it promotable');
});

test('every refusal the promotion can make stops short of the database', async () => {
    const cases = [
        ['not_a_code_step', { id: 's', type: 'integration_action', tool: 'gmail_send' }],
        ['body_empty', codeStep({ code: '' })],
        ['for_each_unsupported', codeStep({ forEach: { overRef: 'steps.l.output.items', itemVar: 'f' } })],
        ['secret_keys_unsupported', codeStep({ inputs: { secretKeys: { kind: 'literal', value: ['stripe_key'] } } })],
        ['allowed_tools_shape', codeStep({ allowedTools: 'gmail_send' })],
        ['input_name_unbindable', codeStep({ inputs: { 'my-input': { kind: 'literal', value: 1 } } })],
    ];
    for (const [reason, step] of cases) {
        const r = await createStepFromCodeStep({ userId: 'u1', title: 'X', step }, promoteDeps(refuseToWrite));
        assert.strictEqual(r.reason, reason);
        assert.strictEqual(r.ok, false);
    }
});

test('a promotion with no title is refused, not stored as Untitled', async () => {
    for (const title of [undefined, '', '   ', 42]) {
        const r = await createStepFromCodeStep({ userId: 'u1', title, step: codeStep() }, promoteDeps(refuseToWrite));
        assert.strictEqual(r.reason, 'title_missing');
        // A Step is picked from a palette by its title: a row nobody can name
        // in the list is a row nobody finds again.
        assert.strictEqual(r.issues[0].path, 'title');
    }
});

test('the promotion is reachable where the routes take the store from', () => {
    // steps.js is spread into the aggregate; a function nobody can require
    // from `stores/automationStore` is a function no route can call.
    const store = require('../automationStore');
    assert.strictEqual(typeof store.createStepFromCodeStep, 'function');
});
