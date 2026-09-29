/**
 * Meeting Notes reprocess route — POST /api/transcriptions/:id/reprocess.
 *
 * Contract: async-202 (like the upload route) — the note flips to
 * 'processing', the response returns immediately, and the pipeline finishes in
 * the background, persisting via the raw ../db UPDATE.
 *
 * Regressions pinned here:
 *  - "Cannot find module '../stores/db'" — the final DB write's lazy require.
 *  - P0 note-clobber: azure/whisper_azure reprocess used to call the chat tool
 *    without user context, ignore the returned {error}, and overwrite the note
 *    as an empty 'completed'. Now a failed rerun must NEVER touch a completed
 *    note's content (status restored, no ../db run()).
 *  - Speaker-collapse: the old merge loop keyed on seg.speakerId while the
 *    tool emitted 'speaker', folding an entire meeting into one segment.
 *    Multi-speaker whisper_azure segments must persist as multiple speakers.
 *  - Missing 'local' branch: a local note fell through to voxtral.
 *  - Azure partial salvage: a truncated run persists with a warning line
 *    prepended to the summary.
 *
 * Drives the REAL Express router with require-cache-stubbed collaborators and a
 * stubbed req/res dispatch harness (same trick as studioAppsRun.test.js) — no
 * HTTP listener, no DB.
 *
 * Run: cd server && node --test routes/transcriptions.reprocess.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── A real on-disk audio path so the handler's fs.access() check passes ──────
const AUDIO_PATH = path.join(os.tmpdir(), `reprocess-test-${Date.now()}.webm`);
fs.writeFileSync(AUDIO_PATH, 'fake-audio-bytes');
test.after(() => { try { fs.unlinkSync(AUDIO_PATH); } catch (_) {} });

// ── Require-cache stubs (before the router loads) ────────────────────────────
function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

let storedTranscription = null;   // what transcriptionStore.getTranscription returns
const runCalls = [];              // every ../db run() call (the final UPDATE)
const statusUpdates = [];         // every transcriptionStore.updateTranscription call

// `claimAllowed` models the atomic claim losing to a concurrent run.
let claimAllowed = true;
const claimCalls = [];
// Het standaardsjabloon dat resolveDefaultTemplate teruggeeft (zie de stub).
let defaultTemplate = null;
stub('../stores/transcriptionStore', {
    getTranscription: async (id) => (storedTranscription ? { ...storedTranscription, id } : null),
    updateTranscription: async (id, userId, updates) => { statusUpdates.push({ id, userId, updates }); return { id }; },
    claimForProcessing: async (id, userId) => { claimCalls.push({ id, userId }); return claimAllowed; },
    // Mirrors the real one: only writes while the claim is still held.
    finishProcessing: async (id, userId, updates) => {
        if (!claimAllowed) return false;
        statusUpdates.push({ id, userId, updates });
        return true;
    },
});
stub('../stores/configStore', {
    getConfig: async () => null,
    getSecret: async () => null,
});
// Object storage (RustFS/S3) — a controllable in-memory backstop for testing
// the "local audio gone, stream the durable copy" path. Reset per test.
const { Readable } = require('stream');
const storageObjects = new Map(); // key → Buffer
let storageUp = true;
stub('../stores/storageStore', {
    isAvailable: () => storageUp,
    ensureAvailable: async () => storageUp,
    getStatus: () => ({ mode: storageUp ? 's3' : null, configured: true, lastError: null, nextRetryAt: 0 }),
    streamFile: async (key) => {
        if (!storageObjects.has(key)) { const e = new Error(`Object not found: ${key}`); e.name = 'NoSuchKey'; throw e; }
        return { stream: Readable.from(storageObjects.get(key)), contentType: 'audio/webm', contentLength: storageObjects.get(key).length };
    },
    uploadFile: async (key, buffer) => { storageObjects.set(key, buffer); return { key }; },
    deleteFile: async () => ({}),
});
stub('../core/llm/llmClient', {});

const pure = require('../core/meetingNotes/transcriptArtifacts');
stub('../core/meetingNotes/summaryHelpers', {
    // reprocess with provider='whisperx' → this is the transcription call
    transcribeWithWhisperX: async () => ({
        segments: [
            { speakerId: 'Speaker 1', start: 0, end: 2, text: 'Hello everyone' },
            { speakerId: 'Speaker 2', start: 2, end: 5, text: 'Hi, good to be here' },
        ],
        text: 'Hello everyone Hi, good to be here',
    }),
    identifySpeakerNames: (...a) => providerStubs.identify(...a),  // default: no remapping
    generateMeetingSummary: async () => 'A short meeting summary.',
    generateChapters: async () => [{ title: 'Opening', start: '00:00' }],
    // Pure — use the real implementations rather than stubs that could drift.
    applySpeakerNames: pure.applySpeakerNames,
    fillGenericSpeakerLabels: pure.fillGenericSpeakerLabels,
    toContextBias: pure.toContextBias,
    buildTranscriptArtifacts: pure.buildTranscriptArtifacts,
    buildPipelineNotices: pure.buildPipelineNotices,
    // De ECHTE poort, niet een stub ervan: welke uitkomsten deze route mag
    // wegschrijven is precies wat hier op het spel staat.
    artifactsUsable: pure.artifactsUsable,
    ARTIFACTS_FAILED: pure.ARTIFACTS_FAILED,
    // Reprocess now re-extracts the structured artifacts from the new transcript.
    // Reassignable per test: what the extractor returns is one half of the M3
    // merge rule (the other half is what the note already holds).
    extractMeetingArtifacts: async (...a) => providerStubs.artifacts(...a),
    generateSpeakerSummaries: async () => ({}),
    applySpeakerSummaries: pure.applySpeakerSummaries,
    tagSpeakerProvenance: pure.tagSpeakerProvenance,
    // destructured at module load but unused by reprocess:
    resolveSmartModel: () => 'model',
    generateMeetingTitle: async () => 'Title',
    transcribeWithScaleway: async () => ({ segments: [] }),
});

// Provider stubs the reprocess dispatch requires lazily. Reassignable per test.
const providerStubs = {
    azure: async () => { throw new Error('azure stub not configured'); },
    whisperBatch: async () => { throw new Error('whisper batch stub not configured'); },
    pyannote: async () => { throw new Error('pyannote stub not configured'); },
    local: async () => null,
    identify: async () => null, // identifySpeakerNames mapping (null = no remap)
    artifacts: async () => ({ actionItems: [], decisions: [], questions: [], tags: [] }),
};
stub('../core/voice/azureSpeech', {
    transcribeWithAzureSpeech: (...a) => providerStubs.azure(...a),
    AZURE_LOCALE_MAP: { nl: 'nl-NL' },
});
stub('../integrations/transcriptionTools', {
    runAzureWhisperBatch: (...a) => providerStubs.whisperBatch(...a),
    executeTranscriptionTool: async () => { throw new Error('reprocess must not use the chat tool'); },
});
stub('../core/voice/pyannoteClient', {
    transcribeWithPyannote: (...a) => providerStubs.pyannote(...a),
});
stub('../core/voice/localWhisper', {
    transcribeLocally: (...a) => providerStubs.local(...a),
});

// requireAuth → pass-through; the handler still reads req.session.user.id.
stub('../auth/permissions', { requireAuth: (req, res, next) => next() });
stub('../auth', { resolveUserOrgIds: async () => new Set(['org-1']) });
stub('../stores/userStore', { getUser: async () => ({ groups: [] }), getAllGroups: async () => [] });
// The module under test: proves require('../db') resolves and run() is reached.
stub('../db', { run: async (sql, params) => { runCalls.push({ sql, params }); return { rowCount: 1 }; } });
// Het standaardsjabloon van de eigenaar. Default null = geen sjabloon, precies
// wat elke bestaande test hier al aannam; één test zet hem.
stub('../stores/summaryTemplateStore', {
    resolveDefaultTemplate: async () => defaultTemplate,
    resolveDefaultPrompt: async () => (defaultTemplate ? defaultTemplate.prompt : null),
});

const router = require('./transcriptions');

// ── Dispatch harness ─────────────────────────────────────────────────────────
function dispatch({ method = 'POST', url, user = 'owner-1', body }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, query: {},
            headers: {},
            session: user ? { isAuthenticated: true, user: { id: user } } : null,
            get(name) { return this.headers[String(name).toLowerCase()]; },
            setTimeout() {},
        };
        if (body !== undefined) req.body = body;
        const res = {
            statusCode: 200,
            headers: {},
            body: undefined,
            set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
            setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
            setTimeout() {},
        };
        router(req, res, (err) => reject(err || new Error(`fell through router: ${method} ${url}`)));
    });
}

/**
 * The value the UPDATE writes to a named column, read via THAT column's
 * placeholder (`col = $n` → params[n-1]) — never by counting from the end of
 * the parameter list. Fase E2 appended the two snippet columns after the
 * template stamp; the stamp still landed in its own column, and a positional
 * read was looking at its neighbour.
 */
