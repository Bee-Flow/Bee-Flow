/**
 * Bundled first-party MCP server path resolution.
 *
 * Run: cd server && node --test core/mcpManager.bundled.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { resolveBundledArgs } = require('./mcpManager');

const SERVER_ROOT = path.resolve(__dirname, '..');

test('a bundled server path becomes absolute so cwd cannot break the spawn', () => {
    const resolved = resolveBundledArgs(['mcpServers/soverin/index.mjs']);

    assert.strictEqual(resolved.length, 1);
    assert.strictEqual(path.isAbsolute(resolved[0]), true);
    assert.strictEqual(resolved[0], path.join(SERVER_ROOT, 'mcpServers/soverin/index.mjs'));
});

test('npx-style args are passed through untouched', () => {
    const args = ['-y', '@modelcontextprotocol/server-github'];

    assert.deepStrictEqual(resolveBundledArgs(args), args);
});

test('only the bundled prefix is rewritten', () => {
    assert.deepStrictEqual(
        resolveBundledArgs(['--flag', '/abs/path/server.js', 'not/mcpServers/x.mjs']),
        ['--flag', '/abs/path/server.js', 'not/mcpServers/x.mjs']
    );
});

test('missing or malformed args never throw at spawn time', () => {
    assert.deepStrictEqual(resolveBundledArgs(), []);
    assert.deepStrictEqual(resolveBundledArgs(null), []);
    assert.deepStrictEqual(resolveBundledArgs('mcpServers/soverin/index.mjs'), []);
    assert.deepStrictEqual(resolveBundledArgs([42, null]), [42, null]);
});
