/**
 * Gemini-API video generation downloads to a temp path and removes it: the
 * caller stores the bytes, so nothing may stay behind on disk.
 * Run: node --test core/providers/google.video.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const GoogleProvider = require('./google');

function providerWith(response, download) {
    const p = new GoogleProvider();
    p.createClient = () => ({
        models: { generateVideos: async () => ({ done: true, response }) },
        files: { download },
    });
    return p;
}

test('the download is read back and the file removed, outside the served uploads folder', async () => {
    let seen = null;
    const p = providerWith(
        { generatedVideos: [{ video: { uri: 'https://x/v.mp4' } }] },
        async ({ downloadPath }) => { seen = downloadPath; await fs.promises.writeFile(downloadPath, 'VIDEO-BYTES'); },
    );
    const out = await p.generateVideo('key', 'a bee');
    assert.strictEqual(out.videoBase64, Buffer.from('VIDEO-BYTES').toString('base64'));
    assert.ok(!fs.existsSync(seen), 'downloaded file removed');
    assert.ok(!seen.includes(path.join('data', 'uploads')), 'not written into the served uploads folder');
});

test('a failed download removes its temp dir too', async () => {
    let seen = null;
    const p = providerWith(
        { generatedVideos: [{ video: { uri: 'https://x/v.mp4' } }] },
        async ({ downloadPath }) => { seen = downloadPath; throw new Error('net'); },
    );
    await assert.rejects(() => p.generateVideo('key', 'a bee'), /net/);
    assert.ok(!fs.existsSync(path.dirname(seen)));
});

test('no generated video gives videoBase64 null', async () => {
    const out = await providerWith({ generatedVideos: [] }, async () => {}).generateVideo('key', 'x');
    assert.strictEqual(out.videoBase64, null);
});
