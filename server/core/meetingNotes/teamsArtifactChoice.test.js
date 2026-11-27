'use strict';
/**
 * Which artifact of a Teams meeting becomes the note, by the chosen text
 * source: the order, the way back to the other source, and the wait for a
 * transcript that Teams has not published yet.
 *
 * Run: cd server && node --test core/meetingNotes/teamsArtifactChoice.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseArtifact, transcriptUnusable, transcriptWaitMs, DEFAULT_TRANSCRIPT_WAIT_MINUTES } = require('./teamsArtifactChoice.mts');

const END = Date.parse('2026-11-20T10:00:00Z');
const SLOT = { meetingStart: '2026-11-20T09:00:00Z', meetingEnd: '2026-11-20T10:00:00Z' };
const minutesAfterEnd = (m) => END + m * 60_000;
const coded = (code) => Object.assign(new Error(code), { code });

/** The listings of one meeting; `calls` records which were asked, in order. */
function meeting({ recordings = [], transcripts = [], transcriptError = null } = {}) {
    const calls = [];
    return {
        calls,
        deps: {
            listRecordings: async () => { calls.push('recordings'); return recordings; },
            listTranscripts: async () => { calls.push('transcripts'); if (transcriptError) throw transcriptError; return transcripts; },
            pickArtifactForSlot: (items) => items[0] || null,
            artifactsForSlot: (items) => items,
        },
    };
}
const choose = (m, over = {}) => chooseArtifact(m.deps, { session: {}, meetingId: 'M1', slot: SLOT, source: 'recording', transcriptAllowed: true, now: minutesAfterEnd(5), ...over });

test.afterEach(() => { delete process.env.TEAMS_TRANSCRIPT_WAIT_MINUTES; });

test('source recording: the recording wins and the transcripts are not even listed', async () => {
    const m = meeting({ recordings: [{ id: 'R1' }], transcripts: [{ id: 'T1' }] });
    assert.deepEqual(await choose(m), { kind: 'recording', id: 'R1' });
    assert.deepEqual(m.calls, ['recordings']);
});

test('source recording: without a recording the transcript is the way back, when the permission allows it', async () => {
    assert.deepEqual(await choose(meeting({ transcripts: [{ id: 'T1' }] })), { kind: 'transcript', id: 'T1' });
    assert.equal(await choose(meeting({ transcripts: [{ id: 'T1' }] }), { transcriptAllowed: false }), null);
    assert.equal(await choose(meeting({ transcriptError: coded('transcript_access_disabled') })), null);
});

test('source transcript: the transcript wins over a recording, and the recordings are not listed', async () => {
    const m = meeting({ recordings: [{ id: 'R1' }], transcripts: [{ id: 'T1' }] });
    assert.deepEqual(await choose(m, { source: 'transcript' }), { kind: 'transcript', id: 'T1' });
    assert.deepEqual(m.calls, ['transcripts']);
});

test('source transcript: a recording without a transcript waits while Teams may still publish one', async () => {
    const m = meeting({ recordings: [{ id: 'R1' }] });
    assert.equal(await choose(m, { source: 'transcript', now: minutesAfterEnd(DEFAULT_TRANSCRIPT_WAIT_MINUTES - 1) }), null);
    assert.deepEqual(await choose(m, { source: 'transcript', now: minutesAfterEnd(DEFAULT_TRANSCRIPT_WAIT_MINUTES + 1) }), { kind: 'recording', id: 'R1' });
});

test('source transcript: a run the member is watching does not wait', async () => {
    const m = meeting({ recordings: [{ id: 'R1' }] });
    assert.deepEqual(await choose(m, { source: 'transcript', wait: false }), { kind: 'recording', id: 'R1' });
});

test('source transcript: no transcript can come, so the recording is used at once', async () => {
    const withoutPermission = meeting({ recordings: [{ id: 'R1' }], transcripts: [{ id: 'T1' }] });
    assert.deepEqual(await choose(withoutPermission, { source: 'transcript', transcriptAllowed: false }), { kind: 'recording', id: 'R1' });
    assert.deepEqual(withoutPermission.calls, ['recordings'], 'the transcripts are not asked for without the permission');
    const switchedOff = meeting({ recordings: [{ id: 'R1' }], transcriptError: coded('transcript_access_disabled') });
    assert.deepEqual(await choose(switchedOff, { source: 'transcript' }), { kind: 'recording', id: 'R1' });
});

test('source transcript: neither a transcript nor a recording is nothing yet; another Graph failure is thrown', async () => {
    assert.equal(await choose(meeting(), { source: 'transcript' }), null);
    await assert.rejects(choose(meeting({ transcriptError: coded('graph_forbidden') }), { source: 'transcript' }), { code: 'graph_forbidden' });
});

test('the other parts of a stopped and restarted recording or transcript are counted', async () => {
    assert.deepEqual(await choose(meeting({ recordings: [{ id: 'R1' }, { id: 'R2' }] })), { kind: 'recording', id: 'R1', extraRecordings: 1 });
    assert.deepEqual(await choose(meeting({ transcripts: [{ id: 'T1' }, { id: 'T2' }, { id: 'T3' }] }), { source: 'transcript' }), { kind: 'transcript', id: 'T1', extraRecordings: 2 });
});

test('TEAMS_TRANSCRIPT_WAIT_MINUTES sets the wait, and 0 switches it off', async () => {
    assert.equal(transcriptWaitMs(), DEFAULT_TRANSCRIPT_WAIT_MINUTES * 60_000);
    process.env.TEAMS_TRANSCRIPT_WAIT_MINUTES = '5';
    assert.equal(transcriptWaitMs(), 5 * 60_000);
    process.env.TEAMS_TRANSCRIPT_WAIT_MINUTES = '0';
    const m = meeting({ recordings: [{ id: 'R1' }] });
    assert.deepEqual(await choose(m, { source: 'transcript', now: minutesAfterEnd(1) }), { kind: 'recording', id: 'R1' });
});

test('transcriptUnusable: only the codes that say this transcript cannot be used', () => {
    for (const code of ['transcript_access_disabled', 'speaker_attribution_disabled', 'empty_transcription']) assert.equal(transcriptUnusable(coded(code)), true, code);
    for (const err of [coded('graph_forbidden'), coded('timeout'), new Error('plain'), null, undefined]) assert.equal(transcriptUnusable(err), false);
});
