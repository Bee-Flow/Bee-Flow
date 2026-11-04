/**
 * Reprocess route: POST /api/transcriptions/:id/reprocess (async-202).
 *
 * Characterisation of the route as it behaves today: the guard clauses
 * before the claim (404/403/410/503/409), the provider dispatch, what the
 * conditional write carries, what is announced, and how a failure after the
 * 202 lands on the note. The heavy collaborators are stubbed; the pure
 * artifact helpers are the real ones.
 *
 * Run: cd server && node --test routes/transcriptions/reprocess.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { preloadStubs } = require('../../testUtils/stubRequire');

const stub = (p, exports) => preloadStubs(require, { [p]: exports });

const AUDIO_PATH = path.join(os.tmpdir(), `reprocess-test-${Date.now()}.webm`);
fs.writeFileSync(AUDIO_PATH, 'fake-audio-bytes');
test.after(() => { try { fs.unlinkSync(AUDIO_PATH); } catch (_) {} });

const pure = require('../../core/meetingNotes/transcriptArtifacts');

// ── state the stubs read and write (reset per test) ──
const calls = {
    getTranscription: [], claim: [], finish: [], run: [], emitted: [], repair: [],
    identify: [], extract: [], summary: [], pyannote: [], whisperx: [], local: [],
    cleanup: 0, warn: [], mistralClient: [], heartbeat: [],
};
/** The answer of the n-th heartbeat (1-based); true = the claim is still held. */
let heartbeatResult = () => true;
let note;
let audio;
let claimResult;
let finishResult;
let runResult;
let provider;
let mistralKey;
let artifactsResult;
let whisperxResult;
let localResult;
let pyannoteResult;

stub('../../telemetry/log', {
    ...require('../../telemetry/logSafe'),
    info() {}, debug() {}, error() {}, warn: (...a) => { calls.warn.push(a.join(' ')); },
});
stub('../../stores/transcriptionStore', {
    getTranscription: async (...a) => { calls.getTranscription.push(a); return note; },
    claimForProcessing: async (...a) => { calls.claim.push(a); return claimResult; },
    heartbeatProcessing: async (...a) => { calls.heartbeat.push(a); return heartbeatResult(calls.heartbeat.length); },
    finishProcessing: async (...a) => { calls.finish.push(a); return finishResult; },
});
stub('../../stores/configStore', {
    getConfig: async (k) => (k === 'transcription_provider' ? provider : null),
    getSecret: async (k) => (k === 'mistral_api_key' ? mistralKey : null),
});
stub('../../auth/permissions', { requireAuth: (req, res, next) => next() });
stub('../../core/voice/audioPreprocess', {
    asM4aIfAdts: async (p, fileName) => ({ path: p, fileName: `m4a:${fileName}`, cleanup() {} }),
});
stub('./shared', {
    parseSpeakerCount: (raw) => { const n = parseInt(raw, 10); return Number.isFinite(n) && n >= 1 ? Math.min(n, 50) : null; },
    resolveAccessContext: async () => ({ orgIds: ['org-1'], userGroupIds: ['g-1'], isSuperAdmin: false }),
    resolveUserOrgFromReq: async () => 'org-1',
    resolveDefaultTemplateForReq: async () => ({ id: 'tpl-1', version: 3, prompt: 'TPL-PROMPT' }),
    VOXTRAL_TIMEOUT_MS: 1234,
});
stub('../../stores/userStore', { getUser: async () => ({ firstName: 'Tom' }) });
stub('../../core/meetingNotes/savedAudioStore', {
    resolveSavedAudio: async () => audio,
    repairSavedAudio: async (a) => { calls.repair.push(a); },
});
stub('../../core/meetingNotes/summaryHelpers', {
    transcribeWithWhisperX: async (...a) => { calls.whisperx.push(a); if (whisperxResult instanceof Error) throw whisperxResult; return whisperxResult; },
    transcribeWithScaleway: async () => ({ segments: [] }),
    identifySpeakerNames: async (...a) => { calls.identify.push(a); return null; },
    generateMeetingSummary: async (...a) => { calls.summary.push(a); return 'Nieuwe samenvatting.'; },
    generateChapters: async () => [{ title: 'Opening', start: '00:00' }],
    generateSpeakerSummaries: async () => ({}),
    extractMeetingArtifacts: async (...a) => { calls.extract.push(a); return artifactsResult; },
    applySpeakerSummaries: pure.applySpeakerSummaries,
    tagSpeakerProvenance: pure.tagSpeakerProvenance,
    applySpeakerNames: pure.applySpeakerNames,
    fillGenericSpeakerLabels: pure.fillGenericSpeakerLabels,
    buildTranscriptArtifacts: pure.buildTranscriptArtifacts,
    buildPipelineNotices: pure.buildPipelineNotices,
    artifactsUsable: pure.artifactsUsable,
});
stub('../../db', { run: async (sql, params) => { calls.run.push({ sql, params }); return runResult; } });
stub('../../stores/transcriptCrypto', {
    resolveTranscriptCrypto: async (org) => ({ org }),
    // Tags every value, so a write that skipped the sealing step is visible in the UPDATE params.
    encryptRow: (id, row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, { sealed: v }])),
    buildSnippet: (id, text) => `snip:${text}`,
    buildSummarySnippet: (id, text) => `ssnip:${text}`,
});
stub('../../core/meetingNotes/ingestRecordingCore', {
    emitMeetingProcessed: (p) => { calls.emitted.push(p); },
});
stub('../../core/voice/localWhisper', { transcribeLocally: async (...a) => { calls.local.push(a); return localResult; } });
stub('../../core/voice/pyannoteClient', { transcribeWithPyannote: async (...a) => { calls.pyannote.push(a); return pyannoteResult; } });
stub('../../core/meetingNotes/voxtralClient', {
    createVoxtralClient: (key, opts) => {
        calls.mistralClient.push({ key, opts });
        return { audio: { transcriptions: { complete: async (req) => ({ text: 'voxtral', segments: [{ speakerId: 'speaker_0', start: 0, end: 4, text: 'dag', req }] }) } } };
    },
});

