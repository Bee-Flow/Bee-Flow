// @typecheck
/**
 * Transcription Store — the durable-audio key is writable AFTER insert,
 * against a real Postgres (PGlite behind db.js's pool, testUtils/pglitePool.js,
 * with the store's own schema).
 *
 * On a deployment with no persistent volume the local `audio_path` dies with
 * its pod, so a note created while object storage happened to be unreachable
 * needs the key filled in later. Two replicas can spot the same unstored file,
 * so the repair only fills a NULL key, and it stays owner-scoped. Also covers
 * the disk-first lookup the repair sweep runs.
 *
 * Run: cd server && node --test stores/transcriptionStore.audioKey.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const store = require('./transcriptionStore');

const A = '/app/data/uploads/saved-recordings/a.webm';
const B = '/app/data/uploads/saved-recordings/b.mp3';

test.before(() => store.initDB());
test.after(close);

let seq = 0;
async function note(userId = 'u1', audioPath = null, key = null) {
    seq += 1;
    const id = `n${seq}`;
    await pg.query('INSERT INTO transcriptions (id, user_id, title, audio_path, audio_storage_key) VALUES ($1, $2, $3, $4, $5)',
        [id, userId, 'Note', audioPath, key]);
    return id;
}
const keyOf = async (id) => (await pg.query('SELECT audio_storage_key FROM transcriptions WHERE id = $1', [id])).rows[0].audio_storage_key;

test('audioStorageKey writes the column; null writes SQL NULL, never the empty string', async () => {
    const id = await note();
    await store.updateTranscription(id, 'u1', { audioStorageKey: 'saved-recordings/a.webm' });
    assert.strictEqual(await keyOf(id), 'saved-recordings/a.webm');
    // '' would take the storage branch downstream and fetch the key '': a 404 dressed up as a durable copy.
    await store.updateTranscription(id, 'u1', { audioStorageKey: null });
    assert.strictEqual(await keyOf(id), null);
});

test('audioStorageKeyIfMissing only fills a NULL column', async () => {
    const empty = await note();
    const stored = await note('u1', null, 'saved-recordings/good.webm');
    await store.updateTranscription(empty, 'u1', { audioStorageKeyIfMissing: 'saved-recordings/a.webm' });
    await store.updateTranscription(stored, 'u1', { audioStorageKeyIfMissing: 'saved-recordings/late.webm' });
    assert.strictEqual(await keyOf(empty), 'saved-recordings/a.webm');
    assert.strictEqual(await keyOf(stored), 'saved-recordings/good.webm', 'whoever lands second must not clobber a good key');
});

test('the repair update stays owner-scoped', async () => {
    const id = await note('u1');
    await store.updateTranscription(id, 'u2', { audioStorageKeyIfMissing: 'k' });
    assert.strictEqual(await keyOf(id), null, "a repair cannot touch another tenant's note");
});

test('an unrelated update does not touch audio_storage_key', async () => {
    const id = await note('u1', null, 'keep');
    await store.updateTranscription(id, 'u1', { title: 'Nieuwe titel' });
    assert.strictEqual(await keyOf(id), 'keep');
});

test('getTranscriptionsByAudioPaths finds notes by exact path, ignoring non-strings and an empty list', async () => {
    const a = await note('u1', A);
    await note('u1', B + '.old');
    const rows = await store.getTranscriptionsByAudioPaths([A, B]);
    assert.deepStrictEqual(rows.map((r) => r.id), [a]);
    assert.deepStrictEqual((await store.getTranscriptionsByAudioPaths([/** @type {any} */ (null), '', A, /** @type {any} */ (42)])).map((r) => r.id), [a]);
    assert.deepStrictEqual(await store.getTranscriptionsByAudioPaths([]), []);
});

test('init creates the partial index the repair sweep relies on', async () => {
    const { rows } = await pg.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_transcriptions_audio_path_unstored'");
    assert.strictEqual(rows.length, 1);
    assert.match(rows[0].indexdef, /WHERE \(audio_storage_key IS NULL\)/);
});
