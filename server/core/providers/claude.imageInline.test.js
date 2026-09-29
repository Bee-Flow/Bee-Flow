/**
 * Regression test — uploaded screenshots must reach Anthropic as bytes.
 *
 * Run: node --test core/providers/claude.imageInline.test.js
 *
 * Sending `source: {type:'url'}` for an image hosted on our own origin made
 * Anthropic fetch it, and its fetcher honours robots.txt — ours carries
 * `Disallow: /api/`, so every screenshot upload failed the WHOLE request with
 * 400 "This URL is disallowed by the website's robots.txt file". Images we host
 * are therefore inlined (core/imageInline.js) before normalization; third-party
 * URLs still go as url-source blocks.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const { Readable } = require('stream');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'unit-test-session-secret-0123456789abcdef';

function mock(id, exports) {
    const p = require.resolve(id);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
mock('../../stores/storageStore', {
    isAvailable: () => true,
    streamFile: async () => ({ stream: Readable.from([PNG_BYTES]), contentType: 'image/png', contentLength: PNG_BYTES.length }),
});

const { generateTempDownloadUrl } = require('../../utils/tempDownloadUrl');
const ClaudeProvider = require('./claude');

const KEY = 'users/u1/uploads/upload_1_abcd.png';

function providerCapturing(captured) {
    const p = new ClaudeProvider();
    p._resolveAuth = async () => ({ token: 'sk-test', oauth: false });
    p.createClient = () => ({
        messages: {
            create: async (params) => {
                captured.params = params;
                return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} };
            },
            stream: async (params) => {
                captured.params = params;
                return (async function* () { /* no events — we only inspect params */ })();
            },
        },
    });
    return p;
}

function pastedScreenshot(url) {
    return [{
        role: 'user',
        content: [
            { type: 'text', text: 'wat staat hier in' },
            { type: 'image_url', image_url: { url, detail: 'auto' }, cache_control: { type: 'ephemeral' } },
        ],
    }];
}

test('chat(): our own signed storage URL becomes a base64 image block', async () => {
    const captured = {};
    const messages = pastedScreenshot(generateTempDownloadUrl(KEY, 900));
    await providerCapturing(captured).chat('sk-test', '', 'claude-opus-5', messages);

    const img = captured.params.messages[0].content[1];
    assert.strictEqual(img.type, 'image');
    assert.strictEqual(img.source.type, 'base64', 'must NOT be a url source — Anthropic 400s on robots.txt');
    assert.strictEqual(img.source.media_type, 'image/png');
    assert.strictEqual(img.source.data, PNG_BYTES.toString('base64'));
    assert.deepStrictEqual(img.cache_control, { type: 'ephemeral' }, 'cache breakpoint preserved');
    assert.ok(messages[0].content[1].image_url.url.includes('/api/storage/tmp/'), 'caller history not rewritten');
});

test('stream(): same treatment on the streaming path', async () => {
    const captured = {};
    await providerCapturing(captured).stream('sk-test', '', 'claude-opus-5', pastedScreenshot(generateTempDownloadUrl(KEY, 900)), {}, () => {});

    const img = captured.params.messages[0].content[1];
    assert.strictEqual(img.source.type, 'base64');
    assert.strictEqual(img.source.data, PNG_BYTES.toString('base64'));
});

test('third-party image URLs still ride as url-source blocks', async () => {
    const captured = {};
    await providerCapturing(captured).chat('sk-test', '', 'claude-opus-5', pastedScreenshot('https://example.com/cat.png'));

    const img = captured.params.messages[0].content[1];
    assert.strictEqual(img.type, 'image');
    assert.deepStrictEqual(img.source, { type: 'url', url: 'https://example.com/cat.png' });
});