const router = require('./reprocess');

function dispatch({ user = 'owner-1', id = 't-1' } = {}) {
    return new Promise((resolve) => {
        const req = {
            method: 'POST', url: `/${id}/reprocess`, query: {}, headers: {}, body: {},
            params: { id },
            session: { isAuthenticated: true, user: { id: user } },
            get(name) { return this.headers[String(name).toLowerCase()]; },
        };
        const res = {
            statusCode: 200, headers: {}, body: undefined, headersSent: false,
            set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
            setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => resolve({ error: err, statusCode: err && err.status, body: err && { code: err.code, message: err.message } }));
    });
}

async function waitFor(cond, ms = 4000) {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > ms) throw new Error('timeout on the background pipeline');
        await new Promise(r => setTimeout(r, 10));
    }
}
const settle = () => new Promise(r => setTimeout(r, 60));

test.beforeEach(() => {
    for (const k of Object.keys(calls)) calls[k] = Array.isArray(calls[k]) ? [] : 0;
    note = {
        id: 't-1', isOwner: true, ownerId: 'owner-1', organizationId: 'org-9', status: 'completed',
        provider: 'whisperx', fileName: 'standup.webm', language: 'en', numSpeakers: '3',
        source: 'upload', createdAt: '2026-03-04T10:00:00Z', attendees: ['Anna'],
        audioStorageKey: null,
        speakers: [{ id: 'Piet', source: 'manual' }, { id: 'Guest-1', source: 'ai' }, { id: '  ', source: 'manual' }],
        actionItems: [{ id: 'mine', text: 'typed by hand', source: 'manual' }],
        decisions: [], questions: [],
    };
    audio = { path: AUDIO_PATH, fromStorage: false, cleanup() { calls.cleanup += 1; } };
    claimResult = true;
    finishResult = true;
    heartbeatResult = () => true;
    runResult = { rowCount: 1 };
    provider = 'voxtral';
    mistralKey = 'key';
    whisperxResult = {
        text: 'hallo hoi',
        segments: [
            { speakerId: 'speaker_0', start: 0, end: 5, text: 'hallo' },
            { speakerId: 'speaker_1', start: 6, end: 9, text: 'hoi' },
        ],
    };
    localResult = { text: 'lokaal', segments: [{ speakerId: 'speaker_0', start: 0, end: 3, text: 'lokaal' }] };
    pyannoteResult = {
        text: 'pyannote tekst',
        segments: [{ speakerId: 'speaker_0', start: 0, end: 3, text: 'tekst' }],
        voiceprintMapping: { speaker_0: 'Anna' },
        voiceprintRoster: ['Anna', 'Bert'],
        voiceprintRuledOut: ['Carl'],
        voiceprintInfo: { detail: [{ speaker: 'speaker_0', name: 'Anna' }] },
    };
    artifactsResult = {
        actionItems: [{ id: 'ai-0', text: 'Offerte sturen', assignee: 'Tom', timestamp: '00:02', done: false }],
        decisions: [{ id: 'd-0', text: 'Plan A', timestamp: '00:03' }],
        questions: [{ id: 'q-0', text: 'Zaal?', timestamp: '00:04', open: true }],
        tags: ['planning'],
        ok: true,
    };
});

