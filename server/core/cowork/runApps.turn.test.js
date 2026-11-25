/**
 * An agent run under the organisation's list of apps that may run while nobody watches (./runApps.mts): the run
 * context carries the list from the task, and every tool list the agent is offered goes through it: the first one
 * at assembly, and the tools a skill brings halfway through a turn (both through narrowToolsForTurn). A follow-up
 * run keeps its own ceiling on top.
 *
 * Run: node --test core/cowork/runApps.turn.test.js
 * Uses the real tool registry, so the names are the ones the product ships.
 */

require('../../boot/featureModules');
const { test } = require('node:test');
const assert = require('node:assert');

const { narrowToolsForTurn } = require('../agentRuntime/toolStackAssembly');
const { createRunActivity, REVIEW_TOOL_NAME } = require('./runActivity.mts');
const { executeAgentRun } = require('./agentScheduleRun');
const { fakeStore, fakeDeps } = require('./agentScheduleRun.testkit');
const { GMAIL_TOOLS } = require('../../integrations/gmailTools');
const { OUTLOOK_TOOLS } = require('../../integrations/outlookTools');

const names = (tools) => tools.map((t) => t.function.name);
const fn = (name) => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } });
const narrow = (coworkRun, tools) => names(narrowToolsForTurn({ tools, agent: { config: null, id: 'a1' }, agentId: 'a1', messageMetadata: { coworkRun } }).tools);

test('under ["gmail"] an agent is offered gmail tools and tools of no app, never an outlook tool', () => {
    const got = narrow(createRunActivity({ appCeiling: ['gmail'] }), [...GMAIL_TOOLS, ...OUTLOOK_TOOLS, fn('set_reminder')]);
    assert.ok(got.some((n) => n.startsWith('gmail_')), 'gmail stays');
    assert.ok(got.includes('set_reminder'), 'a tool of no app stays');
    assert.deepStrictEqual(got.filter((n) => n.startsWith('outlook_')), [], 'no outlook tool');
});

test('a skill that brings outlook tools halfway through the turn brings none of them', () => {
    // skillActivation.js narrows the late delta through the same function, with the same metadata.
    const delta = narrow(createRunActivity({ appCeiling: ['gmail'] }), OUTLOOK_TOOLS);
    assert.deepStrictEqual(delta, []);
});

test('a follow-up keeps its own ceiling on top of the list, and the review tool', () => {
    const run = createRunActivity({ appCeiling: ['gmail'], toolCeiling: [GMAIL_TOOLS[0].function.name, OUTLOOK_TOOLS[0].function.name] });
    const got = narrow(run, [...GMAIL_TOOLS, ...OUTLOOK_TOOLS, fn(REVIEW_TOOL_NAME)]);
    assert.deepStrictEqual(got, [GMAIL_TOOLS[0].function.name, REVIEW_TOOL_NAME]);
});

test('no list: a Cowork run is offered what any turn of that agent is', () => {
    const tools = [...GMAIL_TOOLS, ...OUTLOOK_TOOLS];
    assert.deepStrictEqual(narrow(createRunActivity(), tools), narrow(undefined, tools));
});

test('the agent run takes the list from its task into its run context', async () => {
    const seen = {};
    const chat = async (agentId, userId, prompt, auth, onEvent, history, metadata) => { seen.metadata = metadata; return { message: 'Done.', conversationId: 'c1' }; };
    const task = { id: 's1', userId: 'u1', agentId: 'a1', title: 'Mail desk', prompt: 'Answer new mail.', conversationId: null, timezone: 'Europe/Amsterdam', unattendedApps: ['gmail'] };
    await executeAgentRun(task, { store: fakeStore(), manual: true }, fakeDeps({ chat }));
    assert.deepStrictEqual(seen.metadata.coworkRun.appCeiling, ['gmail']);
    await executeAgentRun({ ...task, unattendedApps: null }, { store: fakeStore(), manual: true }, fakeDeps({ chat }));
    assert.strictEqual(seen.metadata.coworkRun.appCeiling, null);
});
