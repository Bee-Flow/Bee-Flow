'use strict';

/**
 * stores/transcription/lookups.js against a real Postgres (PGlite behind
 * db.js): the "previously in this series" card opens a sealed summary, and
 * the meetings-view lookups by Meet code / Talk room find ONE occurrence's
 * note rather than the newest note of the whole series.
 *
 * Run: cd server && node --test stores/transcription/lookups.pg.test.js
 */

const crypto = require('crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../../testUtils/pglitePool');
const { makeSwaps } = require('../../testUtils/swaps');

const { pg, close } = usePglitePool();
const store = require('../transcriptionStore');
const transcriptCrypto = require('../transcriptCrypto');

const { swap, restore } = makeSwaps();
const ORG_KEYS = { orgEnc: crypto.randomBytes(32) };

before(async () => {
    await pg.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, owner_id TEXT, organization_id TEXT NOT NULL DEFAULT '')`);
    swap(transcriptCrypto, 'resolveTranscriptCrypto', async (orgId) => (
        orgId && ORG_KEYS[orgId]
            ? { key: ORG_KEYS[orgId], encrypt: true, tier: 'standard' }
            : transcriptCrypto.PLAINTEXT_CONTEXT
    ));
    await store.initDB();
});

after(async () => {
    restore();
    await close();
});

/** @param {string} id @param {string} iso */
const setCreated = (id, iso) => pg.query('UPDATE transcriptions SET created_at = $2::timestamptz WHERE id = $1', [id, iso]);

test('series card: an encrypted org gets last week\'s summary, not the ciphertext envelope', async () => {
    const make = (extra) => store.createTranscription({
        userId: 'alice', organizationId: 'orgEnc', status: 'completed', meetMeetingCode: 'enc-defg-hij', ...extra,
    });
    const prev = await make({ title: 'Week 1', summary: 'Last week we agreed to ship.', actionItems: [{ id: 'a1', text: 'Ship', done: false }] });
    await setCreated(prev.id, new Date(Date.now() - 7 * 86400_000).toISOString());
    const cur = await make({ title: 'Week 2', summary: 'This week.' });

    const raw = (await pg.query('SELECT summary FROM transcriptions WHERE id = $1', [prev.id])).rows[0].summary;
    assert.match(raw, /_bfenc/, 'the column really is sealed');

    const curNote = await store.getTranscription(cur.id, 'alice');
    const card = await store.getSeriesPrevious({
        meetMeetingCode: 'enc-defg-hij', beforeCreatedAt: curNote.createdAt, excludeId: cur.id, userId: 'alice',
    });
    assert.ok(card);
    assert.strictEqual(card.id, prev.id);
    assert.strictEqual(card.summary, 'Last week we agreed to ship.');
    assert.deepStrictEqual(card.openActionItems.map((a) => a.id), ['a1']);
});

test('series card: a summary that will not open gives an empty preview, not a failed card', async () => {
    const prev = await store.createTranscription({
        userId: 'alice', organizationId: 'orgEnc', status: 'completed', talkRoomToken: 'room-bad', title: 'Old', summary: 'Sealed.',
    });
    await setCreated(prev.id, new Date(Date.now() - 86400_000).toISOString());
    const undo = swap(transcriptCrypto, 'resolveTranscriptCrypto', async () => ({ key: crypto.randomBytes(32), encrypt: true, tier: 'standard' }));
    try {
        const card = await store.getSeriesPrevious({
            talkRoomToken: 'room-bad', beforeCreatedAt: new Date().toISOString(), excludeId: 'none', userId: 'alice',
        });
        assert.strictEqual(card.id, prev.id);
        assert.strictEqual(card.summary, '');
    } finally { undo(); }
});

test('series card: plaintext rows read as before', async () => {
    const prev = await store.createTranscription({
        userId: 'alice', organizationId: 'orgPlain', status: 'completed', talkRoomToken: 'room-plain', title: 'Old', summary: 'Plain words.',
    });
    await setCreated(prev.id, new Date(Date.now() - 86400_000).toISOString());
    const card = await store.getSeriesPrevious({
        talkRoomToken: 'room-plain', beforeCreatedAt: new Date().toISOString(), excludeId: 'none', userId: 'alice',
    });
    assert.strictEqual(card.summary, 'Plain words.');
});

test('meetings view: a Meet code lookup with `since` finds that occurrence, not week 1 of the series', async () => {
    const w1 = await store.createTranscription({ userId: 'alice', title: 'Stand-up week 1', meetMeetingCode: 'abc-defg-hij' });
    await setCreated(w1.id, '2026-07-17T10:30:00Z');
    const W1_START = '2026-07-17T09:00:00Z';
    const W2_START = '2026-07-24T09:00:00Z';
    const W3_START = '2026-07-31T09:00:00Z';

    assert.strictEqual((await store.getTranscriptionByMeetMeetingCode('abc-defg-hij', 'alice', { since: W1_START })).id, w1.id);
    assert.strictEqual(await store.getTranscriptionByMeetMeetingCode('abc-defg-hij', 'alice', { since: W2_START }), null,
        'week 2 has no note yet: it must be offered for import, not shown as "Note created"');

    const w2 = await store.createTranscription({ userId: 'alice', title: 'Stand-up week 2', meetMeetingCode: 'abc-defg-hij' });
    await setCreated(w2.id, '2026-07-24T10:30:00Z');
    assert.strictEqual((await store.getTranscriptionByMeetMeetingCode('abc-defg-hij', 'alice', { since: W1_START })).id, w1.id,
        'week 1 keeps its own note once week 2 has one');
    assert.strictEqual((await store.getTranscriptionByMeetMeetingCode('abc-defg-hij', 'alice', { since: W2_START })).id, w2.id);
    assert.strictEqual(await store.getTranscriptionByMeetMeetingCode('abc-defg-hij', 'alice', { since: W3_START }), null);
    assert.strictEqual(await store.getTranscriptionByMeetMeetingCode('abc-defg-hij', 'bob', { since: W1_START }), null, 'owner-scoped');

    // Without `since`: the newest note of the series, as before.
    assert.strictEqual((await store.getTranscriptionByMeetMeetingCode('abc-defg-hij', 'alice')).id, w2.id);
    // An unparseable `since` is ignored rather than matching nothing.
    assert.strictEqual((await store.getTranscriptionByMeetMeetingCode('abc-defg-hij', 'alice', { since: 'not a date' })).id, w2.id);
});

test('meetings view: an upcoming Talk occurrence in a room with an old note is not "recorded"', async () => {
    const old = await store.createTranscription({ userId: 'alice', title: 'Room stand-up', talkRoomToken: 'room123' });
    await setCreated(old.id, '2026-07-20T10:00:00Z');
    const nextStart = '2026-07-27T09:00:00Z';

    assert.strictEqual(await store.getTranscriptionByTalkRoomToken('room123', 'alice', { since: nextStart }), null);
    assert.strictEqual((await store.getTranscriptionByTalkRoomToken('room123', 'alice')).id, old.id);
});