// ═══ Guards before the claim ═══════════════════════════════════════════

test('an unknown note is a 404 and nothing is claimed', async () => {
    note = null;
    const res = await dispatch();
    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(res.body, { error: 'Not found' });
    assert.strictEqual(calls.claim.length, 0);
    assert.deepStrictEqual(calls.getTranscription[0], ['t-1', 'owner-1', { orgIds: ['org-1'], userGroupIds: ['g-1'], isSuperAdmin: false }]);
});

test('a non-owner gets 403', async () => {
    note.isOwner = false;
    const res = await dispatch();
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(res.body, { error: 'Only the owner can reprocess' });
    assert.strictEqual(calls.claim.length, 0);
});

test('gone audio of an upload is a 410 audio_gone_uploaded', async () => {
    audio = { path: null, reason: 'missing', cleanup() { calls.cleanup += 1; } };
    const res = await dispatch();
    assert.strictEqual(res.statusCode, 410);
    assert.strictEqual(res.body.code, 'audio_gone_uploaded');
    assert.strictEqual(res.body.error, 'The saved audio is no longer available. Upload the original file again to re-transcribe it.');
    assert.strictEqual(calls.claim.length, 0);
    assert.strictEqual(calls.cleanup, 1, 'the finally still cleans up');
});

test('gone audio of a browser recording is a 410 audio_gone_recorded', async () => {
    note.source = 'recording';
    audio = { path: null, reason: 'missing' };
    const res = await dispatch();
    assert.strictEqual(res.statusCode, 410);
    assert.strictEqual(res.body.code, 'audio_gone_recorded');
    assert.strictEqual(res.body.error, 'This meeting was recorded in your browser, so no other copy of the audio exists. The transcript and summary below are what remains.');
});

test('unavailable audio storage is a 503 audio_storage_unavailable', async () => {
    audio = { path: null, reason: 'storage_unavailable' };
    const res = await dispatch();
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.code, 'audio_storage_unavailable');
    assert.strictEqual(res.body.message, 'Audio storage is temporarily unavailable. Try again in a minute.');
    assert.strictEqual(calls.claim.length, 0);
});

test('a lost claim is a 409 already_processing and runs nothing', async () => {
    claimResult = false;
    const res = await dispatch();
    assert.strictEqual(res.statusCode, 409);
    assert.deepStrictEqual(res.body, {
        error: 'This recording is already being processed. Wait for it to finish.',
        code: 'already_processing',
    });
    assert.deepStrictEqual(calls.claim[0], ['t-1', 'owner-1']);
    await settle();
    assert.strictEqual(calls.whisperx.length, 0);
    assert.strictEqual(calls.run.length, 0);
    assert.strictEqual(calls.finish.length, 0);
    assert.strictEqual(calls.cleanup, 1);
});

