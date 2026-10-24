/**
 * Upload route — POST /api/transcriptions (async-202 + background pipeline).
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────
 * This is the writer where, on a failed artifact pass, there is actually something
 * to ERASE: the note already exists (status 'processing'), is visible and editable,
 * and the pipeline lands on top of it minutes later. Yet the whole upload half of
 * the gate — `artifactsUsable` around actionItems/decisions/questions/tagsIfEmpty,
 * plus the note line — had no single test: the gate could revert to the old raw
 * write without one transcription suite squeaking.
 *
 * The multer middleware is replaced by a pass-through (there is no real multipart
 * stream in this harness); `req.file` is set by the dispatch, exactly as multer
 * would do it.
 *
 * Run: cd server && node --test --test-force-exit routes/transcriptions/upload.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// ── A real file on disk: the route copies it to saved-recordings ──
const AUDIO_PATH = path.join(os.tmpdir(), `upload-test-${Date.now()}.webm`);
fs.writeFileSync(AUDIO_PATH, 'fake-audio-bytes');
// The route really stores the audio on disk (saved-recordings); clean up what
// this harness left behind there.
const savedCopies = new Set();
test.after(() => {
    try { fs.unlinkSync(AUDIO_PATH); } catch (_) {}
    for (const f of savedCopies) { try { fs.unlinkSync(f); } catch (_) {} }
});

// multer → doorlaat. `upload.single('audio')` mag in dit harnas niets doen.
stub('multer', Object.assign(() => ({ single: () => (req, _res, next) => next() }), {
    diskStorage: () => ({}), memoryStorage: () => ({}),
}));

let createFails = null;    // set per test: createTranscription rejects with it
const creates = [];        // createTranscription-payloads
const updates = [];        // updateTranscription-aanroepen
stub('../../stores/transcriptionStore', {
    createTranscription: async (payload) => {
        if (createFails) throw createFails;
        creates.push(payload);
        if (payload.audioPath) savedCopies.add(payload.audioPath);
        return { id: 't-new', ...payload };
    },
    updateTranscription: async (id, userId, patch) => { updates.push({ id, userId, patch }); return { id }; },
});
// Per-test knobs for the provider selection tests below.
const cfg = { config: {}, secrets: {} };
stub('../../stores/configStore', {
    getConfig: async (k) => (k in cfg.config ? cfg.config[k] : (k === 'transcription_provider' ? 'whisperx' : null)),
    getSecret: async (k) => cfg.secrets[k] || null,
});
const providerCalls = { local: [], voxtral: [], mistralClient: [], azure: [], whisperAzure: [] };
let azureResult = { text: 'azuretekst', truncated: null, segments: [{ speakerId: 'speaker_0', start: 0, end: 3, text: 'azure' }] };
stub('../../core/voice/azureSpeech', { transcribeWithAzureSpeech: async (...a) => { providerCalls.azure.push(a); return azureResult; } });
stub('../../integrations/transcriptionTools', { runAzureWhisperBatch: async (a) => { providerCalls.whisperAzure.push(a); return { text: 'whisperazure', segments: [{ speakerId: 'speaker_0', start: 0, end: 3, text: 'wa' }] }; } });
let localImpl = async () => ({ text: 'lokaal', segments: [{ speakerId: 'speaker_0', start: 0, end: 3, text: 'lokaal' }] });
stub('../../core/voice/localWhisper', { transcribeLocally: async (...a) => { providerCalls.local.push(a); return localImpl(...a); } });
stub('../../core/meetingNotes/voxtralClient', {
    createVoxtralClient: (key, opts) => {
        providerCalls.mistralClient.push({ key, opts });
        return { audio: { transcriptions: { complete: async (req) => { providerCalls.voxtral.push(req); return { text: 'voxtral', segments: [{ speakerId: 'speaker_0', start: 0, end: 4, text: 'dag' }] }; } } } };
    },
});
stub('../../stores/userStore', { getUser: async () => ({ firstName: 'Tom', groups: [] }), getAllGroups: async () => [] });
stub('../../auth', { resolveUserOrgIds: async () => new Set(['org-1']) });
stub('../../auth/permissions', { requireAuth: (req, res, next) => next() });
stub('../../stores/summaryTemplateStore', { resolveDefaultTemplate: async () => null, resolveDefaultPrompt: async () => null });
stub('../../stores/storageStore', { getStatus: () => ({ configured: false }), isAvailable: () => false });
stub('../../core/meetingNotes/savedAudioStore', {
    AUDIO_SCRATCH_DIR: os.tmpdir(),
    savedAudioKey: (base) => `saved-recordings/${base}`,
    persistSavedAudioToStorage: async () => ({ ok: false, reason: 'not_configured' }),
});

// The PURE helpers for real, the LLM helpers stubbed. `artifactsUsable` and
// `buildPipelineNotices` are deliberately the real ones: which outcome this route
// may write, and whether it reports that, is exactly what is at stake here.
const pure = require('../../core/meetingNotes/transcriptArtifacts');
let artifactsResult = null;   // wat extractMeetingArtifacts teruggeeft (per test)
stub('../../core/meetingNotes/summaryHelpers', {
    transcribeWithWhisperX: async () => ({
        text: 'hallo hoi',
        segments: [
            { speakerId: 'speaker_0', start: 0, end: 5, text: 'hallo' },
            { speakerId: 'speaker_1', start: 6, end: 9, text: 'hoi' },
        ],
    }),
    transcribeWithScaleway: async () => ({ segments: [] }),
    identifySpeakerNames: async () => null,
    generateMeetingSummary: async () => 'Samenvatting van de meeting.',
    generateMeetingTitle: async () => 'AI titel',
    generateChapters: async () => [{ title: 'Opening', start: '00:00' }],
    generateSpeakerSummaries: async () => ({}),
    extractMeetingArtifacts: async () => artifactsResult,
    // Puur — de echte implementaties, geen stubs die kunnen wegdrijven.
    applySpeakerSummaries: pure.applySpeakerSummaries,
    tagSpeakerProvenance: pure.tagSpeakerProvenance,
    toContextBias: pure.toContextBias,
    applySpeakerNames: pure.applySpeakerNames,
    fillGenericSpeakerLabels: pure.fillGenericSpeakerLabels,
    buildTranscriptArtifacts: pure.buildTranscriptArtifacts,
    buildPipelineNotices: pure.buildPipelineNotices,
    artifactsUsable: pure.artifactsUsable,
    ARTIFACTS_FAILED: pure.ARTIFACTS_FAILED,
});

// Filing into a project: the access decision is projects/meetingFiling.js's
// own (meetingFiling.test.js); here only how the upload route USES the answer.
const target = { asked: [], announced: [], answer: { ok: true, projectId: 'p1' }, throws: false };
stub('../../projects/meetingFiling', {
    resolve: async (userId, orgId, projectId) => {
        target.asked.push({ userId, orgId, projectId });
        if (target.throws) throw new Error('projects table is down');
        return target.answer;
    },
    announce: async (projectId, actorId, meetingId) => { target.announced.push({ projectId, actorId, meetingId }); },
});

const emitted = [];
stub('../../core/meetingNotes/ingestRecordingCore', {
    emitMeetingProcessed: (payload) => { emitted.push(payload); },
});

const router = require('./upload');

function dispatch({ body = {}, file = true, user = 'owner-1' } = {}) {
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST', url: '/', query: {}, headers: {}, body,
            session: user ? { isAuthenticated: true, user: { id: user } } : null,
            ...(file ? { file: { path: AUDIO_PATH, originalname: 'standup.webm', size: 17 } } : {}),
            get(name) { return this.headers[String(name).toLowerCase()]; },
            setTimeout() {},
        };
        const res = {
            statusCode: 200, headers: {}, body: undefined,
            set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
            setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
            setTimeout() {},
            headersSent: false,
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error('viel door de router heen'));
            // As the terminal handler answers: an HttpError keeps its status, message and code.
            if (err.expose) return res.status(err.status).json({ error: err.message, code: err.code });
            return reject(err);
        });
    });
}

/** De 202 komt vóór de achtergrondpijplijn; wacht op zijn afdruk. */
async function waitFor(cond, ms = 4000) {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > ms) throw new Error('time-out op de achtergrondpijplijn');
        await new Promise(r => setTimeout(r, 10));
    }
}

