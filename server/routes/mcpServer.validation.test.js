/**
 * The JSON-RPC envelope of the three MCP surfaces — /mcp (mcpServer.js),
 * /mcp/studio (mcpStudio.js) and /mcp/automations (mcpAutomations.js) — and
 * how each refuses what it cannot run.
 *
 * These routers take no validate() middleware on purpose: a refusal has to be
 * a JSON-RPC error carrying the call's id, not a 400 from the terminal
 * handler. What was wrong inside that envelope:
 *
 *   - every notification but notifications/initialized was ANSWERED — with
 *     "Method not found" and no id, under a 200 — where the transport wants a
 *     bare 202. notifications/cancelled is what Claude Code sends when someone
 *     interrupts a tool call;
 *   - a client's own JSON-RPC response got the same error;
 *   - tools/call `arguments` that were not an object reached the tool as-is.
 *
 * Run: cd server && node --test routes/mcpServer.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every tool call lands in `touched`. A refused call must leave it empty.
const touched = [];
const builder = (surface) => ({
    isEnabled: () => true,
    buildToolList: () => [],
    callTool: async (name, args) => { touched.push({ what: `${surface}.callTool`, args: [name, args] }); return { result: { ok: true } }; },
});

const MOCKS = {
    '../auth/mcpToken': {
        SECRET_KEY: 'mcp_server_token_user_',
        mintToken: () => ({ token: 'bfmcp.x.y', random: 'y' }),
        parseToken: () => null,
        authenticateToken: async (header) => (header === 'Bearer good' ? 'u1' : null),
    },
    '../appStudio/mcpBuilder': builder('studio'),
    '../automation/mcpBuilder': builder('routines'),
    '../core/entitlements/entitlements': { hasCapability: async () => true },
    '../core/entitlements/betaFeatures': { userHasBetaFeature: async () => true },
    '../stores/userStore': { getUser: async () => ({ organizationId: 'org1' }) },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:mcp-server-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]mcp(Server|Studio|Automations)\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const mcp = require('./mcpServer');
const studio = require('./mcpStudio');
const routines = require('./mcpAutomations');
test.after(() => { Module._resolveFilename = originalResolve; });

const SURFACES = [['/mcp', mcp], ['/mcp/studio', studio], ['/mcp/automations', routines]];

function post(router, body, authorization = 'Bearer good') {
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST', url: '/', originalUrl: '/', path: '/', body, query: {},
            headers: { authorization }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            set() { return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => reject(err || new Error('fell through')));
    });
}

test.beforeEach(() => { touched.length = 0; });

for (const [where, surface] of SURFACES) {
    test(`${where}: a notification other than initialized gets no answer`, async () => {
        const out = await surface.handleRpc({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } }, 'u1');
        assert.strictEqual(out, null);
    });

    test(`${where}: a client's own response is not answered as if it were a call`, async () => {
        const out = await surface.handleRpc({ jsonrpc: '2.0', id: 3, result: {} }, 'u1');
        assert.strictEqual(out, null);
    });

    test(`${where}: a message with neither a method nor a result is an Invalid Request, with its id`, async () => {
        const out = await surface.handleRpc({ jsonrpc: '2.0', id: 9 }, 'u1');
        assert.strictEqual(out.error.code, -32600);
        assert.strictEqual(out.id, 9);
    });

    test(`${where}: a message that is not an object is an Invalid Request with a null id`, async () => {
        const out = await surface.handleRpc('ping', 'u1');
        assert.strictEqual(out.error.code, -32600);
        assert.strictEqual(out.id, null);
    });

    test(`${where}: tool arguments that are not an object are refused, not handed to the tool`, async () => {
        for (const args of ['{"to":"x"}', ['x'], 42]) {
            const out = await surface.handleRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'some_tool', arguments: args } }, 'u1');
            assert.strictEqual(out.error.code, -32602, JSON.stringify(args));
            assert.strictEqual(out.error.message, 'Tool arguments must be a JSON object.');
        }
        assert.deepStrictEqual(touched, []);
    });

    test(`${where}: a tools/call sent as a notification is not run`, async () => {
        const out = await surface.handleRpc({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'some_tool', arguments: {} } }, 'u1');
        assert.strictEqual(out, null);
        assert.deepStrictEqual(touched, []);
    });

    test(`${where}: over HTTP, a notification-only POST is a bare 202`, async () => {
        const res = await post(surface, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
        assert.strictEqual(res.statusCode, 202);
        assert.strictEqual(res.body, undefined, 'no body at all');
    });

    test(`${where}: in a batch, only the request is answered`, async () => {
        const res = await post(surface, [
            { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } },
            { jsonrpc: '2.0', id: 'p1', method: 'ping' },
        ]);
        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(res.body, [{ jsonrpc: '2.0', id: 'p1', result: {} }]);
    });
}

test('params stay open beyond name and arguments: _meta rides along to the builder', async () => {
    for (const surface of [studio, routines]) {
        const out = await surface.handleRpc({
            jsonrpc: '2.0', id: 7, method: 'tools/call',
            params: { name: 'x_list', arguments: { q: 1 }, _meta: { progressToken: 'pt-1' } },
        }, 'u1');
        assert.strictEqual(out.result.isError, false);
    }
    assert.deepStrictEqual(touched.map((t) => t.args), [['x_list', { q: 1 }], ['x_list', { q: 1 }]]);
});

test('arguments: null still means no arguments', async () => {
    const out = await studio.handleRpc({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'x_list', arguments: null } }, 'u1');
    assert.strictEqual(out.result.isError, false);
    assert.deepStrictEqual(touched[0].args, ['x_list', {}]);
});
