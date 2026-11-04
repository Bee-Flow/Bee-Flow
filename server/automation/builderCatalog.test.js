/**
 * The builder catalog answers "what can this user wire up?" — and it is handed
 * to a model under the heading "the ONLY tools you may propose".
 *
 * It used to answer with `permitted || connected`, where `permitted` comes from
 * a deliberately credential-blind helper that fails open. On the account this
 * was found on that read 50 of 50 apps as available with 3 connected: 317
 * actions advertised, 13 runnable. A small model duly built a Gmail step for an
 * org with no Gmail. These tests pin the corrected meaning.
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

/**
 * Load builderCatalog with the two permission helpers stubbed. Stubbing at the
 * resolver is the harness this repo already uses for route tests; the module
 * requires them lazily inside the function, so the stub must outlive the call.
 */
function loadWithStubs({ tools, permitted, toolsThrows = false }) {
    const realResolve = Module._resolveFilename;
    const realLoad = Module._load;
    const KEY = require.resolve('../core/integrations/integrationTools');
    Module._load = function (request, parent, isMain) {
        const resolved = (() => {
            try { return Module._resolveFilename(request, parent, isMain); } catch { return null; }
        })();
        if (resolved === KEY) {
            return {
                getIntegrationTools: async () => {
                    if (toolsThrows) throw new Error('resolver down');
                    return { tools: tools.map(name => ({ function: { name } })) };
                },
                getUserPermittedApps: async () => (permitted === null ? null : new Set(permitted)),
            };
        }
        return realLoad.apply(this, arguments);
    };
    delete require.cache[require.resolve('./builderCatalog')];
    const mod = require('./builderCatalog');
    return {
        mod,
        restore() { Module._load = realLoad; Module._resolveFilename = realResolve; delete require.cache[require.resolve('./builderCatalog')]; },
    };
}

const appById = (cat, id) => (cat.apps || []).find(a => a.id === id) || null;

test('an app the user is permitted but has NOT connected is not available', async () => {
    // The regression test for the incident.
    const { mod, restore } = loadWithStubs({ tools: ['nextcloud_files_list'], permitted: null });
    try {
        const cat = await mod.buildCatalogForUser('u1', { user: { id: 'u1' } });
        const gmail = appById(cat, 'gmail');
        assert.ok(gmail, 'the row is still present — permitted is still an honest answer');
        assert.equal(gmail.available, false, 'the model must not be offered it');
        assert.equal(gmail.connected, false);
        assert.deepEqual(gmail.actions, [], 'and none of its actions are advertised');
    } finally { restore(); }
});

test('a connected app exposes ONLY the actions this user can run', async () => {
    const { mod, restore } = loadWithStubs({ tools: ['gmail_search'], permitted: null });
    try {
        const cat = await mod.buildCatalogForUser('u1', { user: { id: 'u1' } });
        const gmail = appById(cat, 'gmail');
        assert.equal(gmail.available, true);
        assert.deepEqual(gmail.actions.map(a => a.name), ['gmail_search'],
            'an app can be connected while only a subset of its actions is granted');
    } finally { restore(); }
});

test('toolNames is the raw resolved set; a tool no registry entry owns gets a row of its own', async () => {
    // MCP / org-custom / agent-callable-automation / Step tools own no
    // TOOL_REGISTRY entry. The user really can run them, and the add-time gate
    // authorises against `toolNames`; the model must also SEE them, so they
    // get a row after the registry apps (builderCatalog extraAppRows).
    const { mod, restore } = loadWithStubs({ tools: ['mcp:srv__do_thing'], permitted: null });
    try {
        const cat = await mod.buildCatalogForUser('u1', { user: { id: 'u1' } });
        assert.ok(cat.toolNames instanceof Set);
        assert.ok(cat.toolNames.has('mcp:srv__do_thing'));
        const available = (cat.apps || []).filter(a => a.available);
        assert.deepEqual(available.map(a => a.id), ['other-tools'], 'no registry app is available, only the extra row');
        assert.deepEqual(available[0].actions.map(a => a.name), ['mcp:srv__do_thing']);
    } finally { restore(); }
});

