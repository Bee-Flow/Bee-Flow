/**
 * What POST /chat/generate-image accepts (routes/ai/directChat/imageGeneration.js).
 *
 * A prompt that was not text reached `prompt.substring` and was a 500; an
 * aspect ratio like '16x9' went to Google, whose refusal surfaced as a 500
 * too; a misspelled key was ignored. The ratio is checked for its shape, not
 * against a list — Google decides which ratios a model draws.
 *
 * Run: cd server && node --test routes/ai/directChat/imageGeneration.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// Every adapter call lands in `calls`. A refused request must leave it empty.
const calls = [];
stub('../../../stores/configStore', { getSecret: async () => 'google-key' });
stub('../../../core/providers', {
    googleAdapter: {
        async generateImage(apiKey, prompt, options) {
            calls.push({ prompt, options });
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
    const url = '/chat/generate-image';
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST', url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: { isAuthenticated: true, user: { id: 'u1' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error('fell through'));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { calls.length = 0; });

test('a prompt that is not text is a 400 naming it, not a 500 from .substring', async () => {
    const res = await dispatch({ prompt: { text: 'a bee' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Prompt is required');
    assert.ok(res.body.details.some((d) => d.path === 'body.prompt'));
    assert.deepStrictEqual(calls, []);
});

test('an aspect ratio that is not width:height is refused before it reaches Google', async () => {
    const res = await dispatch({ prompt: 'a bee', aspectRatio: '16x9' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, "aspectRatio is width:height, like '1:1' or '16:9'.");
    assert.deepStrictEqual(calls, []);
});

test('a misspelled key is refused rather than ignored', async () => {
    const res = await dispatch({ prompt: 'a bee', aspect_ratio: '16:9' });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(calls, []);
});

test('an empty ratio still means the square default', async () => {
    const res = await dispatch({ prompt: 'a bee', aspectRatio: '' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(calls, [{ prompt: 'a bee', options: { aspectRatio: '1:1' } }]);
});

test('a ratio the model may support is passed through for Google to decide', async () => {
    const res = await dispatch({ prompt: 'a bee', aspectRatio: '21:9', conversationId: 'c1' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(calls[0].options, { aspectRatio: '21:9' });
    assert.strictEqual(res.body.conversationId, 'c1');
});
