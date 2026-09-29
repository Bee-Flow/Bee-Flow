/**
 * `meeting.processed` — one event, three ways to get it.
 *
 * A note becomes readable when it is ingested, when it is reprocessed, or when
 * its summary is regenerated. All three have to reach the same subscribers: a
 * `meeting_tag` knowledge source that heard about ingests and not about
 * regenerates would hold the OLD summary for ever, and nobody would be able to
 * say why the answer was stale.
 *
 * ── AND WHAT IS NOT IN IT ───────────────────────────────────────────
 * The id and the tags. Not the summary, not the title, not the attendees. A
 * meeting note is among the most personal things in the product — it is a
 * transcript of colleagues talking — and this payload is handed to whatever a
 * subscription is wired to, which may be an outbound integration. A subscriber
 * entitled to the content fetches it by id through the store's own read ACL;
 * one that is not gets an id it cannot resolve. Same rule as every other
 * outbound destination (BFSF-441).
 *
 * Run: cd server && node --test --test-force-exit core/meetingNotes/meetingProcessedEvent.test.js
 */

'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

const dispatched = [];
const restore = installResolveStub({
    '../../automation/triggerBus': {
        dispatchEvent: async (evt) => { dispatched.push(evt); return []; },
    },
});
after(() => restore());

const { emitMeetingProcessed } = require('./ingestRecordingCore');

beforeEach(() => { dispatched.length = 0; });

/** The dispatch is fire-and-forget, so let its microtask land. */
const settle = () => new Promise(r => setImmediate(r));

test('an ingest announces the note, org-scoped, with its tags', async () => {
    emitMeetingProcessed({ transcriptionId: 'm1', tags: ['sales'], userId: 'u1', orgId: 'org1' });
    await settle();
    assert.strictEqual(dispatched.length, 1);
    assert.deepStrictEqual(dispatched[0], {
        provider: 'meeting-notes',
        event: 'meeting.processed',
        payload: { transcriptionId: 'm1', tags: ['sales'], orgId: 'org1' },
        userId: 'u1',
        orgId: 'org1',
    });
});

test('a regenerate is marked, so a subscriber can tell it from a new meeting', async () => {
    emitMeetingProcessed({ transcriptionId: 'm1', tags: [], userId: 'u1', orgId: 'org1', reprocessed: true });
    await settle();
    assert.strictEqual(dispatched[0].payload.reprocessed, true);
});

test('a first ingest carries no `reprocessed` key at all', async () => {
    // Absent rather than false: a filter written as "only new meetings" reads
    // more naturally against a key that is simply not there.
    emitMeetingProcessed({ transcriptionId: 'm1', tags: [], userId: 'u1', orgId: 'org1' });
    await settle();
    assert.ok(!('reprocessed' in dispatched[0].payload));
});

test('the payload carries NO content — not the summary, not the title', async () => {
    // The one property that has to survive every later edit to this event.
    emitMeetingProcessed({
        transcriptionId: 'm1', tags: ['sales'], userId: 'u1', orgId: 'org1',
        // Even if a caller passes them, they must not reach a subscriber.
        summary: 'We agreed a 12% discount for Van Dijk.',
        title: 'Salesoverleg',
        attendees: ['Tom', 'Fleur'],
    });
    await settle();
    assert.deepStrictEqual(Object.keys(dispatched[0].payload).sort(), ['orgId', 'tags', 'transcriptionId']);
    assert.ok(!JSON.stringify(dispatched[0]).includes('Van Dijk'));
    assert.ok(!JSON.stringify(dispatched[0]).includes('Fleur'));
});

test('the tags ARE carried, because that is what a subscription filters on', async () => {
    // Filtering after a fetch would mean every subscriber reading every note
    // to decide it was not interested.
    emitMeetingProcessed({ transcriptionId: 'm1', tags: ['sales', 'klant-van-dijk'], userId: 'u1', orgId: 'org1' });
    await settle();
    assert.deepStrictEqual(dispatched[0].payload.tags, ['sales', 'klant-van-dijk']);
});

test('a note with no id announces nothing', async () => {
    emitMeetingProcessed({ transcriptionId: null, tags: ['sales'], userId: 'u1' });
    emitMeetingProcessed({});
    await settle();
    assert.deepStrictEqual(dispatched, []);
});

test('a malformed tags value becomes an empty list, never a crash', async () => {
    for (const tags of [null, undefined, 'sales', 5]) {
        emitMeetingProcessed({ transcriptionId: 'm1', tags, userId: 'u1', orgId: 'org1' });
    }
    await settle();
    assert.strictEqual(dispatched.length, 4);
    for (const d of dispatched) assert.deepStrictEqual(d.payload.tags, []);
});

test('a bus that is down never fails the ingest that called it', async () => {
    // The note is already saved by the time this runs.
    const original = require.cache[Object.keys(require.cache).find(k => k.includes('stub:../../automation/triggerBus'))];
    const stub = original.exports;
    original.exports = { dispatchEvent: async () => { throw new Error('bus is down'); } };
    try {
        assert.doesNotThrow(() => emitMeetingProcessed({ transcriptionId: 'm1', tags: [], userId: 'u1' }));
        await settle();
    } finally {
        original.exports = stub;
    }
});

test('it fires AFTER the dedup check, so a lost race announces nothing', () => {
    // Genuinely textual: a concurrent ingest that lost surfaces the winner's
    // note and returns early; announcing there would tell subscribers about a
    // note this run did not create, with this run's (empty) tags. Reaching
    // that branch for real means driving the full ingestLocalRecording
    // pipeline (provider selection, transcription, audio storage) to the
    // point of a createTranscription race — the fixture that already does
    // that (`fx.raceDedup` in ingestRecordingCore.test.js) belongs to that
    // file's own scope, and duplicating it here to add one more assertion on
    // top would be a second copy of a heavy harness for a single call-order
    // fact a source check states directly.
    const src = require('node:fs').readFileSync(require.resolve('./ingestRecordingCore'), 'utf8');
    const dedupAt = src.indexOf('if (saved.dedup)');
    const emitAt = src.indexOf('emitMeetingProcessed({');
    assert.ok(dedupAt > 0 && emitAt > dedupAt, 'the emission must come after the dedup early-return');
});

test('the reprocess and regenerate routes call the same function', () => {
    // Genuinely textual, same reason as above: not their own dispatchEvent — a
    // second copy of the payload is how a subscriber ends up hearing about an
    // ingest and not about a regenerate. Both routes are single 300+ line
    // handlers that run the same real transcription pipeline this file's
    // other test declines to drive; there is no seam here smaller than that.
    const fs = require('node:fs');
    for (const route of ['../../routes/transcriptions/reprocess', '../../routes/transcriptions/noteActions']) {
        const src = fs.readFileSync(require.resolve(route), 'utf8');
        assert.match(src, /emitMeetingProcessed\(/, route);
        assert.match(src, /reprocessed: true/, route);
        assert.doesNotMatch(src, /provider: 'meeting-notes'/, `${route} must not build the payload itself`);
    }
});
