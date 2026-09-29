/**
 * Tests for core/imageInline.js — turning our own signed storage URLs into
 * inline base64 before a prompt leaves for a provider.
 *
 * Run: node --test core/imageInline.test.js
 *
 * storageStore is mocked through the require cache; utils/tempDownloadUrl is the
 * REAL module, so the signature/expiry verification is genuinely exercised
 * (that check is the authorization boundary for reading straight from storage).
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

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
const reads = [];
let storage = {
    isAvailable: () => true,
    streamFile: async (key) => {
        reads.push(key);
        return { stream: Readable.from([PNG_BYTES]), contentType: 'image/png', contentLength: PNG_BYTES.length };
    },
};
mock('../../stores/storageStore', {
    isAvailable: (...a) => storage.isAvailable(...a),
    streamFile: (...a) => storage.streamFile(...a),
});

const { generateTempDownloadUrl } = require('../../utils/tempDownloadUrl');
const { inlineInternalImages, PLACEHOLDER } = require('./imageInline');

const KEY = 'users/u1/uploads/screenshot.png';
const EXPECTED_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;

function imageMessage(url, extra = {}) {
    return {
        role: 'user',
        content: [
            { type: 'text', text: 'wat staat hier in' },
            { type: 'image_url', image_url: { url, detail: 'auto' }, ...extra },
        ],
    };
}

test('signed storage URL is replaced by inline base64, input left untouched', async () => {
    reads.length = 0;
    const messages = [imageMessage(generateTempDownloadUrl(KEY, 900))];
    const originalUrl = messages[0].content[1].image_url.url;

    const out = await inlineInternalImages(messages);

    assert.notStrictEqual(out, messages, 'returns a copy');
    assert.strictEqual(out[0].content[1].image_url.url, EXPECTED_DATA_URL);
    assert.strictEqual(out[0].content[1].image_url.detail, 'auto', 'detail preserved');
    assert.strictEqual(out[0].content[0].text, 'wat staat hier in', 'other blocks untouched');
    assert.strictEqual(messages[0].content[1].image_url.url, originalUrl, 'caller history not mutated');
    assert.deepStrictEqual(reads, [KEY]);
});

test('cache_control on the block survives inlining', async () => {
    const messages = [imageMessage(generateTempDownloadUrl(KEY, 900), { cache_control: { type: 'ephemeral' } })];
    const out = await inlineInternalImages(messages);
    assert.deepStrictEqual(out[0].content[1].cache_control, { type: 'ephemeral' });
});

test('unsigned / tampered / expired storage URLs are refused, never read', async () => {
    const good = generateTempDownloadUrl(KEY, 900);
    const urls = [
        // Forged: right shape, no valid signature.
        'https://beeflow.nl/api/storage/tmp/deadbeef?key=users/victim/uploads/secret.png&expires=99999999999',
        // Someone else's key swapped into a validly-signed URL.
        good.replace(encodeURIComponent(KEY), encodeURIComponent('users/victim/uploads/secret.png')),
        // Genuinely signed, but already expired.
        generateTempDownloadUrl(KEY, -10),
    ];
    for (const url of urls) {
        reads.length = 0;
        const out = await inlineInternalImages([imageMessage(url)]);
        assert.deepStrictEqual(out[0].content[1], { type: 'text', text: PLACEHOLDER }, `must refuse: ${url}`);
        assert.deepStrictEqual(reads, [], 'no storage read for a bad signature');
    }
});

test('external image URLs are passed through untouched', async () => {
    reads.length = 0;
    const messages = [imageMessage('https://example.com/cat.png')];
    const out = await inlineInternalImages(messages);
    assert.strictEqual(out, messages, 'no copy when nothing internal');
    assert.strictEqual(out[0].content[1].image_url.url, 'https://example.com/cat.png');
    assert.deepStrictEqual(reads, []);
});

test('the same image across turns is read once', async () => {
    reads.length = 0;
    const url = generateTempDownloadUrl(KEY, 900);
    const out = await inlineInternalImages([
        imageMessage(url),
        { role: 'assistant', content: 'ok' },
        imageMessage(generateTempDownloadUrl(KEY, 900)), // different signature, same object
    ]);
    assert.deepStrictEqual(reads, [KEY], 'one read for both turns');
    assert.strictEqual(out[0].content[1].image_url.url, EXPECTED_DATA_URL);
    assert.strictEqual(out[2].content[1].image_url.url, EXPECTED_DATA_URL);
    assert.strictEqual(out[1].content, 'ok', 'string content left alone');
});

test('unreadable / unsupported / oversized objects degrade to a text placeholder', async () => {
    const saved = storage;
    const cases = [
        { name: 'storage down', s: { isAvailable: () => false, streamFile: async () => { throw new Error('unused'); } } },
        { name: 'missing object', s: { isAvailable: () => true, streamFile: async () => { const e = new Error('nope'); e.name = 'NoSuchKey'; throw e; } } },
        {
            // A concrete non-image type is refused even though the key ends in
            // .png — the stored type is the authority, not the filename.
            name: 'unsupported type',
            s: {
                isAvailable: () => true,
                streamFile: async () => ({ stream: Readable.from([PNG_BYTES]), contentType: 'application/pdf', contentLength: 10 }),
            },
        },
        {
            name: 'unsupported image type',
            s: {
                isAvailable: () => true,
                streamFile: async () => ({ stream: Readable.from([PNG_BYTES]), contentType: 'image/svg+xml', contentLength: 10 }),
            },
        },
        {
            name: 'oversized',
            s: {
                isAvailable: () => true,
                streamFile: async () => ({ stream: Readable.from([PNG_BYTES]), contentType: 'image/png', contentLength: 40 * 1024 * 1024 }),
            },
        },
    ];
    try {
        for (const c of cases) {
            storage = c.s;
            const out = await inlineInternalImages([imageMessage(generateTempDownloadUrl(KEY, 900))]);
            assert.deepStrictEqual(out[0].content[1], { type: 'text', text: PLACEHOLDER }, c.name);
            assert.strictEqual(out[0].content[0].text, 'wat staat hier in', `${c.name}: text block kept`);
        }
    } finally {
        storage = saved;
    }
});

test('media type falls back to the key extension when Content-Type is generic', async () => {
    const saved = storage;
    storage = {
        isAvailable: () => true,
        streamFile: async () => ({ stream: Readable.from([PNG_BYTES]), contentType: 'application/octet-stream', contentLength: PNG_BYTES.length }),
    };
    try {
        const url = generateTempDownloadUrl('users/u1/uploads/photo.JPG', 900);
        const out = await inlineInternalImages([imageMessage(url)]);
        assert.ok(out[0].content[1].image_url.url.startsWith('data:image/jpeg;base64,'));
    } finally {
        storage = saved;
    }
});

test('non-array content and non-array input are safe', async () => {
    assert.strictEqual(await inlineInternalImages(null), null);
    const messages = [{ role: 'user', content: 'plain text' }];
    assert.strictEqual(await inlineInternalImages(messages), messages);
});
