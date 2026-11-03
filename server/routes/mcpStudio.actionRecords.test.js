'use strict';

/**
 * app_get_action and app_update_records on the Studio MCP surface: both are advertised, the
 * read one is allowed on a read-scoped token, the writing one is not.
 *
 * Run: cd server && node --test routes/mcpStudio.actionRecords.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const studio = require('./mcpStudio');
const studioBuilder = require('../appStudio/mcpBuilder');
const { scopeAllowsTool } = require('../auth/mcpAccess/scopes');

const deps = { entitled: async () => true };
const access = (scopes) => ({ token: { id: 't1', name: 'test', scopes, legacy: false } });
const list = async (scopes) => (await studio.handleRpc({ id: 1, method: 'tools/list' }, 'u1', access(scopes), deps)).result.tools;

test('both tools are advertised with their schema, the appId envelope and honest annotations', () => {
    const tools = new Map(studioBuilder.buildToolList().map((t) => [t.name, t]));
    const get = tools.get('app_get_action');
    const update = tools.get('app_update_records');
    assert.ok(get && update);
    assert.equal(get.annotations.readOnlyHint, true);
    assert.equal(update.annotations.readOnlyHint, false);
    assert.deepEqual(get.inputSchema.required, ['appId', 'ids']);
    assert.equal(get.inputSchema.properties.ids.maxItems, 20);
    assert.deepEqual(update.inputSchema.required, ['appId', 'tableId']);
    assert.equal(update.inputSchema.properties.updates.maxItems, 25);
    assert.equal(update.inputSchema.properties.max.maximum, 200);
    assert.match(update.description, /dry_run/);
    assert.match(get.description, /read-only/);
});

test('a read-scoped token lists and may call app_get_action but not app_update_records', async () => {
    const names = (await list({ studio: { level: 'read' } })).map((t) => t.name);
    assert.ok(names.includes('app_get_action'));
    assert.ok(!names.includes('app_update_records'));
    assert.equal(scopeAllowsTool({ studio: { level: 'read' } }, 'studio', 'app_get_action', { readOnly: true }), true);

    const denied = await studio.handleRpc(
        { id: 2, method: 'tools/call', params: { name: 'app_update_records', arguments: { appId: 'app_x', tableId: 'tbl_x', updates: [] } } },
        'u1', access({ studio: { level: 'read' } }), deps,
    );
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /not available to this token/);
});

test('a write-scoped token lists both; an explicit tools list narrows to what it names', async () => {
    const names = (await list({ studio: { level: 'write' } })).map((t) => t.name);
    assert.ok(names.includes('app_get_action') && names.includes('app_update_records'));
    const narrow = (await list({ studio: { level: 'write', tools: ['app_get_action'] } })).map((t) => t.name);
    assert.deepEqual(narrow, ['app_get_action']);
});