test('a failure before the claim is a 500 reprocess_failed', async () => {
    note = undefined;
    const origGet = require('../../stores/transcriptionStore').getTranscription;
    require('../../stores/transcriptionStore').getTranscription = async () => { throw new Error('db down'); };
    try {
        const res = await dispatch();
        assert.strictEqual(res.statusCode, 500);
        assert.strictEqual(res.body.code, 'reprocess_failed');
        assert.strictEqual(res.body.message, 'Reprocessing failed');
        assert.strictEqual(calls.finish.length, 0);
    } finally {
        require('../../stores/transcriptionStore').getTranscription = origGet;
    }
});

test('a note without a durable copy is repaired from the local file; one with a key is not', async () => {
    await dispatch();
    await waitFor(() => calls.emitted.length > 0);
    assert.deepStrictEqual(calls.repair, [{ id: 't-1', ownerId: 'owner-1', audioPath: AUDIO_PATH, audioStorageKey: null }]);

    calls.repair.length = 0;
    note.audioStorageKey = 'saved-recordings/x';
    await dispatch();
    await waitFor(() => calls.emitted.length > 1);
    assert.strictEqual(calls.repair.length, 0);
});

// ═══ The pipeline ═══════════════════════════════════════════════════════

test('the 202 answers first, then the whisperx run completes the note and announces it', async () => {
    const res = await dispatch();
    assert.strictEqual(res.statusCode, 202);
    assert.deepStrictEqual(res.body, { id: 't-1', status: 'processing' });
    await waitFor(() => calls.emitted.length > 0);

    assert.deepStrictEqual(calls.whisperx[0], [AUDIO_PATH, 'standup.webm', 'en', '']);
    // speaker hint, roster (the attendees: a closed list), the owner's names as candidates, and locks reach the namer
    const id = calls.identify[0];
    assert.strictEqual(id[2], 'en');
    assert.strictEqual(id[3], 'Tom');
    assert.strictEqual(id[4], 'org-1');
    assert.deepStrictEqual(id[5], ['Anna']);
    assert.deepStrictEqual(id[6], { lockedNames: null, ruledOutNames: null, expectedSpeakers: 3, knownNames: ['Piet'] });
    assert.strictEqual(calls.summary[0][3].templatePrompt, 'TPL-PROMPT');
    assert.strictEqual(calls.extract[0][3].meetingDateIso, '2026-03-04');
    assert.ok(calls.extract[0][3].personNames.includes('Anna'));

    assert.strictEqual(calls.run.length, 1);
    const { sql, params } = calls.run[0];
    assert.match(sql, /WHERE id = \$20 AND user_id = \$21 AND status = 'processing'/);
    assert.strictEqual(params.length, 21);
    assert.strictEqual(params[0], 'completed');
    assert.strictEqual(params[1], 9);
    assert.deepStrictEqual(params[4], { sealed: 'hallo hoi' });
    assert.deepStrictEqual(params[8], { sealed: 'Nieuwe samenvatting.' });
    assert.strictEqual(params[13], JSON.stringify(['planning']));
    assert.strictEqual(params[14], '[]');
    assert.strictEqual(params[15], 'tpl-1');
    assert.strictEqual(params[16], 3);
    assert.strictEqual(params[17], 'snip:hallo hoi');
    assert.strictEqual(params[18], 'ssnip:Nieuwe samenvatting.');
    assert.strictEqual(params[19], 't-1');
    assert.strictEqual(params[20], 'owner-1');
    const actions = JSON.parse(params[10]);
    assert.ok(actions.some(a => a.text === 'Offerte sturen'));
    assert.ok(actions.some(a => a.text === 'typed by hand'), 'a hand-typed action survives');
    assert.strictEqual(params[3], JSON.parse(params[6].sealed).length);
    for (const i of [4, 5, 6, 7, 8, 9]) assert.deepStrictEqual(Object.keys(params[i]), ['sealed'], `column ${i} is written sealed`);

    assert.deepStrictEqual(calls.emitted[0], {
        transcriptionId: 't-1', tags: ['planning'], userId: 'owner-1', orgId: 'org-1', reprocessed: true,
    });
    assert.strictEqual(calls.finish.length, 0);
    await waitFor(() => calls.cleanup === 1);
});

