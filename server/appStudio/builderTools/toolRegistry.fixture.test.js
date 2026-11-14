/**
 * The tool registry with tools in it: the two test-only tools in
 * __tests__/registryFixtureTools/ (app_zz_note writes the description and is offered over MCP,
 * app_zz_peek reads and is not), installed BEFORE anything requires the tool schemas, which
 * are module constants. Every test file runs in its own process, so nothing else sees them.
 *
 * What it proves: the base menu keeps its bytes and order, the registry tools come after it,
 * the small band never gets them, dispatch, persistence flags, MCP listing and the discuss gate
 * follow the entry.
 * Run: node --test appStudio/builderTools/toolRegistry.fixture.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const registry = require('./toolRegistry.mts');

registry._installRegistryTools(registry.loadRegistryTools(path.join(__dirname, '__tests__', 'registryFixtureTools')));

const { TOOL_SCHEMAS, REGISTRY_TOOL_VERBS } = require('./schemas');
const { MUTATING_TOOLS, DATA_MODEL_TOOLS, applyToolCall } = require('../builderTools');
const { selectToolMenu } = require('../builderModelProfiles');
const { baseToolSchemaHashes, pinnedOnly } = require('../../testUtils/appCatalogExtensions.testkit');
const pinned = require('./__tests__/toolSchemaHashes.base.json');
const webNames = require('../../../agent-hub/src/components/admin/Studio/AppStudio/chat/appToolNames.generated.json');

const FIXTURES = ['app_zz_note', 'app_zz_peek'];
const names = (/** @type {any[]} */ list) => list.map((t) => t.function?.name || t.name);

function draft() {
    const { canonicalizeAppDefinition } = require('../canonicalize');
    const { emptyDefinition } = require('../componentSpecs');
    return { userId: 'usr_test', def: canonicalizeAppDefinition(emptyDefinition('Fixture app')).def };
}

test('the registry tools come after every base tool; the base menu is the shipped one, in order', () => {
    const all = names(TOOL_SCHEMAS);
    assert.deepEqual(all.slice(-FIXTURES.length), FIXTURES);
    // The generated list also holds the shipped registry tools, which this file replaced with the fixtures.
    const shipped = new Set(registry.loadRegistryTools().map((t) => t.name));
    assert.deepEqual(all.slice(0, -FIXTURES.length), webNames.filter((n) => !shipped.has(n)), 'the base names are the generated list, unchanged');
    const note = TOOL_SCHEMAS.find((t) => t.function.name === 'app_zz_note');
    assert.equal(note.type, 'function');
    assert.deepEqual(note.function.parameters.required, ['text']);
    assert.ok(Object.isFrozen(note.function.parameters), 'a frozen copy: nobody edits the shared menu');
});

test('every pinned base schema keeps its bytes, in the full menu and in the core projection', () => {
    const now = baseToolSchemaHashes();
    assert.deepEqual(pinnedOnly(now.full, pinned.full), pinned.full);
    assert.deepEqual(pinnedOnly(now.core, pinned.core), pinned.core);
});

test('the full band is offered the registry tools, the small band never', () => {
    assert.deepEqual(names(selectToolMenu({ toolset: 'full' }, TOOL_SCHEMAS)).slice(-FIXTURES.length), FIXTURES);
    const core = names(selectToolMenu({ toolset: 'core' }, TOOL_SCHEMAS));
    for (const name of FIXTURES) assert.ok(!core.includes(name), name);
});

test('the tool sets follow the entry flags', () => {
    assert.ok(MUTATING_TOOLS.has('app_zz_note'));
    assert.ok(!MUTATING_TOOLS.has('app_zz_peek'));
    for (const name of FIXTURES) assert.ok(!DATA_MODEL_TOOLS.has(name), name);
});

test('dispatch: the switch default runs the registry apply; a refusal is an answer, never a throw', async () => {
    const wrap = draft();
    const result = await applyToolCall('app_zz_note', { text: 'Tracks the orders.' }, wrap);
    assert.equal(result.error, undefined);
    assert.equal(wrap.def.meta.description, 'Tracks the orders.');
    assert.equal(result.meta.description, 'Tracks the orders.');
    const refused = await applyToolCall('app_zz_note', {}, draft());
    assert.match(refused.error, /Pass `text`/);
    assert.deepEqual(await applyToolCall('app_zz_peek', {}, wrap), { screens: wrap.def.screens.length });
    assert.match((await applyToolCall('app_zz_unknown', {}, wrap)).error, /Unknown app builder tool/);
});

test('a name already on the menu is refused when the schemas are built', () => {
    assert.throws(() => registry.registryToolSchemas(['app_zz_note']), /already a builder tool/);
});

test('MCP: mcp true is listed with appId and a write annotation; mcp false is neither listed nor callable', async () => {
    const mcp = require('../mcpBuilder');
    const listed = mcp.buildToolList();
    const note = listed.find((/** @type {{ name: string }} */ t) => t.name === 'app_zz_note');
    assert.ok(note);
    assert.deepEqual(note.inputSchema.required, ['appId', 'text']);
    assert.equal(note.annotations.readOnlyHint, false);
    assert.ok(!listed.some((/** @type {{ name: string }} */ t) => t.name === 'app_zz_peek'));
    assert.ok(mcp.TOOL_NAMES.has('app_zz_note'));
    assert.ok(!mcp.TOOL_NAMES.has('app_zz_peek'));
    const answer = await mcp.callTool('app_zz_peek', { appId: 'app_x' }, { userId: 'usr_test' });
    assert.match(answer.result.error, /Unknown tool/);
});

test('discuss mode refuses a registry tool, read or write (its allow-list fails closed)', async () => {
    const W = await import('../../usecases/ai/appStudioBuilder/workMode.mts');
    for (const name of FIXTURES) assert.ok(W.gateWorkModeCall(name, 'discuss'), name);
    assert.equal(W.gateWorkModeCall('app_zz_note', 'build'), null);
});

test('the chat verbs of the registry tools, for the web list', () => {
    assert.deepEqual(REGISTRY_TOOL_VERBS, {
        app_zz_note: { key: 'zz_fixture.act_note', en: 'Wrote a note' },
        app_zz_peek: { key: 'zz_fixture.act_peek', en: 'Counted the screens' },
    });
});
