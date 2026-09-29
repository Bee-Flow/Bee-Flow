/**
 * Saved-audio durability: retry, failure taxonomy, local write-back.
 *
 * Every assertion here maps to a way a meeting recording used to be lost or
 * mis-served:
 *   - one failed upload → permanent NULL key → recording gone with the pod
 *   - `null` return conflated "storage is down" with "there is no storage"
 *   - a WebM recording served as audio/mpeg → the browser refuses to decode it
 *   - the write-back cache deleting the very file it just restored
 *
 * Deps stubbed via the require cache; no RustFS, no Postgres.
 *
 * Run: cd server && node --test core/meetingNotes/savedAudioStore.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const fx = {
    available: true,
    configured: true,
    objects: new Map(),   // key → Buffer
    uploadCalls: [],
    failUploadsUntilAttempt: 0,
    streamError: null,
};

stub('../../stores/storageStore', {
    isAvailable: () => fx.available,
    ensureAvailable: async () => fx.available,
    getStatus: () => ({ mode: fx.available ? 's3' : null, configured: fx.configured, lastError: null, nextRetryAt: 0 }),
    uploadFile: async (key, buffer, contentType) => {
        fx.uploadCalls.push({ key, contentType, size: buffer.length });
        if (fx.uploadCalls.length < fx.failUploadsUntilAttempt) throw new Error('rustfs transient');
        fx.objects.set(key, buffer);
        return { key };
    },
    streamFile: async (key) => {
        if (fx.streamError) throw fx.streamError;
        if (!fx.objects.has(key)) { const e = new Error('gone'); e.name = 'NoSuchKey'; throw e; }
        return { stream: Readable.from(fx.objects.get(key)), contentType: 'audio/webm', contentLength: fx.objects.get(key).length };
    },
});
stub('../../stores/transcriptionStore', { updateTranscription: async () => true });

const store = require('./savedAudioStore');
const SAVED_DIR = store.SAVED_RECORDINGS_DIR;

test.beforeEach(() => {
    fx.available = true;
    fx.configured = true;
    fx.objects.clear();
    fx.uploadCalls.length = 0;
    fx.failUploadsUntilAttempt = 0;
    fx.streamError = null;
});

const scratch = [];
function localFile(name, contents = 'local-audio-bytes') {
    fs.mkdirSync(SAVED_DIR, { recursive: true });
    const p = path.join(SAVED_DIR, name);
    fs.writeFileSync(p, contents);
    scratch.push(p);
    return p;
}
test.after(() => { for (const p of scratch) { try { fs.unlinkSync(p); } catch (_) {} } });

// ── persistSavedAudioToStorage ───────────────────────────────────────────────

test('a transient upload failure is retried rather than losing the durable copy', async () => {
    fx.failUploadsUntilAttempt = 2; // first attempt throws, second succeeds
    const res = await store.persistSavedAudioToStorage('saved-recordings/a.webm', Buffer.from('x'), '.webm');
    assert.deepStrictEqual({ ok: res.ok, reason: res.reason }, { ok: true, reason: 'stored' });
    assert.strictEqual(fx.uploadCalls.length, 2);
});

test('storage down reports "unavailable" — distinguishable from "not configured"', async () => {
    // The whole point: a bare `null` made a transient RustFS blip look identical
    // to an install that simply has no object storage, so nothing retried.
    fx.available = false;
    fx.configured = true;
    const down = await store.persistSavedAudioToStorage('saved-recordings/a.webm', Buffer.from('x'), '.webm');
    assert.deepStrictEqual({ ok: down.ok, reason: down.reason, key: down.key }, { ok: false, reason: 'unavailable', key: null });

    fx.configured = false;
    const unconfigured = await store.persistSavedAudioToStorage('saved-recordings/a.webm', Buffer.from('x'), '.webm');
    assert.strictEqual(unconfigured.reason, 'not_configured');
});

test('exhausted retries report "failed", never a phantom key', async () => {
    fx.failUploadsUntilAttempt = 99;
    const res = await store.persistSavedAudioToStorage('saved-recordings/a.webm', Buffer.from('x'), '.webm');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'failed');
    assert.strictEqual(res.key, null, 'a key we did not store must never be recorded');
    assert.strictEqual(fx.uploadCalls.length, 3);
});

test('a recording is uploaded with its real content type', async () => {
    await store.persistSavedAudioToStorage('saved-recordings/a.webm', Buffer.from('x'), '.webm');
    assert.strictEqual(fx.uploadCalls[0].contentType, 'audio/webm');
});

// ── contentTypeForAudio ──────────────────────────────────────────────────────

test('WebM is never labelled audio/mpeg', async () => {
    // The old `|| 'audio/mpeg'` default made every browser recording look like
    // an MP3 to the player, which then refused to decode it.
    assert.strictEqual(store.contentTypeForAudio('saved-recordings/x.webm'), 'audio/webm');
    assert.strictEqual(store.contentTypeForAudio('x.mp3'), 'audio/mpeg');
    assert.strictEqual(store.contentTypeForAudio('x.m4a'), 'audio/mp4');
    const unknown = store.contentTypeForAudio('x.bin');
    assert.strictEqual(unknown, 'application/octet-stream');
    assert.notStrictEqual(unknown, 'audio/mpeg');
});

test('a reported type is used only when the extension says nothing', async () => {
    assert.strictEqual(store.contentTypeForAudio('x.bin', 'audio/flac'), 'audio/flac');
    // Extension wins: the key's extension came from the real filename.
    assert.strictEqual(store.contentTypeForAudio('x.webm', 'application/octet-stream'), 'audio/webm');
});

// ── resolveSavedAudio ────────────────────────────────────────────────────────

test('a readable local file is used directly and storage is never touched', async () => {
    const p = localFile('resolve-local.webm');
    const res = await store.resolveSavedAudio({ audioPath: p, audioStorageKey: 'saved-recordings/resolve-local.webm' });
    assert.strictEqual(res.path, p);
    assert.strictEqual(res.fromStorage, false);
    assert.strictEqual(fx.uploadCalls.length, 0);
});

test('no local file and no key → never_durable (terminal)', async () => {
    const res = await store.resolveSavedAudio({ audioPath: '/nope/gone.webm', audioStorageKey: null });
    assert.strictEqual(res.path, null);
    assert.strictEqual(res.reason, 'never_durable');
});

test('a key with storage down → storage_unavailable (retryable, NOT gone)', async () => {
    fx.available = false;
    const res = await store.resolveSavedAudio({ audioPath: '/nope/gone.webm', audioStorageKey: 'saved-recordings/a.webm' });
    assert.strictEqual(res.path, null);
    assert.strictEqual(res.reason, 'storage_unavailable', 'must not be reported to the user as permanent loss');
});

test('a key whose object is missing → fetch_failed (terminal)', async () => {
    const res = await store.resolveSavedAudio({ audioPath: '/nope/gone.webm', audioStorageKey: 'saved-recordings/missing.webm' });
    assert.strictEqual(res.path, null);
    assert.strictEqual(res.reason, 'fetch_failed');
});

test('a fetched object is written back to the note\'s local slot, and cleanup() does NOT delete it', async () => {
    // 🔴 The trap: reprocess calls cleanup() unconditionally in its `finally`.
    // If cleanup unlinked the cached file, every reprocess would restore the
    // recording and then immediately destroy it again.
    const target = path.join(SAVED_DIR, 'writeback.webm');
    scratch.push(target);
    try { fs.unlinkSync(target); } catch (_) {}
    fx.objects.set('saved-recordings/writeback.webm', Buffer.from('durable-bytes'));

    const res = await store.resolveSavedAudio({ audioPath: target, audioStorageKey: 'saved-recordings/writeback.webm' });

    assert.strictEqual(res.path, target);
    assert.strictEqual(res.fromStorage, true);
    assert.strictEqual(res.cached, true);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'durable-bytes');

    res.cleanup();
    assert.ok(fs.existsSync(target), 'the restored local copy must survive cleanup()');
});

test('a fetch for a path outside the saved-recordings dir uses a temp file that cleanup() DOES delete', async () => {
    fx.objects.set('saved-recordings/tmp.webm', Buffer.from('durable-bytes'));
    const outside = path.join(os.tmpdir(), 'not-our-dir.webm');

    const res = await store.resolveSavedAudio({ audioPath: outside, audioStorageKey: 'saved-recordings/tmp.webm' });

    assert.strictEqual(res.cached, false);
    assert.notStrictEqual(res.path, outside);
    assert.ok(fs.existsSync(res.path));
    res.cleanup();
    assert.ok(!fs.existsSync(res.path), 'a temp file must not leak');
});

test('no .part leftovers after a failed fetch', async () => {
    const target = path.join(SAVED_DIR, 'failed-fetch.webm');
    fx.streamError = new Error('network reset');
    const res = await store.resolveSavedAudio({ audioPath: target, audioStorageKey: 'saved-recordings/failed-fetch.webm' });
    assert.strictEqual(res.path, null);
    const leftovers = fs.existsSync(SAVED_DIR)
        ? fs.readdirSync(SAVED_DIR).filter(n => n.startsWith('failed-fetch.webm.') && n.endsWith('.part'))
        : [];
    assert.deepStrictEqual(leftovers, [], 'a partial write must be cleaned up');
});

// ── repairSavedAudio ─────────────────────────────────────────────────────────

test('repair uploads the local file and fills the missing key', async () => {
    const p = localFile('repair-me.webm', 'bytes-to-back-up');
    const key = await store.repairSavedAudio({ id: 'n1', ownerId: 'u1', audioPath: p, audioStorageKey: null });
    assert.strictEqual(key, 'saved-recordings/repair-me.webm');
    assert.strictEqual(fx.objects.get(key).toString(), 'bytes-to-back-up');
});

test('repair is a no-op when the note already has a durable copy', async () => {
    const p = localFile('already.webm');
    const key = await store.repairSavedAudio({ id: 'n1', ownerId: 'u1', audioPath: p, audioStorageKey: 'saved-recordings/already.webm' });
    assert.strictEqual(key, null);
    assert.strictEqual(fx.uploadCalls.length, 0);
});

test('concurrent repairs of one recording upload it once', async () => {
    // Twenty Range requests for the same file must not become twenty uploads.
    const p = localFile('hot.webm');
    const [a, b, c] = await Promise.all([
        store.repairSavedAudio({ id: 'n1', ownerId: 'u1', audioPath: p, audioStorageKey: null }),
        store.repairSavedAudio({ id: 'n1', ownerId: 'u1', audioPath: p, audioStorageKey: null }),
        store.repairSavedAudio({ id: 'n1', ownerId: 'u1', audioPath: p, audioStorageKey: null }),
    ]);
    assert.strictEqual(fx.uploadCalls.length, 1);
    assert.strictEqual([a, b, c].filter(Boolean).length, 1);
});