test('a failed artifact pass keeps the lists, adds the notice and announces no tags', async () => {
    artifactsResult = pure.ARTIFACTS_FAILED;
    await dispatch();
    await waitFor(() => calls.emitted.length > 0);
    const { params } = calls.run[0];
    assert.match(params[8].sealed, /action items.*failed/i);
    assert.ok(params[8].sealed.includes('Nieuwe samenvatting.'));
    assert.strictEqual(params[13], '[]');
    assert.ok(JSON.parse(params[10]).some(a => a.text === 'typed by hand'));
    assert.deepStrictEqual(calls.emitted[0].tags, []);
    assert.ok(calls.warn.some(w => /artifact extraction failed/.test(w)));
});

test('a lost claim at the write announces nothing and writes no failure', async () => {
    runResult = { rowCount: 0 };
    await dispatch();
    await waitFor(() => calls.run.length > 0);
    await settle();
    assert.strictEqual(calls.emitted.length, 0);
    assert.strictEqual(calls.finish.length, 0);
    assert.ok(calls.warn.some(w => /claim was lost/.test(w)));
    assert.strictEqual(calls.cleanup, 1);
});

test('the run reports between its phases, so the reaper measures silence and not meeting length', async () => {
    await dispatch();
    await waitFor(() => calls.emitted.length > 0);
    // After the transcription, between the LLM passes, and before the write.
    assert.ok(calls.heartbeat.length >= 3, `heartbeats: ${calls.heartbeat.length}`);
    assert.ok(calls.heartbeat.every(([id]) => id === 't-1'));
});

test('a claim lost DURING the LLM passes stops the run: no more passes, no write, no failure stamp', async () => {
    // The first heartbeat (after the transcription) still holds, the second
    // (after speaker naming) finds the note reaped or deleted.
    heartbeatResult = (n) => n < 2;
    await dispatch();
    await waitFor(() => calls.heartbeat.length >= 2);
    await settle();
    assert.strictEqual(calls.summary.length, 0, 'no summary pass is paid for');
    assert.strictEqual(calls.extract.length, 0);
    assert.strictEqual(calls.run.length, 0, 'nothing written');
    assert.strictEqual(calls.finish.length, 0, 'no failure stamped over the note');
    assert.strictEqual(calls.emitted.length, 0);
    assert.ok(calls.warn.some(w => /claim was lost/.test(w)));
    assert.strictEqual(calls.cleanup, 1);
});

test('names the owner typed are candidates for the naming, not part of the closed attendee roster', async () => {
    await dispatch();
    await waitFor(() => calls.identify.length > 0);
    const [, , , , , roster, opts] = calls.identify[0];
    assert.deepStrictEqual(roster, ['Anna'], 'the roster is the attendees (plus voiceprint names)');
    assert.deepStrictEqual(opts.knownNames, ['Piet']);
});

test('no segments after the claim fails the note: a completed note keeps its status', async () => {
    whisperxResult = { text: '', segments: [] };
    const res = await dispatch();
    assert.strictEqual(res.statusCode, 202);
    await waitFor(() => calls.finish.length > 0);
    assert.deepStrictEqual(calls.finish[0], ['t-1', 'owner-1', { status: 'completed' }]);
    assert.strictEqual(calls.run.length, 0);
    assert.strictEqual(calls.emitted.length, 0);
});

