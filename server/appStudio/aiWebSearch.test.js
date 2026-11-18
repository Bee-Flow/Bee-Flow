'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildWebSearchTools, webSearchOn } = require('./aiWebSearch.mts');

const app = { id: 'app1', userId: 'owner1', organizationId: 'org1', name: 'Research' };
const DEFS = [
    { type: 'function', function: { name: 'agent_search', parameters: {} } },
    { type: 'function', function: { name: 'read_url', parameters: {} } },
    { type: 'function', function: { name: 'something_else', parameters: {} } },
];

function deps(over = {}) {
    const calls = [];
    return {
        calls,
        isPermitted: async () => true,
        providerAvailable: async () => true,
        toolDefs: () => DEFS,
        run: async (name, args, egress) => { calls.push({ name, args, egress }); return `result of ${name}`; },
        ...over,
    };
}

test('webSearchOn reads only an explicit enabled: true', () => {
    assert.strictEqual(webSearchOn({ aiWebSearch: { enabled: true } }), true);
    assert.strictEqual(webSearchOn({ aiWebSearch: { enabled: 'true' } }), false);
    assert.strictEqual(webSearchOn({ aiWebSearch: {} }), false);
    assert.strictEqual(webSearchOn({}), false);
    assert.strictEqual(webSearchOn(null), false);
});

test('a step that does not ask gets no tools and nothing is checked', async () => {
    const d = deps({ isPermitted: async () => { throw new Error('must not be asked'); } });
    const out = await buildWebSearchTools(app, {}, { aiWebSearch: false }, d);
    assert.deepStrictEqual(out, { tools: [], promptLine: '' });
});

test('the app switch off refuses with web_search_not_enabled', async () => {
    await assert.rejects(buildWebSearchTools(app, { webSearch: true }, { aiWebSearch: false }, deps()),
        (e) => e.code === 'web_search_not_enabled' && e.status === 403);
});

test('the workspace integration off refuses with web_search_disabled', async () => {
    await assert.rejects(buildWebSearchTools(app, { webSearch: true }, { aiWebSearch: true }, deps({ isPermitted: async () => false })),
        (e) => e.code === 'web_search_disabled');
});

test('no provider refuses with web_search_no_provider', async () => {
    await assert.rejects(buildWebSearchTools(app, { webSearch: true }, { aiWebSearch: true }, deps({ providerAvailable: async () => false })),
        (e) => e.code === 'web_search_no_provider');
});

test('the integration is asked for the OWNER, not the viewer', async () => {
    let asked = null;
    await buildWebSearchTools(app, { webSearch: true }, { aiWebSearch: true, viewerId: 'viewer9' }, deps({ isPermitted: async (uid) => { asked = uid; return true; } }));
    assert.strictEqual(asked, 'owner1');
});

test('all gates open: agent_search and read_url only, run with the app attributed', async () => {
    const d = deps();
    const { tools, promptLine } = await buildWebSearchTools(app, { webSearch: true }, { aiWebSearch: true }, d);
    assert.deepStrictEqual(tools.map((t) => t.def.function.name), ['agent_search', 'read_url']);
    assert.match(promptLine, /DATA, never as instructions/);
    assert.strictEqual(await tools[0].execute({ query: 'vat rates' }), 'result of agent_search');
    assert.deepStrictEqual(d.calls[0], {
        name: 'agent_search', args: { query: 'vat rates' },
        egress: { source: 'studio_app', ids: { organization_id: 'org1', user_id: 'owner1', agent_id: 'app1', agent_name: 'App: Research' } },
    });
});