/** De laatste update die de notitie afrondt (status 'completed'). */
function completion() {
    return updates.map(u => u.patch).filter(p => p.status === 'completed').pop();
}

test.beforeEach(() => {
    // De route ruimt de tijdelijke upload na afloop op (fs.unlinkSync), dus
    // elke test heeft zijn eigen kopie nodig.
    fs.writeFileSync(AUDIO_PATH, 'fake-audio-bytes');
    creates.length = 0;
    updates.length = 0;
    emitted.length = 0;
    target.asked.length = 0;
    target.announced.length = 0;
    target.answer = { ok: true, projectId: 'p1' };
    target.throws = false;
    cfg.config = {};
    cfg.secrets = {};
    providerCalls.local.length = 0;
    providerCalls.voxtral.length = 0;
    providerCalls.mistralClient.length = 0;
    providerCalls.azure.length = 0;
    providerCalls.whisperAzure.length = 0;
    azureResult = { text: 'azuretekst', truncated: null, segments: [{ speakerId: 'speaker_0', start: 0, end: 3, text: 'azure' }] };
    localImpl = async () => ({ text: 'lokaal', segments: [{ speakerId: 'speaker_0', start: 0, end: 3, text: 'lokaal' }] });
    createFails = null;
    artifactsResult = {
        actionItems: [{ id: 'ai-0', text: 'Offerte sturen', assignee: 'Tom', timestamp: '00:02', done: false }],
        decisions: [{ id: 'd-0', text: 'Besloten: plan A', timestamp: '00:03' }],
        questions: [{ id: 'q-0', text: 'Wie regelt de zaal?', timestamp: '00:04', open: true }],
        tags: ['planning'],
        ok: true,
    };
});

