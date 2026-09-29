/**
 * Unit — jsonApiRequest hardened outbound client (H10). DB-free; stubs global
 * fetch. Run: node --test integrations/shared/apiClient.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { jsonApiRequest } = require('./apiClient');

function stubFetch(fn) {
    const orig = global.fetch;
    global.fetch = fn;
    return () => { global.fetch = orig; };
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok, status, text: async () => text };
}

test('refuses a private/internal target before any fetch (SSRF pre-filter)', async () => {
    let called = false;
    const restore = stubFetch(async () => { called = true; return jsonResponse({}); });
    try {
        await assert.rejects(
            () => jsonApiRequest('http://169.254.169.254/latest/meta-data/'),
            (e) => e.code === 'EPRIVATETARGET',
        );
        await assert.rejects(() => jsonApiRequest('http://127.0.0.1:8080/x'), (e) => e.code === 'EPRIVATETARGET');
        await assert.rejects(() => jsonApiRequest('http://2130706433/x'), (e) => e.code === 'EPRIVATETARGET');
        assert.strictEqual(called, false, 'fetch never runs for a blocked target');
    } finally { restore(); }
});

test('allowPrivate lets an internal target through (self-hosted service opt-out)', async () => {
    const restore = stubFetch(async () => jsonResponse({ ok: 1 }));
    try {
        const out = await jsonApiRequest('http://127.0.0.1:5678/rest/workflows', { allowPrivate: true });
        assert.deepStrictEqual(out, { ok: 1 });
    } finally { restore(); }
});

test('public target: returns parsed JSON, sends JSON content-type + body', async () => {
    let seen;
    const restore = stubFetch(async (url, init) => { seen = { url, init }; return jsonResponse({ id: 7 }); });
    try {
        const out = await jsonApiRequest('https://api.example.com/things', { method: 'POST', body: { a: 1 } });
        assert.deepStrictEqual(out, { id: 7 });
        assert.strictEqual(seen.init.method, 'POST');
        assert.strictEqual(seen.init.body, JSON.stringify({ a: 1 }));
        assert.strictEqual(seen.init.headers['Content-Type'], 'application/json');
        assert.ok(seen.init.signal, 'a timeout AbortSignal is attached');
    } finally { restore(); }
});

test('maps a timeout/abort to ETIMEDOUT without leaking the URL', async () => {
    const restore = stubFetch(async () => { const e = new Error('aborted'); e.name = 'TimeoutError'; throw e; });
    try {
        await assert.rejects(
            () => jsonApiRequest('https://slow.example.com/x', { timeoutMs: 5, errorPrefix: 'YouTrack API' }),
            (e) => e.code === 'ETIMEDOUT' && /YouTrack API/.test(e.message) && !/slow\.example\.com/.test(e.message),
        );
    } finally { restore(); }
});

test('truncates the error body and never includes the URL or auth header', async () => {
    const longBody = 'SECRET_TOKEN_abcdef '.repeat(100);
    const restore = stubFetch(async () => jsonResponse(longBody, { ok: false, status: 500 }));
    try {
        await jsonApiRequest('https://api.example.com/x?token=supersecret', {
            headers: { Authorization: 'Bearer supersecret' },
            errorPrefix: 'YouTrack API',
            maxErrorChars: 50,
        });
        assert.fail('should have thrown');
    } catch (e) {
        assert.strictEqual(e.status, 500);
        assert.ok(e.message.length < 120, 'error message is bounded');
        assert.ok(!/supersecret/.test(e.message), 'auth token / query secret not leaked');
        assert.ok(!/api\.example\.com/.test(e.message), 'URL not leaked');
    } finally { restore(); }
});

test('non-network failure becomes a generic EREQUEST (no detail leak)', async () => {
    const restore = stubFetch(async () => { throw new Error('ECONNREFUSED 10.0.0.5:443'); });
    try {
        await assert.rejects(
            () => jsonApiRequest('https://api.example.com/x'),
            (e) => e.code === 'EREQUEST' && !/10\.0\.0\.5/.test(e.message),
        );
    } finally { restore(); }
});

test('empty body returns null', async () => {
    const restore = stubFetch(async () => jsonResponse('', { ok: true, status: 204 }));
    try {
        assert.strictEqual(await jsonApiRequest('https://api.example.com/x'), null);
    } finally { restore(); }
});
