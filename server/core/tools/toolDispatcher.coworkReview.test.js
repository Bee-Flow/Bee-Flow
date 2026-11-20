/**
 * toolDispatcher × cowork_request_review: the dispatcher routes the review tool to its executor with the run context
 * the tool round hands over, and outside a Cowork run the tool refuses.
 *
 * Plain-script style with an explicit exit (requiring the dispatcher keeps the event loop alive), like
 * toolDispatcher.memoryConversation.test.js.
 *
 * Run: cd server && node core/tools/toolDispatcher.coworkReview.test.js
 */

const assert = require('node:assert/strict');

const { executeTool } = require('./toolDispatcher');
const { createRunActivity, REVIEW_TOOL_NAME } = require('../cowork/runActivity.mts');

(async () => {
    const coworkRun = createRunActivity();
    const res = await executeTool(REVIEW_TOOL_NAME, { reason: 'The customer asks for a discount nobody agreed.', question: 'Which discount?' }, {
        userId: 'u1', agentId: 'a1', conversationId: 'c1', coworkRun, egress: false,
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(coworkRun.review.reason, 'The customer asks for a discount nobody agreed.');
    assert.equal(coworkRun.review.question, 'Which discount?');

    const outside = await executeTool(REVIEW_TOOL_NAME, { reason: 'x' }, { userId: 'u1', egress: false });
    assert.ok(outside.error, 'outside a Cowork run the review tool refuses');

    console.log('ok - toolDispatcher routes cowork_request_review with the run context');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
