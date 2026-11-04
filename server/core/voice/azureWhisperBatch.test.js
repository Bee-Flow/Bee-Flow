// @typecheck
/**
 * Azure Whisper batch: concurrent jobs never share a temp file or object.
 *
 * Several meeting uploads run this in ONE process at the same time. The temp
 * input file and the RustFS object were named from Date.now() alone, so two
 * jobs in the same millisecond shared both: the later write won, one note was
 * transcribed from the other user's audio, and the first job's cleanup deleted
 * the file the second still needed.
 *
 * The collaborators (config, object storage, ffmpeg conditioning, temp URL)
 * are stubbed; the run stops at the Azure model listing, right after upload.
 *
 * Run: cd server && node --test core/voice/azureWhisperBatch.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeSwaps } = require('../../testUtils/swaps');

// utils/tempDownloadUrl refuses to load without its HMAC key; its URL maker is swapped below.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'azure-whisper-test-session-secret-0123456789';

// The real modules, their functions swapped (azureWhisperBatch reads them
// through the module object at call time).
const swaps = makeSwaps();
/**
 * @param {string} request
 * @param {Record<string, unknown>} fns
 */
function stubModule(request, fns) {
    const mod = require(request);
    for (const [name, fn] of Object.entries(fns)) swaps.swap(mod, name, fn);
}
test.after(() => swaps.restore());

/** @type {Array<{ key: string, body: string }>} */
const uploads = [];
/** @type {string[]} */
const deletes = [];
/** @type {Array<{ input: string, read: string }>} */
const preprocessed = [];

stubModule('../../stores/configStore', {
    getSecret: async () => 'test-speech-key',
    getConfig: async () => 'westeurope',
});
stubModule('../../stores/storageStore', {
    isAvailable: () => true,
    uploadFile: async (/** @type {string} */ key, /** @type {Buffer} */ body) => { uploads.push({ key, body: body.toString() }); },
    deleteFile: async (/** @type {string} */ key) => { deletes.push(key); },
});
stubModule('../../utils/tempDownloadUrl', {
    generateTempDownloadUrl: (/** @type {string} */ key) => `https://beeflow.example.com/tmp/${key}`,
});
stubModule('./audioPreprocess', {
    // Like ffmpeg: start up for a moment, then read the input and write the output.
    preprocessForStt: async (/** @type {string} */ input) => {
        await new Promise((r) => setTimeout(r, 20));
        const read = fs.readFileSync(input, 'utf8');
        preprocessed.push({ input, read });
        const out = path.join(os.tmpdir(), `azwhi-test-out-${process.pid}-${preprocessed.length}.flac`);
        fs.writeFileSync(out, read);
        return { path: out, preprocessed: true, cleanup: () => fs.unlinkSync(out) };
    },
});

const { runAzureWhisperBatch } = require('./azureWhisperBatch');

const realFetch = globalThis.fetch;
const realNow = Date.now;
const realHost = process.env.SERVER_PUBLIC_HOST;

test.beforeEach(() => {
    uploads.length = 0;
    deletes.length = 0;
    preprocessed.length = 0;
    process.env.SERVER_PUBLIC_HOST = 'beeflow.example.com';
    // Stop each run right after the upload: the model listing fails.
    globalThis.fetch = /** @type {typeof fetch} */ (async () => /** @type {Response} */ (/** @type {unknown} */ ({ ok: false, status: 503 })));
});
test.afterEach(() => {
    globalThis.fetch = realFetch;
    Date.now = realNow;
    if (realHost === undefined) delete process.env.SERVER_PUBLIC_HOST;
    else process.env.SERVER_PUBLIC_HOST = realHost;
});

test('two jobs in the same millisecond each transcode and upload their own audio', async () => {
    const frozen = realNow();
    Date.now = () => frozen;

    const results = await Promise.allSettled([
        runAzureWhisperBatch({ audioData: Buffer.from('AUDIO-OF-USER-A'), fileName: 'recording.webm' }),
        runAzureWhisperBatch({ audioData: Buffer.from('AUDIO-OF-USER-B'), fileName: 'recording.webm' }),
    ]);

    for (const r of results) {
        assert.strictEqual(r.status, 'rejected');
        assert.match(String(/** @type {PromiseRejectedResult} */ (r).reason?.message), /Failed to list Azure models/);
    }
    assert.notStrictEqual(preprocessed[0].input, preprocessed[1].input, 'temp input files must differ');
    assert.deepStrictEqual(preprocessed.map((p) => p.read).sort(), ['AUDIO-OF-USER-A', 'AUDIO-OF-USER-B']);
    assert.strictEqual(uploads.length, 2);
    assert.notStrictEqual(uploads[0].key, uploads[1].key, 'object keys must differ');
    assert.deepStrictEqual(uploads.map((u) => u.body).sort(), ['AUDIO-OF-USER-A', 'AUDIO-OF-USER-B']);
    assert.deepStrictEqual([...deletes].sort(), uploads.map((u) => u.key).sort());
    for (const p of preprocessed) assert.strictEqual(fs.existsSync(p.input), false, 'temp input is cleaned up');
});

test('a file on disk goes to ffmpeg as it is and is left for its owner', async () => {
    const src = path.join(os.tmpdir(), `azwhi-test-src-${process.pid}.webm`);
    fs.writeFileSync(src, 'AUDIO-ON-DISK');
    try {
        await assert.rejects(runAzureWhisperBatch({ filePath: src, fileName: 'recording.webm' }), /Failed to list Azure models/);
        assert.deepStrictEqual(preprocessed, [{ input: src, read: 'AUDIO-ON-DISK' }]);
        assert.strictEqual(fs.existsSync(src), true, 'the caller owns its upload file');
    } finally {
        fs.unlinkSync(src);
    }
});
