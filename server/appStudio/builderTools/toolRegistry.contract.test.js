/**
 * Every AI builder tool in builderTools/tools/ (toolRegistry.mts) held to the rules a shipped
 * tool needs beyond what the loader checks: a name no other tool surface uses, never on the
 * small-model menu, a chat verb whose key is in the English dictionary with that wording and in
 * the Dutch file of its namespace, and a place in the web's generated lists. Needs no edit for a
 * new tool. The same rules also run over the test-only fixture tools
 * (without the dictionary checks: their namespace is not shipped), so this file is never
 * an empty pass.
 * Run: node --test appStudio/builderTools/toolRegistry.contract.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const registry = require('./toolRegistry.mts');
const { TOOL_SCHEMAS } = require('./schemas');
const { APP_CORE_TOOL_NAMES } = require('../builderModelProfiles');
const { STUDIO_TOOLS } = require('../mcpStudioTools');

const CHAT = path.join(__dirname, '../../../agent-hub/src/components/admin/Studio/AppStudio/chat');
const shipped = registry.registryTools();
const fixtures = registry.loadRegistryTools(path.join(__dirname, '__tests__', 'registryFixtureTools'));

/** Every tool name some other surface already answers to. */
async function reservedNames() {
    const { ASK_QUESTIONS_TOOL } = await import('../../routes/ai/appStudioBuilder/workMode.mts');
    const own = new Set(shipped.map((t) => t.name));
    return new Set([
        ...TOOL_SCHEMAS.map((t) => t.function.name).filter((n) => !own.has(n)),
        ...STUDIO_TOOLS.map((t) => t.name),
        ASK_QUESTIONS_TOOL.function.name,
    ]);
}

const MCP_ONLY = new Set(STUDIO_TOOLS.map((t) => t.name));

/**
 * The rules that hold for any registry tool, as sentences (empty when it passes). A tool with
 * `mcp: false` may carry the name of an MCP-only tool: it is that tool's in-product counterpart,
 * never listed over MCP, so the endpoint keeps answering with its own.
 */
function surfaceProblems(/** @type {any} */ tool, /** @type {Set<string>} */ reserved) {
    const out = [];
    const counterpart = tool.mcp === false && MCP_ONLY.has(tool.name);
    if (reserved.has(tool.name) && !counterpart) out.push(`${tool.name}: the name is already a tool of the builder, the MCP endpoint or the question card`);
    if (APP_CORE_TOOL_NAMES.has(tool.name)) out.push(`${tool.name}: a registry tool is never on the small-model menu`);
    return out;
}

test('the rules run over the fixture tools too, so they are never an empty pass', async () => {
    assert.ok(fixtures.length >= 2);
    const reserved = await reservedNames();
    for (const tool of fixtures) assert.deepEqual(surfaceProblems(tool, reserved), [], tool.name);
    assert.equal(surfaceProblems({ name: 'app_update_screen' }, reserved).length, 1, 'a base name is caught');
    assert.equal(surfaceProblems({ name: 'app_run_action' }, reserved).length, 1, 'an MCP-only name is caught');
    assert.equal(surfaceProblems({ name: 'app_run_action', mcp: true }, reserved).length, 1, 'an MCP-only name offered over MCP again is caught');
    assert.equal(surfaceProblems({ name: 'app_run_action', mcp: false }, reserved).length, 0, 'the in-product counterpart of an MCP-only tool passes');
    assert.equal(surfaceProblems({ name: 'app_update_screen', mcp: false }, reserved).length, 1, 'a base name stays caught, offered over MCP or not');
    assert.equal(surfaceProblems({ name: 'app_ask_questions' }, reserved).length, 1, 'the question card is caught');
    assert.equal(surfaceProblems({ name: 'app_finalize' }, reserved).length, 2, 'a core name is caught');
});

test('every shipped tool has a name of its own and stays off the small-model menu', async () => {
    const reserved = await reservedNames();
    for (const tool of shipped) assert.deepEqual(surfaceProblems(tool, reserved), [], tool.name);
});

test('every shipped tool has its verb in the English dictionary and in the Dutch file of its namespace', () => {
    const { GUI_DEFAULTS } = require('../../i18n/defaults/en');
    const nl = require('../../i18n/defaults/nl').loadNamespaceFiles();
    for (const tool of shipped) {
        const { key, en } = tool.verb;
        assert.equal(GUI_DEFAULTS[key], en, `${tool.name}: ${key} is "${en}" in server/i18n/defaults/en/${key.split('.')[0]}.js`);
        assert.ok(Object.hasOwn(nl.translations, key) || nl.sameAsEnglish.includes(key), `${tool.name}: ${key} has its Dutch in server/i18n/defaults/nl/${key.split('.')[0]}.json`);
    }
});

test('the web lists carry every shipped tool: its name and its verb', () => {
    const webNames = require(path.join(CHAT, 'appToolNames.generated.json'));
    const webVerbs = require(path.join(CHAT, 'appToolVerbs.generated.json'));
    for (const tool of shipped) {
        assert.ok(webNames.includes(tool.name), `${tool.name}: run node scripts/gen-app-catalog.mjs --tools`);
        assert.deepEqual(webVerbs[tool.name], tool.verb, `${tool.name}: run node scripts/gen-app-catalog.mjs --tools`);
    }
});
