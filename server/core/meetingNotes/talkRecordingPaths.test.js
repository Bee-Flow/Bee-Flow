/**
 * Talk recording path parsing.
 *
 * The bug these pin down: Talk stores recordings at
 * `<attachmentFolder>/Recording/<token>/<file>`, but Bee Flow assumed
 * `<attachmentFolder>/<token>/<file>` and its parser took the first segment of
 * whatever was left. With the default `/Talk` that made the room token the
 * literal string "Recording" for every recording on every instance — which then
 * failed the armed-token check (so auto-record never produced a note), the
 * participant-roster lookup and the Talk write-back.
 *
 * Run: cd server && node --test core/meetingNotes/talkRecordingPaths.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    DEFAULT_RECORDING_FOLDER,
    normalizeFolder,
    isRecordingRoot,
    talkRecordingRoots,
    parseTalkRoomToken,
} = require('./talkRecordingPaths');

const REC = '/Talk/Recording/a1b2c3d4/recording-20260813-140000.ogg';

test('the default recordings folder is the Recording subfolder', () => {
    assert.strictEqual(DEFAULT_RECORDING_FOLDER, '/Talk/Recording');
});

test('the real Talk layout yields the room token, not "Recording"', () => {
    assert.strictEqual(parseTalkRoomToken(REC, '/Talk/Recording'), 'a1b2c3d4');
});

test('a stored setting of /Talk still resolves the room token', () => {
    // Tenants configured before the fix (and the old default) hold '/Talk'.
    // The Recording subfolder is probed for them rather than silently
    // returning the folder name as the token.
    assert.strictEqual(parseTalkRoomToken(REC, '/Talk'), 'a1b2c3d4');
});

test('the deepest matching root claims the path', () => {
    // /Talk/Recording must win over /Talk; otherwise rest[0] is "Recording".
    assert.deepStrictEqual(talkRecordingRoots('/Talk'), ['/Talk/Recording', '/Talk']);
    assert.notStrictEqual(parseTalkRoomToken(REC, '/Talk'), 'Recording');
});

test('the legacy flat layout <folder>/<token>/<file> still parses', () => {
    assert.strictEqual(parseTalkRoomToken('/Talk/a1b2c3d4/rec.ogg', '/Talk'), 'a1b2c3d4');
});

test('a custom recordings folder is honoured', () => {
    assert.strictEqual(
        parseTalkRoomToken('/Meetings/Calls/zx99/rec.mp4', '/Meetings/Calls'),
        'zx99',
    );
    assert.strictEqual(
        parseTalkRoomToken('/Meetings/Recording/zx99/rec.mp4', '/Meetings'),
        'zx99',
    );
});

test('paths that are not <root>/<token>/<file> are rejected', () => {
    // Directly in the recordings root — not a per-room recording.
    assert.strictEqual(parseTalkRoomToken('/Talk/Recording/rec.ogg', '/Talk/Recording'), null);
    // Too deep: a nested folder inside a room folder is not the recording.
    assert.strictEqual(parseTalkRoomToken('/Talk/Recording/a1b2c3d4/sub/rec.ogg', '/Talk/Recording'), null);
    // Outside the recordings folder entirely.
    assert.strictEqual(parseTalkRoomToken('/Documents/a1b2c3d4/rec.ogg', '/Talk/Recording'), null);
    // A Talk ATTACHMENT (conversation subfolders are `<name>-<token>`), not a
    // recording — the hyphen fails the token shape.
    assert.strictEqual(parseTalkRoomToken('/Talk/Standup-a1b2c3d4/note.ogg', '/Talk'), null);
    assert.strictEqual(parseTalkRoomToken('', '/Talk'), null);
    assert.strictEqual(parseTalkRoomToken(null, '/Talk'), null);
});

test('the recordings root can sit at the Files root', () => {
    // RecordingService resets the attachment folder to '/' when the configured
    // one turns out to be a shared folder.
    assert.deepStrictEqual(talkRecordingRoots('/'), ['/Recording', '/']);
    assert.strictEqual(parseTalkRoomToken('/Recording/a1b2c3d4/rec.ogg', '/'), 'a1b2c3d4');
    assert.strictEqual(parseTalkRoomToken('/a1b2c3d4/rec.ogg', '/'), 'a1b2c3d4');
});

test('folder input is normalised and matching is case-insensitive', () => {
    assert.strictEqual(normalizeFolder('Talk/Recording/'), '/Talk/Recording');
    assert.strictEqual(normalizeFolder('//Talk//Recording//'), '/Talk/Recording');
    assert.strictEqual(parseTalkRoomToken(REC, 'Talk/Recording/'), 'a1b2c3d4');
    assert.strictEqual(parseTalkRoomToken('/talk/recording/a1b2c3d4/rec.ogg', '/Talk/Recording'), 'a1b2c3d4');
});

test('a folder already ending in Recording is not doubled', () => {
    assert.ok(isRecordingRoot('/Talk/Recording'));
    assert.deepStrictEqual(talkRecordingRoots('/Talk/Recording'), ['/Talk/Recording']);
    assert.strictEqual(parseTalkRoomToken('/Talk/Recording/Recording/rec.ogg', '/Talk/Recording'), 'Recording',
        'a room really named "Recording" one level down is still a token');
});
