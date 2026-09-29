/**
 * gmeetArtifacts tests — space lookup, conference-record overlap pick, the
 * three findGeneratedRecording outcomes, setAutoRecording error
 * classification, the Drive download size pre-check / access errors, and the
 * ffmpeg audio-extraction invocation.
 *
 * googleClient, child_process and @ffmpeg-installer/ffmpeg are stubbed via
 * the Module resolve hook; no real Google/ffmpeg calls.
 *
 * Run: cd server && node --test core/meetingNotes/gmeetArtifacts.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');

// ── Mutable fixtures ─────────────────────────────────────────────────
const fx = {
    clientCalls: [],
    space: null,
    spacesGetError: null,
    patchError: null,
    records: [],
    recordings: [],
    participants: [],
    participantsError: null,
    driveMeta: null,
    metaError: null,
    mediaError: null,
    mediaBody: 'mp4-bytes',
    ffmpegExitCode: 0,
    spawnError: null,
    calls: {},
};

function resetFx() {
    fx.clientCalls.length = 0;
    fx.space = { name: 'spaces/SPACE_ID', meetingCode: 'abc-defg-hij' };
    fx.spacesGetError = null;
    fx.patchError = null;
    fx.records = [];
    fx.recordings = [];
    fx.participants = [];
    fx.participantsError = null;
    fx.driveMeta = { size: '1000', name: 'rec.mp4', mimeType: 'video/mp4' };
    fx.metaError = null;
    fx.mediaError = null;
    fx.mediaBody = 'mp4-bytes';
    fx.ffmpegExitCode = 0;
    fx.spawnError = null;
    fx.calls = { spacesGet: [], spacesPatch: [], recordsList: [], recordingsList: [], participantsList: [], driveMeta: [], driveMedia: [], spawns: [] };
}
resetFx();

const fakeMeet = {
    spaces: {
        get: async (params) => {
            fx.calls.spacesGet.push(params);
            if (fx.spacesGetError) throw fx.spacesGetError;
            return { data: fx.space };
        },
        patch: async (params) => {
            fx.calls.spacesPatch.push(params);
            if (fx.patchError) throw fx.patchError;
            return { data: {} };
        },
    },
    conferenceRecords: {
        list: async (params) => {
            fx.calls.recordsList.push(params);
            return { data: { conferenceRecords: fx.records } };
        },
        recordings: {
            list: async (params) => {
                fx.calls.recordingsList.push(params);
                return { data: { recordings: fx.recordings } };
            },
        },
        participants: {
            list: async (params) => {
                fx.calls.participantsList.push(params);
                if (fx.participantsError) throw fx.participantsError;
                return { data: { participants: fx.participants } };
            },
        },
    },
};

const fakeDrive = {
    files: {
        get: async (params, opts) => {
            if (params.alt === 'media') {
                fx.calls.driveMedia.push({ params, opts });
                if (fx.mediaError) throw fx.mediaError;
                return { data: Readable.from([Buffer.from(fx.mediaBody)]) };
            }
            fx.calls.driveMeta.push(params);
            if (fx.metaError) throw fx.metaError;
            return { data: fx.driveMeta };
        },
    },
};

function fakeSpawn(cmd, args, opts) {
    fx.calls.spawns.push({ cmd, args, opts });
    const proc = new EventEmitter();
    proc.stderr = new EventEmitter();
    setImmediate(() => {
        if (fx.spawnError) { proc.emit('error', fx.spawnError); return; }
        proc.stderr.emit('data', 'frame=1\n');
        proc.emit('close', fx.ffmpegExitCode);
    });
    return proc;
}

const MOCKS = {
    '../../integrations/googleClient': {
        createGoogleApiClient: async (session, opts) => {
            fx.clientCalls.push({ api: opts.api, version: opts.version });
            if (!session?.accessToken) throw new Error(opts?.notConnectedError || 'Not connected');
            if (opts.api === 'meet') return fakeMeet;
            if (opts.api === 'drive') return fakeDrive;
            throw new Error(`unexpected api ${opts.api}`);
        },
    },
    'child_process': { spawn: fakeSpawn },
    '@ffmpeg-installer/ffmpeg': { path: '/fake/bin/ffmpeg' },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:gmeetart:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /meetingNotes[\\/]gmeetArtifacts\.js$/.test(parent.filename) && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const {
    getSpaceByMeetingCode,
    findConferenceRecord,
    findGeneratedRecording,
    listParticipantNames,
    setAutoRecording,
    downloadRecordingToFile,
    extractAudioTrack,
} = require('./gmeetArtifacts');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmeet-artifacts-test-'));
test.after(() => {
    Module._resolveFilename = originalResolve;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

const session = { accessToken: 'at', refreshToken: 'rt' };

// gaxios-shaped API error.
function gaxErr(status, message, details) {
    const e = new Error(message);
    e.status = status;
    e.response = { status, data: { error: { code: status, message, status: status === 403 ? 'PERMISSION_DENIED' : 'FAILED_PRECONDITION', ...(details ? { details } : {}) } } };
    return e;
}

// ── getSpaceByMeetingCode ────────────────────────────────────────────

test('getSpaceByMeetingCode: resolves the code alias, null on 404', async () => {
    resetFx();
    const space = await getSpaceByMeetingCode(session, 'abc-defg-hij');
    assert.equal(space.name, 'spaces/SPACE_ID');
    assert.deepEqual(fx.calls.spacesGet[0], { name: 'spaces/abc-defg-hij' });
    assert.deepEqual(fx.clientCalls[0], { api: 'meet', version: 'v2' });

    fx.spacesGetError = gaxErr(404, 'Space not found');
    assert.equal(await getSpaceByMeetingCode(session, 'abc-defg-hij'), null);

    fx.spacesGetError = gaxErr(500, 'boom');
    await assert.rejects(() => getSpaceByMeetingCode(session, 'abc-defg-hij'), /boom/);
});

// ── findConferenceRecord ─────────────────────────────────────────────

test('findConferenceRecord: filters by space.name and picks the overlapping record', async () => {
    resetFx();
    const start = Date.parse('2026-07-16T10:00:00Z');
    const end = Date.parse('2026-07-16T11:00:00Z');
    fx.records = [
        { name: 'conferenceRecords/old', startTime: '2026-07-15T10:00:00Z', endTime: '2026-07-15T11:00:00Z' },
        { name: 'conferenceRecords/match', startTime: '2026-07-16T10:02:00Z', endTime: '2026-07-16T11:05:00Z' },
        { name: 'conferenceRecords/future', startTime: '2026-07-16T20:00:00Z', endTime: '2026-07-16T21:00:00Z' },
    ];
    const record = await findConferenceRecord(session, {
        spaceName: 'spaces/SPACE_ID',
        meetingStart: new Date(start),
        meetingEnd: new Date(end),
    });
    assert.equal(record.name, 'conferenceRecords/match');
    assert.equal(fx.calls.recordsList[0].filter, 'space.name = "spaces/SPACE_ID"');
});

test('findConferenceRecord: latest overlapping start wins; null when nothing overlaps', async () => {
    resetFx();
    fx.records = [
        { name: 'conferenceRecords/first', startTime: '2026-07-16T09:50:00Z', endTime: '2026-07-16T10:20:00Z' },
        { name: 'conferenceRecords/rejoin', startTime: '2026-07-16T10:25:00Z', endTime: '2026-07-16T11:00:00Z' },
    ];
    const record = await findConferenceRecord(session, {
        spaceName: 'spaces/SPACE_ID',
        meetingStart: '2026-07-16T10:00:00Z',
        meetingEnd: '2026-07-16T11:00:00Z',
    });
    assert.equal(record.name, 'conferenceRecords/rejoin');

    fx.records = [{ name: 'conferenceRecords/old', startTime: '2026-07-10T10:00:00Z', endTime: '2026-07-10T11:00:00Z' }];
    assert.equal(await findConferenceRecord(session, {
        spaceName: 'spaces/SPACE_ID',
        meetingStart: '2026-07-16T10:00:00Z',
        meetingEnd: '2026-07-16T11:00:00Z',
    }), null);
});

test('findConferenceRecord: a later meeting on a reused link does not steal an earlier slot', async () => {
    resetFx();
    // One standing Meet link, two teams. The 14:00 job must not pick up the
    // 16:00 conference just because it started later — the candidate window
    // runs to meetingEnd + 6h, so both are in range.
    fx.records = [
        { name: 'conferenceRecords/standup', startTime: '2026-07-16T14:01:00Z', endTime: '2026-07-16T14:28:00Z' },
        { name: 'conferenceRecords/other-team', startTime: '2026-07-16T16:00:00Z', endTime: '2026-07-16T17:00:00Z' },
    ];
    const record = await findConferenceRecord(session, {
        spaceName: 'spaces/SPACE_ID',
        meetingStart: '2026-07-16T14:00:00Z',
        meetingEnd: '2026-07-16T14:30:00Z',
    });
    assert.equal(record.name, 'conferenceRecords/standup');
});

test('findConferenceRecord: with no overlap at all, the nearest candidate wins', async () => {
    resetFx();
    // A meeting that ran entirely outside its booked slot is still the right
    // answer when it is the only plausible one — but "nearest", not "latest".
    fx.records = [
        { name: 'conferenceRecords/ran-late', startTime: '2026-07-16T11:05:00Z', endTime: '2026-07-16T11:40:00Z' },
        { name: 'conferenceRecords/much-later', startTime: '2026-07-16T15:00:00Z', endTime: '2026-07-16T16:00:00Z' },
    ];
    const record = await findConferenceRecord(session, {
        spaceName: 'spaces/SPACE_ID',
        meetingStart: '2026-07-16T10:00:00Z',
        meetingEnd: '2026-07-16T11:00:00Z',
    });
    assert.equal(record.name, 'conferenceRecords/ran-late');
});

// ── findGeneratedRecording ───────────────────────────────────────────

test('findGeneratedRecording: FILE_GENERATED → recordingName + driveFileId', async () => {
    resetFx();
    fx.recordings = [
        { name: 'conferenceRecords/cr1/recordings/r1', state: 'FILE_GENERATED', driveDestination: { file: 'drive-file-1' } },
    ];
    const res = await findGeneratedRecording(session, 'conferenceRecords/cr1');
    assert.deepEqual(res, { recordingName: 'conferenceRecords/cr1/recordings/r1', driveFileId: 'drive-file-1' });
    assert.equal(fx.calls.recordingsList[0].parent, 'conferenceRecords/cr1');
});

test('findGeneratedRecording: recordings without a generated file → notReady', async () => {
    resetFx();
    fx.recordings = [{ name: 'conferenceRecords/cr1/recordings/r1', state: 'ENDED' }];
    assert.deepEqual(await findGeneratedRecording(session, 'conferenceRecords/cr1'), { notReady: true });

    fx.recordings = [{ name: 'conferenceRecords/cr1/recordings/r1', state: 'FILE_GENERATED', driveDestination: {} }];
    assert.deepEqual(await findGeneratedRecording(session, 'conferenceRecords/cr1'), { notReady: true });
});

test('findGeneratedRecording: no recordings at all → none', async () => {
    resetFx();
    fx.recordings = [];
    assert.deepEqual(await findGeneratedRecording(session, 'conferenceRecords/cr1'), { none: true });
});

// ── listParticipantNames ─────────────────────────────────────────────

test('listParticipantNames: signed-in/anonymous/phone names, [] on error', async () => {
    resetFx();
    fx.participants = [
        { signedinUser: { displayName: 'Tom Smit' } },
        { anonymousUser: { displayName: 'Guest' } },
        { phoneUser: { displayName: '+31 6 ••• ••12' } },
        { signedinUser: { displayName: 'Tom Smit' } }, // dedup
        {},
    ];
    assert.deepEqual(await listParticipantNames(session, 'conferenceRecords/cr1'), ['Tom Smit', 'Guest', '+31 6 ••• ••12']);
    assert.equal(fx.calls.participantsList[0].parent, 'conferenceRecords/cr1');

    fx.participantsError = gaxErr(500, 'boom');
    assert.deepEqual(await listParticipantNames(session, 'conferenceRecords/cr1'), []);
});

// ── setAutoRecording ─────────────────────────────────────────────────

test('setAutoRecording: patches the resolved space name with the artifactConfig mask', async () => {
    resetFx();
    assert.deepEqual(await setAutoRecording(session, { meetingCode: 'abc-defg-hij', enabled: true }), { ok: true });
    const patch = fx.calls.spacesPatch[0];
    assert.equal(patch.name, 'spaces/SPACE_ID');
    assert.equal(patch.updateMask, 'config.artifactConfig.recordingConfig.autoRecordingGeneration');
    assert.equal(patch.requestBody.config.artifactConfig.recordingConfig.autoRecordingGeneration, 'ON');

    assert.deepEqual(await setAutoRecording(session, { meetingCode: 'abc-defg-hij', enabled: false }), { ok: true });
    assert.equal(fx.calls.spacesPatch[1].requestBody.config.artifactConfig.recordingConfig.autoRecordingGeneration, 'OFF');
});

test('setAutoRecording: 403 scope error → no_scope', async () => {
    resetFx();
    fx.patchError = gaxErr(403, 'Request had insufficient authentication scopes.', [
        { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' },
    ]);
    assert.deepEqual(await setAutoRecording(session, { meetingCode: 'abc-defg-hij', enabled: true }), { error: 'no_scope' });
});

test('setAutoRecording: plain 403 → not_host, 400 → unsupported_edition, other → error', async () => {
    resetFx();
    fx.patchError = gaxErr(403, "The caller doesn't have permission");
    assert.deepEqual(await setAutoRecording(session, { meetingCode: 'abc-defg-hij', enabled: true }), { error: 'not_host' });

    fx.patchError = gaxErr(400, 'Auto recording generation is not available for this Google Workspace edition');
    assert.deepEqual(await setAutoRecording(session, { meetingCode: 'abc-defg-hij', enabled: true }), { error: 'unsupported_edition' });

    fx.patchError = gaxErr(500, 'Internal error');
    assert.deepEqual(await setAutoRecording(session, { meetingCode: 'abc-defg-hij', enabled: true }), { error: 'error' });
});

// ── downloadRecordingToFile ──────────────────────────────────────────

test('downloadRecordingToFile: size pre-check rejects before any media request', async () => {
    resetFx();
    fx.driveMeta = { size: String(900 * 1024 * 1024), name: 'big.mp4', mimeType: 'video/mp4' };
    const dest = path.join(tmpDir, 'too-large.mp4');
    await assert.rejects(
        () => downloadRecordingToFile(session, 'drive-file-1', dest, { maxBytes: 500 * 1024 * 1024 }),
        (err) => err.code === 'recording_too_large',
    );
    assert.equal(fx.calls.driveMedia.length, 0, 'no media request after failed pre-check');
    assert.equal(fx.calls.driveMeta.length, 1);
    assert.equal(fx.calls.driveMeta[0].fields, 'size,name,mimeType');
    assert.equal(fs.existsSync(dest), false);
});

test('downloadRecordingToFile: streams the file to disk', async () => {
    resetFx();
    fx.mediaBody = 'fake-mp4-content';
    const dest = path.join(tmpDir, 'ok.mp4');
    const res = await downloadRecordingToFile(session, 'drive-file-1', dest, { maxBytes: 500 * 1024 * 1024 });
    assert.deepEqual(res, { size: 1000, name: 'rec.mp4', mimeType: 'video/mp4' });
    assert.equal(fs.readFileSync(dest, 'utf8'), 'fake-mp4-content');
    const media = fx.calls.driveMedia[0];
    assert.equal(media.params.alt, 'media');
    assert.equal(media.params.fileId, 'drive-file-1');
    assert.deepEqual(media.opts, { responseType: 'stream' });
});

test('downloadRecordingToFile: 403 on media → no_drive_access, 404 on metadata too', async () => {
    resetFx();
    fx.mediaError = gaxErr(403, 'The user does not have sufficient permissions for this file');
    await assert.rejects(
        () => downloadRecordingToFile(session, 'drive-file-1', path.join(tmpDir, 'denied.mp4'), { maxBytes: 500 * 1024 * 1024 }),
        (err) => err.code === 'no_drive_access',
    );

    resetFx();
    fx.metaError = gaxErr(404, 'File not found');
    await assert.rejects(
        () => downloadRecordingToFile(session, 'drive-file-1', path.join(tmpDir, 'missing.mp4'), { maxBytes: 500 * 1024 * 1024 }),
        (err) => err.code === 'no_drive_access',
    );

    resetFx();
    fx.metaError = gaxErr(500, 'Backend error');
    await assert.rejects(
        () => downloadRecordingToFile(session, 'drive-file-1', path.join(tmpDir, 'transient.mp4'), { maxBytes: 500 * 1024 * 1024 }),
        (err) => err.code === 'download_failed',
    );
});

// ── extractAudioTrack ────────────────────────────────────────────────

test('extractAudioTrack: spawns the resolved ffmpeg with -vn and the output path', async () => {
    resetFx();
    const out = await extractAudioTrack('/videos/in.mp4', '/videos/out.m4a');
    assert.equal(out, '/videos/out.m4a');
    const { cmd, args } = fx.calls.spawns[0];
    assert.equal(cmd, '/fake/bin/ffmpeg');
    assert.ok(args.includes('-vn'), 'strips the video track');
    assert.equal(args[args.indexOf('-i') + 1], '/videos/in.mp4');
    assert.equal(args[args.length - 1], '/videos/out.m4a');
    assert.equal(args[args.indexOf('-ac') + 1], '1', 'mono audio');
});

test('extractAudioTrack: non-zero exit rejects', async () => {
    resetFx();
    fx.ffmpegExitCode = 1;
    await assert.rejects(() => extractAudioTrack('/videos/in.mp4', '/videos/out.m4a'), /ffmpeg exited with code 1/);
});
