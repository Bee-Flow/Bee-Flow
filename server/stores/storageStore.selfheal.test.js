/**
 * Storage Store — availability must recover on its own.
 *
 * The incident this pins: `init()` ran once at boot, fire-and-forget. If RustFS
 * was not up yet (compose has no `depends_on: rustfs`; pod start order in k8s is
 * arbitrary) the non-404 HeadBucket branch set `s3 = null` and never assigned
 * `mode`, so `isAvailable()` returned false for that process's ENTIRE life.
 * Every meeting note that pod created got a NULL `audio_storage_key` — no
 * durable copy — and since the server Deployment has no persistent volume, the
 * recording died with the pod. "Saved audio not found. Cannot reprocess."
 *
 * Stubs @aws-sdk/client-s3 via the require-cache BEFORE storageStore loads
 * (it requires the SDK at module top), so no network and no RustFS.
 *
 * Run: cd server && node --test stores/storageStore.selfheal.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

// ── SDK stub, installed before the store is required ─────────────────────────
const calls = { head: 0, create: 0 };
let headBehaviour = 'ok'; // 'ok' | 'notfound' | 'error'

class FakeCmd { constructor(input) { this.input = input; } }
class HeadBucketCommand extends FakeCmd {}
class CreateBucketCommand extends FakeCmd {}

function sdkError(name, status) {
    const e = new Error(`${name} (${status})`);
    e.name = name;
    e.$metadata = { httpStatusCode: status };
    return e;
}

const sdkPath = require.resolve('@aws-sdk/client-s3');
require.cache[sdkPath] = {
    id: sdkPath, filename: sdkPath, loaded: true,
    exports: {
        S3Client: class {
            async send(cmd) {
                if (cmd instanceof HeadBucketCommand) {
                    calls.head++;
                    if (headBehaviour === 'notfound') throw sdkError('NotFound', 404);
                    if (headBehaviour === 'error') throw sdkError('InternalError', 500);
                    return {};
                }
                if (cmd instanceof CreateBucketCommand) { calls.create++; return {}; }
                return {};
            }
        },
        HeadBucketCommand, CreateBucketCommand,
        PutObjectCommand: FakeCmd, GetObjectCommand: FakeCmd,
        DeleteObjectCommand: FakeCmd, HeadObjectCommand: FakeCmd,
    },
};
// The presigner is only used by getPresignedUrl; stub it so requiring the store
// never reaches for real AWS code.
const presignPath = require.resolve('@aws-sdk/s3-request-presigner');
require.cache[presignPath] = {
    id: presignPath, filename: presignPath, loaded: true,
    exports: { getSignedUrl: async () => 'https://example.invalid/signed' },
};

process.env.RUSTFS_ENDPOINT = 'http://rustfs.invalid:9000';
process.env.RUSTFS_ACCESS_KEY = 'test-access';
process.env.RUSTFS_SECRET_KEY = 'test-secret';

const store = require('./storageStore');

test('a RustFS outage at boot leaves storage unavailable — and NOT silently local', async () => {
    headBehaviour = 'error';
    const ok = await store.init();

    assert.strictEqual(ok, false);
    assert.strictEqual(store.isAvailable(), false);

    const status = store.getStatus();
    // `configured: true` is the whole point — it is what marks this failure as
    // retryable rather than "this install has no object storage".
    assert.strictEqual(status.configured, true);
    assert.strictEqual(status.mode, null);
    assert.ok(status.lastError, 'the reason is retained for the UI');
    assert.ok(status.nextRetryAt > Date.now(), 'a retry is scheduled');

    // The critical non-regression: it must NOT fall back to local mode. On prod
    // `localRoot` is the same volume-less container disk that already holds
    // audio_path, so a local key would be a real-looking pointer at storage that
    // dies with the pod — turning a repairable NULL into an unrepairable lie.
    assert.notStrictEqual(status.mode, 'local');
});

test('ensureAvailable() reconnects once RustFS comes back — no restart needed', async () => {
    headBehaviour = 'error';
    await store.init();
    assert.strictEqual(store.isAvailable(), false);

    // Backoff window: an immediate second call must not hammer the endpoint.
    const headsAfterInit = calls.head;
    assert.strictEqual(await store.ensureAvailable(), false);
    assert.strictEqual(calls.head, headsAfterInit, 'suppressed by the backoff window');

    // RustFS comes back. Fast-forward past the window the only way the module
    // exposes: it reads Date.now(), so wait out the 5s minimum via a stub.
    headBehaviour = 'ok';
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    try {
        assert.strictEqual(await store.ensureAvailable(), true);
    } finally {
        Date.now = realNow;
    }

    assert.strictEqual(store.isAvailable(), true, 'recovered without a process restart');
    const status = store.getStatus();
    assert.strictEqual(status.mode, 's3');
    assert.strictEqual(status.lastError, null, 'the retry state is cleared on success');
    assert.strictEqual(status.nextRetryAt, 0);
});

test('a 404 on the bucket still creates it', async () => {
    headBehaviour = 'notfound';
    const before = calls.create;
    const ok = await store.init();
    assert.strictEqual(ok, true);
    assert.strictEqual(calls.create, before + 1);
    assert.strictEqual(store.getStatus().mode, 's3');
});

test('concurrent ensureAvailable() calls issue a single connect attempt', async () => {
    headBehaviour = 'error';
    await store.init();

    headBehaviour = 'ok';
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    const before = calls.head;
    try {
        const results = await Promise.all([
            store.ensureAvailable(), store.ensureAvailable(), store.ensureAvailable(),
        ]);
        assert.deepStrictEqual(results, [true, true, true]);
    } finally {
        Date.now = realNow;
    }
    assert.strictEqual(calls.head - before, 1, 'three callers, one HeadBucket');
});