test('extra rows: one per MCP server, then custom, automations, Step tools, other; registry tools never twice', () => {
    const { extraAppRows } = require('./builderCatalog')._internals;
    const classify = { isSideEffect: () => true, isMemoisable: () => false, getOutputSchema: () => null };
    const params = { type: 'object', properties: { x: { type: 'string' } } };
    const rows = extraAppRows([
        { function: { name: 'gmail_search' } },
        { function: { name: 'step_a', parameters: params }, __step: { id: 's' } },
        { function: { name: 'loose' } },
        { function: { name: 'automation_a' }, __automation: { id: 'a' } },
        { function: { name: 'cint_x_y' } },
        { function: { name: 'mcp_z_do' }, _mcp: { serverId: 'z', serverName: 'Zeta' } },
        { function: { name: 'mcp_b_do' }, _mcp: { serverId: 'b', serverName: 'Beta' } },
        { function: { name: 'mcp_b_do' }, _mcp: { serverId: 'b', serverName: 'Beta' } },
        { function: {} },
    ], new Set(['gmail_search']), classify);
    assert.deepEqual(rows.map(r => [r.id, r.label]), [
        ['mcp:b', 'MCP · Beta'], ['mcp:z', 'MCP · Zeta'], ['custom-integrations', 'Custom integrations'],
        ['agent-automations', 'Agent-callable automations'], ['step-tools', 'Step tools'], ['other-tools', 'Other tools'],
    ]);
    assert.deepEqual(rows[0].actions.map(a => a.name), ['mcp_b_do'], 'a duplicate definition is listed once');
    assert.deepEqual(rows.find(r => r.id === 'step-tools').actions[0].inputSchema, params, 'the schema of the definition itself');
    assert.ok(rows.every(r => r.available && r.connected && r.permitted));
});

test('inputSchemasByTool: rows first, then the resolved definitions a row did not carry', () => {
    const { inputSchemasByTool } = require('./builderCatalog');
    const rowSchema = { type: 'object', properties: { a: { type: 'string' } } };
    const defSchema = { type: 'object', properties: { b: { type: 'string' } } };
    const catalog = { apps: [{ id: 'x', actions: [{ name: 'x_do', inputSchema: rowSchema }, { name: 'x_bare', inputSchema: null }] }] };
    Object.defineProperty(catalog, 'toolDefs', { value: [
        { function: { name: 'x_do', parameters: defSchema } },
        { function: { name: 'mcp_only', parameters: defSchema } },
        { function: { name: 'no_params' } },
    ], enumerable: false });
    const out = inputSchemasByTool(catalog);
    assert.deepEqual(Object.keys(out).sort(), ['mcp_only', 'x_do']);
    assert.equal(out.x_do, rowSchema, 'the row wins');
    assert.equal(out.mcp_only, defSchema);
    assert.deepEqual(inputSchemasByTool(null), {});
});

test('inspectedToolsFrom: the stored names the user can still run; anything else is an empty set', () => {
    const { inspectedToolsFrom } = require('./builderCatalog');
    assert.deepEqual([...inspectedToolsFrom(['a', 'gone', 7, '', 'b'], new Set(['a', 'b']))], ['a', 'b']);
    assert.deepEqual([...inspectedToolsFrom(['a', 'gone'], null)], ['a', 'gone'], 'could not tell what is runnable: keep them');
    assert.equal(inspectedToolsFrom(undefined, new Set(['a'])).size, 0);
    assert.equal(inspectedToolsFrom('a', null).size, 0);
});

test('a resolver failure throws rather than reporting an empty catalog', async () => {
    // "We could not tell" and "you have nothing" must never look the same: a
    // model told the latter either invents a tool or gives up.
    const { mod, restore } = loadWithStubs({ tools: [], permitted: null, toolsThrows: true });
    try {
        await assert.rejects(
            () => mod.buildCatalogForUser('u1', { user: { id: 'u1' } }),
            (e) => e && e.code === 'catalog_unresolved',
        );
    } finally { restore(); }
});

test('with nothing connected, no app is available and toolNames is empty', async () => {
    const { mod, restore } = loadWithStubs({ tools: [], permitted: null });
    try {
        const cat = await mod.buildCatalogForUser('u1', { user: { id: 'u1' } });
        assert.equal((cat.apps || []).filter(a => a.available).length, 0);
        assert.equal(cat.toolNames.size, 0);
    } finally { restore(); }
});

test('a catalog that could not be BUILT (not a resolver failure) carries a marker and is logged, never "no integrations"', async () => {
    // The registry itself failing to load is the one failure that does not throw:
    // the caller gets an empty catalog, and without a marker the prompt used to
    // read that as "the user has no integrations connected".
    const registryPath = require.resolve('./toolRegistry');
    const real = require.cache[registryPath];
    const logPath = require.resolve('../telemetry/log');
    const realLog = require.cache[logPath];
    const warnings = [];
    require.cache[registryPath] = { id: registryPath, filename: registryPath, loaded: true, exports: { get TOOL_REGISTRY() { throw new Error('registry would not load'); }, loadTools: () => [] } };
    require.cache[logPath] = { id: logPath, filename: logPath, loaded: true, exports: { ...realLog.exports, warn: (...a) => warnings.push(a.join(' ')) } };
    const { mod, restore } = loadWithStubs({ tools: ['gmail_search'], permitted: ['gmail'] });
    try {
        const cat = await mod.buildCatalogForUser('u1', {});
        assert.deepStrictEqual(cat.apps, []);
        assert.match(cat.catalogError, /registry would not load/);
        assert.strictEqual(cat.toolNames, undefined, 'the add-time gate stays permissive: we could not tell');
        assert.ok(warnings.some(w => /catalog could not be built/.test(w)), 'and it is logged');
    } finally {
        restore();
        if (real) require.cache[registryPath] = real; else delete require.cache[registryPath];
        if (realLog) require.cache[logPath] = realLog; else delete require.cache[logPath];
    }
});

