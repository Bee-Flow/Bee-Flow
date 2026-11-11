'use strict';

/**
 * The answer rules of an AI step that are pure functions: what an empty reply
 * and a declared contract accept.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { parseAiStepOutput, declaredContractErrors } = require('./aiStepOutputParse');

const shape = { step: { id: 's1' }, effectiveSchema: null, inferred: null, inferredFields: null, outputContract: { declared: false } };
const schema = { type: 'object', properties: { name: { type: 'string' }, score: { type: 'number' } }, required: ['name'] };

test('an empty reply without a schema after successful tool calls is a done step', () => {
    const toolInfo = { tally: [{ name: 'send_mail', error: null }], hitIterationCap: false };
    assert.strictEqual(parseAiStepOutput('', { ...shape, toolInfo }), '');
});

test('an empty reply without tool calls, or after a failed one, is an error', () => {
    assert.throws(() => parseAiStepOutput('  ', shape), /returned no answer/);
    const toolInfo = { tally: [{ name: 'agent_search', error: 'Search failed: timeout' }], hitIterationCap: false };
    assert.throws(() => parseAiStepOutput('', { ...shape, toolInfo }), /returned no answer/);
});

test('an empty reply with a schema is an error even after successful tool calls', () => {
    const toolInfo = { tally: [{ name: 'agent_search', error: null }], hitIterationCap: false };
    assert.throws(() => parseAiStepOutput('', { ...shape, effectiveSchema: schema, toolInfo }), /returned no answer/);
});

test('null in an optional field passes the declared contract; in a required field it does not', () => {
    const info = { tally: [], hitIterationCap: false };
    assert.deepStrictEqual(declaredContractErrors({ name: 'Jan', score: null }, schema, info), []);
    const errors = declaredContractErrors({ name: null, score: 3 }, schema, info);
    assert.deepStrictEqual(errors.map((e) => e.path), ['name']);
});
