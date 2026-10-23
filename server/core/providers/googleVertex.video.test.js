/**
 * Vertex video generation reads the SDK's `generatedVideos` (it read the
 * non-existent `generatedSamples`, so it always answered "no video") and, for a
 * storage URI, downloads to a path (files.download returns nothing).
 *
 * Run: node --test core/providers/googleVertex.video.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const GoogleVertexProvider = require('./googleVertex');

function providerWith(response, download) {
    const p = new GoogleVertexProvider();
    p.createClient = () => ({
        models: { generateVideos: async () => ({ done: true, response }) },
        files: { download },
    });
    return p;
}

test('inline videoBytes from generatedVideos are returned as the video', async () => {
    const p = providerWith(
        { generatedVideos: [{ video: { videoBytes: 'QUJD', mimeType: 'video/mp4' } }] },
        async () => { throw new Error('must not download'); },
    );
    const out = await p.generateVideo('key', 'a bee');
    assert.deepStrictEqual(out, { videoBase64: 'QUJD', mimeType: 'video/mp4' });
});

test('a storage URI is downloaded to a path, read back and the temp file removed', async () => {
    let seen = null;
    const p = providerWith(
        { generatedVideos: [{ video: { uri: 'gs://b/v.mp4' } }] },
        async ({ file, downloadPath }) => {
            seen = { file, downloadPath };
            await fs.promises.writeFile(downloadPath, 'VIDEO-BYTES');
        },
    );
    const out = await p.generateVideo('key', 'a bee');
    assert.strictEqual(out.videoBase64, Buffer.from('VIDEO-BYTES').toString('base64'));
    assert.deepStrictEqual(seen.file, { uri: 'gs://b/v.mp4' });
    assert.ok(seen.downloadPath, 'downloadPath passed');
    assert.ok(!fs.existsSync(seen.downloadPath), 'temp file removed');
});

test('no generated video gives videoBase64 null', async () => {
    const out = await providerWith({ generatedVideos: [] }, async () => {}).generateVideo('key', 'x');
    assert.strictEqual(out.videoBase64, null);
});
