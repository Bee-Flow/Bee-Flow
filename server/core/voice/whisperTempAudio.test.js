// @typecheck
/**
 * whisperTempAudio — the temporary recording copy of an Azure Whisper batch
 * job is removed when the process that made it never got to.
 *
 * Run: cd server && node --test core/voice/whisperTempAudio.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { whisperTempKey, whisperTempKeyWrittenAt, sweepStaleWhisperAudio, WHISPER_TEMP_PREFIX, _resetForTests } = require('./whisperTempAudio.mts');

const HOUR = 60 * 60_000;
const NOW = 1_800_000_000_000;

/** @param {string[]} keys */
function fakeStorage(keys, { available = true } = {}) {
    /** @type {string[]} */
    const deleted = [];
    return {
        deleted,
        keys,
        isAvailable: () => available,
        listKeys: async (/** @type {string} */ prefix) => keys.filter((k) => k.startsWith(prefix)),
        deleteFile: async (/** @type {string} */ key) => { deleted.push(key); keys.splice(keys.indexOf(key), 1); },
    };
}

test.beforeEach(() => _resetForTests());

test('a key says when it was written and keeps nothing of the file name but safe characters', () => {
    const key = whisperTempKey('Overleg Q3 (def).m4a', NOW);
    assert.ok(key.startsWith(`${WHISPER_TEMP_PREFIX}${NOW}-`));
    assert.ok(key.endsWith('-Overleg_Q3__def_.m4a.flac'));
    assert.strictEqual(whisperTempKeyWrittenAt(key), NOW);
    assert.notStrictEqual(whisperTempKey('a.m4a', NOW), whisperTempKey('a.m4a', NOW), 'two jobs in the same millisecond get their own copy');
    // The older key shape starts with a random id.
    assert.strictEqual(whisperTempKeyWrittenAt(`${WHISPER_TEMP_PREFIX}fd533e35-0650-4dec-a5c9-ff1ef9815c8b-Test.m4a.flac`), null);
    assert.strictEqual(whisperTempKeyWrittenAt('other/1800000000000-x.flac'), null);
});

test('a copy older than the longest wait plus an hour is deleted; one a job may still need stays', async () => {
    const old = whisperTempKey('old.m4a', NOW - 8 * HOUR);
    const inFlight = whisperTempKey('long-meeting.m4a', NOW - 5 * HOUR);
    const storage = fakeStorage([old, inFlight, 'webpages/u1/index.html']);
    assert.strictEqual(await sweepStaleWhisperAudio({ storage, now: NOW, env: {} }), 1);
    assert.deepStrictEqual(storage.deleted, [old]);
});

test('a longer configured wait keeps the copies that long', async () => {
    const key = whisperTempKey('x.m4a', NOW - 8 * HOUR);
    const storage = fakeStorage([key]);
    const env = { WHISPER_AZURE_POLL_TIMEOUT_MS: String(12 * HOUR) };
    assert.strictEqual(await sweepStaleWhisperAudio({ storage, now: NOW, env }), 0);
    assert.strictEqual(await sweepStaleWhisperAudio({ storage, now: NOW + 6 * HOUR, env }), 1);
});

test('a key without a time counts from the first pass that saw it', async () => {
    const legacy = `${WHISPER_TEMP_PREFIX}fd533e35-0650-4dec-a5c9-ff1ef9815c8b-Test.m4a.flac`;
    const storage = fakeStorage([legacy]);
    assert.strictEqual(await sweepStaleWhisperAudio({ storage, now: NOW, env: {} }), 0, 'it may belong to a job on a replica that is still running');
    assert.strictEqual(await sweepStaleWhisperAudio({ storage, now: NOW + 6 * HOUR, env: {} }), 0);
    assert.strictEqual(await sweepStaleWhisperAudio({ storage, now: NOW + 8 * HOUR, env: {} }), 1);
    assert.deepStrictEqual(storage.deleted, [legacy]);
});

test('without object storage there is nothing to sweep', async () => {
    const onDisk = { ...fakeStorage([whisperTempKey('old.m4a', NOW - 99 * HOUR)]), getStatus: () => ({ mode: 'local' }) };
    assert.strictEqual(await sweepStaleWhisperAudio({ storage: onDisk, now: NOW, env: {} }), 0, 'the on-disk store cannot list a prefix');
    const storage = fakeStorage([whisperTempKey('old.m4a', NOW - 99 * HOUR)], { available: false });
    assert.strictEqual(await sweepStaleWhisperAudio({ storage, now: NOW, env: {} }), 0);
    assert.deepStrictEqual(storage.deleted, []);
});
