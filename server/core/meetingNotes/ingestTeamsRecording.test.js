/**
 * ingestTeamsRecording tests — dedup key, the recording path (download →
 * audio → core, video always deleted), the transcript path (VTT → core with
 * the speakers' own names) and same-organisation sharing.
 *
 * Run: cd server && node --test core/meetingNotes/ingestTeamsRecording.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-ingest-'));
const fx = {};
function resetFx() {
    fx.existing = {};
    fx.coreCalls = [];
    fx.downloads = [];
    fx.vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n<v An>Hoi.</v>\n';
    fx.users = { 'an@x.nl': { id: 'u2', organizationId: 'orgA' }, 'ext@y.nl': { id: 'u3', organizationId: 'orgB' } };
    fx.audioBytes = 10;
}
resetFx();

class IngestError extends Error {
    constructor(message, { code, status } = {}) { super(message); this.code = code; this.status = status; }
}

const ingest = require('./ingestTeamsRecording');
const { ingestTeamsMeeting, teamsSourceUri } = ingest;
ingest.init({
    transcriptionStore: { getTranscriptionBySourceUri: async (uri) => fx.existing[uri] || null },
    core: {
        IngestError,
        assertDedupHitReadable: async () => {},
        ingestLocalRecording: async (opts) => {
            fx.coreCalls.push({ ...opts, audioExisted: opts.filePath ? fs.existsSync(opts.filePath) : null });
            // The real core consumes the input file.
            if (opts.filePath) fs.rmSync(opts.filePath, { force: true });
            return { id: 'n1', dedup: false };
        },
    },
    artifacts: {
        fetchTranscriptVtt: async () => fx.vtt,
        downloadRecordingToFile: async (session, { destPath, recordingId }) => {
            fx.downloads.push({ destPath, recordingId });
            fs.writeFileSync(destPath, 'video');
            return { size: 5 };
        },
        extractAudioTrack: async (videoPath, audioPath) => { fs.writeFileSync(audioPath, Buffer.alloc(fx.audioBytes)); },
    },
    scratchDir: scratch,
    getUserByEmail: async (email) => fx.users[email] || null,
});

const base = {
    userId: 'u1', orgId: 'orgA', session: {}, meetingId: 'MSo1', title: 'Overleg',
    attendees: [{ email: 'AN@x.nl', displayName: 'An' }, { email: 'ext@y.nl', displayName: 'Ext' }, { email: 'u1@x.nl' }],
};

test.beforeEach(resetFx);
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test('sourceUri is per owner scope and per artifact', () => {
    assert.strictEqual(teamsSourceUri({ orgId: 'orgA', userId: 'u1', meetingId: 'M', artifactKind: 'recording', artifactId: 'R' }), 'teams://orgA/M/recording/R');
    assert.strictEqual(teamsSourceUri({ orgId: null, userId: 'u1', meetingId: 'M', artifactKind: 'transcript', artifactId: 'T' }), 'teams://user:u1/M/transcript/T');
});

test('recording: audio goes to the core, the video is deleted, attendees anchor names', async () => {
    await ingestTeamsMeeting({ ...base, artifact: { kind: 'recording', id: 'R1' } });
    const call = fx.coreCalls[0];
    assert.strictEqual(fx.downloads[0].recordingId, 'R1');
    assert.ok(!fs.existsSync(fx.downloads[0].destPath), 'video removed');
    assert.ok(call.audioExisted);
    assert.match(call.filePath, /\.m4a$/);
    assert.strictEqual(call.source, 'teams');
    assert.strictEqual(call.sourceUri, 'teams://orgA/MSo1/recording/R1');
    assert.deepStrictEqual(call.participantNames, ['An', 'Ext']);
    assert.deepStrictEqual(call.extraStoreFields.sharedWith, ['u2'], 'only colleagues in the same organisation');
    assert.strictEqual(call.transcriptResponse, undefined);
});

test('recording: audio over 500 MB is refused and cleaned up', async () => {
    fx.audioBytes = 500 * 1024 * 1024 + 1;
    await assert.rejects(ingestTeamsMeeting({ ...base, artifact: { kind: 'recording', id: 'R1' } }),
        (err) => err.code === 'recording_too_large');
    assert.deepStrictEqual(fs.readdirSync(scratch), []);
});

test('transcript: parsed VTT reaches the core with the Teams names', async () => {
    await ingestTeamsMeeting({ ...base, artifact: { kind: 'transcript', id: 'T1' } });
    const call = fx.coreCalls[0];
    assert.strictEqual(call.filePath, undefined);
    assert.strictEqual(call.provider, 'teams_transcript');
    assert.strictEqual(call.speakersNamed, true);
    assert.deepStrictEqual(call.transcriptResponse.segments.map(s => s.speakerId), ['An']);
    assert.strictEqual(fx.downloads.length, 0);
});

test('transcript without speaker attribution is not marked as named; an empty one fails', async () => {
    fx.vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHoi.\n';
    await ingestTeamsMeeting({ ...base, artifact: { kind: 'transcript', id: 'T1' } });
    assert.strictEqual(fx.coreCalls[0].speakersNamed, false);
    fx.vtt = 'WEBVTT\n\n';
    await assert.rejects(ingestTeamsMeeting({ ...base, artifact: { kind: 'transcript', id: 'T2' } }),
        (err) => err.code === 'empty_transcription');
});

test('an already imported artifact returns the existing note without downloading', async () => {
    fx.existing['teams://orgA/MSo1/recording/R1'] = { id: 'old', title: 'Eerder' };
    const out = await ingestTeamsMeeting({ ...base, artifact: { kind: 'recording', id: 'R1' } });
    assert.deepStrictEqual(out, { id: 'old', title: 'Eerder', dedup: true, sourceUri: 'teams://orgA/MSo1/recording/R1' });
    assert.strictEqual(fx.downloads.length, 0);
});
