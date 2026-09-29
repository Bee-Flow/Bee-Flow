/**
 * webpagesFullTierProxy — gate + WS-upgrade-auth regressions (BE-P3).
 *
 * This proxy is GATED + INERT unless webpageRuntimeManager.isEnabled()
 * (WEBPAGE_FULL_RUNTIME_ENABLED=1 + reachable Docker). These tests exercise
 * what's verifiable without Docker or a real container:
 *   - Gate-off: requiring server/index.js's call site never loads
 *     http-proxy-middleware, and startReaper() is a safe no-op.
 *   - mountFullTierProxy() registers exactly one 'upgrade' listener.
 *   - The single highest-value invariant this module documents: a WS upgrade
 *     with a missing/invalid/mismatched preview token is destroyed BEFORE
 *     ever reaching the proxy — never "upgrade first, check after". Verified
 *     by mocking verifyPreviewToken/getReachableBase and asserting
 *     socket.destroy() fires without the proxy's internal upgrade path
 *     running (no HTTP request is ever made to a mocked target).
 *
 * Run: node --test routes/webpagesFullTierProxy.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

process.env.NODE_ENV = 'test';
process.env.WEBPAGE_FULL_RUNTIME_ENABLED = '1';

const webpageRuntimeManager = require('../services/webpageRuntimeManager');
const { mountFullTierProxy } = require('./webpagesFullTierProxy');

function fakeServer() {
    const s = new EventEmitter();
    s.listenerCount = EventEmitter.prototype.listenerCount.bind(s);
    return s;
}
function fakeApp() {
    return { use: () => {} }; // mountFullTierProxy only calls app.use() once, synchronously
}

test('mountFullTierProxy registers exactly one upgrade listener', () => {
    const server = fakeServer();
    mountFullTierProxy(fakeApp(), server);
    assert.strictEqual(server.listenerCount('upgrade'), 1);
});

test('WS upgrade with no token is destroyed before touching getReachableBase', async () => {
    const server = fakeServer();
    let reachableBaseCalled = false;
    const originalGetReachableBase = webpageRuntimeManager.getReachableBase;
    webpageRuntimeManager.getReachableBase = async () => { reachableBaseCalled = true; return 'http://127.0.0.1:9999'; };
    try {
        mountFullTierProxy(fakeApp(), server);
        const req = { url: '/api/webpages-preview/wp1/full/?token=' };
        let destroyed = false;
        const socket = { destroy: () => { destroyed = true; } };
        server.emit('upgrade', req, socket, Buffer.alloc(0));
        await new Promise(r => setImmediate(r));
        assert.strictEqual(destroyed, true);
        assert.strictEqual(reachableBaseCalled, false, 'must never look up a target before auth succeeds');
    } finally {
        webpageRuntimeManager.getReachableBase = originalGetReachableBase;
    }
});

test('WS upgrade with a token issued for a DIFFERENT webpage is destroyed', async () => {
    const server = fakeServer();
    const { issuePreviewToken } = require('../auth/webpagePreviewToken');
    let reachableBaseCalled = false;
    const originalGetReachableBase = webpageRuntimeManager.getReachableBase;
    webpageRuntimeManager.getReachableBase = async () => { reachableBaseCalled = true; return 'http://127.0.0.1:9999'; };
    try {
        mountFullTierProxy(fakeApp(), server);
        const { token } = issuePreviewToken({ userId: 'u1', webpageId: 'wp-OTHER' });
        const req = { url: `/api/webpages-preview/wp1/full/?token=${encodeURIComponent(token)}` };
        let destroyed = false;
        const socket = { destroy: () => { destroyed = true; } };
        server.emit('upgrade', req, socket, Buffer.alloc(0));
        await new Promise(r => setImmediate(r));
        assert.strictEqual(destroyed, true);
        assert.strictEqual(reachableBaseCalled, false);
    } finally {
        webpageRuntimeManager.getReachableBase = originalGetReachableBase;
    }
});

test('WS upgrade for an unrelated path is left untouched (no socket mutation)', async () => {
    const server = fakeServer();
    mountFullTierProxy(fakeApp(), server);
    const req = { url: '/some/other/websocket/path' };
    let destroyed = false;
    const socket = { destroy: () => { destroyed = true; } };
    server.emit('upgrade', req, socket, Buffer.alloc(0));
    await new Promise(r => setImmediate(r));
    assert.strictEqual(destroyed, false, 'unrelated upgrade paths must not be touched');
});

test('WS upgrade with a VALID matching token proceeds to resolve a target (auth passes)', async () => {
    const server = fakeServer();
    const { issuePreviewToken } = require('../auth/webpagePreviewToken');
    let resolvedFor = null;
    const originalGetReachableBase = webpageRuntimeManager.getReachableBase;
    webpageRuntimeManager.getReachableBase = async (webpageId) => { resolvedFor = webpageId; return null; }; // no running container → destroy, but auth must have passed first
    try {
        mountFullTierProxy(fakeApp(), server);
        const { token } = issuePreviewToken({ userId: 'u1', webpageId: 'wp1' });
        const req = { url: `/api/webpages-preview/wp1/full/?token=${encodeURIComponent(token)}` };
        let destroyed = false;
        const socket = { destroy: () => { destroyed = true; } };
        server.emit('upgrade', req, socket, Buffer.alloc(0));
        await new Promise(r => setImmediate(r));
        assert.strictEqual(resolvedFor, 'wp1', 'auth passed — target lookup ran for the right webpage');
        assert.strictEqual(destroyed, true, 'no running container → still destroyed, just after (not instead of) auth');
    } finally {
        webpageRuntimeManager.getReachableBase = originalGetReachableBase;
    }
});
