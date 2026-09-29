/**
 * The Routines MCP endpoint's protocol layer.
 *
 * The builder tools are covered by their own suites and the envelope by
 * automation/mcpBuilder.test.js; what is left here is the JSON-RPC contract a
 * client actually connects over, plus the fact that this endpoint reuses the
 * existing token rather than inventing a third one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const routines = require('./mcpAutomations');
const studio = require('./mcpStudio');
const mcpServer = require('./mcpServer');

test('initialize advertises tools and carries the orientation instructions', async () => {
    const res = await routines.handleRpc({ id: 1, method: 'initialize' }, 'u1');
    assert.equal(res.jsonrpc, '2.0');
    assert.equal(res.id, 1);
    assert.equal(res.result.protocolVersion, mcpServer.PROTOCOL_VERSION);
    assert.equal(res.result.serverInfo.name, 'bee-flow-routines');
    assert.ok(res.result.capabilities.tools);
    // A client that never reads the guide invents step types the validator
    // rejects, so initialize is where that is said.
    assert.match(res.result.instructions, /routines_get_guide/);
    assert.match(res.result.instructions, /automationId/);
    // And the thing an agent must not assume: finalise is not activate.
    assert.match(res.result.instructions, /INACTIVE/);
});

test('all three MCP surfaces identify as different servers', async () => {
    // Same host, same token, three endpoints — a client that saw one name for
    // several would present one merged tool list.
    const names = await Promise.all([
        routines.handleRpc({ id: 1, method: 'initialize' }, 'u1'),
        studio.handleRpc({ id: 1, method: 'initialize' }, 'u1'),
        mcpServer.handleRpc({ id: 1, method: 'initialize' }, 'u1'),
    ]).then(rs => rs.map(r => r.result.serverInfo.name));
    assert.equal(new Set(names).size, 3, `server names collide: ${names.join(', ')}`);
});

test('ping answers and initialized is a notification', async () => {
    assert.deepEqual((await routines.handleRpc({ id: 2, method: 'ping' }, 'u1')).result, {});
    assert.equal(await routines.handleRpc({ method: 'notifications/initialized' }, 'u1'), null);
});

test('an unsupported method is a proper JSON-RPC error', async () => {
    const res = await routines.handleRpc({ id: 3, method: 'resources/list' }, 'u1');
    assert.equal(res.error.code, -32601);
    assert.match(res.error.message, /resources\/list/);
});

test('tools/call without a name is rejected as an invalid-params error', async () => {
    const res = await routines.handleRpc({ id: 4, method: 'tools/call', params: {} }, 'u1');
    assert.equal(res.error.code, -32602);
});

test('an unentitled user is advertised no tools rather than an error', async () => {
    // A user with no 'automations' feature cannot build routines. Answering
    // tools/list with an error makes the client fail to connect and tells the
    // operator nothing; an empty list is the honest, usable answer.
    const res = await routines.handleRpc({ id: 5, method: 'tools/list' }, 'nobody-with-this-id');
    assert.deepEqual(res.result.tools, []);
});

test('a tools/call from an unentitled user is a readable tool error', async () => {
    const res = await routines.handleRpc(
        { id: 6, method: 'tools/call', params: { name: 'routines_list' } },
        'nobody-with-this-id',
    );
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /not available on this account/);
});

test('the endpoint accepts the token /mcp already mints', async () => {
    // Deliberately one credential for all three surfaces: another token type is
    // another secret to rotate and another way to get revocation wrong.
    const { token } = mcpServer.mintToken('user-xyz');
    assert.equal(mcpServer.parseToken(token).userId, 'user-xyz');
    // And an unknown token authenticates nobody on this path either.
    assert.equal(await mcpServer.authenticateToken('Bearer bfmcp.abc.short'), null);
});
