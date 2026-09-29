/**
 * Transcription tools — batch-failure diagnostics, duration-scaled batch
 * limits, and provider dispatch.
 *
 * Regressions pinned here:
 *  - "Azure Whisper batch job Failed. Check your Azure Speech resource."
 *    dead-end: the poll loop used to throw away properties.error.{code,message}.
 *  - Fixed 10-min poll cap / 15-min URL: long recordings need duration-scaled
 *    limits (computeWhisperBatchTimeouts).
 *  - executeTranscriptionTool ignored args.provider and re-read the admin
 *    default — a reprocess of an azure note could silently run voxtral.
 *
 * DB-free: configStore is require-cache stubbed. Run:
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
stub('../stores/configStore', {
    getSecret: async () => null,
    getConfig: async (key) => (key === 'transcription_provider' ? 'voxtral' : null),
});

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

const AUDIO_FIXTURE = path.join(os.tmpdir(), `tt-dispatch-${Date.now()}.mp3`);
test.before(() => fs.writeFileSync(AUDIO_FIXTURE, 'fake-audio'));
test.after(() => { try { fs.unlinkSync(AUDIO_FIXTURE); } catch (_) {} });

test('args.provider is honored over the admin default', async () => {
    const res = await executeTranscriptionTool(
        'transcribe_audio',
        { provider: 'whisper_azure', filePath: AUDIO_FIXTURE },
        { userId: 'u1' },
    );
    // whisper_azure path → Azure Speech credential error, NOT the voxtral
    // "Mistral API key" error the admin default would produce.
    assert.match(res.error, /Azure Speech key or region not configured/);
});

test('azure provider reaches the shared Speech core', async () => {
    const res = await executeTranscriptionTool(
        'transcribe_audio',
        { provider: 'azure', filePath: AUDIO_FIXTURE },
        { userId: 'u1' },
    );
    assert.match(res.error, /Azure Speech credentials not configured/);
});

test('absent or bogus args.provider falls back to the admin default (voxtral)', async () => {
    for (const args of [{ filePath: AUDIO_FIXTURE }, { provider: 'nonsense', filePath: AUDIO_FIXTURE }]) {
        const res = await executeTranscriptionTool('transcribe_audio', args, { userId: 'u1' });
        assert.match(res.error, /Mistral API key not configured/);
    }
});

test('pyannote provider reaches the pyannote core', async () => {
    const res = await executeTranscriptionTool(
        'transcribe_audio',
        { provider: 'pyannote', filePath: AUDIO_FIXTURE },
        { userId: 'u1' },
    );
    // pyannote path → its own "not configured" error, NOT voxtral's.
    assert.match(res.error, /Pyannote (API key not configured|transcription failed)/);
    assert.doesNotMatch(res.error, /Mistral/);
});

test('missing user context is rejected before any provider work', async () => {
    const res = await executeTranscriptionTool('transcribe_audio', { provider: 'azure' }, {});
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
