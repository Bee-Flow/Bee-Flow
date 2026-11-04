/**
 * Transcription tools — batch-failure diagnostics, duration-scaled batch
 * limits, and provider dispatch.
 *
 * Regressions pinned here:
 *  - "Azure Whisper batch job Failed. Check your Azure Speech resource."
 *    dead-end: the poll loop used to throw away properties.error.{code,message}.
 *  - Fixed 10-min poll cap / 15-min URL: long recordings need duration-scaled
 *    limits (computeWhisperBatchTimeouts).
 *  - The tool honoured undeclared `filePath` / `provider` arguments from a
 *    model or automation step: any local file was read and sent to a cloud
 *    engine, and the admin's choice of engine was bypassed. Only the declared
 *    parameters survive now, and the engine is always the admin's.
 *  - context_terms never reached Voxtral (`prompt` is not a field of the SDK)
 *    nor Scaleway (the handler read camelCase `contextTerms`).
 *
 * DB-free: configStore and the provider cores are require-cache stubbed. Run:
 *   cd server && node --test integrations/transcriptionTools.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Require-cache stubs (before the module under test loads) ─────────────────
function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// No secrets configured; admin default provider = voxtral. Each provider then
// fails on its own distinctive missing-credential error, which is exactly what
// the dispatch tests use to prove WHICH handler was reached.
// The admin's engine; each test that needs another one sets it.
let adminProvider = 'voxtral';
let mistralKey = null;
stub('../stores/configStore', {
    // Only Scaleway gets a key: its handler is driven to a full result below.
    getSecret: async (key) => {
        if (key === 'scaleway_api_key') return 'test-key';
        if (key === 'mistral_api_key') return mistralKey;
        return null;
    },
    getConfig: async (key) => (key === 'transcription_provider' ? adminProvider : null),
});
const withAdminProvider = (t, provider) => { adminProvider = provider; t.after(() => { adminProvider = 'voxtral'; }); };

// Provider cores for the end-to-end result tests at the bottom. Pyannote
// without a staged answer fails like the real core does without a key.
const llmCalls = [];
let llmReply = '{}';
let pyOut = null; let scwOut = null; let localOut = null;
stub('../core/llm/llmClient', {
    async chat(modelId, messages) { llmCalls.push(messages[1].content); return { content: llmReply }; },
});
stub('../core/voice/pyannoteClient', {
    async transcribeWithPyannote() { if (!pyOut) throw new Error('Pyannote API key not configured'); return pyOut; },
});
stub('../stores/userStore', { getUser: async () => ({ organizationId: 'o1' }) });
const scwPaths = [];
const scwTerms = [];
stub('../core/meetingNotes/summaryHelpers', { transcribeWithScaleway: async (p, _n, _l, terms) => { scwPaths.push(p); scwTerms.push(terms); return scwOut; } });
const voxtralCalls = [];
stub('../core/meetingNotes/voxtralClient', {
    createVoxtralClient: () => ({ audio: { transcriptions: { complete: async (opts) => { voxtralCalls.push(opts); return { segments: [] }; } } } }),
});
stub('../core/voice/localWhisper', { transcribeLocally: async () => localOut });

const { formatAzureBatchFailure, computeWhisperBatchTimeouts, executeTranscriptionTool, azureDiarizationSpeakers } = require('./transcriptionTools');

test('surfaces Azure error code and message when present', () => {
    const msg = formatAzureBatchFailure({
        status: 'Failed',
        properties: { error: { code: 'InvalidUri', message: 'could not download the file at the given URL' } },
    });
    assert.match(msg, /Failed/);
    assert.match(msg, /InvalidUri/);
    assert.match(msg, /could not download the file at the given URL/);
});

test('includes just the message when code is absent', () => {
    const msg = formatAzureBatchFailure({
        status: 'Failed',
        properties: { error: { message: 'unsupported audio format' } },
    });
    assert.match(msg, /unsupported audio format/);
    assert.doesNotMatch(msg, /undefined/);
});

test('falls back to the generic hint when no error detail exists', () => {
    const msg = formatAzureBatchFailure({ status: 'Failed' });
    assert.strictEqual(msg, 'Azure Whisper batch job Failed. Check your Azure Speech resource.');
});

test('handles missing status without throwing', () => {
    assert.strictEqual(
        formatAzureBatchFailure({}),
        'Azure Whisper batch job Failed. Check your Azure Speech resource.'
    );
    assert.strictEqual(
        formatAzureBatchFailure(null),
        'Azure Whisper batch job Failed. Check your Azure Speech resource.'
    );
});

test('reflects the actual terminal status word', () => {
    const msg = formatAzureBatchFailure({ status: 'Cancelled' });
    assert.match(msg, /Cancelled/);
});

// ── computeWhisperBatchTimeouts ──────────────────────────────────────────────

test('poll cap scales with estimated audio duration and clamps to [15m, 60m]', () => {
    // 100-min OGG at ~64kbps ≈ 48 MB → est 6000s → clamped to the 60-min ceiling
    const long = computeWhisperBatchTimeouts({ bytes: 6000 * 8000, ext: '.ogg', env: {} });
    assert.strictEqual(long.estimatedSeconds, 6000);
    assert.strictEqual(long.pollCapMs, 60 * 60_000);

    // 1-min WAV → floor at 15 min
    const short = computeWhisperBatchTimeouts({ bytes: 60 * 32000, ext: '.wav', env: {} });
    assert.strictEqual(short.estimatedSeconds, 60);
    assert.strictEqual(short.pollCapMs, 15 * 60_000);

    // 30-min MP3 at ~128kbps sits between the clamps
    const mid = computeWhisperBatchTimeouts({ bytes: 1800 * 16000, ext: '.mp3', env: {} });
    assert.strictEqual(mid.pollCapMs, 1800 * 1000);
});

test('unknown format → 30-min default; env override wins; URL TTL covers queue time', () => {
    const unknown = computeWhisperBatchTimeouts({ bytes: 12345, ext: '.xyz', env: {} });
    assert.strictEqual(unknown.estimatedSeconds, null);
    assert.strictEqual(unknown.pollCapMs, 30 * 60_000);

    const overridden = computeWhisperBatchTimeouts({ bytes: 6000 * 8000, ext: '.ogg', env: { WHISPER_AZURE_POLL_TIMEOUT_MS: '120000' } });
    assert.strictEqual(overridden.pollCapMs, 120000);

    // URL must outlive the poll window plus 15 min of job-queue headroom.
    assert.strictEqual(unknown.urlTtlSeconds, 30 * 60 + 900);
    assert.strictEqual(overridden.urlTtlSeconds, 120 + 900);
});

// ── executeTranscriptionTool provider dispatch ───────────────────────────────
//
// Each provider fails fast on its own distinctive missing-credential message,
// which proves which handler the dispatch reached — no network involved.

const AUDIO_CTX = { userId: 'u1', attachments: [{ name: 'a.mp3', data: Buffer.from('abc').toString('base64') }] };

test('the admin engine is used for each provider', async (t) => {
    const cases = {
        whisper_azure: /Azure Speech key or region not configured/,
        azure: /Azure Speech credentials not configured/,
        voxtral: /Mistral API key not configured/,
        pyannote: /Pyannote (API key not configured|transcription failed)/,
    };
    t.after(() => { adminProvider = 'voxtral'; });
    for (const [provider, expected] of Object.entries(cases)) {
        adminProvider = provider;
        const res = await executeTranscriptionTool('transcribe_audio', {}, AUDIO_CTX);
        assert.match(res.error, expected, provider);
    }
});

test('a caller-supplied provider is ignored: the admin engine wins', async (t) => {
    withAdminProvider(t, 'scaleway');
    scwPaths.length = 0;
    for (const provider of ['azure', 'whisper_azure', 'voxtral', 'pyannote', 'local']) {
        const res = await executeTranscriptionTool('transcribe_audio', { provider }, AUDIO_CTX);
        assert.doesNotMatch(String(res.error), /Azure|Mistral|Pyannote|Local/, provider);
    }
    assert.strictEqual(scwPaths.length, 5, 'every call went to the admin engine (scaleway)');
});

test('a caller-supplied filePath is never read, for any provider', async (t) => {
    const secret = path.join(os.tmpdir(), `tt-filepath-${process.pid}-${Date.now()}.webm`);
    fs.writeFileSync(secret, 'OTHER-USER-AUDIO-BYTES');
    t.after(() => { fs.rmSync(secret, { force: true }); mistralKey = null; });
    mistralKey = 'mk';
    for (const provider of ['voxtral', 'azure', 'whisper_azure', 'pyannote', 'scaleway', 'local']) {
        withAdminProvider(t, provider);
        voxtralCalls.length = 0; scwPaths.length = 0;
        const res = await executeTranscriptionTool('transcribe_audio', { filePath: secret, fileName: 'x.webm' }, { userId: 'u1', attachments: [] });
        assert.match(String(res.error), /No audio file found/, provider);
        assert.strictEqual(voxtralCalls.length, 0, provider);
        assert.strictEqual(scwPaths.length, 0, provider);
    }
});

test('context_terms reach Voxtral as contextBias (the SDK has no prompt field)', async (t) => {
    t.after(() => { mistralKey = null; });
    mistralKey = 'mk';
    voxtralCalls.length = 0;
    await executeTranscriptionTool('transcribe_audio', { context_terms: 'AFAS, Bflow;  ' }, AUDIO_CTX);
    assert.strictEqual(voxtralCalls.length, 1);
    assert.deepStrictEqual(voxtralCalls[0].contextBias, ['AFAS', 'Bflow']);
    assert.ok(!('prompt' in voxtralCalls[0]));

    voxtralCalls.length = 0;
    await executeTranscriptionTool('transcribe_audio', {}, AUDIO_CTX);
    assert.ok(!('contextBias' in voxtralCalls[0]), 'no empty glossary is sent');
});

test('context_terms reach Scaleway', async (t) => {
    withAdminProvider(t, 'scaleway');
    t.after(() => { scwOut = null; });
    scwOut = { segments: [] };
    scwTerms.length = 0;
    await executeTranscriptionTool('transcribe_audio', { context_terms: 'AFAS, Bflow' }, AUDIO_CTX);
    assert.deepStrictEqual(scwTerms, ['AFAS, Bflow']);
});

test('missing user context is rejected before any provider work', async () => {
    const res = await executeTranscriptionTool('transcribe_audio', {}, {});
    assert.match(res.error, /User context required/);
});

// ── azureDiarizationSpeakers (multi-speaker diarization config) ──────────────

test('azureDiarizationSpeakers: exact count → minCount=maxCount, clamped to 35', () => {
    assert.deepStrictEqual(azureDiarizationSpeakers(5), { speakers: { minCount: 5, maxCount: 5 } });
    assert.deepStrictEqual(azureDiarizationSpeakers(99), { speakers: { minCount: 35, maxCount: 35 } });
});

test('azureDiarizationSpeakers: unknown → wide 1..35 range (not the 2-speaker default)', () => {
    assert.deepStrictEqual(azureDiarizationSpeakers(null), { speakers: { minCount: 1, maxCount: 35 } });
    assert.deepStrictEqual(azureDiarizationSpeakers(0), { speakers: { minCount: 1, maxCount: 35 } });
    assert.deepStrictEqual(azureDiarizationSpeakers(undefined), { speakers: { minCount: 1, maxCount: 35 } });
});

test('formatAzureBatchFailure adds a hint for InvalidData', () => {
    const msg = formatAzureBatchFailure({ status: 'Failed', properties: { error: { code: 'InvalidData', message: 'The recordings URI contains invalid data.' } } });
    assert.match(msg, /InvalidData/);
    assert.match(msg, /SERVER_PUBLIC_HOST|pyannote/);
});

// ── Provider result shape (merge, speaker tally, names) ─────────────────────
// Pinned before the shared tail moved to transcription/finalize.js.

const SEGS = [
    { speakerId: 'S1', start: 0, end: 4.5, text: ' hello ' },
    { speakerId: 'S1', start: 4.5, end: 9, text: 'there' },
    { speakerId: 'S2', start: 9, end: 70, text: 'long answer' },
    { speakerId: 'S1', start: 70, end: 3700, text: 'bye' },
];
const ATTACH_CTX = { userId: 'u1', attachments: [{ name: 'meet.mp3', data: Buffer.from('abc').toString('base64') }] };
const runProvider = (provider) => { adminProvider = provider; return executeTranscriptionTool('transcribe_audio', {}, ATTACH_CTX).finally(() => { adminProvider = 'voxtral'; }); };
const executeTranscriptionScaleway = (ctx) => { adminProvider = 'scaleway'; return executeTranscriptionTool('transcribe_audio', {}, ctx).finally(() => { adminProvider = 'voxtral'; }); };
const LINES = [
    '[S1] 00:00 - 00:09: hello there',
    '[S2] 00:09 - 01:10: long answer',
    '[S1] 01:10 - 01:01:40: bye',
];
function expectedResult({ duration, durationSeconds, names = {} }) {
    const n = (id) => names[id] || id;
    return {
        success: true,
        fileName: 'meet.mp3',
        language: 'nl',
        duration,
        durationSeconds,
        speakerCount: 2,
        segmentCount: 3,
        speakers: [
            { id: n('S1'), speakingTime: '01:00:39', segments: 2 },
            { id: n('S2'), speakingTime: '01:01', segments: 1 },
        ],
        transcript: LINES.map((l) => l.replace(/^\[(S\d)\]/, (_, id) => `[${n(id)}]`)).join('\n'),
        segments: [
            { speaker: n('S1'), start: 0, end: 9, startFormatted: '00:00', endFormatted: '00:09', text: 'hello there' },
            { speaker: n('S2'), start: 9, end: 70, startFormatted: '00:09', endFormatted: '01:10', text: 'long answer' },
            { speaker: n('S1'), start: 70, end: 3700, startFormatted: '01:10', endFormatted: '01:01:40', text: 'bye' },
        ],
    };
}

test('pyannote: provider duration, voiceprint pins win over the LLM names', async (t) => {
    t.after(() => { pyOut = null; });
    llmCalls.length = 0; llmReply = '{"S1": "Tom", "S2": "Ann"}';
    pyOut = { segments: SEGS.map(s => ({ ...s })), durationSeconds: 3725.6, voiceprintMapping: { S2: 'Bea' } };
    const res = await runProvider('pyannote');
    assert.deepStrictEqual(res, expectedResult({ duration: '01:02:05', durationSeconds: 3726, names: { S1: 'Tom', S2: 'Bea' } }));
    assert.strictEqual(llmCalls.length, 1);
    assert.match(llmCalls[0], /^Speaker IDs: S1, S2\nLanguage: nl\n/);
    assert.ok(llmCalls[0].endsWith(LINES.join('\n')), 'the LLM sees the merged lines before renaming');
});

test('scaleway: segments normalised, max end as duration, no LLM JSON leaves ids', async () => {
    llmCalls.length = 0; llmReply = 'no json here';
    scwOut = { segments: [...SEGS.map(s => ({ ...s, start: String(s.start) })), { speakerId: 'S3', start: 1, end: 2, text: '   ' }] };
    const res = await runProvider('scaleway');
    assert.deepStrictEqual(res, expectedResult({ duration: '01:01:40', durationSeconds: 3700 }));
    assert.strictEqual(llmCalls.length, 1);
});

test('local: one speaker skips the LLM and durationSec wins; two speakers ask it', async () => {
    llmCalls.length = 0; llmReply = '{"S1": "Tom"}';
    localOut = { segments: [{ start: 0, end: 5, text: 'solo' }], durationSec: 6.4 };
    const solo = await runProvider('local');
    assert.strictEqual(llmCalls.length, 0);
    assert.deepStrictEqual(solo.speakers, [{ id: 'speaker_0', speakingTime: '00:05', segments: 1 }]);
    assert.strictEqual(solo.durationSeconds, 6);
    assert.strictEqual(solo.transcript, '[speaker_0] 00:00 - 00:05: solo');

    localOut = { segments: SEGS.map(s => ({ ...s })) };
    const duo = await runProvider('local');
    assert.strictEqual(llmCalls.length, 1);
    assert.deepStrictEqual(duo, expectedResult({ duration: '01:01:40', durationSeconds: 3700, names: { S1: 'Tom' } }));
});

// ── Chat attachments: only inline data, own storage keys, guarded URLs ──────

test('an attachment path from the request body is never read', async () => {
    const file = path.join(os.tmpdir(), `bf-transcribe-path-${process.pid}.mp3`);
    fs.writeFileSync(file, 'secret');
    try {
        const res = await executeTranscriptionScaleway(
            { userId: 'u1', attachments: [{ name: 'a.mp3', type: 'audio/mpeg', path: file }] });
        assert.ok(res.error, 'no audio is read from a client-supplied path');
        assert.match(res.error, /Could not read audio data/);
    } finally { fs.rmSync(file, { force: true }); }
});

test('an attachment url to a private or metadata address is refused without a bare fetch', async (t) => {
    const original = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = async () => { fetched += 1; return new Response('x'); };
    t.after(() => { globalThis.fetch = original; });
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:3101/api/health', 'https://10.0.0.5/a.mp3']) {
        const res = await executeTranscriptionScaleway(
            { userId: 'u1', attachments: [{ name: 'a.mp3', type: 'audio/mpeg', url }] });
        assert.match(String(res.error), /Could not download the audio file/, url);
    }
    assert.strictEqual(fetched, 0);
});

test('a storage key outside the caller\'s own prefix is refused', async () => {
    for (const storageKey of ['users/u2/audio/x.mp3', 'users/u1/../u2/audio/x.mp3', 'shared/avatars/x.mp3']) {
        const res = await executeTranscriptionScaleway(
            { userId: 'u1', attachments: [{ name: 'a.mp3', type: 'audio/mpeg', storageKey }] });
        assert.match(String(res.error), /Could not read the audio file/, storageKey);
    }
});

test('an attachment name with directory parts stays inside the temp directory', async (t) => {
    t.after(() => { scwOut = null; });
    scwOut = { segments: [] };
    scwPaths.length = 0;
    await executeTranscriptionScaleway(
        { userId: 'u1', attachments: [{ name: '../../../../tmp/evil/x.mp3', type: 'audio/mpeg', data: Buffer.from('abc').toString('base64') }] });
    assert.strictEqual(scwPaths.length, 1);
    assert.strictEqual(path.dirname(scwPaths[0]), os.tmpdir());
    assert.ok(!scwPaths[0].includes('..'));
});