function paramFor(sql, params, column) {
    const m = sql.match(new RegExp(`\\b${column} = \\$(\\d+)`));
    assert.ok(m, `${column} is not written by the UPDATE`);
    return params[Number(m[1]) - 1];
}

/** The 202 resolves before the background pipeline lands; poll for its effect. */
async function waitFor(cond, ms = 2000) {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > ms) throw new Error('timed out waiting for background pipeline');
        await new Promise(r => setTimeout(r, 10));
    }
}

test.beforeEach(() => {
    runCalls.length = 0;
    statusUpdates.length = 0;
    claimCalls.length = 0;
    claimAllowed = true;
    defaultTemplate = null;
    storedTranscription = {
        id: 't-123',
        ownerId: 'owner-1',
        isOwner: true,
        status: 'failed',
        provider: 'whisperx',
        audioPath: AUDIO_PATH,
        // Already backed up, so the opportunistic repair does not fire and add
        // an extra updateTranscription to every unrelated assertion.
        audioStorageKey: 'saved-recordings/already-durable.webm',
        fileName: 'standup.webm',
        language: 'nl',
    };
    providerStubs.azure = async () => { throw new Error('azure stub not configured'); };
    providerStubs.whisperBatch = async () => { throw new Error('whisper batch stub not configured'); };
    providerStubs.pyannote = async () => { throw new Error('pyannote stub not configured'); };
    providerStubs.local = async () => null;
    providerStubs.identify = async () => null;
    providerStubs.artifacts = async () => ({ actionItems: [], decisions: [], questions: [], tags: [] });
    storageObjects.clear();
});

