/**
 * ingestRecordingCore tests — parity guard for the Nextcloud ingest refactor.
 *
 * `ingestNextcloudRecording` delegates its provider-agnostic middle
 * (transcribe → diarize → summarize → persist) to `ingestLocalRecording`.
 * The parity tests drive the full Nextcloud wrapper with fixed fixtures and
 * pin the `createTranscription` payload + return shape to the pre-refactor
 * behavior; the core tests cover provider override, extraStoreFields
 * passthrough and sourceUri dedup.
 *
 * Deps are stubbed via the Module resolve hook.
 *
 * Run: cd server && node --test core/meetingNotes/ingestRecordingCore.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// ── Mutable fixtures ─────────────────────────────────────────────────
const fx = {
    configProvider: 'whisperx',
    existingByUri: {},       // sourceUri → row (getTranscriptionBySourceUri)
    readableIds: [],         // note ids the caller may open (canReadTranscription)
    raceDedup: false,        // createTranscription lost the ON CONFLICT race
    creates: [],             // createTranscription spy
    downloads: [],           // nextcloudClient.downloadBinary spy
    azureTruncated: null,
    azureCalls: [],
    whisperAzureCalls: [],
    transcribeCalls: [],     // transcribeWithWhisperX spy
    identifyCalls: [],       // identifySpeakerNames spy
    talkCalls: [],           // executeNextcloudTalkTool spy
    roster: [{ displayName: 'Tom Smit' }, { displayName: 'Sanne' }],
    nameMapping: { speaker_0: 'Tom', speaker_1: 'Sanne' },
    whisperResponse: {
        text: 'hallo hoi',
        segments: [
            { speakerId: 'speaker_0', start: 0, end: 5, text: 'hallo' },
            { speakerId: 'speaker_1', start: 5, end: 9, text: 'hoi' },
        ],
    },
    summary: 'Samenvatting van de meeting.',
    aiTitle: 'AI titel',
    // The default template of the owner (null = none). Determines the template
    // stamp on the note.
    defaultTemplate: null,
    actionItems: [{ text: 'Doe iets', assignee: 'Tom' }],
    artifactsFailed: false,  // de artefactpass viel om / was niet te parsen
    chapters: [{ title: 'Opening', start: '00:00' }],
};

function resetFx() {
    fx.configProvider = 'whisperx';
    fx.existingByUri = {};
    fx.readableIds = [];
    fx.raceDedup = false;
    fx.transcribeError = null;
    fx.defaultTemplate = null;
    fx.artifactsFailed = false;
    fx.creates.length = 0;
    fx.downloads.length = 0;
    fx.transcribeCalls.length = 0;
    fx.azureCalls.length = 0;
    fx.azureTruncated = null;
    fx.whisperAzureCalls.length = 0;
    fx.identifyCalls.length = 0;
    fx.talkCalls.length = 0;
    fx.ncScopeDenies = false;
}

function fmt(s) {
    const m = Math.floor((s || 0) / 60), ss = Math.floor((s || 0) % 60);
    return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

// applySpeakerNames and toContextBias are pure — use the genuine
// implementations so these parity tests exercise the real merge/dedup instead
// of a stub that could drift from it. They come from the dep-free module, not
// summaryHelpers, which would drag llmClient in and hang the test run.
const realHelpers = require('./transcriptArtifacts');

const MOCKS = {
    './summaryHelpers': {
        applySpeakerNames: realHelpers.applySpeakerNames,
        fillGenericSpeakerLabels: realHelpers.fillGenericSpeakerLabels,
        toContextBias: realHelpers.toContextBias,
        transcribeWithWhisperX: async (filePath, fileName, language, contextTerms) => {
            fx.transcribeCalls.push({ filePath, fileName, language, contextTerms });
            if (fx.transcribeError) throw fx.transcribeError;
            return fx.whisperResponse;
        },
        identifySpeakerNames: async (transcript, speakerIds, language, userName, orgId, participantNames) => {
            fx.identifyCalls.push({ speakerIds, language, userName, orgId, participantNames });
            return fx.nameMapping;
        },
        generateMeetingSummary: async () => fx.summary,
        generateMeetingTitle: async () => fx.aiTitle,
        extractMeetingArtifacts: async () => (fx.artifactsFailed
            // The REAL shared failure value, not a self-invented form:
            // a stub that invents its own 'failed' proves nothing about
            // what the pipeline does with the real one.
            ? realHelpers.ARTIFACTS_FAILED
            : {
                actionItems: fx.actionItems,
                decisions: fx.decisions || [],
                questions: fx.questions || [],
                tags: fx.autoTags || [],
                ok: true,
            }),
        artifactsUsable: realHelpers.artifactsUsable,
        ARTIFACTS_FAILED: realHelpers.ARTIFACTS_FAILED,
        generateChapters: async () => fx.chapters,
        generateSpeakerSummaries: async () => fx.speakerSummaries || {},
        applySpeakerSummaries: realHelpers.applySpeakerSummaries,
        tagSpeakerProvenance: realHelpers.tagSpeakerProvenance,
        buildPipelineNotices: realHelpers.buildPipelineNotices,
        formatTime: fmt,
        // Fresh objects per call — the pipeline mutates merged/speakers in place.
        buildTranscriptArtifacts: () => ({
            merged: [
                { speaker: 'speaker_0', speakerId: 'speaker_0', start: 0, end: 5, text: 'hallo' },
                { speaker: 'speaker_1', speakerId: 'speaker_1', start: 5, end: 9, text: 'hoi' },
            ],
            transcript: '[speaker_0] 00:00 - 00:05: hallo\n[speaker_1] 00:05 - 00:09: hoi',
            speakers: [
                { id: 'speaker_0', speakingSeconds: 5, segments: 1, speakingTime: '00:05' },
                { id: 'speaker_1', speakingSeconds: 4, segments: 1, speakingTime: '00:04' },
            ],
            totalDuration: 9,
        }),
    },
    '../../stores/transcriptionStore': {
        getTranscriptionBySourceUri: async (uri) => fx.existingByUri[uri] || null,
        // The real ACL lives in the store; here, "readable" means the note is
        // explicitly listed in `fx.readableIds`.
        canReadTranscription: async (id) => fx.readableIds.includes(id),
        createTranscription: async (payload) => {
            fx.creates.push(payload);
            if (fx.raceDedup) return { id: 'race-winner', dedup: true };
            return { id: 'new-id' };
        },
    },
    '../../stores/configStore': {
        getConfig: async (k) => {
            if (k === 'transcription_provider') return fx.configProvider;
            return null; // local_whisper_enabled etc.
        },
        getSecret: async () => null,
    },
    '../voice/azureSpeech': {
        transcribeWithAzureSpeech: async (filePath, opts) => {
            fx.azureCalls.push({ filePath, opts });
            return { text: 'az', segments: [{ speakerId: 'Guest-1', start: 0, end: 2, text: 'az' }], truncated: fx.azureTruncated || null };
        },
    },
    '../voice/azureWhisperBatch': {
        runAzureWhisperBatch: async (opts) => {
            fx.whisperAzureCalls.push(opts);
            return { text: 'wa', segments: [{ speakerId: 'Guest-1', start: 0, end: 2, text: 'wa' }], durationSeconds: 2 };
        },
    },
    '../../stores/userStore': {
        getUser: async () => ({ id: 'u1', firstName: 'Tom' }),
    },
    '../../stores/summaryTemplateStore': {
        resolveDefaultTemplate: async () => fx.defaultTemplate,
        resolveDefaultPrompt: async () => (fx.defaultTemplate ? fx.defaultTemplate.prompt : null),
    },
    '../../integrations/nextcloudClient': {
        downloadBinary: async (session, userId, ncPath, destPath) => {
            fx.downloads.push({ ncPath, destPath });
            fs.writeFileSync(destPath, 'fake-audio-bytes');
        },
    },
    // The write-back now passes the per-user Nextcloud scope guard, whose real
    // implementation reads the scope from Postgres and — correctly — FAILS
    // CLOSED when it cannot. In this DB-free harness that turned the parity
    // test red, so the guard is stubbed to its two real outcomes: run the call,
    // or refuse it. `fx.ncScopeDenies` exercises the refusal below.
    '../integrations/ncScopeGuard': {
        guardedNcCall: async (toolName, toolArgs, ctx, run) => (
            fx.ncScopeDenies
                ? { error: 'out of scope', nc_scope_denied: true }
                : run()
        ),
    },
    '../../integrations/nextcloudTalkTools': {
        executeNextcloudTalkTool: async (tool, args) => {
            fx.talkCalls.push({ tool, args });
            if (tool === 'nextcloud_talk_list_participants') return { participants: fx.roster };
            return {};
        },
    },
};
// Core reaches these clients through core/integrations/integrationClients.js
// (boot registers the real ones).
require('../integrations/integrationClients').registerIntegrationClients({
    nextcloud: () => MOCKS['../../integrations/nextcloudClient'],
    nextcloudTalk: () => MOCKS['../../integrations/nextcloudTalkTools'],
});
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:ingestcore:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /meetingNotes[\\/]ingest(NextcloudRecording|RecordingCore|Transcription)\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const { ingestNextcloudRecording, IngestError } = require('./ingestNextcloudRecording');

test.after(() => {
    Module._resolveFilename = originalResolve;
    // Remove the audio copies the pipeline persisted under saved-recordings.
    for (const c of fx.allCreates || []) {
        if (c.audioPath) { try { fs.unlinkSync(c.audioPath); } catch (_) {} }
    }
});
fx.allCreates = [];

// Expected post-name-mapping artifacts (shared by parity + core assertions).
const MAPPED_SEGMENTS = [
    { speaker: 'Tom', speakerId: 'speaker_0', start: 0, end: 5, text: 'hallo' },
    { speaker: 'Sanne', speakerId: 'speaker_1', start: 5, end: 9, text: 'hoi' },
];
const MAPPED_TRANSCRIPT = '[Tom] 00:00 - 00:05: hallo\n[Sanne] 00:05 - 00:09: hoi';
const MAPPED_SPEAKERS = [
    { id: 'Tom', speakingSeconds: 5, segments: 1, speakingTime: '00:05' },
    { id: 'Sanne', speakingSeconds: 4, segments: 1, speakingTime: '00:04' },
];

function trackCreates() {
    fx.allCreates.push(...fx.creates);
}

// ── Parity: Talk recording through the full Nextcloud wrapper ────────
test('parity: talk ingest produces the pre-refactor createTranscription payload and result', async () => {
    resetFx();
    const out = await ingestNextcloudRecording({
        userId: 'u1', session: { user: { id: 'u1' } }, orgId: 'orgA',
        ncPath: '/Talk/tok123/rec.mp4', talkRoomToken: 'tok123', source: 'talk',
    });
    trackCreates();

    assert.strictEqual(fx.downloads.length, 1);
    assert.strictEqual(fx.downloads[0].ncPath, '/Talk/tok123/rec.mp4');
    assert.strictEqual(fx.transcribeCalls.length, 1);
    assert.strictEqual(fx.transcribeCalls[0].fileName, 'rec.mp4');
    assert.strictEqual(fx.transcribeCalls[0].language, 'nl');

    // Roster + resolved first name reach the speaker-naming step.
    assert.strictEqual(fx.identifyCalls.length, 1);
    assert.deepStrictEqual(fx.identifyCalls[0].participantNames, ['Tom Smit', 'Sanne']);
    assert.strictEqual(fx.identifyCalls[0].userName, 'Tom');
    assert.strictEqual(fx.identifyCalls[0].orgId, 'orgA');

    // createTranscription payload — the pre-refactor shape.
    assert.strictEqual(fx.creates.length, 1);
    const p = fx.creates[0];
    assert.ok(p.audioPath && fs.existsSync(p.audioPath), 'audio persisted for playback');
    assert.deepStrictEqual({ ...p, audioPath: '<checked>' }, {
        userId: 'u1', organizationId: 'orgA', title: 'AI titel', fileName: 'rec.mp4', language: 'nl',
        durationSeconds: 9, speakerCount: 2, segmentCount: 2,
        fullText: 'hallo hoi', transcript: MAPPED_TRANSCRIPT,
        segments: MAPPED_SEGMENTS, speakers: MAPPED_SPEAKERS,
        summary: fx.summary, audioPath: '<checked>', provider: 'whisperx',
        actionItems: fx.actionItems, chapters: fx.chapters,
        // Structured artifacts from the combined extraction pass (empty in fx).
        decisions: [], questions: [], tags: [],
        // Durable object-storage copy; null here because no RustFS/S3 in the test env.
        audioStorageKey: null,
        // The resolved roster is PERSISTED, not just used in-memory for naming.
        // Without it, re-transcribing an auto-imported note started blind and
        // relabelled everyone "Spreker 1/2" — the manual upload path has always
        // stored its attendees.
        attendees: ['Tom Smit', 'Sanne'],
        source: 'talk', sourceUri: 'talk://orgA/tok123/rec.mp4', talkRoomToken: 'tok123',
        // With which template the summary was written. Without a default
        // template that is NOTHING: the built-in first-generation prompt is
        // none of the five built-in templates, so there is nothing true to
        // report about it and nothing is claimed.
        summaryTemplateId: null, summaryTemplateVersion: null,
    });

    // Public result shape.
    assert.deepStrictEqual(out, {
        id: 'new-id', title: 'AI titel', fileName: 'rec.mp4', language: 'nl',
        duration: '00:09', durationSeconds: 9, speakerCount: 2, segmentCount: 2,
        speakers: MAPPED_SPEAKERS, fullText: 'hallo hoi',
        transcript: MAPPED_TRANSCRIPT, segments: MAPPED_SEGMENTS,
        summary: fx.summary, actionItems: fx.actionItems,
        source: 'talk', sourceUri: 'talk://orgA/tok123/rec.mp4', talkRoomToken: 'tok123',
        dedup: false, writeBack: null,
    });
});

test('parity: plain nextcloud ingest (no talk room) derives sourceUri and skips the roster', async () => {
    resetFx();
    const out = await ingestNextcloudRecording({
        userId: 'u1', session: {}, orgId: null,
        ncPath: '/Recordings/standup.mp3',
    });
    trackCreates();

    assert.strictEqual(fx.talkCalls.length, 0);
    assert.deepStrictEqual(fx.identifyCalls[0].participantNames, []);
    const p = fx.creates[0];
    assert.strictEqual(p.source, 'nextcloud');
    assert.strictEqual(p.sourceUri, 'nextcloud://u1/Recordings/standup.mp3');
    assert.strictEqual(p.talkRoomToken, null);
    assert.strictEqual(out.source, 'nextcloud');
    assert.strictEqual(out.sourceUri, 'nextcloud://u1/Recordings/standup.mp3');
    assert.strictEqual(out.dedup, false);
    assert.strictEqual(out.writeBack, null);
});

test('parity: pre-existing sourceUri short-circuits before download', async () => {
    resetFx();
    // Tenant-scoped key: a Talk room token is unique per Nextcloud, not per
    // Bee Flow tenant, so the org (or `user:<id>` when personal) is part of it.
    fx.existingByUri['talk://user:u1/tok9/rec.mp4'] = { id: 'ex1', title: 'Bestaande note', user_id: 'u1' };
    const out = await ingestNextcloudRecording({
        userId: 'u1', session: {}, ncPath: '/Talk/tok9/rec.mp4', talkRoomToken: 'tok9', source: 'talk',
    });
    assert.deepStrictEqual(out, { id: 'ex1', title: 'Bestaande note', dedup: true, sourceUri: 'talk://user:u1/tok9/rec.mp4', writeBack: null });
    assert.strictEqual(fx.downloads.length, 0);
    assert.strictEqual(fx.transcribeCalls.length, 0);
    assert.strictEqual(fx.creates.length, 0);
});

test('a Talk recording imported by one tenant does not dedup against another', async () => {
    resetFx();
    // Same Nextcloud, same room token, two Bee Flow orgs. `source_uri` carries
    // a GLOBAL unique index, so an unscoped key let org B's import return org
    // A's note id — unopenable for B — and B's recording was never transcribed.
    fx.existingByUri['talk://orgA/tok9/rec.mp4'] = { id: 'ex1', title: 'Note van org A', user_id: 'someone-else' };
    const out = await ingestNextcloudRecording({
        userId: 'u2', orgId: 'orgB', session: {}, ncPath: '/Talk/tok9/rec.mp4', talkRoomToken: 'tok9', source: 'talk',
    });
    assert.strictEqual(out.dedup, false);
    assert.strictEqual(out.sourceUri, 'talk://orgB/tok9/rec.mp4');
    assert.strictEqual(fx.creates.length, 1, 'org B gets its own note');
});

test('a dedup hit the caller cannot read is refused, not handed over', async () => {
    resetFx();
    // Same org, colleague already imported it, note not shared with us. The old
    // code answered 200 with {id, title} — leaking the title and handing the
    // client an id that 404s the moment it opens it.
    fx.existingByUri['talk://orgA/tok9/rec.mp4'] = { id: 'ex1', title: 'Salarisbespreking', user_id: 'colleague' };
    await assert.rejects(
        () => ingestNextcloudRecording({
            userId: 'u2', orgId: 'orgA', session: {}, ncPath: '/Talk/tok9/rec.mp4',
            talkRoomToken: 'tok9', source: 'talk', accessCtx: { orgIds: ['orgA'] },
        }),
        (err) => {
            assert.strictEqual(err.code, 'already_imported');
            assert.strictEqual(err.status, 409);
            assert.ok(!/Salarisbespreking/.test(err.message), 'the title must not leak');
            return true;
        },
    );
    assert.strictEqual(fx.downloads.length, 0);
});

test('parity: losing the createTranscription race returns the winner with dedup', async () => {
    resetFx();
    fx.raceDedup = true;
    const out = await ingestNextcloudRecording({
        userId: 'u1', session: {}, ncPath: '/Recordings/x.mp3',
    });
    trackCreates();
    assert.deepStrictEqual(out, { id: 'race-winner', title: 'AI titel', dedup: true, sourceUri: 'nextcloud://u1/Recordings/x.mp3', writeBack: null });
});

test('parity: postSummaryBack posts into the Talk room', async () => {
    resetFx();
    const out = await ingestNextcloudRecording({
        userId: 'u1', session: {}, ncPath: '/Talk/tokW/rec.mp4', talkRoomToken: 'tokW', source: 'talk',
        postSummaryBack: true,
    });
    trackCreates();
    assert.deepStrictEqual(out.writeBack, { ok: true });
    const send = fx.talkCalls.find(c => c.tool === 'nextcloud_talk_send_message');
    assert.ok(send, 'summary message sent');
    assert.strictEqual(send.args.token, 'tokW');
    assert.ok(send.args.message.includes('AI titel'));
    assert.ok(send.args.message.includes('Doe iets'));
});

// ── Core: ingestLocalRecording ────────────────────────────────────────
const core = require('./ingestRecordingCore');
const { ingestLocalRecording } = core;

function makeLocalFile(ext = '.mp3') {
    const p = path.join(os.tmpdir(), `ingest-core-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    fs.writeFileSync(p, 'fake-audio-bytes');
    return p;
}

test('core: IngestError is the same class the wrapper re-exports', () => {
    assert.strictEqual(core.IngestError, IngestError);
});

test('core: explicit provider overrides the configured transcription_provider', async () => {
    resetFx();
    fx.configProvider = 'voxtral'; // would demand a Mistral key if honored
    const filePath = makeLocalFile();
    const out = await ingestLocalRecording({
        userId: 'u1', orgId: 'orgA', filePath, fileName: 'meet.m4a',
        provider: 'whisperx', source: 'gmeet', sourceUri: 'gmeet://orgA/rec1',
    });
    trackCreates();
    assert.strictEqual(fx.transcribeCalls.length, 1);
    assert.strictEqual(fx.creates[0].provider, 'whisperx');
    assert.strictEqual(out.source, 'gmeet');
    assert.strictEqual(out.dedup, false);
    assert.ok(!fs.existsSync(filePath), 'input file consumed');
});

test('core: workspace engine azure transcribes via Azure Speech, not Voxtral', async () => {
    resetFx();
    fx.configProvider = 'azure';
    const filePath = makeLocalFile();
    await ingestLocalRecording({
        userId: 'u1', filePath, fileName: 'meet.m4a', language: 'en', contextTerms: 'alpha',
        source: 'teams', sourceUri: 'teams://orgA/az1',
    });
    trackCreates();
    assert.strictEqual(fx.azureCalls.length, 1);
    assert.strictEqual(fx.azureCalls[0].opts.language, 'en');
    assert.strictEqual(fx.azureCalls[0].opts.contextTerms, 'alpha');
    assert.strictEqual(fx.creates[0].provider, 'azure');
});

test('core: a truncated Azure transcript puts the early-stop notice on the summary', async () => {
    resetFx();
    fx.configProvider = 'azure';
    fx.azureTruncated = { reason: 'inactivity', atSeconds: 2 };
    const filePath = makeLocalFile();
    await ingestLocalRecording({
        userId: 'u1', filePath, fileName: 'meet.m4a', language: 'en',
        source: 'teams', sourceUri: 'teams://orgA/az2',
    });
    trackCreates();
    assert.match(fx.creates[0].summary, /stopped early at 00:02/);
});

test('core: workspace engine whisper_azure runs the Azure Whisper batch', async () => {
    resetFx();
    fx.configProvider = 'whisper_azure';
    const filePath = makeLocalFile();
    await ingestLocalRecording({
        userId: 'u1', filePath, fileName: 'meet.m4a', language: 'en',
        source: 'teams', sourceUri: 'teams://orgA/wa1',
    });
    trackCreates();
    assert.strictEqual(fx.whisperAzureCalls.length, 1);
    assert.strictEqual(fx.whisperAzureCalls[0].fileName, 'meet.m4a');
    assert.strictEqual(fx.whisperAzureCalls[0].language, 'en');
    assert.strictEqual(fx.creates[0].provider, 'whisper_azure');
});

test('core: absent provider falls back to the configured one', async () => {
    resetFx();
    fx.configProvider = 'whisperx';
    const filePath = makeLocalFile();
    await ingestLocalRecording({
        userId: 'u1', filePath, source: 'gmeet', sourceUri: 'gmeet://orgA/rec1b',
    });
    trackCreates();
    assert.strictEqual(fx.transcribeCalls.length, 1);
    assert.strictEqual(fx.creates[0].provider, 'whisperx');
});

test('core: extraStoreFields land in the createTranscription payload', async () => {
    resetFx();
    const filePath = makeLocalFile();
    await ingestLocalRecording({
        userId: 'u1', filePath, fileName: 'meet.m4a', provider: 'whisperx',
        source: 'gmeet', sourceUri: 'gmeet://orgA/rec2',
        extraStoreFields: { meetMeetingCode: 'abc-defg-hij', talkRoomToken: null },
    });
    trackCreates();
    assert.strictEqual(fx.creates.length, 1);
    assert.strictEqual(fx.creates[0].meetMeetingCode, 'abc-defg-hij');
    assert.strictEqual(fx.creates[0].talkRoomToken, null);
    assert.strictEqual(fx.creates[0].source, 'gmeet');
    assert.strictEqual(fx.creates[0].sourceUri, 'gmeet://orgA/rec2');
});

test('core: pre-existing sourceUri returns the existing row without transcribing', async () => {
    resetFx();
    fx.existingByUri['gmeet://orgA/rec3'] = { id: 'ex-g', title: 'Bestaand' };
    const filePath = makeLocalFile();
    const out = await ingestLocalRecording({
        userId: 'u1', filePath, provider: 'whisperx', source: 'gmeet', sourceUri: 'gmeet://orgA/rec3',
    });
    assert.deepStrictEqual(out, { id: 'ex-g', title: 'Bestaand', dedup: true, sourceUri: 'gmeet://orgA/rec3' });
    assert.strictEqual(fx.transcribeCalls.length, 0);
    assert.strictEqual(fx.creates.length, 0);
    assert.ok(!fs.existsSync(filePath), 'input file consumed');
});

test('core: losing the createTranscription race returns the winner with dedup', async () => {
    resetFx();
    fx.raceDedup = true;
    const filePath = makeLocalFile();
    const out = await ingestLocalRecording({
        userId: 'u1', filePath, provider: 'whisperx', source: 'gmeet', sourceUri: 'gmeet://orgA/rec4',
    });
    trackCreates();
    assert.deepStrictEqual(out, { id: 'race-winner', title: 'AI titel', dedup: true, sourceUri: 'gmeet://orgA/rec4' });
});

test('core: transcription failure unlinks the input and throws a classified IngestError', async () => {
    resetFx();
    fx.transcribeError = new Error('whisperx down');
    const filePath = makeLocalFile();
    await assert.rejects(
        () => ingestLocalRecording({ userId: 'u1', filePath, provider: 'whisperx', source: 'gmeet', sourceUri: 'gmeet://orgA/rec5' }),
        (err) => err instanceof IngestError && err.code === 'transcription_failed' && err.message === 'whisperx down',
    );
    assert.strictEqual(fx.creates.length, 0);
    assert.ok(!fs.existsSync(filePath), 'input file consumed');
});

test('the Talk write-back is skipped when the room is outside the user\'s scope', async () => {
    // Posting a meeting summary into a conversation the user asked Bee Flow to
    // stay out of is a write into a room they excluded — the whole reason this
    // path was routed through the guard.
    resetFx();
    fx.ncScopeDenies = true;
    const out = await ingestNextcloudRecording({
        userId: 'u1', session: {}, ncPath: '/Talk/tokX/rec.mp4', talkRoomToken: 'tokX', source: 'talk',
        postSummaryBack: true,
    });
    trackCreates();
    assert.deepStrictEqual(out.writeBack, { ok: false, error: 'nc_scope_denied' });
    assert.ok(!fx.talkCalls.some(c => c.tool === 'nextcloud_talk_send_message'),
        'and nothing was posted');
});


// ── DE SJABLOONSTEMPEL OP EEN AUTO-INGEST ────────────────────────────

test('core: het standaardsjabloon van de eigenaar stempelt de notitie', async () => {
    resetFx();
    fx.defaultTemplate = { id: 'tpl-7', name: 'Standaard', prompt: 'DEFAULT PROMPT', version: 3 };
    await ingestNextcloudRecording({
        userId: 'u1', session: { user: { id: 'u1' } }, orgId: 'orgA',
        ncPath: '/Talk/tok123/rec.mp4', talkRoomToken: 'tok123', source: 'talk',
    });
    trackCreates();

    const p = fx.creates[0];
    assert.strictEqual(p.summaryTemplateId, 'tpl-7');
    assert.strictEqual(p.summaryTemplateVersion, 3, 'de versie van dít moment, niet die van straks');
});

test('core: zonder standaardsjabloon stempelt de ingest niets', async () => {
    // The built-in first-generation prompt is none of the five built-in
    // templates. Stamping 'builtin:general' would name a template that did not
    // write this text.
    resetFx();
    fx.defaultTemplate = null;
    await ingestNextcloudRecording({
        userId: 'u1', session: { user: { id: 'u1' } }, orgId: 'orgA',
        ncPath: '/Talk/tok123/rec.mp4', talkRoomToken: 'tok123', source: 'talk',
    });
    trackCreates();

    const p = fx.creates[0];
    assert.strictEqual(p.summaryTemplateId, null);
    assert.strictEqual(p.summaryTemplateVersion, null);
});


// ── A FAILED ARTIFACT PASS IS NOT AN EMPTY MEETING ─────────────────
//
// This writer passed `artifacts.actionItems/decisions/questions` through raw. On a failed pass (a
// fallen-over or unparseable smart tier) that yielded a COMPLETED note that claims nothing was agreed,
// without a single word on the screen. The meeting may have lasted hours; nobody can see from the note
// that the pass never ran, so nobody presses "Regenerate". buildPipelineNotices is precisely the channel
// for that: the same place where an engine fallback and a truncated transcription already stand.

test('core: een mislukte artefactpass zegt dat op de notitie en claimt geen lege vergadering', async () => {
    resetFx();
    fx.artifactsFailed = true;
    fx.autoTags = ['planning'];   // must NOT come from a failed pass

    await ingestNextcloudRecording({
        userId: 'u1', session: { user: { id: 'u1' } }, orgId: 'orgA',
        ncPath: '/Talk/tok123/rec.mp4', talkRoomToken: 'tok123', source: 'talk',
    });
    trackCreates();

    assert.strictEqual(fx.creates.length, 1);
    const p = fx.creates[0];
    // Het scherm ZEGT het: de notitieregel staat boven de samenvatting, in de
    // taal van de vergadering.
    assert.match(p.summary, /actiepunten/i, 'de notitie meldt de mislukte pass');
    assert.ok(p.summary.includes(fx.summary), 'de samenvatting zelf blijft staan');
    // Nothing is claimed as the result of the pass, and that must be VISIBLE. These assertions stood as
    // `p.actionItems || []`, and `undefined || []` is `[]`: they therefore also passed if the gate had
    // not been there at all and `artifacts.actionItems` (undefined on a failed pass) had been passed
    // through raw. Precisely the `|| []` pattern that this fix abolishes elsewhere. Without a fallback, a
    // missing key is an error.
    for (const key of ['actionItems', 'decisions', 'questions', 'tags']) {
        assert.ok(key in p, `${key} hoort geschreven te worden, ook (juist) als lege lijst`);
        assert.deepStrictEqual(p[key], [], `${key}: een pass die niet gedraaid heeft claimt niets`);
    }
});

test('core: een GESLAAGDE pass zegt niets extra en schrijft gewoon wat hij vond', async () => {
    // De keerzijde: de notitieregel mag niet op elke vergadering verschijnen.
    resetFx();
    fx.autoTags = ['planning'];
    await ingestNextcloudRecording({
        userId: 'u1', session: { user: { id: 'u1' } }, orgId: 'orgA',
        ncPath: '/Talk/tok123/rec.mp4', talkRoomToken: 'tok123', source: 'talk',
    });
    trackCreates();

    const p = fx.creates[0];
    assert.strictEqual(p.summary, fx.summary, 'geen notitieregel op een geslaagde pass');
    assert.deepStrictEqual(p.actionItems, fx.actionItems);
    assert.deepStrictEqual(p.tags, ['planning']);
});

test('core: a ready-made transcript (Teams VTT) skips transcription, naming and audio', async () => {
    resetFx();
    const out = await ingestLocalRecording({
        userId: 'u1', orgId: 'orgA', fileName: 'Overleg.vtt',
        provider: 'teams_transcript', source: 'teams', sourceUri: 'teams://orgA/MSo1/transcript/T1',
        transcriptResponse: { text: 'hallo hoi', segments: fx.whisperResponse.segments },
        speakersNamed: true,
    });
    trackCreates();
    assert.strictEqual(fx.transcribeCalls.length, 0, 'no transcription engine call');
    assert.strictEqual(fx.identifyCalls.length, 0, 'the platform already named the speakers');
    assert.strictEqual(fx.creates[0].provider, 'teams_transcript');
    assert.strictEqual(fx.creates[0].audioPath, '');
    assert.strictEqual(fx.creates[0].audioStorageKey, null);
    assert.deepStrictEqual(fx.creates[0].speakers.map(s => s.id), ['speaker_0', 'speaker_1'],
        'names kept as given, not replaced by "Spreker N"');
    assert.strictEqual(out.source, 'teams');
});

test('core: without a transcript a filePath is still required', async () => {
    resetFx();
    await assert.rejects(ingestLocalRecording({ userId: 'u1' }), (err) => err.code === 'missing_path');
});
