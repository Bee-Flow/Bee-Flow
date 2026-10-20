/**
 * Storage Store, uploadFileFromPath in S3 mode: a recording goes up from disk
 * in bounded parts, never as one whole-file Buffer. Small files take a single
 * PutObject; a failed part aborts the multipart upload.
 *
 * Stubs @aws-sdk/client-s3 through the require cache before the store loads.
 *
 * Run: cd server && node --test stores/storageStore.fromPath.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sent = [];
let failPart = 0;

class Cmd { constructor(input) { this.input = input; this.type = this.constructor.name; } }
const names = ['HeadBucketCommand', 'CreateBucketCommand', 'PutObjectCommand', 'GetObjectCommand',
    'DeleteObjectCommand', 'HeadObjectCommand', 'CreateMultipartUploadCommand', 'UploadPartCommand',
    'CompleteMultipartUploadCommand', 'AbortMultipartUploadCommand'];
const classes = Object.fromEntries(names.map((n) => [n, ({ [n]: class extends Cmd {} })[n]]));

const sdkPath = require.resolve('@aws-sdk/client-s3');
require.cache[sdkPath] = {
    id: sdkPath, filename: sdkPath, loaded: true,
    exports: {
        S3Client: class {
            async send(cmd) {
                const i = cmd.input;
                // Snapshot the body: the store reuses one buffer across parts.
                sent.push({ type: cmd.type, ...i, Body: Buffer.isBuffer(i.Body) ? Buffer.from(i.Body) : i.Body });
                if (cmd.type === 'CreateMultipartUploadCommand') return { UploadId: 'u1' };
                if (cmd.type === 'UploadPartCommand') {
                    if (failPart && i.PartNumber === failPart) throw new Error('part failed');
                    return { ETag: `etag-${i.PartNumber}` };
                }
                return {};
            }
        },
        ...classes,
    },
};
const presignPath = require.resolve('@aws-sdk/s3-request-presigner');
require.cache[presignPath] = { id: presignPath, filename: presignPath, loaded: true, exports: { getSignedUrl: async () => 'x' } };

process.env.RUSTFS_ENDPOINT = 'http://rustfs.invalid:9000';
process.env.RUSTFS_ACCESS_KEY = 'a';
process.env.RUSTFS_SECRET_KEY = 'b';

const store = require('./storageStore');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frompath-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
test.beforeEach(() => { sent.length = 0; failPart = 0; });

test.before(async () => { assert.strictEqual(await store.init(), true); sent.length = 0; });

test('a small file is one PutObject with the right body and content type', async () => {
    const f = path.join(tmp, 'small.webm');
    fs.writeFileSync(f, 'tiny-audio');
    await store.uploadFileFromPath('saved-recordings/small.webm', f, 'audio/webm');
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].type, 'PutObjectCommand');
    assert.strictEqual(sent[0].ContentType, 'audio/webm');
    assert.strictEqual(sent[0].Body.toString(), 'tiny-audio');
});

test('a large file goes up as 16 MB parts that reassemble to the original bytes', async () => {
    const f = path.join(tmp, 'big.bin');
    const size = 16 * 1024 * 1024 * 2 + 12345;
    const data = Buffer.alloc(size);
    for (let i = 0; i < size; i += 4096) data[i] = (i / 4096) % 251;
    fs.writeFileSync(f, data);
    await store.uploadFileFromPath('saved-recordings/big.bin', f, 'audio/mpeg');
    const types = sent.map((c) => c.type);
    assert.deepStrictEqual(types, ['CreateMultipartUploadCommand', 'UploadPartCommand', 'UploadPartCommand', 'UploadPartCommand', 'CompleteMultipartUploadCommand']);
    assert.strictEqual(sent[0].ContentType, 'audio/mpeg');
    const joined = Buffer.concat(sent.filter((c) => c.type === 'UploadPartCommand').map((c) => c.Body));
    assert.ok(joined.equals(data));
    assert.deepStrictEqual(sent[4].MultipartUpload.Parts.map((p) => p.PartNumber), [1, 2, 3]);
});

test('a failing part aborts the multipart upload and rejects', async () => {
    const f = path.join(tmp, 'big2.bin');
    fs.writeFileSync(f, Buffer.alloc(17 * 1024 * 1024, 1));
    failPart = 2;
    await assert.rejects(store.uploadFileFromPath('saved-recordings/big2.bin', f, 'audio/mpeg'), /part failed/);
    assert.strictEqual(sent.at(-1).type, 'AbortMultipartUploadCommand');
    assert.ok(!sent.some((c) => c.type === 'CompleteMultipartUploadCommand'));
});
