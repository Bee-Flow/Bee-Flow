/**
 * Transcription Store — Google Meet additions + audio-orphan fix.
 *
 * Covers:
 *   - deleteTranscription unlinks the row's saved audio (only inside the
 *     uploads root; ENOENT swallowed; foreign paths never touched)
 *   - createTranscription persists meet_meeting_code
 *   - getTranscriptionByMeetMeetingCode is owner-scoped and returns the newest
 *   - additive meet_meeting_code migration runs at init
 *
 * The real db.js and the store's own schema on a real Postgres (PGlite behind
 * db.js's pool, testUtils/pglitePool.js).
 *
 * Run: cd server && node --test stores/transcriptionStore.gmeet.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { usePglitePool } = require('../testUtils/pglitePool');
const { insertRow } = require('../testUtils/pgliteSeed');

// Must match the store's uploads root (both files live in server/stores).
const UPLOADS_ROOT = path.resolve(__dirname, '../data/uploads');

const { pg, close } = usePglitePool();
const store = require('./transcriptionStore');
test.before(() => store.initDB());

let seq = 0;
/** A transcription row; `id` given or generated. */
async function note(over = {}) {
    seq += 1;
    const row = { id: `t-${seq}`, user_id: 'u-1', title: 'Note', ...over };
    await insertRow(pg, 'transcriptions', row);
    return row.id;
}
const exists = async (id) => (await pg.query('SELECT 1 FROM transcriptions WHERE id = $1', [id])).rows.length === 1;

// ── fs.promises.unlink spy (store and test share the fs singleton) ───────────
const unlinkCalls = [];
let unlinkError = null;
const realUnlink = fs.promises.unlink;
fs.promises.unlink = async (p) => {
    unlinkCalls.push(String(p));
    if (unlinkError) throw unlinkError;
};
test.after(async () => { fs.promises.unlink = realUnlink; await close(); });

test.beforeEach(() => {
    unlinkCalls.length = 0;
    unlinkError = null;
});

// ── deleteTranscription ──────────────────────────────────────────────────────

test('delete removes the owner\'s row and unlinks its audio_path when it lives under uploads', async () => {
    const audioPath = path.join(UPLOADS_ROOT, 'saved-recordings', '123-u1.webm');
    const id = await note({ audio_path: audioPath });
    const ok = await store.deleteTranscription(id, 'u-1');
    assert.strictEqual(ok, true);
    assert.strictEqual(await exists(id), false);
    assert.deepStrictEqual(unlinkCalls, [path.resolve(audioPath)]);
});

test('delete swallows ENOENT from unlink and still returns true', async () => {
    const id = await note({ audio_path: path.join(UPLOADS_ROOT, 'audio', 'gone.webm') });
    unlinkError = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    assert.strictEqual(await store.deleteTranscription(id, 'u-1'), true);
    assert.strictEqual(unlinkCalls.length, 1);
    assert.strictEqual(await exists(id), false);
});

test('delete swallows non-ENOENT unlink errors too (best-effort)', async () => {
    const id = await note({ audio_path: path.join(UPLOADS_ROOT, 'audio', 'locked.webm') });
    unlinkError = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    assert.strictEqual(await store.deleteTranscription(id, 'u-1'), true);
});

test('delete never unlinks paths outside the uploads root', async () => {
    const outside = [
        path.resolve(__dirname, '../data/evil.webm'),
        path.join(UPLOADS_ROOT, '..', '..', 'secret.txt'),       // traversal
        `${UPLOADS_ROOT}-evil${path.sep}x.webm`,                  // sibling prefix
        UPLOADS_ROOT,                                             // the root itself
    ];
    for (const audioPath of outside) {
        const id = await note({ audio_path: audioPath });
        assert.strictEqual(await store.deleteTranscription(id, 'u-1'), true);
    }
    assert.deepStrictEqual(unlinkCalls, [], 'no unlink for foreign paths');
});

test('delete of a row without saved audio does not unlink', async () => {
    const id = await note({ audio_path: '' });
    assert.strictEqual(await store.deleteTranscription(id, 'u-1'), true);
    assert.deepStrictEqual(unlinkCalls, []);
});

