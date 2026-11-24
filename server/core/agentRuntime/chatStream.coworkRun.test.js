// @typecheck
/**
 * A Cowork run through the real streaming turn (agentTurn.testkit.js): the review tool is offered only in a Cowork
 * run, its call lands on the run context, every settled call is noted by name and outcome, and a follow-up run with a
 * ceiling is offered nothing outside it.
 *
 * Synthetic data. Run: node --test core/agentRuntime/chatStream.coworkRun.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { installAgentTurnHarness, turnState, resetTurnState, fn } = require('./agentTurn.testkit');
const { createRunActivity, summariseActivity, offeredToolNames, REVIEW_TOOL_NAME } = require('../cowork/runActivity.mts');
const { executeReviewTool } = require('../cowork/reviewTool.mts');

const S = { ...turnState() };
const TOOLS = [fn('web_lookup'), fn('crm_update')];

// Round 0: one lookup and the review request; then the closing text.
const drive = (cb, options, round) => {
    if (round === 0) {
        cb('tool_use', { id: 'call_web', name: 'web_lookup', input: { query: 'opening hours' } });
        cb('tool_use', { id: 'call_review', name: REVIEW_TOOL_NAME, input: { reason: 'The price is not in the list.', question: 'Which price applies?' } });
    } else {
        cb('text', { text: 'I asked for a review.' });
    }
    cb('done', {});
};

const kit = installAgentTurnHarness(S, {
    stubs: {
        '../tools/toolDispatcher': {
            executeTool: async (name, args, ctx) => {
                S.dispatched.push({ name });
                if (name === REVIEW_TOOL_NAME) return executeReviewTool(name, args, ctx);
                return { ok: true, message: `${name} ran` };
            },
        },
    },
});
test.after(() => kit.restore());

test('a Cowork run is offered the review tool, and the request and the calls land on the run context', async () => {
    resetTurnState(S, { drive, tools: TOOLS });
    const coworkRun = createRunActivity({ appOf: () => null });
    const { error } = await kit.runTurn({ coworkRun });
    assert.ifError(error);
    assert.ok(S.toolsOfferedPerRound[0].includes(REVIEW_TOOL_NAME));
    assert.deepStrictEqual(coworkRun.review, { reason: 'The price is not in the list.', question: 'Which price applies?', summary: null });
    const tools = Object.fromEntries(summariseActivity(coworkRun, new Map()).tools.map((t) => [t.name, t.ok]));
    assert.deepStrictEqual(tools, { web_lookup: 1, [REVIEW_TOOL_NAME]: 1 });
    assert.ok(offeredToolNames(coworkRun).includes('crm_update'));
});

test('a chat turn is not offered the review tool', async () => {
    resetTurnState(S, { drive: (cb) => { cb('text', { text: 'hi' }); cb('done', {}); }, tools: TOOLS });
    await kit.runTurn({});
    assert.ok(!S.toolsOfferedPerRound[0].includes(REVIEW_TOOL_NAME));
});

test('a follow-up run is offered only what the run it continues was offered, plus the review and outcome tools', async () => {
    resetTurnState(S, { drive: (cb) => { cb('text', { text: 'ok' }); cb('done', {}); }, tools: TOOLS });
    await kit.runTurn({ coworkRun: createRunActivity({ toolCeiling: ['web_lookup'] }) });
    assert.deepStrictEqual([...S.toolsOfferedPerRound[0]].sort(), ['web_lookup', REVIEW_TOOL_NAME, 'cowork_report_outcome'].sort());
});
