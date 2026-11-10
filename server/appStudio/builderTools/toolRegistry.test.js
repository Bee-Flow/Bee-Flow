/**
 * toolRegistry.mts: discovery and the rules a tool file is held to at load.
 * The registry wired into the menu, dispatch and MCP: toolRegistry.fixture.test.js.
 * Run: node --test appStudio/builderTools/toolRegistry.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const registry = require('./toolRegistry.mts');

const FIXTURE_DIR = path.join(__dirname, '__tests__', 'registryFixtureTools');

/** A valid entry; each refusal test breaks one field of a copy. */
const valid = () => ({
    name: 'app_zz_valid',
    since: 3,
    description: 'Fixture.',
    schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
    apply: () => ({ ok: true }),
    mutating: false,
    core: false,
    mcp: true,
    verb: { key: 'zz_fixture.act_valid', en: 'Did it' },
});

test('a missing directory is an empty registry', () => {
    assert.deepEqual(registry.loadRegistryTools(path.join(__dirname, 'no-such-dir')), []);
});

test('the files of a directory load in file-name order, checked', () => {
    const tools = registry.loadRegistryTools(FIXTURE_DIR);
    assert.deepEqual(tools.map((t) => t.name), ['app_zz_note', 'app_zz_peek']);
    for (const tool of tools) assert.equal(typeof tool.apply, 'function');
});

test('the shipped folder loads (it holds only a README until a package adds a tool)', () => {
    const shipped = registry.loadRegistryTools();
    assert.ok(Array.isArray(shipped));
    assert.deepEqual(shipped.map((t) => t.name), registry.registryTools().map((t) => t.name));
});

test('a valid entry passes; each malformed field is refused with its rule', () => {
    assert.equal(registry.checkTool(valid(), 'app_zz_valid').name, 'app_zz_valid');
    const cases = [
        [{ name: 'zz_valid' }, /starts with app_/],
        [{ name: 'app_zz_other' }, /equals the file name/],
        [{ since: 2 }, /"since" of 3 or more/],
        [{ description: ' ' }, /"description"/],
        [{ schema: { type: 'string' } }, /"schema" is \{ type: "object"/],
        [{ schema: { type: 'object', properties: {}, required: ['b'] } }, /"schema.required"/],
        [{ schema: { type: 'object', properties: { a: { type: 'object', properties: {}, additionalProperties: false } } } }, /never closes/],
        [{ apply: null }, /"apply"/],
        [{ mutating: 'yes' }, /"mutating"/],
        [{ dataModel: true }, /needs "mutating": true/],
        [{ core: true }, /"core" is false/],
        [{ mcp: undefined }, /"mcp"/],
        [{ verb: { key: 'nodot', en: 'x' } }, /"verb"/],
        [{ verb: { key: 'ns.k', en: '' } }, /"verb"/],
    ];
    for (const [patch, rx] of cases) {
        assert.throws(() => registry.checkTool({ ...valid(), ...patch }, 'app_zz_valid'), rx, JSON.stringify(patch));
    }
    assert.throws(() => registry.checkTool(null, 'app_zz_valid'), /must export an object/);
});

test('install for a test is refused once the registry was read', () => {
    registry.registryTools();
    assert.throws(() => registry._installRegistryTools([valid()]), /before anything reads the registry/);
});