test('delete miss (not owner / not found) returns false, keeps the row and does not unlink', async () => {
    const id = await note({ audio_path: path.join(UPLOADS_ROOT, 'audio', 'mine.webm') });
    assert.strictEqual(await store.deleteTranscription(id, 'other-user'), false);
    assert.strictEqual(await store.deleteTranscription('no-such-id', 'u-1'), false);
    assert.strictEqual(await exists(id), true);
    assert.deepStrictEqual(unlinkCalls, []);
});

test('delete is owner-scoped in the DELETE itself: a row handed to someone else after the check stays', async () => {
    const id = await note({ audio_path: path.join(UPLOADS_ROOT, 'audio', 'moved.webm') });
    const db = require('../db');
    const saved = db.pool.query;
    db.pool.query = async (sql, params) => {
        const out = await saved(sql, params);
        if (String(sql).startsWith('SELECT audio_storage_key FROM transcriptions')) await pg.query("UPDATE transcriptions SET user_id = 'u-2' WHERE id = $1", [id]);
        return out;
    };
    let ok;
    try { ok = await store.deleteTranscription(id, 'u-1'); } finally { db.pool.query = saved; }
    assert.strictEqual(ok, false);
    assert.strictEqual(await exists(id), true);
    assert.deepStrictEqual(unlinkCalls, []);
});

// ── createTranscription ──────────────────────────────────────────────────────

const codeOf = async (id) => (await pg.query('SELECT meet_meeting_code FROM transcriptions WHERE id = $1', [id])).rows[0].meet_meeting_code;

test('createTranscription persists meet_meeting_code', async () => {
    const created = await store.createTranscription({
        userId: 'u-1', title: 'Weekly sync', fileName: 'sync.m4a',
        source: 'gmeet', sourceUri: 'gmeet://org-1/conferenceRecords/abc',
        meetMeetingCode: 'abc-defg-hjk',
    });
    assert.strictEqual(created.meetMeetingCode, 'abc-defg-hjk');
    assert.strictEqual(await codeOf(created.id), 'abc-defg-hjk');
});

test('createTranscription defaults meet_meeting_code to null', async () => {
    const created = await store.createTranscription({ userId: 'u-1', title: 'Upload' });
    assert.strictEqual(created.meetMeetingCode, null);
    assert.strictEqual(await codeOf(created.id), null);
});

// ── getTranscriptionByMeetMeetingCode ────────────────────────────────────────

test('getTranscriptionByMeetMeetingCode is owner-scoped and newest first', async () => {
    await note({ id: 'mc-old', meet_meeting_code: 'mc-1', created_at: '2026-07-01T00:00:00Z' });
    await note({ id: 'mc-new', meet_meeting_code: 'mc-1', created_at: '2026-07-17T00:00:00Z' });
    await note({ id: 'mc-theirs', user_id: 'u-2', meet_meeting_code: 'mc-1', created_at: '2026-07-20T00:00:00Z' });
    await note({ id: 'mc-other-code', meet_meeting_code: 'mc-2', created_at: '2026-07-30T00:00:00Z' });
    assert.strictEqual((await store.getTranscriptionByMeetMeetingCode('mc-1', 'u-1')).id, 'mc-new');
    assert.strictEqual((await store.getTranscriptionByMeetMeetingCode('mc-1', 'u-2')).id, 'mc-theirs');
    assert.strictEqual(await store.getTranscriptionByMeetMeetingCode('mc-1', 'u-3'), null);
});

test('getTranscriptionByMeetMeetingCode without userId looks across owners', async () => {
    await note({ id: 'any-a', meet_meeting_code: 'mc-any', created_at: '2026-07-01T00:00:00Z' });
    await note({ id: 'any-b', user_id: 'u-9', meet_meeting_code: 'mc-any', created_at: '2026-07-02T00:00:00Z' });
    assert.strictEqual((await store.getTranscriptionByMeetMeetingCode('mc-any')).id, 'any-b');
});

test('getTranscriptionByMeetMeetingCode returns null for empty code', async () => {
    await note({ meet_meeting_code: '' });
    assert.strictEqual(await store.getTranscriptionByMeetMeetingCode(''), null);
});

// ── Migration ────────────────────────────────────────────────────────────────

test('init adds meet_meeting_code to the transcriptions table', async () => {
    const { rows } = await pg.query("SELECT data_type FROM information_schema.columns WHERE table_name = 'transcriptions' AND column_name = 'meet_meeting_code'");
    assert.deepStrictEqual(rows, [{ data_type: 'text' }]);
});