test('een GESLAAGDE pass schrijft de drie lijsten en de tags weg', async () => {
    const res = await dispatch();
    assert.strictEqual(res.statusCode, 202);
    await waitFor(() => !!completion());

    const p = completion();
    assert.deepStrictEqual(p.actionItems, artifactsResult.actionItems);
    assert.deepStrictEqual(p.decisions, artifactsResult.decisions);
    assert.deepStrictEqual(p.questions, artifactsResult.questions);
    assert.deepStrictEqual(p.tagsIfEmpty, ['planning'], 'auto-tags vullen alleen een lege kolom');
    // No notes line on a successful pass.
    assert.strictEqual(p.summary, 'Samenvatting van de meeting.');
});

test('een MISLUKTE pass laat de drie kolommen ONAANGERAAKT en zegt het op de notitie', async () => {
    // The note is set to 'processing' but is already open and editable: whoever records a decision in
    // that window must not lose it through a pass that never ran. `undefined` means in updateTranscription
    // "do not touch this column" — an EMPTY list would wipe it instead.
    artifactsResult = pure.ARTIFACTS_FAILED;
    await dispatch();
    await waitFor(() => !!completion());

    const p = completion();
    assert.strictEqual('actionItems' in p, false, 'action_items wordt niet geschreven');
    assert.strictEqual('decisions' in p, false, 'decisions wordt niet geschreven');
    assert.strictEqual('questions' in p, false, 'questions wordt niet geschreven');
    assert.strictEqual('tagsIfEmpty' in p, false, 'geen tags uit een pass die niet gedraaid heeft');
    // And the screen CAN say so: the note line is the only channel left after the 202.
    assert.match(p.summary, /actiepunten/i, 'de notitie meldt de mislukte pass');
    assert.ok(p.summary.includes('Samenvatting van de meeting.'), 'de samenvatting zelf blijft staan');
});

test('een antwoord ZONDER lijsten telt niet als geslaagde pass', async () => {
    // The old gate was `ok !== false`; a shape that did not set the flag got through, and
    // `artifacts.actionItems` (undefined) emptied the column.
    artifactsResult = {};
    await dispatch();
    await waitFor(() => !!completion());

    const p = completion();
    assert.strictEqual('actionItems' in p, false);
    assert.strictEqual('decisions' in p, false);
    assert.strictEqual('questions' in p, false);
    assert.match(p.summary, /actiepunten/i);
});

