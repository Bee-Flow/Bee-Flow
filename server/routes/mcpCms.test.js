/**
 * /mcp/cms over real HTTP: the access gate in front of the JSON-RPC endpoint,
 * the flag that keeps the route unmounted by default, and the raw-body upload
 * path end to end (ticket → streamed PUT → stored asset).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { makeRouter } = require('./mcpCms');
const cmsMcp = require('../cms/mcp');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(2000, 5)]);

function boot({ gateResult, mcpOver = {}, receiverDeps = {} } = {}) {
    const kv = new Map();
    const tickets = cmsMcp.createUploadTickets({
        store: {
            get: async (k) => (kv.has(k) ? structuredClone(kv.get(k)) : null),
            set: async (k, v) => { kv.set(k, structuredClone(v)); },
            mutate: async (k, fn) => { const n = fn(kv.has(k) ? structuredClone(kv.get(k)) : null); kv.set(k, n); return n; },
            remove: async (k) => { kv.delete(k); },
            listKeys: async () => [],
        },
    });
    const stored = [];
    const receiver = cmsMcp.createUploadReceiver({
        tickets,
        storage: { isAvailable: () => true, uploadFile: async (key, body, type) => { stored.push({ key, size: body.length, type }); } },
        streamIntoStorage: async () => {},
        sanitizeSvg: (b) => b,
        isValidVtt: () => true,
        looksLikeClip: () => true,
        checkAccess: async () => ({ ok: true }),
        ...receiverDeps,
    });
    const handled = [];
    const mcp = { handleRpc: async (message, ctx) => { handled.push({ message, ctx }); return { jsonrpc: '2.0', id: message.id, result: { ok: true } }; }, ...mcpOver };
    const denied = [];
    const gate = {
        gateRequest: async () => gateResult || { ok: true, user: { id: 'u1', role: 'admin' }, orgId: 'o1', token: { id: 't1', name: 'laptop', scopes: { cms: { level: 'write' } } } },
        rpcDenied: (res, status, id) => { denied.push(status); res.status(status).json({ jsonrpc: '2.0', id, error: { code: -1, message: 'denied' } }); },
    };
    const app = express();
    app.use('/mcp/cms', makeRouter({ runtime: () => ({ mcp, receiver }), gate, publicBaseUrl: () => 'https://app.example.test' }));
    const server = http.createServer(app);
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
        const base = `http://127.0.0.1:${server.address().port}`;
        resolve({ base, tickets, stored, handled, denied, close: () => new Promise((r) => server.close(r)) });
    }));
}

test('POST /: a gated request reaches the RPC handler with user, org, token and base url', async () => {
    const h = await boot();
    try {
        const res = await fetch(`${h.base}/mcp/cms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { jsonrpc: '2.0', id: 1, result: { ok: true } });
        const { ctx } = h.handled[0];
        assert.equal(ctx.userId, 'u1');
        assert.equal(ctx.orgId, 'o1');
        assert.equal(ctx.token.name, 'laptop');
        assert.equal(ctx.baseUrl, 'https://app.example.test');
    } finally { await h.close(); }
});

test('POST /: a refused request never reaches the handler', async () => {
    const h = await boot({ gateResult: { ok: false, status: 403, reason: 'ip_outside_org_list' } });
    try {
        const res = await fetch(`${h.base}/mcp/cms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
        assert.equal(res.status, 403);
        assert.deepEqual(h.denied, [403]);
        assert.equal(h.handled.length, 0);
    } finally { await h.close(); }
});

test('POST /: batches are answered as a batch, notifications get 202', async () => {
    const h = await boot({ mcpOver: { handleRpc: async (m) => (m.id === undefined ? null : { jsonrpc: '2.0', id: m.id, result: {} }) } });
    try {
        const batch = await fetch(`${h.base}/mcp/cms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }]) });
        assert.equal((await batch.json()).length, 1);
        const note = await fetch(`${h.base}/mcp/cms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
        assert.equal(note.status, 202);
    } finally { await h.close(); }
});

test('POST /: a batch of more than 20 messages is an Invalid Request and nothing runs', async () => {
    const h = await boot();
    try {
        const send = (n) => fetch(`${h.base}/mcp/cms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(new Array(n).fill({ jsonrpc: '2.0', id: 1, method: 'ping' })) });
        const big = await send(21);
        assert.equal(big.status, 400);
        const body = await big.json();
        assert.equal(body.error.code, -32600);
        assert.equal(h.handled.length, 0);
        assert.equal((await send(20)).status, 200);
        assert.equal(h.handled.length, 20);
    } finally { await h.close(); }
});

test('POST /: a handler that throws answers an internal error to a request', async () => {
    const h = await boot({ mcpOver: { handleRpc: async () => { throw new Error('boom'); } } });
    try {
        const res = await fetch(`${h.base}/mcp/cms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' }) });
        const body = await res.json();
        assert.equal(body.error.code, -32603);
        assert.ok(!JSON.stringify(body).includes('boom'));
    } finally { await h.close(); }
});

test('GET / is refused for the unauthenticated and 405 for the authenticated', async () => {
    const denied = await boot({ gateResult: { ok: false, status: 401, reason: 'token_unknown' } });
    try { assert.equal((await fetch(`${denied.base}/mcp/cms`)).status, 401); } finally { await denied.close(); }
    const ok = await boot();
    try { assert.equal((await fetch(`${ok.base}/mcp/cms`)).status, 405); } finally { await ok.close(); }
});

test('PUT /upload/:ticketId: a raw binary body is streamed, stored, answered with the asset url', async () => {
    const h = await boot();
    try {
        const { ticketId, secret } = await h.tickets.issue({ userId: 'u1', orgId: 'o1', siteId: 'pj_aaaa', contentType: 'image/png', maxSize: PNG.length, filename: 'hero.png' });
        const res = await fetch(`${h.base}/mcp/cms/upload/${ticketId}`, { method: 'PUT', headers: { 'content-type': 'image/png', 'x-upload-ticket': secret }, body: PNG });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.match(body.key, /^cms\/\d+-[a-f0-9]{12}-hero\.png$/);
        assert.equal(body.url, `/api/cms/asset/${body.key}`);
        assert.equal(body.absoluteUrl, `https://app.example.test${body.url}`);
        assert.equal(body.contentType, 'image/png');
        assert.equal(body.size, PNG.length);
        assert.deepEqual(h.stored, [{ key: body.key, size: PNG.length, type: 'image/png' }]);
        assert.equal(h.handled.length, 0, 'no bearer, no RPC: the ticket is the credential');

        const again = await fetch(`${h.base}/mcp/cms/upload/${ticketId}`, { method: 'PUT', headers: { 'content-type': 'image/png', 'x-upload-ticket': secret }, body: PNG });
        assert.equal(again.status, 403);
        assert.equal(h.stored.length, 1);
    } finally { await h.close(); }
});

test('PUT /upload/:ticketId: the secret must come in the X-Upload-Ticket header, never in the path', async () => {
    const h = await boot();
    try {
        const { ticket, ticketId, secret } = await h.tickets.issue({ userId: 'u1', orgId: 'o1', siteId: 'pj_aaaa', contentType: 'image/png', maxSize: PNG.length, filename: 'hero.png' });
        const put = (url, headers = {}) => fetch(url, { method: 'PUT', headers: { 'content-type': 'image/png', ...headers }, body: PNG });
        assert.equal((await put(`${h.base}/mcp/cms/upload/${ticketId}`)).status, 403, 'no header');
        assert.equal((await put(`${h.base}/mcp/cms/upload/${ticketId}`, { 'x-upload-ticket': 'x'.repeat(43) })).status, 403, 'wrong secret');
        assert.equal((await put(`${h.base}/mcp/cms/upload/${ticket}`)).status, 403, 'the old id.secret path form no longer works');
        assert.equal(h.stored.length, 0);
        assert.equal((await put(`${h.base}/mcp/cms/upload/${ticketId}`, { 'x-upload-ticket': secret })).status, 200, 'the right header still works: nothing above spent the ticket');
    } finally { await h.close(); }
});

test('PUT /upload/:ticket: a JSON content type never gets near storage (the global JSON parser is not our concern)', async () => {
    const h = await boot();
    try {
        const { ticketId, secret } = await h.tickets.issue({ userId: 'u1', orgId: 'o1', siteId: 'pj_aaaa', contentType: 'image/png', maxSize: 100, filename: 'a.png' });
        const res = await fetch(`${h.base}/mcp/cms/upload/${ticketId}`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-upload-ticket': secret }, body: '{}' });
        assert.equal(res.status, 415);
        assert.equal(h.stored.length, 0);
    } finally { await h.close(); }
});

test('PUT /upload/:ticket: an oversize stream is answered 413 and nothing is stored', async () => {
    const h = await boot();
    try {
        const { ticketId, secret } = await h.tickets.issue({ userId: 'u1', orgId: 'o1', siteId: 'pj_aaaa', contentType: 'image/png', maxSize: 500, filename: 'a.png' });
        // Chunked: no Content-Length, so only the stream cap can stop it.
        const chunks = (async function* () { for (let i = 0; i < 20; i += 1) yield Buffer.alloc(100, 1); })();
        let status = 0;
        try {
            const res = await fetch(`${h.base}/mcp/cms/upload/${ticketId}`, { method: 'PUT', headers: { 'content-type': 'image/png', 'x-upload-ticket': secret }, body: chunks, duplex: 'half' });
            status = res.status;
        } catch (_) { status = 413; /* the server may drop the connection once it has answered */ }
        assert.equal(status, 413);
        assert.equal(h.stored.length, 0);
    } finally { await h.close(); }
});

test('the route is unmounted by default: the flag is exactly "1"', () => {
    const saved = process.env.CMS_MCP_ENABLED;
    try {
        delete process.env.CMS_MCP_ENABLED;
        assert.equal(cmsMcp.isEnabled(), false);
        for (const v of ['', 'true', '0', 'yes', 'TRUE']) {
            process.env.CMS_MCP_ENABLED = v;
            assert.equal(cmsMcp.isEnabled(), false, v);
        }
        process.env.CMS_MCP_ENABLED = '1';
        assert.equal(cmsMcp.isEnabled(), true);
    } finally {
        if (saved === undefined) delete process.env.CMS_MCP_ENABLED; else process.env.CMS_MCP_ENABLED = saved;
    }
});
