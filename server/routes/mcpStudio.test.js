/**
 * The App Studio MCP endpoint's protocol layer.
 *
 * The builder tools are covered by their own suites and the envelope by
 * appStudio/mcpBuilder.test.js; what is left here is the JSON-RPC contract a
 * client actually connects over, plus the fact that this endpoint reuses the
 * existing token rather than inventing a second one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const studio = require('./mcpStudio');
const mcpServer = require('./mcpServer');

test('initialize advertises tools and carries the orientation instructions', async () => {
    const res = await studio.handleRpc({ id: 1, method: 'initialize' }, 'u1');
    assert.equal(res.jsonrpc, '2.0');
    assert.equal(res.id, 1);
    assert.equal(res.result.protocolVersion, mcpServer.PROTOCOL_VERSION);
    assert.equal(res.result.serverInfo.name, 'bee-flow-app-studio');
    assert.ok(res.result.capabilities.tools);
    // A client that never reads the guide invents component types the
    // validator rejects, so initialize is where that is said.
    assert.match(res.result.instructions, /studio_get_guide/);
    assert.match(res.result.instructions, /appId/);
});

test('the server identifies as a DIFFERENT server from /mcp', async () => {
    // Same host, same token, two endpoints — a client that saw one name for
    // both would present one merged tool list.
    const studioInit = await studio.handleRpc({ id: 1, method: 'initialize' }, 'u1');
    const integrationInit = await mcpServer.handleRpc({ id: 1, method: 'initialize' }, 'u1');
    assert.notEqual(studioInit.result.serverInfo.name, integrationInit.result.serverInfo.name);
});

test('ping answers and initialized is a notification', async () => {
    assert.deepEqual((await studio.handleRpc({ id: 2, method: 'ping' }, 'u1')).result, {});
    assert.equal(await studio.handleRpc({ method: 'notifications/initialized' }, 'u1'), null);
});

test('an unsupported method is a proper JSON-RPC error', async () => {
    const res = await studio.handleRpc({ id: 3, method: 'resources/list' }, 'u1');
    assert.equal(res.error.code, -32601);
    assert.match(res.error.message, /resources\/list/);
});

test('tools/call without a name is rejected as an invalid-params error', async () => {
    const res = await studio.handleRpc({ id: 4, method: 'tools/call', params: {} }, 'u1');
    assert.equal(res.error.code, -32602);
});

test('the endpoint accepts the token /mcp already mints', async () => {
    // Deliberately one credential for both surfaces: a second token type is a
    // second secret to rotate and a second way to get revocation wrong.
    const { token } = mcpServer.mintToken('user-xyz');
    assert.equal(mcpServer.parseToken(token).userId, 'user-xyz');
    // And an unknown token authenticates nobody on this path either.
    assert.equal(await mcpServer.authenticateToken('Bearer bfmcp.abc.short'), null);
});