test('een GESLAAGDE LEGE pass ruimt de kolommen wél op', async () => {
    // The flip side, so that "narrowing" does not secretly become "never replace again":
    // a meeting in which nothing was agreed should clean up outdated AI rows.
    artifactsResult = { actionItems: [], decisions: [], questions: [], tags: [], ok: true };
    await dispatch();
    await waitFor(() => !!completion());

    const p = completion();
    assert.deepStrictEqual(p.actionItems, []);
    assert.deepStrictEqual(p.decisions, []);
    assert.deepStrictEqual(p.questions, []);
    assert.strictEqual('tagsIfEmpty' in p, false, 'geen lege tag-lijst over bestaande tags heen');
    assert.strictEqual(p.summary, 'Samenvatting van de meeting.', 'geen notitieregel: de pass is gewoon gelukt');
});

// ═══ Filing the new note into a project ═══════════════════════════════

test('with a projectId the uploader may use, the note is created IN the project and announced', async () => {
    const res = await dispatch({ body: { projectId: 'p1' } });
    assert.strictEqual(res.statusCode, 202);
    assert.strictEqual(res.body.projectId, 'p1');
    assert.strictEqual(target.asked.length, 1);
    assert.strictEqual(target.asked[0].userId, 'owner-1');
    assert.strictEqual(target.asked[0].projectId, 'p1');
    assert.strictEqual(creates.length, 1);
    assert.strictEqual(creates[0].projectId, 'p1', 'filed at birth, in the same INSERT');
    assert.deepStrictEqual(target.announced, [{ projectId: 'p1', actorId: 'owner-1', meetingId: 't-new' }]);
    await waitFor(() => !!completion());
});

test('without a projectId nothing about projects is asked and the note is private', async () => {
    const res = await dispatch({ body: { projectId: '' } });
    assert.strictEqual(res.statusCode, 202);
    assert.strictEqual(res.body.projectId, null);
    assert.deepStrictEqual(target.asked, []);
    assert.strictEqual(creates[0].projectId, null);
    assert.deepStrictEqual(target.announced, []);
    await waitFor(() => !!completion());
});

test('a refused project stops the upload before anything is saved, and the temp file is gone', async () => {
    target.answer = { ok: false, status: 403, code: 'forbidden', error: 'You can view this project, but only its editors can add meeting notes to it.' };
    const res = await dispatch({ body: { projectId: 'p1' } });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'forbidden');
    assert.strictEqual(creates.length, 0, 'no note');
    assert.deepStrictEqual(target.announced, []);
    assert.strictEqual(fs.existsSync(AUDIO_PATH), false, 'the upload is not left on disk');
});

test('a project access check that cannot be answered is a refusal, never a blind filing', async () => {
    target.throws = true;
    const res = await dispatch({ body: { projectId: 'p1' } });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.code, 'project_check_unavailable');
    assert.ok(!JSON.stringify(res.body).includes('projects table'), 'no internal detail');
    assert.strictEqual(creates.length, 0);
});

test('a finished upload announces meeting.processed once, after the note is complete', async () => {
    await dispatch();
    await waitFor(() => emitted.length > 0);
    assert.ok(completion(), 'the note was completed before the announcement');
    assert.strictEqual(emitted.length, 1);
    assert.deepStrictEqual(emitted[0].tags, ['planning']);
    assert.strictEqual(emitted[0].userId, 'owner-1');
    assert.strictEqual(emitted[0].reprocessed, undefined);
});

// ═══ Characterisation: intake, provider choice, fallback, failure ═════════

/** The last failed write on the note. */
function failure() {
    return updates.map(u => u.patch).filter(p => p.status === 'failed').pop();
}

test('a request without a file is a 400', async () => {
    const res = await dispatch({ file: false });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.body, { error: 'No audio file uploaded' });
    assert.strictEqual(creates.length, 0);
});

