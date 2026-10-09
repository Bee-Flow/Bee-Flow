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

test('toolNames is the raw resolved set, deliberately wider than any app row', async () => {
    // MCP / org-custom / agent-callable-automation / Step tools own no
    // TOOL_REGISTRY entry, so they can never appear under `apps` — but the user
    // really can run them, and the add-time gate authorises against this set.
    const { mod, restore } = loadWithStubs({ tools: ['mcp:srv__do_thing'], permitted: null });
    try {
        const cat = await mod.buildCatalogForUser('u1', { user: { id: 'u1' } });
        assert.ok(cat.toolNames instanceof Set);
        assert.ok(cat.toolNames.has('mcp:srv__do_thing'));
        assert.equal((cat.apps || []).some(a => a.available), false, 'no registry app is available');
    } finally { restore(); }
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
