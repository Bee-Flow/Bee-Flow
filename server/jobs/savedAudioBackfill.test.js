/**
 * Saved-audio backfill sweep.
 *
 * Pins the behaviour that recovers meeting recordings which have a local file
 * but no durable object-storage copy — the state that produced
 * "Saved audio not found. Cannot reprocess — please upload again."
 *
 * Deps are stubbed via the require cache; no Postgres, no RustFS, real temp dir.
 *
 * Run: cd server && node --test jobs/savedAudioBackfill.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-audio-backfill-'));

function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const fx = {
    storageUp: true,
    rows: [],
    uploads: [],          // {key, size}
    updates: [],          // {id, userId, updates}
    uploadError: null,
};

stub('../stores/storageStore', {
    init: async () => true,
    isAvailable: () => fx.storageUp,
    ensureAvailable: async () => fx.storageUp,
    getStatus: () => ({ mode: fx.storageUp ? 's3' : null, configured: true, lastError: null, nextRetryAt: 0 }),
    uploadFile: async (key, buffer) => {
        if (fx.uploadError) throw fx.uploadError;
        fx.uploads.push({ key, size: buffer.length });
        return { key };
    },
});

stub('../stores/transcriptionStore', {
    getTranscriptionsByAudioPaths: async (paths) => fx.rows.filter(r => paths.includes(r.audio_path)),
    updateTranscription: async (id, userId, updates) => { fx.updates.push({ id, userId, updates }); return true; },
});

// The real savedAudioStore is used deliberately — repairSavedAudio IS the unit
// under test here, and a stub of it could not catch the thing that matters
// (that the repair is owner-scoped and only fills a missing key).
const savedAudioStore = require('../core/meetingNotes/savedAudioStore');
// Point the module's directory constant at our temp dir.
Object.defineProperty(savedAudioStore, 'SAVED_RECORDINGS_DIR', { value: tmpDir, writable: true });

const { runOnce } = require('./savedAudioBackfill');

function writeFile(name, contents = 'audio-bytes') {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, contents);
    return p;
}

test.beforeEach(() => {
    for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f), { force: true });
    fx.storageUp = true;
    fx.rows = [];
    fx.uploads.length = 0;
    fx.updates.length = 0;
    fx.uploadError = null;
});

test.after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} });

test('repairs only the notes that lack a durable copy', async () => {
    const durable = writeFile('1-owner.mp3');
    const needy = writeFile('2-owner.webm');
    fx.rows = [
        { id: 'n1', user_id: 'u1', audio_path: durable, audio_storage_key: 'saved-recordings/1-owner.mp3' },
        { id: 'n2', user_id: 'u2', audio_path: needy, audio_storage_key: null },
    ];

    const r = await runOnce();

    assert.strictEqual(r.scanned, 2);
    assert.strictEqual(r.alreadyDurable, 1);
    assert.strictEqual(r.repaired, 1);
    assert.deepStrictEqual(fx.uploads.map(u => u.key), ['saved-recordings/2-owner.webm']);
});

test('the repair is owner-scoped and only fills a MISSING key', async () => {
    const needy = writeFile('2-owner.webm');
    fx.rows = [{ id: 'n2', user_id: 'u2', audio_path: needy, audio_storage_key: null }];

    await runOnce();

    assert.strictEqual(fx.updates.length, 1);
    const [call] = fx.updates;
    assert.strictEqual(call.id, 'n2');
    // The row's OWN user, never the caller's — a repair must not be able to
    // reach across tenants.
    assert.strictEqual(call.userId, 'u2');
    // IfMissing, so a second replica racing this one cannot clobber a good key.
    assert.strictEqual(call.updates.audioStorageKeyIfMissing, 'saved-recordings/2-owner.webm');
    assert.strictEqual(call.updates.audioStorageKey, undefined);
});

test('a recording file with no note row is counted, never uploaded or deleted', async () => {
    const orphan = writeFile('9-orphan.mp3');
    fx.rows = [];

    const r = await runOnce();

    assert.strictEqual(r.orphans, 1);
    assert.strictEqual(r.repaired, 0);
    assert.strictEqual(fx.uploads.length, 0);
    assert.ok(fs.existsSync(orphan), 'the file must survive — deleting is a separate decision');
});

test('does nothing (and does not throw) while object storage is down', async () => {
    writeFile('2-owner.webm');
    fx.rows = [{ id: 'n2', user_id: 'u2', audio_path: path.join(tmpDir, '2-owner.webm'), audio_storage_key: null }];
    fx.storageUp = false;

    const r = await runOnce();

    assert.strictEqual(r.skipped, 1);
    assert.strictEqual(r.repaired, 0);
    assert.strictEqual(fx.uploads.length, 0, 'never reads the directory when it cannot upload');
});

test('honours the batch cap and leaves the rest for the next tick', async () => {
    for (let i = 0; i < 5; i++) writeFile(`${i}-owner.webm`);
    fx.rows = Array.from({ length: 5 }, (_, i) => ({
        id: `n${i}`, user_id: 'u1', audio_path: path.join(tmpDir, `${i}-owner.webm`), audio_storage_key: null,
    }));

    const r = await runOnce({ batch: 2 });

    assert.strictEqual(r.repaired, 2);
    assert.strictEqual(fx.uploads.length, 2);
});

test('dry-run reports without uploading or mutating', async () => {
    writeFile('2-owner.webm');
    fx.rows = [{ id: 'n2', user_id: 'u2', audio_path: path.join(tmpDir, '2-owner.webm'), audio_storage_key: null }];

    const r = await runOnce({ dryRun: true });

    assert.strictEqual(r.repaired, 1, 'reports what it would do');
    assert.strictEqual(fx.uploads.length, 0);
    assert.strictEqual(fx.updates.length, 0);
});

test('an in-flight write-back .part file is not mistaken for a recording', async () => {
    writeFile('2-owner.webm.abc.part');
    fx.rows = [];
    const r = await runOnce();
    assert.strictEqual(r.scanned, 0);
    assert.strictEqual(r.orphans, 0, 'a temp file is not an orphaned recording');
});

test('a failed upload does not mark the note as repaired', async () => {
    writeFile('2-owner.webm');
    fx.rows = [{ id: 'n2', user_id: 'u2', audio_path: path.join(tmpDir, '2-owner.webm'), audio_storage_key: null }];
    fx.uploadError = new Error('rustfs exploded');

    const r = await runOnce();

    assert.strictEqual(r.repaired, 0);
    assert.strictEqual(fx.updates.length, 0, 'never claim a durable copy we do not have');
});