test('the 202 carries id, status, title, fileName and projectId; the note is created from the form', async () => {
    const res = await dispatch({ body: { title: 'Weekstart', language: 'en', attendees: 'Anna, Bert', num_speakers: '3', capture_mode: 'recording' } });
    assert.strictEqual(res.statusCode, 202);
    assert.deepStrictEqual(res.body, { id: 't-new', status: 'processing', title: 'Weekstart', fileName: 'standup.webm', projectId: null });
    assert.strictEqual(creates.length, 1);
    const c = creates[0];
    assert.strictEqual(c.userId, 'owner-1');
    assert.strictEqual(c.organizationId, 'org-1');
    assert.strictEqual(c.title, 'Weekstart');
    assert.strictEqual(c.fileName, 'standup.webm');
    assert.strictEqual(c.language, 'en');
    assert.strictEqual(c.status, 'processing');
    assert.strictEqual(c.provider, 'whisperx');
    assert.deepStrictEqual(c.attendees, ['Anna', 'Bert']);
    assert.strictEqual(c.numSpeakers, 3);
    assert.strictEqual(c.source, 'recording');
    assert.strictEqual(c.audioStorageKey, null);
    assert.ok(c.audioPath.endsWith('.webm') && fs.existsSync(c.audioPath), 'the audio was saved up front');
    await waitFor(() => !!completion());
});

test('without a title the file name is the placeholder, and the AI title replaces it only while unchanged', async () => {
    const res = await dispatch();
    assert.strictEqual(res.body.title, 'standup.webm');
    await waitFor(() => !!completion());
    assert.deepStrictEqual(completion().titleIfUnchanged, { title: 'AI titel', expected: 'standup.webm' });
    assert.strictEqual(completion().provider, 'whisperx');
    assert.strictEqual(completion().durationSeconds, 9);
    assert.strictEqual(completion().summaryTemplateId, null, 'the (empty) template stamp is written');
    assert.strictEqual(completion().summaryTemplateVersion, null);
});

test('the temporary upload is removed after a successful run', async () => {
    await dispatch();
    await waitFor(() => !!completion());
    assert.strictEqual(fs.existsSync(AUDIO_PATH), false);
});

test('a provider the admin did not allow is a 403 with the allowed list, and the upload is dropped', async () => {
    cfg.config.transcription_providers_allowed = ['whisperx', 'scaleway'];
    const res = await dispatch({ body: { provider: 'pyannote' } });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(res.body, {
        error: 'That transcription engine is not enabled for this workspace.',
        code: 'provider_not_allowed',
        allowed: ['whisperx', 'scaleway'],
    });
    assert.strictEqual(creates.length, 0);
    assert.strictEqual(fs.existsSync(AUDIO_PATH), false);
});

test('the configured default is always allowed, and local needs local_whisper_enabled', async () => {
    cfg.config.transcription_providers_allowed = ['scaleway'];
    let res = await dispatch({ body: { provider: 'whisperx' } });
    assert.strictEqual(res.statusCode, 202, 'whisperx is the configured default');
    await waitFor(() => !!completion());

    fs.writeFileSync(AUDIO_PATH, 'fake-audio-bytes');
    cfg.config = { local_whisper_enabled: false };
    res = await dispatch({ body: { provider: 'local' } });
    assert.strictEqual(res.statusCode, 403);
    assert.ok(!res.body.allowed.includes('local'));
    assert.deepStrictEqual(res.body.allowed, ['voxtral', 'whisperx', 'scaleway', 'azure', 'whisper_azure', 'pyannote']);
});

test('an empty allowed list means every known engine', async () => {
    cfg.config.transcription_providers_allowed = [];
    const res = await dispatch({ body: { provider: 'scaleway' } });
    assert.strictEqual(res.statusCode, 202);
    await waitFor(() => !!failure() || !!completion());
});

test('local transcribes on-device with the language and records provider local', async () => {
    const res = await dispatch({ body: { provider: 'local', language: 'en' } });
    assert.strictEqual(res.statusCode, 202);
    assert.strictEqual(creates[0].provider, 'local');
    await waitFor(() => !!completion());
    assert.deepStrictEqual(providerCalls.local[0], [AUDIO_PATH, { language: 'en' }]);
    assert.strictEqual(completion().fullText, 'lokaal');
    assert.strictEqual(completion().provider, 'local');
});

