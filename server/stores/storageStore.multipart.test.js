/**
 * Storage Store — multipart upload contract (local mode).
 *
 * The dataset upload path streams multi-GB files in bounded parts; any replica
 * may upload any part or complete the upload, so the whole protocol state lives
 * with the caller (uploadId + part etags), not in process memory. These tests
 * pin the local-mode implementation to the same contract S3 mode gets from the
 * SDK: 1-based part numbers, order-independent `parts` on complete, missing
 * parts refused, abort discards everything.
 *
 * Runs in LOCAL mode (RUSTFS_* env cleared before the store loads) under a
 * unique key prefix that is removed afterwards.
 *
 * Run: cd server && node --test stores/storageStore.multipart.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

delete process.env.RUSTFS_ENDPOINT;
delete process.env.RUSTFS_ACCESS_KEY;
delete process.env.RUSTFS_SECRET_KEY;

const store = require('./storageStore');

const RUN_PREFIX = `tests/mpu-${process.pid}-${Date.now()}`;
const LOCAL_ROOT = path.resolve(__dirname, '..', 'data', 'storage');

test.before(async () => {
    assert.strictEqual(await store.init(), true);
    assert.strictEqual(store.getStatus().mode, 'local');
});

test.after(() => {
    fs.rmSync(path.join(LOCAL_ROOT, 'tests'), { recursive: true, force: true });
});

async function readAll(stream) {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
}

test('round trip: begin → parts → complete assembles in partNumber order', async () => {
    const key = `${RUN_PREFIX}/roundtrip.bin`;
    const { uploadId } = await store.beginMultipartUpload(key, 'application/gzip');

    const p1 = Buffer.from('first-');
    const p2 = Buffer.from('second-');
    const p3 = Buffer.from('third');
    const e1 = await store.uploadPartBuffer(key, uploadId, 1, p1);
    const e2 = await store.uploadPartBuffer(key, uploadId, 2, p2);
    const e3 = await store.uploadPartBuffer(key, uploadId, 3, p3);
    for (const e of [e1, e2, e3]) assert.match(e.etag, /^[0-9a-f]{32}$/, 'md5-shaped etag');

    // Deliberately shuffled: complete() must order by partNumber, not array order.
    await store.completeMultipartUpload(key, uploadId, [
        { partNumber: 3, etag: e3.etag },
        { partNumber: 1, etag: e1.etag },
        { partNumber: 2, etag: e2.etag },
    ]);

    const out = await store.streamFile(key);
    assert.strictEqual((await readAll(out.stream)).toString(), 'first-second-third');
    assert.strictEqual(out.contentType, 'application/gzip', 'content type from begin survives to complete');

    // The staging dir is gone once assembled.
    const partDirs = fs.readdirSync(path.dirname(path.join(LOCAL_ROOT, key))).filter((n) => n.includes('.mpu-'));
    assert.deepStrictEqual(partDirs, []);
});

test('complete refuses when a part is missing', async () => {
    const key = `${RUN_PREFIX}/missing.bin`;
    const { uploadId } = await store.beginMultipartUpload(key);
    const { etag } = await store.uploadPartBuffer(key, uploadId, 1, Buffer.from('only'));
    await assert.rejects(
        store.completeMultipartUpload(key, uploadId, [{ partNumber: 1, etag }, { partNumber: 2, etag: 'x' }]),
        /missing part 2/,
    );
});

test('abort discards parts; further part uploads are refused', async () => {
    const key = `${RUN_PREFIX}/aborted.bin`;
    const { uploadId } = await store.beginMultipartUpload(key);
    await store.uploadPartBuffer(key, uploadId, 1, Buffer.from('gone'));
    await store.abortMultipartUpload(key, uploadId);
    await assert.rejects(store.uploadPartBuffer(key, uploadId, 2, Buffer.from('late')), /unknown uploadId/);
    // Abort is idempotent — a second abort (or an abort for a never-begun id) is quiet.
    await store.abortMultipartUpload(key, uploadId);
    await store.abortMultipartUpload(key, 'deadbeefdeadbeefdeadbeefdeadbeef');
});

test('part numbers are 1-based and bounded', async () => {
    const key = `${RUN_PREFIX}/bounds.bin`;
    const { uploadId } = await store.beginMultipartUpload(key);
    await assert.rejects(store.uploadPartBuffer(key, uploadId, 0, Buffer.from('x')), /1\.\.10000/);
    await assert.rejects(store.uploadPartBuffer(key, uploadId, 10001, Buffer.from('x')), /1\.\.10000/);
    await assert.rejects(store.uploadPartBuffer(key, uploadId, 1.5, Buffer.from('x')), /1\.\.10000/);
    await store.abortMultipartUpload(key, uploadId);
});

test('buildStudioAppDatasetKey: artifact vocabulary is closed', () => {
    assert.strictEqual(
        store.buildStudioAppDatasetKey('u1', 'a1', 'd1', 'raw'),
        'studio-apps/u1/a1/datasets/d1/raw',
    );
    assert.strictEqual(
        store.buildStudioAppDatasetKey('u1', 'a1', 'd1', 'data.bgz'),
        'studio-apps/u1/a1/datasets/d1/data.bgz',
    );
    assert.strictEqual(
        store.buildStudioAppDatasetKey('u1', 'a1', 'd1', 'rsid/07.bin'),
        'studio-apps/u1/a1/datasets/d1/rsid/07.bin',
    );
    assert.throws(() => store.buildStudioAppDatasetKey('u1', 'a1', 'd1', '../escape'), /unknown artifact/);
    assert.throws(() => store.buildStudioAppDatasetKey('u1', 'a1', 'd1', 'rsid/99.bin'), /unknown artifact/);
    assert.throws(() => store.buildStudioAppDatasetKey('u1', 'a1', 'd1', ''), /requires/);
});
