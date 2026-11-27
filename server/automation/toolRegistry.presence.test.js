// @typecheck
/**
 * automation/toolRegistry.js lists an app of a first-party module only while that module is here.
 *
 * A row whose `module` is a name ('integrations/gmailTools') is the module's file, asked for by
 * that name. With the name unregistered (the module absent) the row is left out of TOOL_REGISTRY,
 * INLINE_TOOL_APPS and ALL_TOOL_APPS, so the agent tool picker and the runtime's attribution index
 * list no app without tools. A double registered by name puts it back in its place, and a module
 * that FAILED keeps its row, read as unreadable rather than empty.
 *
 * The name is cleared and registered here, so this runs alike with every module present or hidden.
 *
 * Run: node --test automation/toolRegistry.presence.test.js
 */

const { test, before } = require('node:test');
const assert = require('node:assert');

const toolRegistry = require('./toolRegistry');
const { registerFeatureModules, _clearFeatureModulesForTests } = require('../core/featureModules');
const moduleState = require('../modules/firstParty/moduleState');

const GMAIL = 'integrations/gmailTools';
const WORKSPACE = 'integrations/workspaceTools';
const ids = (/** @type {{ app: string }[]} */ list) => list.map((e) => e.app);
/** @type {string[]} */
let coreIds;

before(() => {
    // Whatever the modules registered, then neither of the two names.
    require('../modules/firstParty/registrationChannels').ensureOpen('boot/featureModules');
    _clearFeatureModulesForTests(GMAIL);
    _clearFeatureModulesForTests(WORKSPACE);
    coreIds = ids(toolRegistry.ALL_TOOL_APPS);
});

test('a module that is not here: its rows are not listed, the rest keep their order', () => {
    assert.ok(!coreIds.includes('gmail'));
    assert.ok(!coreIds.includes('workspace'));
    for (const app of ['kb-search', 'memory', 'browser-fetch', 'regex-generator', 'presentations']) assert.ok(coreIds.includes(app), app);
    assert.deepStrictEqual(ids(toolRegistry.ALL_TOOL_APPS), [...ids(toolRegistry.TOOL_REGISTRY), ...ids(toolRegistry.INLINE_TOOL_APPS)]);
    assert.strictEqual(toolRegistry.appEntryFor('gmail'), null);
    assert.strictEqual(toolRegistry.ALL_TOOL_APPS, toolRegistry.ALL_TOOL_APPS, 'the same list while nothing changes');
});

test('the row of a name nobody registered reads as absent, not as a broken require', () => {
    const row = { app: 'gmail', label: 'Gmail', module: GMAIL, arrayName: 'GMAIL_TOOLS' };
    assert.deepStrictEqual(toolRegistry.loadToolsResult(row), { tools: [], ok: false, reason: 'module_absent' });
});

test('a double registered by name lists the app in its own place, with the double\'s tools', () => {
    const tools = [{ type: 'function', function: { name: 'gmail_search' } }];
    registerFeatureModules({ [GMAIL]: () => ({ GMAIL_TOOLS: tools }) });
    try {
        assert.strictEqual(toolRegistry.TOOL_REGISTRY[0].app, 'gmail', 'gmail is the first row');
        assert.deepStrictEqual(ids(toolRegistry.ALL_TOOL_APPS).filter((app) => app !== 'gmail'), coreIds);
        const entry = toolRegistry.appEntryFor('gmail');
        assert.ok(entry);
        assert.deepStrictEqual(toolRegistry.loadToolsResult(entry), { tools, ok: true, reason: null });
        assert.strictEqual(toolRegistry.findOwnerOfTool('gmail_search')?.app, 'gmail');
    } finally {
        _clearFeatureModulesForTests(GMAIL);
    }
    assert.deepStrictEqual(ids(toolRegistry.ALL_TOOL_APPS), coreIds, 'gone again once the double is');
});

test('a module that failed keeps its row, and its tools read as unreadable', () => {
    const owner = moduleState.providerOf('featureModules', GMAIL) ?? 'int_google';
    if (moduleState.providerOf('featureModules', GMAIL) === null) moduleState.declareProvides(owner, { featureModules: [GMAIL] });
    moduleState.setModuleState(owner, 'failed', 'test');
    const entry = toolRegistry.appEntryFor('gmail');
    assert.ok(entry, 'a failed module never looks absent');
    assert.deepStrictEqual(toolRegistry.loadToolsResult(entry), { tools: [], ok: false, reason: 'require_failed' });
});
