/**
 * POST /chat/generate-image must reach the Google adapter. The route was split
 * out of directChat.js without its adapter import, so every call threw a
 * ReferenceError before the first byte of the response.
 *
 * Run: cd server && node --test --test-force-exit routes/ai/directChat/imageGeneration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const calls = [];
stub('../../../stores/configStore', { getSecret: async () => 'google-key' });
stub('../../../core/providers', {
    googleAdapter: {
        async generateImage(apiKey, prompt, options) {
            calls.push({ apiKey, prompt, options });
            return { imageBase64: 'aW1n', mimeType: 'image/png', text: '' };
        },
    },
});
stub('../../../auth/permissions', { requireAuth: (req, res, next) => next() });
stub('../../../stores/usageStore', { logUsage: async () => {} });

const router = require('./imageGeneration');
// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../../core/http/terminalErrorHandler');

function dispatch(body) {
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST', url: '/chat/generate-image', originalUrl: '/chat/generate-image',
            query: {}, headers: {}, body,
            session: { isAuthenticated: true, user: { id: 'u1' } },
            get(name) { return this.headers[String(name).toLowerCase()]; },
        };
        const res = {
            statusCode: 200, body: undefined, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
            setHeader() {},
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error('fell through router'));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test('a prompt produces an image through the Google adapter', async () => {
    const res = await dispatch({ prompt: 'a bee on a flower', aspectRatio: '16:9' });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.imageBase64, 'aW1n');
    assert.strictEqual(res.body.mimeType, 'image/png');
    assert.deepStrictEqual(calls, [{ apiKey: 'google-key', prompt: 'a bee on a flower', options: { aspectRatio: '16:9' } }]);
});

test('a missing prompt is a 400, not a call', async () => {
    calls.length = 0;
    const res = await dispatch({});
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(calls.length, 0);
});