test('a failure on a note that was not completed marks it failed with the reason', async () => {
    note.status = 'failed';
    whisperxResult = { text: '', segments: [] };
    await dispatch();
    await waitFor(() => calls.finish.length > 0);
    assert.deepStrictEqual(calls.finish[0], ['t-1', 'owner-1', { status: 'failed', summary: 'Transcription failed: Transcription returned no segments.' }]);
});

test('a failure whose claim is already gone is only logged', async () => {
    whisperxResult = { text: '', segments: [] };
    finishResult = false;
    await dispatch();
    await waitFor(() => calls.finish.length > 0);
    await settle();
    assert.ok(calls.warn.some(w => /claim was already lost/.test(w)));
});

// ═══ Provider dispatch ══════════════════════════════════════════════════

test('provider fallback: the stored provider wins, else the admin config, else voxtral', async () => {
    note.provider = null; provider = 'whisperx';
    await dispatch();
    await waitFor(() => calls.emitted.length > 0);
    assert.strictEqual(calls.whisperx.length, 1, 'admin config picked whisperx');
});

test('voxtral: the key is required and the file goes over as m4a-named content', async () => {
    note.provider = 'voxtral';
    await dispatch();
    await waitFor(() => calls.emitted.length > 0);
    assert.deepStrictEqual(calls.mistralClient[0], { key: 'key', opts: { timeoutMs: 1234 } });
    const params = calls.run[0].params;
    assert.deepStrictEqual(params[4], { sealed: 'voxtral' });
});

test('voxtral without an API key fails the note', async () => {
    note.provider = 'voxtral'; mistralKey = null;
    await dispatch();
    await waitFor(() => calls.finish.length > 0);
    assert.deepStrictEqual(calls.finish[0], ['t-1', 'owner-1', { status: 'completed' }]);
    note.status = 'failed';
    await dispatch();
    await waitFor(() => calls.finish.length > 1);
    assert.strictEqual(calls.finish[1][2].summary, 'Transcription failed: Mistral API key not configured');
});

test('local: transcribes on-device and fails loudly when the model is missing', async () => {
    note.provider = 'local';
    await dispatch();
    await waitFor(() => calls.emitted.length > 0);
    assert.deepStrictEqual(calls.local[0], [AUDIO_PATH, { language: 'en' }]);
    assert.deepStrictEqual(calls.run[0].params[4], { sealed: 'lokaal' });

    localResult = null; note.status = 'failed';
    await dispatch();
    await waitFor(() => calls.finish.length > 0);
    assert.strictEqual(calls.finish[0][2].summary, 'Transcription failed: Local transcription model is not available. Try again, or pick a cloud provider.');
});

test('pyannote: org comes from the note and the voiceprint results reach naming, notice and match column', async () => {
    note.provider = 'pyannote';
    await dispatch();
    await waitFor(() => calls.emitted.length > 0);
    assert.deepStrictEqual(calls.pyannote[0], [AUDIO_PATH, {
        language: 'en', numSpeakers: 3, orgId: 'org-9', recorderUserId: 'owner-1', attendees: ['Anna'],
    }]);
    const id = calls.identify[0];
    assert.deepStrictEqual(id[5], ['Anna', 'Bert']);
    assert.deepStrictEqual(id[6], { lockedNames: { speaker_0: 'Anna' }, ruledOutNames: ['Carl'], expectedSpeakers: 3, knownNames: ['Piet'] });
    assert.strictEqual(calls.run[0].params[14], JSON.stringify([{ speaker: 'speaker_0', name: 'Anna' }]));
});

// ═══ Fixes ═════════════════════════════════════════════════════════════

test('gone audio of an imported note says where it came from, not "upload it again"', async () => {
    note.source = 'teams';
    audio = { path: null, reason: 'never_durable' };
    const res = await dispatch();
    assert.strictEqual(res.statusCode, 410);
    assert.strictEqual(res.body.code, 'audio_gone_imported');
    assert.strictEqual(res.body.importedFrom, 'teams');
    assert.match(res.body.error, /imported from Microsoft Teams/);
    assert.doesNotMatch(res.body.error, /Upload the original file/);
    assert.strictEqual(calls.claim.length, 0);
});

