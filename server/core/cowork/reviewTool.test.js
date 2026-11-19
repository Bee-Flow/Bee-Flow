/**
 * cowork_request_review: the structured "a person has to decide" signal of a Cowork run. It only works inside a
 * Cowork run, records the reason / question / summary on the run context, and sends nothing anywhere.
 *
 * Run: node --test core/cowork/reviewTool.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { reviewToolDef, executeReviewTool, REVIEW_LIMITS } = require('./reviewTool.mts');
const { createRunActivity, REVIEW_TOOL_NAME } = require('./runActivity.mts');

test('the definition is the review tool and says when to use it', () => {
    const def = reviewToolDef();
    assert.strictEqual(def.function.name, REVIEW_TOOL_NAME);
    assert.deepStrictEqual(def.function.parameters.required, ['reason']);
    assert.match(def.function.description, /instead of writing/i);
    assert.match(def.function.description, /not.*(final|end)/i);
});

test('inside a Cowork run it records the request on the run context and answers the model', async () => {
    const coworkRun = createRunActivity();
    const res = await executeReviewTool(REVIEW_TOOL_NAME, { reason: 'Price is not in the price list', question: 'Which discount applies?', summary: 'Drafted nothing yet.' }, { coworkRun });
    assert.deepStrictEqual(coworkRun.review, { reason: 'Price is not in the price list', question: 'Which discount applies?', summary: 'Drafted nothing yet.' });
    assert.strictEqual(res.ok, true);
});

test('outside a Cowork run it refuses and records nothing', async () => {
    const res = await executeReviewTool(REVIEW_TOOL_NAME, { reason: 'x' }, {});
    assert.ok(res.error);
});

test('a reason is required; texts are trimmed and cut to their limits', async () => {
    const coworkRun = createRunActivity();
    assert.ok((await executeReviewTool(REVIEW_TOOL_NAME, { reason: '   ' }, { coworkRun })).error);
    assert.strictEqual(coworkRun.review, null);
    await executeReviewTool(REVIEW_TOOL_NAME, { reason: `  ${'r'.repeat(REVIEW_LIMITS.reason + 50)}  `, question: 7 }, { coworkRun });
    assert.strictEqual(coworkRun.review.reason.length, REVIEW_LIMITS.reason);
    assert.strictEqual(coworkRun.review.question, null);
});

test('a second request in the same run keeps the latest one', async () => {
    const coworkRun = createRunActivity();
    await executeReviewTool(REVIEW_TOOL_NAME, { reason: 'first' }, { coworkRun });
    await executeReviewTool(REVIEW_TOOL_NAME, { reason: 'second' }, { coworkRun });
    assert.strictEqual(coworkRun.review.reason, 'second');
});
