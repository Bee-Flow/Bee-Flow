'use strict';

/**
 * The token's scopes on the three MCP surfaces: tools/list shows only what the
 * scopes allow, and tools/call re-checks the same rule, so a client that skips
 * the list still cannot call a tool outside its token.
 *
 * Run: node --test routes/mcpScopes.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const mcp = require('./mcpServer');
const studio = require('./mcpStudio');
const automations = require('./mcpAutomations');
const studioBuilder = require('../appStudio/mcpBuilder');
const automationBuilder = require('../automation/mcpBuilder');
// Entitlements are not what is under test; they say yes. The builders and the
// tool classification are the real ones.
const deps = { entitled: async () => true };
const access = (scopes) => ({ token: { id: 't1', name: 'test', scopes, legacy: false } });
const list = async (surface, scopes) => (await surface.handleRpc({ id: 1, method: 'tools/list' }, 'u1', access(scopes), deps)).result.tools;
const call = (surface, name, scopes) => surface.handleRpc({ id: 2, method: 'tools/call', params: { name, arguments: {} } }, 'u1', access(scopes), deps);

// ── The two builders: studio and automations ────────────────────────────────

for (const [server, surface, builder] of [['studio', studio, studioBuilder], ['automations', automations, automationBuilder]]) {
    const all = builder.buildToolList();
    const readOnly = all.filter((t) => t.annotations.readOnlyHint === true);
    const writes = all.filter((t) => t.annotations.readOnlyHint !== true);

    test(`${server}: the builder has both read-only and writing tools to tell apart`, () => {
        assert.ok(readOnly.length > 0 && writes.length > 0);
    });

    test(`${server}: level write lists everything, level read lists only read-only tools`, async () => {
        assert.equal((await list(surface, { [server]: { level: 'write' } })).length, all.length);
        const names = (await list(surface, { [server]: { level: 'read' } })).map((t) => t.name);
        assert.deepEqual(names, readOnly.map((t) => t.name));
    });

    test(`${server}: a token without this server sees no tools and cannot call any`, async () => {
        const other = server === 'studio' ? 'automations' : 'studio';
        assert.deepEqual(await list(surface, { [other]: { level: 'write' } }), []);
        const res = await call(surface, readOnly[0].name, { [other]: { level: 'write' } });
        assert.equal(res.result.isError, true);
        assert.match(res.result.content[0].text, /not available to this token/);
    });

    test(`${server}: an explicit tools list narrows the list and the call`, async () => {
        const scopes = { [server]: { level: 'write', tools: [writes[0].name] } };
        assert.deepEqual((await list(surface, scopes)).map((t) => t.name), [writes[0].name]);
        const denied = await call(surface, readOnly[0].name, scopes);
        assert.equal(denied.result.isError, true);
        assert.match(denied.result.content[0].text, /not available to this token/);
    });

    test(`${server}: a read token cannot call a writing tool, even one it never listed`, async () => {
        const denied = await call(surface, writes[0].name, { [server]: { level: 'read' } });
        assert.equal(denied.result.isError, true);
        assert.match(denied.result.content[0].text, /not available to this token/);
        const unknown = await call(surface, 'no_such_tool', { [server]: { level: 'read' } });
        assert.equal(unknown.result.isError, true, 'an unknown tool counts as a write');
    });

    test(`${server}: without an access context nothing is narrowed (direct callers, the legacy path)`, async () => {
        const res = await surface.handleRpc({ id: 1, method: 'tools/list' }, 'u1', null, deps);
        assert.equal(res.result.tools.length, all.length);
    });
}

// ── The integrations surface (/mcp) ─────────────────────────────────────────

const fn = (name) => ({ function: { name, description: name, parameters: { type: 'object', properties: {} } } });
const { isSideEffect } = require('../automation/sideEffectMap');

test('integrations: tools are filtered by level and by the explicit list, and tools/call re-checks', async () => {
    // Names from the real side-effect map: one read-only, one that writes.
    const readName = 'nextcloud_search';
    const writeName = 'nextcloud_write_file';
    assert.equal(isSideEffect(readName), false);
    assert.equal(isSideEffect(writeName), true);
    const names = [readName, writeName];
    const rpc = (message, scopes) => mcp.handleRpc(message, 'u1', { toolsForUser: async () => ({ tools: names.map(fn), session: null }) }, access(scopes));

    const writeAll = await rpc({ id: 1, method: 'tools/list' }, { integrations: { level: 'write' } });
    assert.deepEqual(writeAll.result.tools.map((t) => t.name).sort(), [...names].sort());

    const readOnlyList = await rpc({ id: 1, method: 'tools/list' }, { integrations: { level: 'read' } });
    assert.deepEqual(readOnlyList.result.tools.map((t) => t.name), [readName]);

    const narrowed = await rpc({ id: 1, method: 'tools/list' }, { integrations: { level: 'write', tools: [writeName] } });
    assert.deepEqual(narrowed.result.tools.map((t) => t.name), [writeName]);

    const none = await rpc({ id: 1, method: 'tools/list' }, { studio: { level: 'write' } });
    assert.deepEqual(none.result.tools, []);

    // tools/call: refused before anything runs.
    const denied = await rpc({ id: 2, method: 'tools/call', params: { name: writeName, arguments: {} } }, { integrations: { level: 'read' } });
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /not available/);
    const outsideList = await rpc({ id: 2, method: 'tools/call', params: { name: writeName, arguments: {} } }, { integrations: { level: 'write', tools: [readName] } });
    assert.equal(outsideList.result.isError, true);
    assert.match(outsideList.result.content[0].text, /not available/);
});
