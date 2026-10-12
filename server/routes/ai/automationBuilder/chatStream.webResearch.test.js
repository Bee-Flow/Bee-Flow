/**
 * The composer's Web search toggle reaches the builder model as a tool.
 *
 * Before: `webSearchEnabled` only told the prompt it may PROPOSE an
 * agent_search step, so with the toggle on the builder told the user to look
 * up API documentation themselves. Now the toggle offers agent_search and
 * read_url behind the main chat's gates (webResearch.js), in every work mode,
 * and the client hears whether it worked.
 *
 * The gates are replaced through webResearch._deps; the route, the menu, the
 * work-mode filter and the prompt composition are real.
 *
 * Run: cd server && node --test routes/ai/automationBuilder/chatStream.webResearch.test.js
 */

'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createBuilderStream, call } = require('../../../testUtils/builderStreamHarness');

const h = createBuilderStream();
const webResearch = require('./webResearch');

const real = { ...webResearch._deps };
const fx = { available: true, permitted: true, shield: null, runs: [] };

beforeEach(() => {
    fx.available = true;
    fx.permitted = true;
    fx.shield = null;
    fx.runs = [];
    Object.assign(webResearch._deps, {
        providerStatus: async () => ({ available: fx.available, provider: 'agent-search', fallbackToNode: false }),
        isPermitted: async ({ appId }) => appId === 'agent-search' && fx.permitted,
        getShield: async () => fx.shield,
        run: async (name, args, egress) => { fx.runs.push({ name, args, egress }); return `## Results\nInserve API docs at https://docs.example.test/api`; },
    });
});

after(() => {
    Object.assign(webResearch._deps, real);
    h.restore();
});

const definition = { schemaVersion: 2, trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [], edges: [] };
const draft = () => ({ id: 'a1', userId: 'u1', title: 'Tickets', description: '', definition: structuredClone(definition) });
const menu = (run) => run.roundOptions(0).tools.map((t) => t.function.name);
const dynamicText = (run) => run.roundMessages(0).filter((m) => m.role === 'system').map((m) => m.content).join('\n');

for (const workMode of ['build', 'discuss', 'plan', 'approve']) {
    test(`toggle on + allowed: ${workMode} mode offers agent_search and read_url and runs a search`, async () => {
        const run = await h.run({
            draft: draft(),
            message: 'Kan je online zoeken naar documentatie?',
            body: { automationId: 'a1', workMode, webSearchEnabled: true },
            rounds: [{ toolCalls: [call('agent_search', { query: 'Inserve API tickets' })] }, { text: 'Gevonden.' }],
        });
        assert.ok(menu(run).includes('agent_search'), 'agent_search offered');
        assert.ok(menu(run).includes('read_url'), 'read_url offered');
        assert.deepEqual(run.first('web_search'), { requested: true, available: true, reason: null });
        // The same provider-aware search with an egress row, attributed to the builder.
        assert.equal(fx.runs.length, 1);
        assert.deepEqual(fx.runs[0].args, { query: 'Inserve API tickets' });
        assert.equal(fx.runs[0].egress.source, 'automation_builder');
        assert.equal(fx.runs[0].egress.ids.user_id, 'u1');
        // Not refused by the work mode, and the model reads the result text.
        const toolMsg = run.roundMessages(1).filter((m) => m.role === 'tool').at(-1);
        assert.match(toolMsg.content, /docs\.example\.test/);
        const shown = run.dataOf('tool_call').find((c) => c.name === 'agent_search');
        assert.equal(shown.result.ok, true);
        assert.match(dynamicText(run), /Web research: ON/);
        // Nothing went through the draft tools.
        assert.equal(run.toolCalls.length, 0);
    });
}

test('toggle off: no web tools, the model is told it cannot search, the client hears why', async () => {
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'build', webSearchEnabled: false } });
    assert.ok(!menu(run).includes('agent_search'));
    assert.ok(!menu(run).includes('read_url'));
    assert.deepEqual(run.first('web_search'), { requested: false, available: false, reason: 'off' });
    assert.match(dynamicText(run), /Web research: OFF in this chat \(the user switched Web search off/);
});

test('no provider configured: not offered, honest reason', async () => {
    fx.available = false;
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', webSearchEnabled: true } });
    assert.ok(!menu(run).includes('agent_search'));
    assert.deepEqual(run.first('web_search'), { requested: true, available: false, reason: 'not_configured' });
    assert.match(dynamicText(run), /never claim you did/);
});

test('web-search app not permitted for the user: not offered', async () => {
    fx.permitted = false;
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', webSearchEnabled: true } });
    assert.ok(!menu(run).includes('agent_search'));
    assert.equal(run.first('web_search').reason, 'not_permitted');
});

test('a web tool called while not offered is refused and never runs', async () => {
    fx.available = false;
    const run = await h.run({
        draft: draft(),
        body: { automationId: 'a1', workMode: 'discuss', webSearchEnabled: true },
        rounds: [{ toolCalls: [call('agent_search', { query: 'x' })] }, { text: 'Ok.' }],
    });
    assert.equal(fx.runs.length, 0);
    const shown = run.dataOf('tool_call').find((c) => c.name === 'agent_search');
    assert.ok(shown.result.error);
});