test('a failed retry on a reaped note that still holds content leaves its summary alone', async () => {
    // The reaper sets status 'failed' and nothing else: transcript and summary are intact.
    note.status = 'failed';
    note.transcript = '[Anna] 00:00 - 00:05: the whole transcript';
    note.summary = 'GOOD SUMMARY';
    whisperxResult = { text: '', segments: [] };
    await dispatch();
    await waitFor(() => calls.finish.length > 0);
    assert.deepStrictEqual(calls.finish[0], ['t-1', 'owner-1', { status: 'completed' }]);
});

test('the reason on a failed note is redacted of the upstream body', async () => {
    note.status = 'failed';
    whisperxResult = new Error('WhisperX service error (502): <html>bad gateway at http://whisperx.internal:9000</html>');
    await dispatch();
    await waitFor(() => calls.finish.length > 0);
    assert.deepStrictEqual(calls.finish[0][2], { status: 'failed', summary: 'Transcription failed: WhisperX service error (502)' });
});

test('the artifact columns are written through the window of the snapshot read, and the stored tags are announced', async () => {
    note.readAt = '2026-11-04T10:00:00.123456Z';
    note.tags = ['intern'];
    runResult = { rowCount: 1, rows: [{ tags: ['intern'] }] };
    await dispatch();
    await waitFor(() => calls.emitted.length > 0);
    const { sql, params } = calls.run[0];
    assert.strictEqual(params.length, 22);
    assert.strictEqual(params[21], '2026-11-04T10:00:00.123456Z');
    assert.match(sql, /action_items = \(SELECT COALESCE\(jsonb_agg/);
    assert.match(sql, /'touchedAt' > \$22::text/, 'rows touched after the read survive');
    assert.match(sql, /RETURNING tags/);
    assert.deepStrictEqual(calls.emitted[0].tags, ['intern'], 'the note keeps its tags, the event says so');
});

test('a summary step that fails keeps the previous summary and says so', async () => {
    note.transcript = '[Anna] 00:00 - 00:05: old transcript';
    note.summary = 'ℹ️ Automatic voice recognition failed for this recording.\n\nOLD GOOD SUMMARY';
    note.summaryTemplateId = 'tpl-old';
    note.summaryTemplateVersion = 2;
    const helpers = require('../../core/meetingNotes/summaryHelpers');
    const real = helpers.generateMeetingSummary;
    helpers.generateMeetingSummary = async () => '';
    let restored = false;
    try {
        // The pipeline destructured the helper at load: reload it to pick up the stub.
        delete require.cache[require.resolve('./reprocessPipeline')];
        delete require.cache[require.resolve('./reprocess')];
        const freshRouter = require('./reprocess');
        const req = {
            method: 'POST', url: '/t-1/reprocess', query: {}, headers: {}, body: {}, params: { id: 't-1' },
            session: { isAuthenticated: true, user: { id: 'owner-1' } },
            get() { return undefined; },
        };
        const res = { statusCode: 200, headersSent: false, status(c) { this.statusCode = c; return this; }, json() { this.headersSent = true; return this; }, setHeader() {}, set() { return this; } };
        freshRouter(req, res, () => {});
        await waitFor(() => calls.run.length > 0);
        helpers.generateMeetingSummary = real;
        restored = true;
        const { params } = calls.run[0];
        const summary = params[8].sealed;
        assert.match(summary, /^⚠️ Writing a new summary failed; the previous summary has been kept/);
        assert.ok(summary.endsWith('OLD GOOD SUMMARY'));
        assert.doesNotMatch(summary, /voice recognition/, 'the old run\'s notices do not come along');
        assert.strictEqual(params[15], 'tpl-old', 'the kept summary keeps the stamp of the template that wrote it');
        assert.strictEqual(params[16], 2);
    } finally {
        if (!restored) helpers.generateMeetingSummary = real;
    }
});
