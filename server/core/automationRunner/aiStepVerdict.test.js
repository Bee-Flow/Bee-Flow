/**
 * An AI step's own verdict (./aiStepVerdict.mts): asked in its structured output only when the step asks for it, taken
 * out of the output before anything binds to it, and the worst one of a step that ran once per item.
 *
 * Run: cd server && node --test core/automationRunner/aiStepVerdict.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { withVerdict, splitVerdict, verdictOf, worstVerdict, VERDICT_FIELD } = require('./aiStepVerdict.mts');

const plain = { inferred: null, inferredFields: null, outputContract: { schema: null, declared: false }, effectiveSchema: null };
const schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] };
const declared = { inferred: null, inferredFields: null, outputContract: { schema, declared: true, source: 'step' }, effectiveSchema: schema };

test('a step that does not ask for a verdict is left exactly as it was', () => {
    assert.strictEqual(withVerdict(declared, {}), declared);
    assert.deepStrictEqual(splitVerdict({ summary: 'x' }, declared), { output: { summary: 'x' }, verdict: null });
});

test('a step with an object schema gets one more field; the verdict comes out of the output', () => {
    const c = withVerdict(declared, { reportOutcome: true });
    assert.ok(c.effectiveSchema.properties[VERDICT_FIELD]);
    assert.deepStrictEqual(c.effectiveSchema.required, ['summary'], 'the verdict is not required');
    const split = splitVerdict({ summary: 'Three meetings.', [VERDICT_FIELD]: { outcome: 'done', reason: ' Summarised  all three. ' } }, c);
    assert.deepStrictEqual(split, { output: { summary: 'Three meetings.' }, verdict: { outcome: 'done', reason: 'Summarised all three.' } });
});

test('a step that answers in text answers {answer, verdict}, and its output is the text again', () => {
    const c = withVerdict(plain, { reportOutcome: true });
    assert.deepStrictEqual(Object.keys(c.effectiveSchema.properties), ['answer', VERDICT_FIELD]);
    assert.strictEqual(c.outputContract.declared, false);
    assert.deepStrictEqual(splitVerdict({ answer: 'No meetings found.', [VERDICT_FIELD]: { outcome: 'nothing_to_do' } }, c), { output: 'No meetings found.', verdict: { outcome: 'nothing_to_do', reason: null } });
    assert.deepStrictEqual(splitVerdict({ answer: 'Prose the model wrapped.' }, c), { output: 'Prose the model wrapped.', verdict: null }, 'no verdict, the text as it was');
});

test('a verdict that does not parse is none; a reason is one short sentence', () => {
    assert.strictEqual(verdictOf({ outcome: 'great' }), null);
    assert.strictEqual(verdictOf('failed'), null);
    assert.strictEqual(verdictOf({ outcome: 'FAILED', reason: 'x'.repeat(500) }).reason.length, 200);
});

test('a step that ran once per item: one failed item fails it, else done when one item had work', () => {
    const v = (outcome) => ({ outcome, reason: null });
    assert.strictEqual(worstVerdict([v('done'), v('failed'), v('nothing_to_do')]).outcome, 'failed');
    assert.strictEqual(worstVerdict([v('nothing_to_do'), v('done')]).outcome, 'done');
    assert.strictEqual(worstVerdict([v('nothing_to_do')]).outcome, 'nothing_to_do');
    assert.strictEqual(worstVerdict([]), null);
});