test('a healthy catalog has no marker, and carries the tool definitions out of band', async () => {
    const { mod, restore } = loadWithStubs({ tools: ['gmail_search'], permitted: ['gmail'] });
    try {
        const cat = await mod.buildCatalogForUser('u1', {});
        assert.ok(!('catalogError' in cat));
        assert.deepStrictEqual(cat.toolDefs.map(t => t.function.name), ['gmail_search']);
        assert.ok(!Object.keys(cat).includes('toolDefs'), 'non-enumerable: a spread or a JSON dump does not carry it');
        assert.ok(!('toolDefs' in { ...cat }));
    } finally { restore(); }
});

// ── Connected only (D1) ─────────────────────────────────────────────────
// An MCP server's tools reach the resolved set on the org and group grant
// alone; the catalogue keeps them only when this user supplied every
// credential the server needs (integrationTools.availableMcpServerIds).

const mcpDef = (server, tool, label = server) => ({ type: 'function', function: { name: `mcp_${server}_${tool}`, parameters: { type: 'object', properties: {} } }, _mcp: { serverId: server, serverName: label } });
const D1_DEFS = [
    mcpDef('tix', 'create_ticket', 'Ticket desk'),
    mcpDef('wiki', 'search', 'Wiki'),
    { type: 'function', function: { name: 'cint_crm_find_contact' }, _cint: { rawName: 'find_contact' } },
    { type: 'function', function: { name: 'step_normalise_address' }, __step: { id: 's1' } },
];

/** buildCatalogForUser over D1_DEFS with `connected` as the credentialled servers. */
function catalogWithMcp(connected, extra = {}) {
    const asked = [];
    const deps = {
        getIntegrationTools: async () => ({ tools: D1_DEFS }),
        getUserPermittedApps: async () => null,
        availableMcpServerIds: async (names, userId) => { asked.push({ names: [...names], userId }); return new Set(connected); },
        ...extra,
    };
    return require('./builderCatalog').buildCatalogForUser('u1', { user: { id: 'u1' } }, { deps: /** @type {any} */ (deps) }).then(cat => ({ cat, asked }));
}

test('an MCP server without its credentials gets no row and its tools are not in toolNames; a credentialled one does', async () => {
    const { cat, asked } = await catalogWithMcp(['tix']);
    assert.ok(appById(cat, 'mcp:tix'), 'the credentialled server has its row');
    assert.deepEqual(appById(cat, 'mcp:tix').actions.map(a => a.name), ['mcp_tix_create_ticket']);
    assert.equal(appById(cat, 'mcp:wiki'), null, 'the server missing a credential has no row');
    assert.ok(cat.toolNames.has('mcp_tix_create_ticket'));
    assert.equal(cat.toolNames.has('mcp_wiki_search'), false, 'and the add-time gate does not let its tools through');
    assert.ok(!cat.toolDefs.some(d => d.function.name === 'mcp_wiki_search'), 'nor do the definitions the pickers read');
    assert.equal(asked.length, 1);
    assert.equal(asked[0].userId, 'u1', 'the credentials of THIS user decide');
    assert.ok(asked[0].names.includes('mcp_wiki_search'));
});

test('custom integrations and Step tools need no per-user credential and stay', async () => {
    const { cat } = await catalogWithMcp([]);
    assert.ok(cat.toolNames.has('cint_crm_find_contact'));
    assert.ok(cat.toolNames.has('step_normalise_address'));
    assert.ok(appById(cat, 'custom-integrations'));
    assert.ok(appById(cat, 'step-tools'));
    assert.ok(!(cat.apps || []).some(a => String(a.id).startsWith('mcp:')), 'no MCP server is connected');
});

test('the credential check failing, or missing, counts as not connected (fail closed)', async () => {
    const failed = await catalogWithMcp(['tix'], { availableMcpServerIds: async () => { throw new Error('store down'); } });
    assert.ok(![...failed.cat.toolNames].some(n => n.startsWith('mcp_')));
    assert.ok(failed.cat.toolNames.has('cint_crm_find_contact'), 'the rest of the catalogue is untouched');
    const missing = await catalogWithMcp(['tix'], { availableMcpServerIds: undefined });
    assert.ok(![...missing.cat.toolNames].some(n => n.startsWith('mcp_')));
});

test('without MCP tools the credential check is not asked', async () => {
    const { connectedOnly } = require('./builderCatalog')._internals;
    let calls = 0;
    const defs = [{ function: { name: 'gmail_search' } }];
    assert.equal(await connectedOnly(defs, 'u1', async () => { calls++; return new Set(); }), defs);
    assert.equal(calls, 0);
});