test('local too long falls back to voxtral, says so on the note and records the new provider', async () => {
    localImpl = async () => { const e = new Error('Recording too long'); e.code = 'local_whisper_too_long'; throw e; };
    cfg.secrets.mistral_api_key = 'k';
    await dispatch({ body: { provider: 'local', context_terms: 'Acme, Bee' } });
    await waitFor(() => !!completion());
    const p = completion();
    assert.strictEqual(p.provider, 'voxtral');
    assert.strictEqual(p.fullText, 'voxtral');
    assert.notStrictEqual(p.summary, 'Samenvatting van de meeting.', 'a notice line is prepended');
    assert.ok(p.summary.endsWith('Samenvatting van de meeting.'));
    assert.strictEqual(creates[0].provider, 'local', 'the note was created with the requested engine');
    assert.deepStrictEqual(providerCalls.mistralClient[0].key, 'k');
    assert.deepStrictEqual(providerCalls.voxtral[0].contextBias, ['Acme', 'Bee']);
    assert.strictEqual(providerCalls.voxtral[0].model, 'voxtral-mini-2602');
    assert.strictEqual(providerCalls.voxtral[0].file.fileName, 'standup.webm');
});

test('local too long with no cloud engine configured fails the note with the combined reason', async () => {
    localImpl = async () => { const e = new Error('Recording too long'); e.code = 'local_whisper_too_long'; throw e; };
    const old = process.env.WHISPERX_URL;
    delete process.env.WHISPERX_URL;
    try {
        await dispatch({ body: { provider: 'local' } });
        await waitFor(() => !!failure());
    } finally { if (old !== undefined) process.env.WHISPERX_URL = old; }
    assert.strictEqual(failure().summary, 'Transcription failed: Recording too long. No cloud provider is configured — ask an admin to enable Voxtral, WhisperX or Azure, or split the recording.');
    assert.strictEqual(completion(), undefined);
});

test('a local model that is missing fails the note', async () => {
    localImpl = async () => null;
    await dispatch({ body: { provider: 'local' } });
    await waitFor(() => !!failure());
    assert.strictEqual(failure().summary, 'Transcription failed: Local transcription model is not available. Try again, or pick a cloud provider.');
});

test('voxtral without an API key fails the note and the temp file is gone', async () => {
    cfg.config.transcription_provider = 'voxtral';
    await dispatch();
    await waitFor(() => !!failure());
    assert.strictEqual(failure().summary, 'Transcription failed: Mistral API key not configured. Go to Admin → AI Config → API Keys.');
    assert.strictEqual(fs.existsSync(AUDIO_PATH), false);
});

test('a transcription without segments fails the note instead of completing it empty', async () => {
    cfg.config.transcription_provider = 'scaleway';
    await dispatch();
    await waitFor(() => !!failure());
    assert.strictEqual(failure().summary, 'Transcription failed: Transcription returned no segments.');
    assert.strictEqual(completion(), undefined);
    assert.strictEqual(emitted.length, 0);
    assert.strictEqual(fs.existsSync(AUDIO_PATH), false);
});

test('a failure before the note exists is a 500 transcription_failed and writes nothing', async () => {
    createFails = new Error('db down');
    const res = await dispatch();
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(res.body.code, 'transcription_failed');
    assert.strictEqual(res.body.error, 'Transcription failed');
    assert.strictEqual(updates.length, 0);
});

test('azure: transcribes with language and context terms, and a salvaged partial transcript is announced on the note', async () => {
    cfg.config.transcription_provider = 'azure';
    azureResult = { ...azureResult, truncated: { seconds: 600 } };
    await dispatch({ body: { language: 'en', context_terms: 'Acme' } });
    await waitFor(() => !!completion());
    assert.deepStrictEqual(providerCalls.azure[0], [AUDIO_PATH, { language: 'en', contextTerms: 'Acme' }]);
    const p = completion();
    assert.strictEqual(p.fullText, 'azuretekst');
    assert.strictEqual(p.provider, 'azure');
    assert.notStrictEqual(p.summary, 'Samenvatting van de meeting.', 'a truncation notice is prepended');
    assert.ok(p.summary.endsWith('Samenvatting van de meeting.'));
});

test('whisper_azure: gets the file, name, language and speaker hint, and keeps its text and segments', async () => {
    cfg.config.transcription_provider = 'whisper_azure';
    await dispatch({ body: { language: 'en', num_speakers: '2' } });
    await waitFor(() => !!completion());
    assert.deepStrictEqual(providerCalls.whisperAzure[0], { filePath: AUDIO_PATH, fileName: 'standup.webm', language: 'en', numSpeakers: 2 });
    assert.strictEqual(completion().fullText, 'whisperazure');
    assert.strictEqual(completion().provider, 'whisper_azure');
});
