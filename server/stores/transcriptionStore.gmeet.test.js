/**
 * Transcription Store — Google Meet additions + audio-orphan fix.
 *
 * Covers:
 *   - deleteTranscription unlinks the row's saved audio (only inside the
 *     uploads root; ENOENT swallowed; foreign paths never touched)
 *   - createTranscription persists meet_meeting_code
 *   - getTranscriptionByMeetMeetingCode query shape (owner-scoped, newest first)
 *   - additive meet_meeting_code migration runs at init
 *
 * Stubs ../db via the require-cache (same trick as
 * routes/transcriptions.reprocess.test.js) — no Postgres needed.
 *
 * Run: cd server && node --test stores/transcriptionStore.gmeet.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Must match the store's uploads root (both files live in server/stores).
const UPLOADS_ROOT = path.resolve(__dirname, '../data/uploads');

// ── Require-cache stub for ../db (before the store loads) ────────────────────
function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const execCalls = [];
const runCalls = [];
const getOneCalls = [];
let runResult = { rowCount: 1, rows: [] };
let getOneResult = null;

stub('../db', {
    exec: async (sql) => { execCalls.push(sql); },
    run: async (sql, params) => { runCalls.push({ sql, params }); return runResult; },
    getOne: async (sql, params) => { getOneCalls.push({ sql, params }); return getOneResult; },
    getAll: async () => [],
});

const store = require('./transcriptionStore');

// ── fs.promises.unlink spy (store and test share the fs singleton) ───────────
const unlinkCalls = [];
let unlinkError = null;
const realUnlink = fs.promises.unlink;
fs.promises.unlink = async (p) => {
    unlinkCalls.push(String(p));
    if (unlinkError) throw unlinkError;
};
test.after(() => { fs.promises.unlink = realUnlink; });

test.beforeEach(() => {
    runCalls.length = 0;
    getOneCalls.length = 0;
    unlinkCalls.length = 0;
    unlinkError = null;
    runResult = { rowCount: 1, rows: [] };
    getOneResult = null;
});

// ── deleteTranscription ──────────────────────────────────────────────────────

test('delete unlinks the row audio_path when it lives under uploads', async () => {
    const audioPath = path.join(UPLOADS_ROOT, 'saved-recordings', '123-u1.webm');
    runResult = { rowCount: 1, rows: [{ audio_path: audioPath }] };

    const ok = await store.deleteTranscription('t-1', 'u-1');

    assert.strictEqual(ok, true);
    assert.strictEqual(runCalls.length, 1);
    assert.match(runCalls[0].sql, /DELETE FROM transcriptions WHERE id = \$1 AND user_id = \$2/);
    assert.match(runCalls[0].sql, /RETURNING audio_path/);
    assert.deepStrictEqual(runCalls[0].params, ['t-1', 'u-1']);
    assert.deepStrictEqual(unlinkCalls, [path.resolve(audioPath)]);
});

test('delete swallows ENOENT from unlink and still returns true', async () => {
    const audioPath = path.join(UPLOADS_ROOT, 'audio', 'gone.webm');
    runResult = { rowCount: 1, rows: [{ audio_path: audioPath }] };
    unlinkError = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });

    const ok = await store.deleteTranscription('t-2', 'u-1');

    assert.strictEqual(ok, true);
    assert.strictEqual(unlinkCalls.length, 1);
});

test('delete swallows non-ENOENT unlink errors too (best-effort)', async () => {
    const audioPath = path.join(UPLOADS_ROOT, 'audio', 'locked.webm');
    runResult = { rowCount: 1, rows: [{ audio_path: audioPath }] };
    unlinkError = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });

    const ok = await store.deleteTranscription('t-3', 'u-1');

    assert.strictEqual(ok, true);
});

test('delete never unlinks paths outside the uploads root', async () => {
    const outside = [
        path.resolve(__dirname, '../data/evil.webm'),
        path.join(UPLOADS_ROOT, '..', '..', 'secret.txt'),       // traversal
        `${UPLOADS_ROOT}-evil${path.sep}x.webm`,                  // sibling prefix
        UPLOADS_ROOT,                                             // the root itself
    ];
    for (const audioPath of outside) {
        runResult = { rowCount: 1, rows: [{ audio_path: audioPath }] };
        const ok = await store.deleteTranscription('t-4', 'u-1');
        assert.strictEqual(ok, true);
    }
    assert.deepStrictEqual(unlinkCalls, [], 'no unlink for foreign paths');
});

test('delete of a row without saved audio does not unlink', async () => {
    runResult = { rowCount: 1, rows: [{ audio_path: '' }] };
    const ok = await store.deleteTranscription('t-5', 'u-1');
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(unlinkCalls, []);
});

test('delete miss (not owner / not found) returns false and does not unlink', async () => {
    runResult = { rowCount: 0, rows: [] };
    const ok = await store.deleteTranscription('t-6', 'other-user');
    assert.strictEqual(ok, false);
    assert.deepStrictEqual(unlinkCalls, []);
});

// ── createTranscription ──────────────────────────────────────────────────────

test('createTranscription persists meet_meeting_code', async () => {
    const created = await store.createTranscription({
        userId: 'u-1', title: 'Weekly sync', fileName: 'sync.m4a',
        source: 'gmeet', sourceUri: 'gmeet://org-1/conferenceRecords/abc',
        meetMeetingCode: 'abc-defg-hjk',
    });

    assert.strictEqual(runCalls.length, 1);
    const { sql, params } = runCalls[0];
    assert.match(sql, /INSERT INTO transcriptions/);
    const columns = sql.match(/INSERT INTO transcriptions \(([^)]+)\)/)[1].split(',').map(s => s.trim());
    const idx = columns.indexOf('meet_meeting_code');
    assert.notStrictEqual(idx, -1, 'INSERT must include meet_meeting_code');
    assert.strictEqual(params[idx], 'abc-defg-hjk');
    assert.strictEqual(columns.length, params.length, 'every column has a value');
    assert.strictEqual(created.meetMeetingCode, 'abc-defg-hjk');
});

test('createTranscription defaults meet_meeting_code to null', async () => {
    const created = await store.createTranscription({ userId: 'u-1', title: 'Upload' });
    const { sql, params } = runCalls[0];
    const columns = sql.match(/INSERT INTO transcriptions \(([^)]+)\)/)[1].split(',').map(s => s.trim());
    assert.strictEqual(params[columns.indexOf('meet_meeting_code')], null);
    assert.strictEqual(created.meetMeetingCode, null);
});

// ── getTranscriptionByMeetMeetingCode ────────────────────────────────────────

test('getTranscriptionByMeetMeetingCode is owner-scoped and newest first', async () => {
    getOneResult = { id: 't-9', user_id: 'u-1', title: 'Sync', created_at: '2026-07-17' };

    const row = await store.getTranscriptionByMeetMeetingCode('abc-defg-hjk', 'u-1');

    assert.strictEqual(getOneCalls.length, 1);
    const { sql, params } = getOneCalls[0];
    assert.match(sql, /WHERE meet_meeting_code = \$1 AND user_id = \$2/);
    assert.match(sql, /ORDER BY created_at DESC LIMIT 1/);
    assert.deepStrictEqual(params, ['abc-defg-hjk', 'u-1']);
    assert.strictEqual(row.id, 't-9');
});

test('getTranscriptionByMeetMeetingCode without userId omits the owner clause', async () => {
    await store.getTranscriptionByMeetMeetingCode('abc-defg-hjk');
    const { sql, params } = getOneCalls[0];
    assert.match(sql, /WHERE meet_meeting_code = \$1 ORDER BY created_at DESC LIMIT 1/);
    assert.deepStrictEqual(params, ['abc-defg-hjk']);
});

test('getTranscriptionByMeetMeetingCode returns null for empty code without querying', async () => {
    assert.strictEqual(await store.getTranscriptionByMeetMeetingCode(''), null);
    assert.strictEqual(getOneCalls.length, 0);
});

// ── Migration ────────────────────────────────────────────────────────────────

test('init runs the additive meet_meeting_code migration', () => {
    assert.ok(
        execCalls.some(sql => /ALTER TABLE transcriptions ADD COLUMN IF NOT EXISTS meet_meeting_code TEXT/.test(sql)),
        'expected ADD COLUMN IF NOT EXISTS meet_meeting_code in init DDL'
    );
});
