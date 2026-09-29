/**
 * Armed-token set for Talk auto-record.
 *
 * An armed token means "the next recording in this room came from auto-record,
 * so transcribe it even though autoTranscribe is off". Getting its lifetime
 * wrong transcribes meetings the user chose not to have transcribed — on a
 * privacy product that is the whole point of the setting.
 *
 * configStore is stubbed via the Module resolve hook: no database.
 *
 * Run: cd server && node --test core/meetingNotes/talkAutoRecord.armed.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const store = {}; // key → value
const stubConfigStore = {
    getConfig: async (k) => (k in store ? store[k] : null),
    setConfig: async (k, v) => { store[k] = v; },
    getAllConfig: async () => ({ ...store }),
};

const configResolved = require.resolve(path.join(__dirname, '..', '..', 'stores', 'configStore.js'));
require.cache[configResolved] = {
    id: configResolved, filename: configResolved, loaded: true, exports: stubConfigStore,
};

const { armToken, isArmed, disarmToken } = require('./talkAutoRecord');

const KEY = 'talk_autorecord_armed_u1';
const DAY = 24 * 60 * 60 * 1000;

test('arm → isArmed → disarm', async () => {
    for (const k of Object.keys(store)) delete store[k];
    assert.strictEqual(await isArmed('u1', 'tok1'), false);
    await armToken('u1', 'tok1');
    assert.strictEqual(await isArmed('u1', 'tok1'), true);
    assert.strictEqual(await isArmed('u1', 'tok2'), false, 'other rooms unaffected');
    await disarmToken('u1', 'tok1');
    assert.strictEqual(await isArmed('u1', 'tok1'), false);
});

test('an armed token expires after 24h instead of arming the room forever', async () => {
    for (const k of Object.keys(store)) delete store[k];
    // A call that was auto-recorded but whose file never arrived (crash, failed
    // upload, user deleted it) left this token armed with nothing to disarm it,
    // so every LATER manual recording in the room was auto-transcribed against
    // the user's setting.
    store[KEY] = [{ token: 'stale', ts: Date.now() - (DAY + 60_000) }];
    assert.strictEqual(await isArmed('u1', 'stale'), false, 'expired');

    store[KEY] = [{ token: 'fresh', ts: Date.now() - (DAY - 60_000) }];
    assert.strictEqual(await isArmed('u1', 'fresh'), true, 'still inside the window');
});

test('pre-TTL bare-string entries stay armed across the upgrade', async () => {
    for (const k of Object.keys(store)) delete store[k];
    // The old format was a plain array of tokens. Dropping them on deploy would
    // lose a call that is in flight right then.
    store[KEY] = ['legacy-token'];
    assert.strictEqual(await isArmed('u1', 'legacy-token'), true);
});

test('disarming also garbage-collects expired entries', async () => {
    for (const k of Object.keys(store)) delete store[k];
    store[KEY] = [
        { token: 'stale', ts: Date.now() - (DAY * 3) },
        { token: 'current', ts: Date.now() },
    ];
    await disarmToken('u1', 'current');
    assert.deepStrictEqual(store[KEY], [], 'nothing left, including the expired row');
});

test('arming the same room twice refreshes rather than duplicating', async () => {
    for (const k of Object.keys(store)) delete store[k];
    await armToken('u1', 'tok1');
    await armToken('u1', 'tok1');
    assert.strictEqual(store[KEY].length, 1);
});
