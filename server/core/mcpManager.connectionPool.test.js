/**
 * The per-user connection pool spawns ONE process per user+server, also when
 * two tool calls of the same round ask for it before the first connect ended.
 *
 * Run: cd server && node --test core/mcpManager.connectionPool.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const mcpStore = require('../stores/mcpStore');
const configStore = require('../stores/configStore');
const mcpManager = require('./mcpManager');

test('two concurrent calls to one server share a single spawned connection', async (t) => {
    const clients = [];
    class FakeTransport { constructor(opts) { this.opts = opts; } }
    class FakeClient {
        constructor() { this.closed = false; this.calls = 0; clients.push(this); }
        async connect() { await new Promise((r) => setImmediate(r)); }
        async listTools() { return { tools: [] }; }
        async callTool({ name }) { this.calls += 1; return { content: [{ type: 'text', text: `ran ${name}` }] }; }
        async close() { this.closed = true; }
    }
    mcpManager._setSdkForTests({ Client: FakeClient, StdioClientTransport: FakeTransport });

    const server = { id: 'srv', name: 'Srv', enabled: true, command: 'node', args: [], required_credentials: [], tools_cache: [{ name: 'a' }] };
    t.mock.method(mcpStore, 'getServer', async () => server);
    t.mock.method(mcpStore, 'deleteServer', async () => true);
    t.mock.method(configStore, 'getSecret', async () => null);

    const [a, b] = await Promise.all([
        mcpManager.callTool('srv', 'a', {}, 'user-1'),
        mcpManager.callTool('srv', 'a', {}, 'user-1'),
    ]);
    assert.strictEqual(a, 'ran a');
    assert.strictEqual(b, 'ran a');
    assert.strictEqual(clients.length, 1, 'one process, not one per call');
    assert.strictEqual(clients[0].calls, 2);

    // Another user gets their own connection.
    await mcpManager.callTool('srv', 'a', {}, 'user-2');
    assert.strictEqual(clients.length, 2);

    // removeServer closes every pooled connection (and clears the idle timers).
    await mcpManager.removeServer('srv');
    assert.ok(clients.every((c) => c.closed), 'no connection left open');
});

test('a failed connect is not remembered: the next call spawns again', async (t) => {
    let attempts = 0;
    class FakeTransport {}
    class FakeClient {
        async connect() { attempts += 1; if (attempts === 1) throw new Error('spawn ENOENT'); }
        async listTools() { return { tools: [] }; }
        async callTool() { return { content: [{ type: 'text', text: 'ok' }] }; }
        async close() {}
    }
    mcpManager._setSdkForTests({ Client: FakeClient, StdioClientTransport: FakeTransport });
    const server = { id: 'srv2', name: 'Srv2', enabled: true, command: 'node', args: [], required_credentials: [], tools_cache: [{ name: 'a' }] };
    t.mock.method(mcpStore, 'getServer', async () => server);
    t.mock.method(mcpStore, 'deleteServer', async () => true);
    t.mock.method(configStore, 'getSecret', async () => null);

    await assert.rejects(() => mcpManager.callTool('srv2', 'a', {}, 'user-1'), /ENOENT/);
    assert.strictEqual(await mcpManager.callTool('srv2', 'a', {}, 'user-1'), 'ok');
    await mcpManager.removeServer('srv2');
});

test('disconnectUser closes that user\'s connections only', async (t) => {
    const clients = [];
    class FakeTransport {}
    class FakeClient {
        constructor() { this.closed = false; clients.push(this); }
        async connect() {}
        async listTools() { return { tools: [] }; }
        async callTool() { return { content: [{ type: 'text', text: 'ok' }] }; }
        async close() { this.closed = true; }
    }
    mcpManager._setSdkForTests({ Client: FakeClient, StdioClientTransport: FakeTransport });
    const server = { id: 'srv3', name: 'Srv3', enabled: true, command: 'node', args: [], required_credentials: [], tools_cache: [{ name: 'a' }] };
    t.mock.method(mcpStore, 'getServer', async () => server);
    t.mock.method(mcpStore, 'deleteServer', async () => true);
    t.mock.method(configStore, 'getSecret', async () => null);

    await mcpManager.callTool('srv3', 'a', {}, 'u1');
    await mcpManager.callTool('srv3', 'a', {}, 'u12');
    await mcpManager.disconnectUser('u1');
    assert.deepStrictEqual(clients.map((c) => c.closed), [true, false], 'u12 is another user');
    await mcpManager.removeServer('srv3');
});
