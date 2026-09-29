/**
 * ingestGmeetRecording tests — the Google Meet ingest entry point.
 *
 * Covers: dedup pre-check before any download, provider pinning + payload
 * wiring into the shared core, video cleanup on success AND failure,
 * classified Drive errors propagating untouched, and the attendee-email →
 * connected-user sharedWith mapping.
 *
 * Deps (gmeetArtifacts, ingestRecordingCore, transcriptionStore,
 * configStore/userStore) are stubbed via the Module resolve hook.
 *
 * Run: cd server && node --test core/meetingNotes/ingestGmeetRecording.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const Module = require('module');

// Same shape as the real class in ingestRecordingCore.js — the wrapper both
// consumes it (instanceof) and re-exports it.
class StubIngestError extends Error {
    constructor(message, { code = 'ingest_failed', status = 500 } = {}) {
        super(message);
        this.name = 'IngestError';
        this.code = code;
        this.status = status;
    }
}

// ── Mutable fixtures ─────────────────────────────────────────────────
const fx = {
    existingByUri: {},       // sourceUri → row (getTranscriptionBySourceUri)
    downloadError: null,     // thrown by downloadRecordingToFile
    extractError: null,      // thrown by extractAudioTrack
    ingestError: null,       // thrown by ingestLocalRecording
    usersError: null,        // thrown by getAllUsers
    driveName: 'Weekly sync (2026-07-17)',
    participantNames: [],    // listParticipantNames result
    users: [],               // getAllUsers result
    configs: {},             // key → value (getConfigsByKeys source)
    downloads: [],           // downloadRecordingToFile spy
    extracts: [],            // extractAudioTrack spy
    rosterCalls: [],         // listParticipantNames spy
    ingestCalls: [],         // ingestLocalRecording spy
};

function resetFx() {
    fx.existingByUri = {};
    fx.downloadError = null;
    fx.extractError = null;
    fx.ingestError = null;
    fx.usersError = null;
    fx.driveName = 'Weekly sync (2026-07-17)';
    fx.participantNames = [];
    fx.users = [];
    fx.configs = {};
    fx.downloads.length = 0;
    fx.extracts.length = 0;
    fx.rosterCalls.length = 0;
    fx.ingestCalls.length = 0;
}

const MOCKS = {
    './ingestRecordingCore': {
        IngestError: StubIngestError,
        // Mirrors the real guard's contract (owner passes; anyone else must be
        // readable). The guard ITSELF is tested against the real implementation
        // in ingestRecordingCore.test.js — here we only need the wrapper to
        // actually call it. Requiring the real module at this point would drag
        // in the whole LLM stack before the resolve hook is installed.
        assertDedupHitReadable: async (existing, userId) => {
            if (!existing || existing.user_id === userId) return;
            if (fx.readableIds && fx.readableIds.includes(existing.id)) return;
            throw new StubIngestError('already imported by someone else', { code: 'already_imported', status: 409 });
        },
        ingestLocalRecording: async (args) => {
            fx.ingestCalls.push(args);
            // The real core CONSUMES filePath on both success and failure.
            try { fs.unlinkSync(args.filePath); } catch (_) {}
            if (fx.ingestError) throw fx.ingestError;
            return { id: 'new-id', title: 'AI titel', dedup: false, source: args.source, sourceUri: args.sourceUri };
        },
    },
    './gmeetArtifacts': {
        downloadRecordingToFile: async (session, driveFileId, destPath, opts) => {
            fx.downloads.push({ session, driveFileId, destPath, opts });
            if (fx.downloadError) throw fx.downloadError;
            fs.writeFileSync(destPath, 'fake-video-bytes');
            return { size: 16, name: fx.driveName, mimeType: 'video/mp4' };
        },
        extractAudioTrack: async (videoPath, audioPath) => {
            fx.extracts.push({ videoPath, audioPath });
            if (fx.extractError) throw fx.extractError;
            fs.writeFileSync(audioPath, 'fake-audio-bytes');
            return audioPath;
        },
        listParticipantNames: async (session, conferenceRecordName) => {
            fx.rosterCalls.push({ conferenceRecordName });
            return fx.participantNames;
        },
    },
    '../../stores/transcriptionStore': {
        getTranscriptionBySourceUri: async (uri) => fx.existingByUri[uri] || null,
    },
    '../../stores/userStore': {
        getAllUsers: async () => {
            if (fx.usersError) throw fx.usersError;
            return fx.users;
        },
    },
    '../../stores/configStore': {
        getConfigsByKeys: async (keys) => {
            const out = {};
            for (const k of keys) {
                if (fx.configs[k] !== undefined) out[k] = fx.configs[k];
            }
            return out;
        },
    },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:ingestgmeet:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /meetingNotes[\\/]ingestGmeetRecording\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const { ingestGmeetRecording, IngestError } = require('./ingestGmeetRecording');

test.after(() => {
    Module._resolveFilename = originalResolve;
});

// Remove any temp video/audio a test left under data/uploads/audio.
function cleanupTempFiles() {
    for (const d of fx.downloads) { try { fs.unlinkSync(d.destPath); } catch (_) {} }
    for (const e of fx.extracts) { try { fs.unlinkSync(e.audioPath); } catch (_) {} }
}

function baseOpts(overrides = {}) {
    return {
        userId: 'u1', orgId: 'orgA', session: { accessToken: 'tok' },
        conferenceRecordName: 'conferenceRecords/cr1', driveFileId: 'df1',
        meetingCode: 'abc-defg-hij', title: 'Weekly sync',
        ...overrides,
    };
}

test('happy path: pins whisperx and wires source/sourceUri/meetMeetingCode into the core', async (t) => {
    t.after(cleanupTempFiles);
    resetFx();
    fx.participantNames = ['Sanne Jansen', 'Externe Gast'];
    fx.users = [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }];
    fx.configs = {
        google_workspace_email_user_u1: 'tom@beeflow.nl',   // owner — excluded
        google_workspace_email_user_u2: 'sanne@beeflow.nl', // connected attendee
    };

    const out = await ingestGmeetRecording(baseOpts({
        attendees: [
            { email: 'tom@beeflow.nl', displayName: 'Tom Smit' },
            { email: 'sanne@beeflow.nl', displayName: 'Sanne Jansen' },
        ],
    }));

    // Download + extraction happened against the temp paths.
    assert.strictEqual(fx.downloads.length, 1);
    assert.strictEqual(fx.downloads[0].driveFileId, 'df1');
    assert.ok(fx.downloads[0].destPath.endsWith('.mp4'));
    assert.strictEqual(fx.extracts.length, 1);
    assert.strictEqual(fx.extracts[0].videoPath, fx.downloads[0].destPath);
    assert.deepStrictEqual(fx.rosterCalls, [{ conferenceRecordName: 'conferenceRecords/cr1' }]);

    // Core payload.
    assert.strictEqual(fx.ingestCalls.length, 1);
    const call = fx.ingestCalls[0];
    assert.strictEqual(call.provider, 'whisperx');
    assert.strictEqual(call.source, 'gmeet');
    assert.strictEqual(call.sourceUri, 'gmeet://orgA/conferenceRecords/cr1');
    assert.strictEqual(call.titleHint, 'Weekly sync');
    assert.strictEqual(call.userId, 'u1');
    assert.strictEqual(call.orgId, 'orgA');
    assert.strictEqual(call.filePath, fx.extracts[0].audioPath);
    assert.strictEqual(call.fileName, 'Weekly sync (2026-07-17).m4a');
    assert.deepStrictEqual(call.participantNames, ['Tom Smit', 'Sanne Jansen', 'Externe Gast']);
    assert.deepStrictEqual(call.extraStoreFields, { meetMeetingCode: 'abc-defg-hij', sharedWith: ['u2'] });

    // Video deleted on success; result surfaced from the core.
    assert.ok(!fs.existsSync(fx.downloads[0].destPath), 'video deleted');
    assert.strictEqual(out.id, 'new-id');
    assert.strictEqual(out.dedup, false);
    assert.strictEqual(out.sourceUri, 'gmeet://orgA/conferenceRecords/cr1');
});

test('dedup: pre-existing sourceUri short-circuits before any download', async () => {
    resetFx();
    // The caller's OWN earlier import — always readable, no ACL check needed.
    fx.existingByUri['gmeet://orgA/conferenceRecords/cr2'] = { id: 'ex1', title: 'Bestaande note', user_id: 'u1' };
    const out = await ingestGmeetRecording(baseOpts({ conferenceRecordName: 'conferenceRecords/cr2' }));
    assert.deepStrictEqual(out, { id: 'ex1', title: 'Bestaande note', dedup: true, sourceUri: 'gmeet://orgA/conferenceRecords/cr2' });
    assert.strictEqual(fx.downloads.length, 0);
    assert.strictEqual(fx.extracts.length, 0);
    assert.strictEqual(fx.ingestCalls.length, 0);
});

test('dedup: no orgId scopes the sourceUri to the user', async () => {
    resetFx();
    fx.existingByUri['gmeet://user:u9/conferenceRecords/cr9'] = { id: 'ex9', title: 'Persoonlijk', user_id: 'u9' };
    const out = await ingestGmeetRecording(baseOpts({ userId: 'u9', orgId: null, conferenceRecordName: 'conferenceRecords/cr9' }));
    assert.deepStrictEqual(out, { id: 'ex9', title: 'Persoonlijk', dedup: true, sourceUri: 'gmeet://user:u9/conferenceRecords/cr9' });
    assert.strictEqual(fx.downloads.length, 0);
});

test('ingest failure: core error propagates and the video is still deleted', async (t) => {
    t.after(cleanupTempFiles);
    resetFx();
    fx.ingestError = new StubIngestError('whisperx down', { code: 'transcription_failed', status: 500 });
    await assert.rejects(
        () => ingestGmeetRecording(baseOpts({ conferenceRecordName: 'conferenceRecords/cr3' })),
        (err) => err instanceof IngestError && err.code === 'transcription_failed',
    );
    assert.strictEqual(fx.downloads.length, 1);
    assert.ok(!fs.existsSync(fx.downloads[0].destPath), 'video deleted on ingest failure');
    assert.ok(!fs.existsSync(fx.extracts[0].audioPath), 'audio consumed by the core');
});

test('no_drive_access from the Drive download propagates untouched', async () => {
    resetFx();
    const boom = Object.assign(new Error('organizer-only Drive access'), { code: 'no_drive_access' });
    fx.downloadError = boom;
    await assert.rejects(
        () => ingestGmeetRecording(baseOpts({ conferenceRecordName: 'conferenceRecords/cr4' })),
        (err) => err === boom,
    );
    assert.strictEqual(fx.extracts.length, 0);
    assert.strictEqual(fx.ingestCalls.length, 0);
});

test('extraction failure: classified as failed, video deleted, core never called', async (t) => {
    t.after(cleanupTempFiles);
    resetFx();
    fx.extractError = new Error('ffmpeg exited with code 1');
    await assert.rejects(
        () => ingestGmeetRecording(baseOpts({ conferenceRecordName: 'conferenceRecords/cr5' })),
        (err) => err instanceof IngestError && err.code === 'failed',
    );
    assert.strictEqual(fx.downloads.length, 1);
    assert.ok(!fs.existsSync(fx.downloads[0].destPath), 'video deleted');
    assert.strictEqual(fx.ingestCalls.length, 0);
});

test('sharedWith: two attendees, one connected non-owner user', async (t) => {
    t.after(cleanupTempFiles);
    resetFx();
    fx.users = [{ id: 'owner' }, { id: 'u5' }, { id: 'u6' }];
    fx.configs = {
        google_workspace_email_user_owner: 'a@x.nl', // attendee, but the owner
        google_workspace_email_user_u5: 'b@x.nl',    // attendee + connected
        google_workspace_email_user_u6: 'c@x.nl',    // connected, not an attendee
    };
    await ingestGmeetRecording(baseOpts({
        userId: 'owner', conferenceRecordName: 'conferenceRecords/cr6',
        attendees: [{ email: 'a@x.nl' }, { email: 'B@x.nl' }],
    }));
    assert.deepStrictEqual(fx.ingestCalls[0].extraStoreFields.sharedWith, ['u5']);
});

test('sharedWith: user lookup failure degrades to [] without failing the ingest', async (t) => {
    t.after(cleanupTempFiles);
    resetFx();
    fx.usersError = new Error('db down');
    const out = await ingestGmeetRecording(baseOpts({
        conferenceRecordName: 'conferenceRecords/cr7',
        attendees: [{ email: 'sanne@beeflow.nl' }],
    }));
    assert.deepStrictEqual(fx.ingestCalls[0].extraStoreFields.sharedWith, []);
    assert.strictEqual(out.id, 'new-id');
});