test('reprocess responds 202 and persists a completed transcription in the background', async () => {
    const res = await dispatch({ url: '/t-123/reprocess' });

    assert.strictEqual(res.statusCode, 202);
    assert.deepStrictEqual(res.body, { id: 't-123', status: 'processing' });
    // The note is claimed ATOMICALLY before the 202 — a plain "set status to
    // processing" let two concurrent runs both think they owned it.
    assert.strictEqual(claimCalls.length, 1);
    assert.deepStrictEqual(claimCalls[0], { id: 't-123', userId: 'owner-1' });

    await waitFor(() => runCalls.length === 1);
    const { sql, params } = runCalls[0];
    assert.match(sql, /UPDATE transcriptions SET status/);
    assert.strictEqual(params[0], 'completed');             // status
    assert.strictEqual(params[params.length - 2], 't-123'); // WHERE id
    assert.strictEqual(params[params.length - 1], 'owner-1'); // AND user_id
});

test('reprocess never surfaces a module-not-found error', async () => {
    const res = await dispatch({ url: '/t-123/reprocess' });
    const err = res.body?.error || '';
    assert.doesNotMatch(err, /Cannot find module/);
    assert.doesNotMatch(err, /stores\/db/);
    await waitFor(() => runCalls.length === 1);
});

test('non-owner cannot reprocess (403, no transcription run)', async () => {
    storedTranscription.isOwner = false;
    const res = await dispatch({ url: '/t-123/reprocess' });
    assert.strictEqual(res.statusCode, 403);
    // "No run happened" is precisely "the note was never claimed". Asserting on
    // statusUpdates instead makes this test sensitive to the async tail of the
    // preceding test, which finishes after its own waitFor() returns.
    assert.strictEqual(claimCalls.length, 0);
    assert.strictEqual(runCalls.length, 0);
});

test('a SECOND concurrent reprocess is refused instead of clobbering the first', async () => {
    // Regression: a double-clicked Retry (or a second tab) started two runs on
    // one note. Both were billed, and whichever failed wrote status:'failed'
    // plus its error over the other's finished transcript and summary.
    claimAllowed = false;
    const res = await dispatch({ url: '/t-123/reprocess' });

    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'already_processing');
    assert.strictEqual(runCalls.length, 0, 'the losing request must not transcribe anything');
});

test('a run that loses its claim mid-flight does not write its failure', async () => {
    // The mirror image: this run started legitimately, then took so long that
    // the note was reclaimed. Its outcome must be discarded, not stamped over
    // whatever the note now holds.
    storedTranscription.status = 'failed';
    providerStubs.azure = async () => { throw new Error('boom'); };
    storedTranscription.provider = 'azure';

    const res = await dispatch({ url: '/t-123/reprocess' });
    assert.strictEqual(res.statusCode, 202);

    claimAllowed = false;                       // someone else takes over
    await new Promise(r => setTimeout(r, 60));
    assert.deepStrictEqual(
        statusUpdates.filter(u => u.updates?.status === 'failed'), [],
        'a lost claim must not write a failure',
    );
});

test('missing saved audio with no durable copy → 410 gone, no DB write', async () => {
    storedTranscription.audioPath = path.join(os.tmpdir(), 'does-not-exist-xyz.webm');
    storedTranscription.audioStorageKey = null;
    const res = await dispatch({ url: '/t-123/reprocess' });
    assert.strictEqual(res.statusCode, 410, 'gone, not a generic bad request');
    assert.strictEqual(res.body.code, 'audio_gone_uploaded');
    assert.strictEqual(runCalls.length, 0);
    assert.strictEqual(statusUpdates.length, 0);
});

test('a RECORDED meeting is never told to upload the file again', async () => {
    // The reported bug. A browser recording's bytes existed nowhere else, so
    // "please upload again" is advice the user cannot possibly act on.
    storedTranscription.audioPath = path.join(os.tmpdir(), 'does-not-exist-xyz.webm');
    storedTranscription.audioStorageKey = null;
    storedTranscription.source = 'recording';
    const res = await dispatch({ url: '/t-123/reprocess' });
    assert.strictEqual(res.statusCode, 410);
    assert.strictEqual(res.body.code, 'audio_gone_recorded');
    assert.doesNotMatch(res.body.error, /upload (it |the file |the original )?again/i);
});

