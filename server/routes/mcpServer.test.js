/**
 * Bee Flow's MCP server surface.
 *
 * The security-relevant part is the token codec and the per-call permission
 * re-check: an MCP client holds a static bearer token for months, so "the tool
 * list I saw at connect time" must never be what authorises a call.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const mcp = require('./mcpServer');

test('a minted token round-trips through the parser', () => {
    const { token, random } = mcp.mintToken('user-abc-123');
    const parsed = mcp.parseToken(token);
    assert.equal(parsed.userId, 'user-abc-123');
    assert.equal(parsed.random, random);
    assert.match(random, /^[a-f0-9]{64}$/);
});

test('a user id with awkward characters survives the round-trip', () => {
    // Ids are base64url-encoded precisely so a '.' or '/' in one cannot break
    // the three-part split.
    for (const id of ['a.b.c', 'user/with/slashes', 'ü-née', 'a+b/c=']) {
        assert.equal(mcp.parseToken(mcp.mintToken(id).token).userId, id);
    }
});

test('malformed tokens are rejected rather than half-parsed', () => {
    assert.equal(mcp.parseToken(''), null);
    assert.equal(mcp.parseToken(null), null);
    assert.equal(mcp.parseToken('bfmcp.abc'), null, 'too few parts');
    assert.equal(mcp.parseToken('bfmcp.abc.def.ghi'), null, 'too many parts');
    assert.equal(mcp.parseToken('other.abc.' + 'a'.repeat(64)), null, 'wrong prefix');
    assert.equal(mcp.parseToken('bfmcp.abc.short'), null, 'random half wrong length');
    assert.equal(mcp.parseToken('bfmcp.abc.' + 'z'.repeat(64)), null, 'random half not hex');
});

test('an empty user id is rejected', () => {
    const empty = Buffer.from('', 'utf8').toString('base64url');
    assert.equal(mcp.parseToken(`bfmcp.${empty}.${'a'.repeat(64)}`), null);
});

test('an absent Authorization header authenticates nobody', async () => {
    assert.equal(await mcp.authenticateToken(undefined), null);
    assert.equal(await mcp.authenticateToken(''), null);
    assert.equal(await mcp.authenticateToken('Bearer nonsense'), null);
});

test('tool annotations mirror the side-effect classification', () => {
    // These two are pinned in sideEffectMap and its completeness test, so this
    // is really asserting that the MCP surface reads the same source of truth
    // rather than a second, drifting one.
    const read = mcp.toMcpTool({ name: 'nextcloud_list_files', description: 'x', parameters: { type: 'object' } });
    assert.equal(read.annotations.readOnlyHint, true);
    assert.equal(read.annotations.destructiveHint, false);

    const write = mcp.toMcpTool({ name: 'nextcloud_delete', description: 'x', parameters: { type: 'object' } });
    assert.equal(write.annotations.readOnlyHint, false);
    assert.equal(write.annotations.destructiveHint, true);
});

test('an unclassified tool is advertised as destructive, not safe', () => {
    // Fail-closed. A tool added without a sideEffectMap entry must not be
    // presented to a client as something it can call without asking.
    const unknown = mcp.toMcpTool({ name: 'some_tool_added_next_year', parameters: {} });
    assert.equal(unknown.annotations.readOnlyHint, false);
    assert.equal(unknown.annotations.destructiveHint, true);
});

test('a tool with no parameter schema still gets a valid inputSchema', () => {
    // MCP clients reject a tool whose inputSchema is absent or not an object.
    const t = mcp.toMcpTool({ name: 'x' });
    assert.equal(t.inputSchema.type, 'object');
    assert.deepEqual(t.inputSchema.properties, {});
});

test('initialize advertises the protocol version and the tools capability', async () => {
    const res = await mcp.handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize' }, 'user-1');
    assert.equal(res.result.protocolVersion, mcp.PROTOCOL_VERSION);
    assert.ok(res.result.capabilities.tools);
    assert.equal(res.result.serverInfo.name, 'bee-flow');
});

test('an initialized notification produces no response', async () => {
    // Notifications have no id; answering one is a protocol error.
    assert.equal(await mcp.handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, 'user-1'), null);
});

test('an unknown method returns method-not-found, not a crash', async () => {
    const res = await mcp.handleRpc({ jsonrpc: '2.0', id: 7, method: 'resources/list' }, 'user-1');
    assert.equal(res.error.code, -32601);
    assert.match(res.error.message, /resources\/list/);
});

test('tools/call without a name is a parameter error', async () => {
    const res = await mcp.handleRpc({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: {} }, 'user-1');
    assert.equal(res.error.code, -32602);
});

// The tool list itself comes from getIntegrationTools, which needs Postgres,
// and this file is part of the infra-free CI gate. So the tests below inject
// the resolver through handleRpc's `deps` seam; the real one is only reduced
// by toolListFrom, tested on its own.

test('toolListFrom takes the array out of getIntegrationTools\' { tools, n8nOrgId }', () => {
    // The bug this pins: the answer is an object, and testing IT with
    // Array.isArray gave /mcp an empty tool list for every user.
    const tools = [{ type: 'function', function: { name: 'gmail_search' } }];
    assert.deepEqual(mcp.toolListFrom({ tools, n8nOrgId: 'org-9' }), tools);
    assert.deepEqual(mcp.toolListFrom(null), []);
    assert.deepEqual(mcp.toolListFrom({ tools: 'nope' }), []);
});

const FAKE_TOOLS = [
    { type: 'function', function: { name: 'gmail_search', description: 'Search mail', parameters: { type: 'object', properties: { q: { type: 'string' } } } } },
    { type: 'function', function: { name: 'gmail_send', description: 'Send mail' } },
];
const withTools = { toolsForUser: async () => ({ tools: FAKE_TOOLS, session: null }) };

test('tools/list advertises every tool the user can use, with safety annotations', async () => {
    const res = await mcp.handleRpc({ jsonrpc: '2.0', id: 11, method: 'tools/list' }, 'user-1', withTools);
    const names = res.result.tools.map(t => t.name);
    assert.deepEqual(names, ['gmail_search', 'gmail_send']);
    const search = res.result.tools[0];
    assert.equal(search.description, 'Search mail');
    assert.deepEqual(search.inputSchema.properties.q, { type: 'string' });
    assert.equal(typeof search.annotations.readOnlyHint, 'boolean');
});

test('tools/call refuses a tool the user does not have, without running it', async () => {
    const res = await mcp.handleRpc({
        jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'drive_delete', arguments: {} },
    }, 'user-1', withTools);
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /not available to this account/);
});
