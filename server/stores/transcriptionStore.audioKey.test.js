/**
 * Transcription Store — the durable-audio key must be writable AFTER insert.
 *
 * `audio_storage_key` used to be settable only by the INSERT. On a deployment
 * with no persistent volume (ours: the server Deployment declares no volumes and
 * is HPA-scaled), the local `audio_path` dies with its pod, so a note created
 * while object storage happened to be unreachable was permanently unrecoverable
 * — there was no SQL anywhere that could fill the column in later.
 *
 * Also covers the disk-first lookup the repair sweep runs.
 *
 * Stubs ../db via the require-cache (same trick as transcriptionStore.gmeet.test.js)
 * — no Postgres needed.
 *
 * Run: cd server && node --test stores/transcriptionStore.audioKey.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const runCalls = [];
const execCalls = [];
let getAllResult = [];
const getAllCalls = [];

stub('../db', {
    exec: async (sql) => { execCalls.push(sql); },
    run: async (sql, params) => { runCalls.push({ sql, params }); return { rowCount: 1, rows: [] }; },
    getOne: async () => null,
    getAll: async (sql, params) => { getAllCalls.push({ sql, params }); return getAllResult; },
});

const store = require('./transcriptionStore');

const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const lastRun = () => runCalls[runCalls.length - 1];

/** The value bound to the $n referenced by a SET clause. */
function paramFor(call, clauseRe) {
    const m = clauseRe.exec(norm(call.sql));
    assert.ok(m, `clause not found: ${clauseRe} in ${norm(call.sql)}`);
    return call.params[Number(m[1]) - 1];
}

test.beforeEach(() => { runCalls.length = 0; getAllCalls.length = 0; getAllResult = []; });

// ── updateTranscription: audioStorageKey ─────────────────────────────────────

test('audioStorageKey writes the column', async () => {
    await store.updateTranscription('n1', 'u1', { audioStorageKey: 'saved-recordings/a.webm' });
    const call = lastRun();
    assert.match(norm(call.sql), /audio_storage_key = \$\d+/);
    assert.strictEqual(paramFor(call, /audio_storage_key = \$(\d+)/), 'saved-recordings/a.webm');
});

test('audioStorageKey: null writes SQL NULL, never the empty string', async () => {
    // '' would be truthy-adjacent downstream: `if (audioStorageKey)` guards in
    // savedAudioStore/resolveSavedAudio would take the storage branch and then
    // fetch the key '' — a 404 dressed up as a real durable copy.
    await store.updateTranscription('n1', 'u1', { audioStorageKey: null });
    assert.strictEqual(paramFor(lastRun(), /audio_storage_key = \$(\d+)/), null);
});

test('audioStorageKeyIfMissing only fills a NULL column', async () => {
    // Two replicas can both spot the same unstored file. Whoever lands second
    // must not clobber a key that is already good.
    await store.updateTranscription('n1', 'u1', { audioStorageKeyIfMissing: 'saved-recordings/a.webm' });
    const sql = norm(lastRun().sql);
    assert.match(sql, /audio_storage_key = CASE WHEN audio_storage_key IS NULL THEN \$\d+::text ELSE audio_storage_key END/);
});

test('the repair update stays owner-scoped', async () => {
    // The sweep passes the row's own user_id; the owner predicate must survive,
    // or a repair would be able to touch another tenant's note.
    await store.updateTranscription('n1', 'u1', { audioStorageKeyIfMissing: 'k' });
    const call = lastRun();
    assert.match(norm(call.sql), /WHERE id = \$\d+ AND user_id = \$\d+/);
    assert.deepStrictEqual(call.params.slice(-2), ['n1', 'u1']);
});

test('an unrelated update does not touch audio_storage_key', async () => {
    await store.updateTranscription('n1', 'u1', { title: 'Nieuwe titel' });
    assert.ok(!/audio_storage_key/.test(norm(lastRun().sql)));
});

// ── getTranscriptionsByAudioPaths ────────────────────────────────────────────

test('getTranscriptionsByAudioPaths queries by exact path array', async () => {
    getAllResult = [{ id: 'n1', user_id: 'u1', audio_path: '/app/data/uploads/saved-recordings/a.webm', audio_storage_key: null }];
    const rows = await store.getTranscriptionsByAudioPaths([
        '/app/data/uploads/saved-recordings/a.webm',
        '/app/data/uploads/saved-recordings/b.mp3',
    ]);
    const call = getAllCalls[getAllCalls.length - 1];
    assert.match(norm(call.sql), /WHERE audio_path = ANY\(\$1::text\[\]\)/);
    assert.strictEqual(call.params[0].length, 2);
    assert.strictEqual(rows[0].id, 'n1');
});

test('getTranscriptionsByAudioPaths short-circuits on an empty list', async () => {
    // An empty saved-recordings dir must not issue `= ANY('{}')` every tick.
    const rows = await store.getTranscriptionsByAudioPaths([]);
    assert.deepStrictEqual(rows, []);
    assert.strictEqual(getAllCalls.length, 0, 'no query issued');
});

test('getTranscriptionsByAudioPaths ignores non-string entries', async () => {
    await store.getTranscriptionsByAudioPaths([null, '', '/app/data/uploads/saved-recordings/a.webm', 42]);
    assert.deepStrictEqual(getAllCalls[getAllCalls.length - 1].params[0], ['/app/data/uploads/saved-recordings/a.webm']);
});

// ── migration ────────────────────────────────────────────────────────────────

test('init creates the partial index the repair sweep relies on', () => {
    const sql = execCalls.map(norm).join('\n');
    assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_transcriptions_audio_path_unstored/);
    assert.match(sql, /WHERE audio_storage_key IS NULL/);
});