test('storage merely unreachable → 503 retryable, and the claim is NOT burned', async () => {
    // A transient RustFS blip must not look like permanent data loss, and must
    // not consume the processing claim — the note has to stay reprocessable.
    storedTranscription.audioPath = path.join(os.tmpdir(), 'does-not-exist-xyz.webm');
    storedTranscription.audioStorageKey = 'saved-recordings/exists-but-unreachable.webm';
    storageUp = false;
    try {
        const res = await dispatch({ url: '/t-123/reprocess' });
        assert.strictEqual(res.statusCode, 503);
        assert.strictEqual(res.body.code, 'audio_storage_unavailable');
        assert.strictEqual(claimCalls.length, 0, 'a retryable failure must not claim the note');
        assert.strictEqual(statusUpdates.length, 0);
    } finally {
        storageUp = true;
    }
});

test('a readable local file with no durable copy is repaired on the way through', async () => {
    // Opportunistic repair: on a multi-replica deploy this pod is the only one
    // that can see the file, so every reprocess is a chance to back it up.
    storedTranscription.audioStorageKey = null;
    const res = await dispatch({ url: '/t-123/reprocess' });
    assert.strictEqual(res.statusCode, 202);
    await waitFor(() => storageObjects.size > 0);
    const [key] = [...storageObjects.keys()];
    assert.match(key, /^saved-recordings\//);
});

test('local audio gone but durable object-storage copy exists → reprocess proceeds', async () => {
    // The reported SaaS failure: after a pod restart the local file is gone.
    // With a stored audio_storage_key we stream the durable copy and continue.
    storedTranscription.audioPath = path.join(os.tmpdir(), 'gone-after-restart.webm');
    storedTranscription.audioStorageKey = 'saved-recordings/1700000000000-owner-1.webm';
    storageObjects.set(storedTranscription.audioStorageKey, Buffer.from('durable-audio-bytes'));

    const res = await dispatch({ url: '/t-123/reprocess' });
    assert.strictEqual(res.statusCode, 202);
    await waitFor(() => runCalls.length === 1);
    assert.strictEqual(runCalls[0].params[0], 'completed');
});

// ── P0 regression: a failed rerun must never clobber a completed note ────────

test('azure failure on a completed note → content untouched, status restored', async () => {
    storedTranscription.provider = 'azure';
    storedTranscription.status = 'completed';
    providerStubs.azure = async () => { throw new Error('Azure Speech error: boom'); };

    const res = await dispatch({ url: '/t-9/reprocess' });
    assert.strictEqual(res.statusCode, 202);

    // background: processing → (failure) → restored to completed
    await waitFor(() => statusUpdates.length === 1);
    assert.deepStrictEqual(statusUpdates[0].updates, { status: 'completed' });
    assert.strictEqual(runCalls.length, 0, 'the content UPDATE must never run on failure');
});

test('azure failure on a failed note → stays failed with the reason, content untouched', async () => {
    storedTranscription.provider = 'azure';
    storedTranscription.status = 'failed';
    providerStubs.azure = async () => { throw new Error('Azure Speech error: boom'); };

    await dispatch({ url: '/t-9/reprocess' });
    await waitFor(() => statusUpdates.length === 1);
    assert.strictEqual(statusUpdates[0].updates.status, 'failed');
    assert.match(statusUpdates[0].updates.summary, /Azure Speech error: boom/);
    assert.strictEqual(runCalls.length, 0);
});

test('empty transcription result → treated as failure, note not overwritten', async () => {
    storedTranscription.provider = 'whisper_azure';
    storedTranscription.status = 'completed';
    providerStubs.whisperBatch = async () => ({ text: '', segments: [], durationSeconds: 0 });

    await dispatch({ url: '/t-9/reprocess' });
    await waitFor(() => statusUpdates.length === 1);
    assert.deepStrictEqual(statusUpdates[0].updates, { status: 'completed' });
    assert.strictEqual(runCalls.length, 0);
});

// ── Speaker-collapse regression (speaker vs speakerId merge keys) ────────────

test('whisper_azure reprocess keeps multiple speakers (no collapse to one segment)', async () => {
    storedTranscription.provider = 'whisper_azure';
    providerStubs.whisperBatch = async () => ({
        text: 'Hello everyone Good to be here Thanks all',
        segments: [
            { speakerId: 'Guest-1', start: 0, end: 2, text: 'Hello everyone' },
            { speakerId: 'Guest-2', start: 2, end: 5, text: 'Good to be here' },
            { speakerId: 'Guest-1', start: 5, end: 7, text: 'Thanks all' },
        ],
        durationSeconds: 7,
    });

    await dispatch({ url: '/t-42/reprocess' });
    await waitFor(() => runCalls.length === 1);

    const { params } = runCalls[0];
    // params: [status, duration, speaker_count, segment_count, full_text, transcript, speakers, ...]
    assert.strictEqual(params[2], 2, 'two distinct speakers must survive');
    assert.strictEqual(params[3], 3, 'three turns must survive (no collapse into one)');
    const speakers = JSON.parse(params[7]);
    // Naming returns no mapping here (identify stub → null), so the generic-label
    // floor gives each un-named diarizer id a clean, localized "Spreker N"
    // (language nl) instead of leaking the raw diarizer id — two speakers, still distinct.
    assert.deepStrictEqual(speakers.map(s => s.id).sort(), ['Spreker 1', 'Spreker 2']);
});

// ── pyannote branch ──────────────────────────────────────────────────────────

test('pyannote reprocess keeps multiple speakers and reuses the stored speaker count', async () => {
    storedTranscription.provider = 'pyannote';
    storedTranscription.numSpeakers = 3;
    let receivedOpts = null;
    providerStubs.pyannote = async (_path, opts) => {
        receivedOpts = opts;
        return {
            text: 'Hallo Goedemorgen Tot zo',
            segments: [
                { speakerId: 'SPEAKER_00', start: 0, end: 2, text: 'Hallo' },
                { speakerId: 'SPEAKER_01', start: 2, end: 4, text: 'Goedemorgen' },
                { speakerId: 'SPEAKER_00', start: 4, end: 6, text: 'Tot zo' },
            ],
            durationSeconds: 6,
        };
    };

    await dispatch({ url: '/t-77/reprocess' });
    await waitFor(() => runCalls.length === 1);

    // The persisted speaker-count hint is reused for the rerun.
    assert.strictEqual(receivedOpts.numSpeakers, 3);
    const { params } = runCalls[0];
    assert.strictEqual(params[2], 2, 'two speakers survive');
    assert.strictEqual(params[3], 3, 'three turns survive');
});

// ── local branch ─────────────────────────────────────────────────────────────

test('local notes reprocess on-device, never silently via a cloud provider', async () => {
    storedTranscription.provider = 'local';
    let localCalls = 0;
    providerStubs.local = async () => {
        localCalls += 1;
        return { text: 'Local text', segments: [{ speakerId: 'speaker_0', start: 0, end: 3, text: 'Local text' }] };
    };

    await dispatch({ url: '/t-7/reprocess' });
    await waitFor(() => runCalls.length === 1);
    assert.strictEqual(localCalls, 1, 'transcribeLocally must be used for local notes');
    assert.strictEqual(runCalls[0].params[0], 'completed');
});

test('local model unavailable → failed with a clear message, not a voxtral run', async () => {
    storedTranscription.provider = 'local';
    storedTranscription.status = 'failed';
    providerStubs.local = async () => null;

    await dispatch({ url: '/t-7/reprocess' });
    await waitFor(() => statusUpdates.length === 1);
    assert.strictEqual(statusUpdates[0].updates.status, 'failed');
    assert.match(statusUpdates[0].updates.summary, /Local transcription model is not available/);
    assert.strictEqual(runCalls.length, 0);
});

// ── Azure partial salvage ────────────────────────────────────────────────────

test('truncated azure run persists with a warning line prepended to the summary', async () => {
    storedTranscription.provider = 'azure';
    providerStubs.azure = async () => ({
        text: 'Hello everyone',
        segments: [{ speakerId: 'Guest-1', start: 0, end: 120, text: 'Hello everyone' }],
        durationSeconds: 6000,
        truncated: { reason: 'inactivity', atSeconds: 120 },
    });

    await dispatch({ url: '/t-55/reprocess' });
    await waitFor(() => runCalls.length === 1);

    const { params } = runCalls[0];
    const summary = params[8];
    assert.match(summary, /^⚠️/, 'summary must lead with the truncation notice');
    assert.match(summary, /voortijdig gestopt|stopped early/);
    assert.match(summary, /A short meeting summary\./, 'the generated summary must still follow');
    assert.strictEqual(params[0], 'completed');
});

// ── Re-identify speakers (auto naming on the stored transcript) ──────────────

test('re-identify maps Guest-N to real names using the supplied roster, no re-transcription', async () => {
    storedTranscription.segments = [
        { speaker: 'Guest-1', start: 0, end: 4, text: 'Ik open de vergadering' },
        { speaker: 'Guest-2', start: 4, end: 8, text: 'Dank je Gerard' },
        { speaker: 'Guest-1', start: 8, end: 12, text: 'Tom, jouw punt?' },
    ];
    storedTranscription.speakers = [
        { id: 'Guest-1', speakingSeconds: 8, segments: 2 },
        { id: 'Guest-2', speakingSeconds: 4, segments: 1 },
    ];
    let receivedRoster = null;
    providerStubs.identify = async (_segs, _rows, _lang, _user, _org, roster) => {
        receivedRoster = roster;
        return { 'Guest-1': 'Gerard', 'Guest-2': 'Tom' };
    };

    const res = await dispatch({ method: 'POST', url: '/t-9/reidentify-speakers', body: { attendees: 'Gerard, Tom' } });
    assert.strictEqual(res.statusCode, 200);

    // Roster forwarded to the naming step.
    assert.deepStrictEqual(receivedRoster, ['Gerard', 'Tom']);
    // Segments + speakers were rewritten (whisperx transcription NOT called).
    const upd = statusUpdates.find(u => u.updates.segments);
    assert.ok(upd, 'segments were updated');
    assert.deepStrictEqual(upd.updates.segments.map(s => s.speaker), ['Gerard', 'Tom', 'Gerard']);
    assert.deepStrictEqual(upd.updates.speakers.map(s => s.id).sort(), ['Gerard', 'Tom']);
    assert.strictEqual(runCalls.length, 0, 'no re-transcription / no ../db run()');
});

test('re-identify with no confident mapping → 422, note untouched', async () => {
    storedTranscription.segments = [{ speaker: 'Guest-1', start: 0, end: 4, text: 'hm' }];
    storedTranscription.speakers = [{ id: 'Guest-1', speakingSeconds: 4, segments: 1 }];
    providerStubs.identify = async () => null;

    const res = await dispatch({ method: 'POST', url: '/t-9/reidentify-speakers', body: {} });
    assert.strictEqual(res.statusCode, 422);
    assert.strictEqual(statusUpdates.length, 0);
});

test('re-identify on a note with no segments → 400', async () => {
    storedTranscription.segments = [];
    const res = await dispatch({ method: 'POST', url: '/t-9/reidentify-speakers', body: {} });
    assert.strictEqual(res.statusCode, 400);
});

// ── Re-transcribing replaces the AI's action items, not the person's (M3) ────
//
// The comment above the re-extraction justifies it with "the old items point at
// timestamps that no longer exist". True of the model's items; false of an
// action a person typed, which has no timestamp to invalidate. Losing it here
// would be the same silent deletion "Opnieuw" used to do, one button further
// away — and this path writes with a raw UPDATE, so it needs its own teeth.

test('a user-added action survives a reprocess, without its stale transcript anchors', async () => {
    storedTranscription.actionItems = [
        { id: 'ai-0', source: 'ai', text: 'Oud AI-punt', timestamp: '12:30', done: false },
        {
            id: 'u-77', source: 'user', text: 'Bel de klant', done: true,
            segmentIndex: 42, timestamp: '12:30', due: '2026-09-30',
            destination: { kind: 'kb', ref: 'kb-3', label: 'Sales', at: '2026-09-01T08:30:00.000Z' },
        },
    ];
    providerStubs.artifacts = async () => ({
        actionItems: [{ id: 'ai-0', source: 'ai', text: 'Vers AI-punt', timestamp: '00:05', done: false }],
        decisions: [], questions: [], tags: [],
    });

    const res = await dispatch({ url: '/t-123/reprocess' });
    assert.strictEqual(res.statusCode, 202);
    await waitFor(() => runCalls.length === 1);

    // action_items is $11 in the UPDATE — params are 0-indexed.
    const written = JSON.parse(runCalls[0].params[10]);
    assert.deepStrictEqual(written.map((i) => i.text), ['Bel de klant', 'Vers AI-punt']);

    const mine = written[0];
    assert.strictEqual(mine.done, true);
    assert.strictEqual(mine.due, '2026-09-30');
    assert.deepStrictEqual(mine.destination, { kind: 'kb', ref: 'kb-3', label: 'Sales', at: '2026-09-01T08:30:00.000Z' });
    // The transcript it pointed into was just replaced: seeking to line 42 of a
    // re-diarized transcript lands on the wrong sentence, which is worse than
    // not offering to seek at all.
    assert.ok(!('segmentIndex' in mine));
    assert.ok(!('timestamp' in mine));
});


// ── …and so does a decision picked off a transcript line (M4) ────────
//
// This UPDATE wrote `JSON.stringify(artifacts.decisions)` — the extractor's
// list, whole. Defensible only while the extractor was the sole writer of that
// column; M4's per-line popover made it the same silent deletion, and this
// path writes with a raw UPDATE, so it needs its own teeth.

test('a decision the user picked off a line survives a reprocess too', async () => {
    storedTranscription.decisions = [
        { id: 'd-0', text: 'Wat het model vond', timestamp: '00:20' },
        { id: 'ud-77', source: 'user', text: 'We gaan met leverancier B verder', segmentIndex: 12, timestamp: '12:34' },
    ];
    storedTranscription.questions = [
        { id: 'uq-3', source: 'user', text: 'Wie betaalt de licentie?', segmentIndex: 14, open: false },
    ];
    providerStubs.artifacts = async () => ({
        actionItems: [],
        decisions: [{ id: 'd-0', text: 'Vers besluit' }],
        questions: [{ id: 'q-0', text: 'Verse vraag' }],
        tags: [],
    });

    const res = await dispatch({ url: '/t-123/reprocess' });
    assert.strictEqual(res.statusCode, 202);
    await waitFor(() => runCalls.length === 1);

    // decisions is $12 and questions $13 in the UPDATE — params are 0-indexed.
    const decisions = JSON.parse(runCalls[0].params[11]);
    assert.deepStrictEqual(decisions.map((d) => d.text), ['We gaan met leverancier B verder', 'Vers besluit']);
    // The transcript it pointed into was just replaced: chipping line 12 of a
    // re-diarized transcript marks the wrong sentence.
    assert.ok(!('segmentIndex' in decisions[0]));
    assert.ok(!('timestamp' in decisions[0]));

    const questions = JSON.parse(runCalls[0].params[12]);
    assert.deepStrictEqual(questions.map((q) => q.text), ['Wie betaalt de licentie?', 'Verse vraag']);
    assert.strictEqual(questions[0].open, false, 'answering it is not undone by a reprocess');
});


// ── EEN MISLUKTE ARTEFACT-PASS IS GEEN LEGE VERGADERING ──────────────
//
// extractMeetingArtifacts kent DRIE uitkomsten en zegt met `ok` welke. Deze
// route las die vlag niet: een time-out of onparseerbaar JSON leverde vier lege
// lijsten, en die werden over een notitie geschreven die al 'completed' was —
// actiepunten, besluiten en vragen weg, zonder undo en zonder dat het scherm
// iets liet zien. De regenerate-route dicht dit al (noteActions.js); deze
// schrijft met een kale UPDATE en had dus zijn eigen tanden nodig.

test('a failed artifact pass keeps the action items, decisions and questions', async () => {
    storedTranscription.status = 'completed';
    storedTranscription.actionItems = [
        { id: 'ai-0', source: 'ai', text: 'Offerte versturen', assignee: 'Tom', timestamp: '12:30', segmentIndex: 8, done: false },
        { id: 'ai-1', source: 'ai', text: 'Planning bijwerken', assignee: 'Sandra', timestamp: '20:10', done: true },
    ];
    storedTranscription.decisions = [
        { id: 'd-0', text: 'We gaan met leverancier B verder', timestamp: '00:20', segmentIndex: 3 },
    ];
    storedTranscription.questions = [
        { id: 'q-0', text: 'Wie betaalt de licentie?', timestamp: '31:00', open: true },
    ];
    // Precies wat de helper teruggeeft bij een time-out van de smart-tier én
    // bij een antwoord dat niet te parsen was.
    providerStubs.artifacts = async () => ({ actionItems: [], decisions: [], questions: [], tags: [], ok: false });

    const res = await dispatch({ url: '/t-123/reprocess' });
    assert.strictEqual(res.statusCode, 202);
    await waitFor(() => runCalls.length === 1);

    const { params } = runCalls[0];
    assert.strictEqual(params[0], 'completed');
    const actionItems = JSON.parse(params[10]);
    assert.deepStrictEqual(actionItems.map((i) => i.text), ['Offerte versturen', 'Planning bijwerken']);
    assert.strictEqual(actionItems[1].done, true, 'de afgevinkte staat blijft staan');
    // De hertranscriptie SLAAGDE, dus de ankers naar de vervangen transcriptie
    // gaan er wél uit — regel 42 van een opnieuw gediarizeerde transcriptie is
    // een andere zin.
    assert.ok(!('segmentIndex' in actionItems[0]));
    assert.ok(!('timestamp' in actionItems[0]));

    const decisions = JSON.parse(params[11]);
    assert.deepStrictEqual(decisions.map((d) => d.text), ['We gaan met leverancier B verder']);
    assert.ok(!('segmentIndex' in decisions[0]));

    const questions = JSON.parse(params[12]);
    assert.deepStrictEqual(questions.map((q) => q.text), ['Wie betaalt de licentie?']);
    assert.strictEqual(questions[0].open, true);
});

test('an answer this route does not recognise as a finished pass empties nothing', async () => {
    // ONBEKEND MOET VERSMALLEN. De poort stond op `artifacts.ok !== false`, en
    // dat is fail-open: alles wat GEEN `ok:false` draagt gold als geslaagd —
    // ook een antwoord zonder lijsten. De merge kreeg dan `undefined` als verse
    // lijst en verving elke opgeslagen AI-rij door niets: actiepunten,
    // besluiten en vragen weg van een notitie die al 'completed' was, zonder
    // undo en zonder dat het scherm iets liet zien.
    //
    // De vraag is nu "heeft deze pass daadwerkelijk een antwoord gelezen", en
    // die stelt de waarde zelf: geen lijsten = niets om mee te schrijven.
    storedTranscription.status = 'completed';
    storedTranscription.actionItems = [
        { id: 'ai-0', source: 'ai', text: 'Offerte versturen', assignee: 'Tom', done: true },
    ];
    storedTranscription.decisions = [{ id: 'd-0', text: 'We gaan met leverancier B verder' }];
    storedTranscription.questions = [{ id: 'q-0', text: 'Wie betaalt de licentie?', open: true }];
    // Geen `ok:false`, en ook geen lijsten — precies de vorm die de oude poort
    // als "gelukt" doorliet.
    providerStubs.artifacts = async () => ({});

    const res = await dispatch({ url: '/t-123/reprocess' });
    assert.strictEqual(res.statusCode, 202);
    await waitFor(() => runCalls.length === 1);

    const { params } = runCalls[0];
    assert.strictEqual(params[0], 'completed');
    assert.deepStrictEqual(JSON.parse(params[10]).map((i) => i.text), ['Offerte versturen']);
    assert.strictEqual(JSON.parse(params[10])[0].done, true);
    assert.deepStrictEqual(JSON.parse(params[11]).map((d) => d.text), ['We gaan met leverancier B verder']);
    assert.deepStrictEqual(JSON.parse(params[12]).map((q) => q.text), ['Wie betaalt de licentie?']);
    // En het staat op het scherm: de samenvatting draagt de notitieregel, want
    // een stille mislukking laat de gebruiker denken dat er niets besproken is.
    assert.match(params[8], /actiepunten/i);
});

test('a failed artifact pass says so on the note', async () => {
    // Dezelfde regel voor de gedeelde mislukt-waarde: bewaren is de helft,
    // zeggen dat je bewaard hebt is de andere helft.
    storedTranscription.status = 'completed';
    providerStubs.artifacts = async () => ({ ok: false });

    const res = await dispatch({ url: '/t-123/reprocess' });
    assert.strictEqual(res.statusCode, 202);
    await waitFor(() => runCalls.length === 1);
    assert.match(runCalls[0].params[8], /actiepunten/i, 'de notitie meldt de mislukte pass');
    // De tagkolom krijgt een echte lege lijst, geen SQL-NULL, van een pass die
    // geen tags heeft kunnen bedenken.
    assert.deepStrictEqual(JSON.parse(runCalls[0].params[13]), []);
});

test('a SUCCESSFUL pass on a meeting with nothing in it still clears the AI rows', async () => {
    // De keerzijde, en de reden dat `ok` bestaat: `ok:true` met lege lijsten
    // betekent "in deze vergadering is niets afgesproken" en moet wél
    // opruimen. Zonder dit onderscheid zou de regel hierboven verouderde
    // actiepunten voor eeuwig laten staan.
    storedTranscription.status = 'completed';
    storedTranscription.actionItems = [{ id: 'ai-0', source: 'ai', text: 'Oud AI-punt', done: false }];
    storedTranscription.decisions = [{ id: 'd-0', text: 'Oud besluit' }];
    storedTranscription.questions = [{ id: 'q-0', text: 'Oude vraag', open: true }];
    providerStubs.artifacts = async () => ({ actionItems: [], decisions: [], questions: [], tags: [], ok: true });

    const res = await dispatch({ url: '/t-123/reprocess' });
    assert.strictEqual(res.statusCode, 202);
    await waitFor(() => runCalls.length === 1);

    const { params } = runCalls[0];
    assert.deepStrictEqual(JSON.parse(params[10]), []);
    assert.deepStrictEqual(JSON.parse(params[11]), []);
    assert.deepStrictEqual(JSON.parse(params[12]), []);
});


// ── DE SJABLOONSTEMPEL OVERLEEFT EEN REPROCESS NIET ONGECONTROLEERD ──
//
// Reprocess schrijft de samenvatting OPNIEUW. De stempel ("met welk sjabloon
// is dit gemaakt") gaat dus mee — ook als het antwoord "geen sjabloon" is.
// Een oude stempel laten staan zou een sjabloonnaam plakken op tekst die dat
// sjabloon nooit geschreven heeft.

test('reprocess schrijft de sjabloonstempel van het gebruikte standaardsjabloon', async () => {
    defaultTemplate = { id: 'tpl-7', name: 'Standaard', prompt: 'DEFAULT PROMPT', version: 3 };
    const res = await dispatch({ url: '/t-123/reprocess' });
    assert.strictEqual(res.statusCode, 202);

    await waitFor(() => runCalls.length === 1);
    const { sql, params } = runCalls[0];
    // Gelezen via de eigen plaatshouder van elke kolom, niet op positie in de
    // lijst: de kolomvolgorde is geen belofte van de route, de kolom wél.
    assert.strictEqual(paramFor(sql, params, 'summary_template_id'), 'tpl-7');
    assert.strictEqual(paramFor(sql, params, 'summary_template_version'), 3);
});

test('reprocess zonder standaardsjabloon WIST de stempel in plaats van hem te laten staan', async () => {
    defaultTemplate = null;
    const res = await dispatch({ url: '/t-123/reprocess' });
    assert.strictEqual(res.statusCode, 202);

    await waitFor(() => runCalls.length === 1);
    const { sql, params } = runCalls[0];
    assert.strictEqual(paramFor(sql, params, 'summary_template_id'), null, 'de kolom wordt echt geschreven, met NULL');
    assert.strictEqual(paramFor(sql, params, 'summary_template_version'), null);
});

test('de UPDATE houdt kolommen en plaatshouders uitgelijnd', async () => {
    // Handgenummerde $n over negentien parameters: één kolom erbij schuift
    // alles op, en een misteling landt waarden stil in de verkeerde kolom.
    await dispatch({ url: '/t-123/reprocess' });
    await waitFor(() => runCalls.length === 1);
    const { sql, params } = runCalls[0];
    assert.ok(sql);
    const numbers = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    assert.deepStrictEqual([...new Set(numbers)].sort((a, b) => a - b),
        params.map((_, i) => i + 1),
        'elke $n van 1..N komt precies één keer voor en er zijn evenveel waarden');
});
