/**
 * Azure Speech shared core — duration-aware timeouts + partial salvage.
 *
 * Regression for the "Azure timed out" dead-end on long meetings: the old
 * inline implementations carried a fixed 10-minute cap and discarded every
 * segment already received when it fired. This pins:
 *   - the pure timeout/duration helpers (clamps, env overrides),
 *   - watchdog trip WITH partial segments → resolves with `truncated`,
 *   - watchdog trip WITHOUT segments → rejects,
 *   - clean session stop → full result, no truncation,
 *   - transcriber.close() + wav cleanup on every path.
 *
 * SDK + configStore + audioPreprocess are require-cache stubbed — no network,
 * no DB. Run: cd server && node --test core/voice/azureSpeech.test.js
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

stub('../../stores/configStore', {
    getSecret: async (key) => (key === 'azure_speech_key' ? 'test-key' : null),
    getConfig: async (key) => (key === 'azure_speech_region' ? 'westeurope' : null),
});

// A real WAV-ish temp file so fs.readFile/statSync work.
const WAV_PATH = path.join(os.tmpdir(), `azure-speech-test-${Date.now()}.wav`);
fs.writeFileSync(WAV_PATH, Buffer.alloc(44 + 32000)); // header + 1s of 16kHz mono s16le
const cleanupCalls = [];
stub('./audioPreprocess', {
    preprocessForStt: async () => ({ path: WAV_PATH, preprocessed: true, cleanup: () => cleanupCalls.push('wav') }),
});

// ── Fake Speech SDK ──────────────────────────────────────────────────────────
// scenario controls what startTranscribingAsync does; handlers are the ones the
// module assigned to the transcriber instance before starting.
const fake = { scenario: 'clean', closed: 0, stopped: 0 };

function emitSegment(t, startSec, endSec, text, speakerId = 'Guest-1') {
    t.transcribed(null, {
        result: {
            reason: 3, // RecognizedSpeech
            text,
            speakerId,
            offset: startSec * 10_000_000,
            duration: (endSec - startSec) * 10_000_000,
        },
    });
}

class FakeTranscriber {
    constructor() { fake.instance = this; }
    close() { fake.closed += 1; }
    stopTranscribingAsync(ok) { fake.stopped += 1; if (ok) ok(); }
    startTranscribingAsync(ok) {
        ok();
        setTimeout(() => {
            if (fake.scenario === 'clean') {
                emitSegment(this, 0, 2, 'Hello everyone', 'Guest-1');
                emitSegment(this, 2, 5, 'Good to be here', 'Guest-2');
                this.sessionStopped();
            } else if (fake.scenario === 'stall-with-partials') {
                emitSegment(this, 0, 2, 'Hello everyone', 'Guest-1');
                // ...then silence: the inactivity watchdog must trip.
            } else if (fake.scenario === 'stall-no-segments') {
                // no events at all
            }
        }, 5);
    }
}

stub('microsoft-cognitiveservices-speech-sdk', {
    SpeechConfig: { fromSubscription: () => ({ requestWordLevelTimestamps() {}, setProfanity() {}, setProperty() {}, close() { fake.configClosed = (fake.configClosed || 0) + 1; } }) },
    AudioConfig: { fromWavFileInput: () => ({}) },
    ConversationTranscriber: FakeTranscriber,
    PhraseListGrammar: { fromRecognizer: () => ({ addPhrase() {} }) },
    OutputFormat: { Detailed: 1 },
    ProfanityOption: { Raw: 2 },
    ResultReason: { RecognizedSpeech: 3 },
    CancellationReason: { Error: 4 },
});

const { transcribeWithAzureSpeech, wavDurationSeconds, computeAzureTimeouts } = require('./azureSpeech');

test.after(() => { try { fs.unlinkSync(WAV_PATH); } catch (_) {} });

test.beforeEach(() => {
    fake.scenario = 'clean';
    fake.closed = 0;
    fake.stopped = 0;
    cleanupCalls.length = 0;
    delete process.env.AZURE_SPEECH_TIMEOUT_MS;
    delete process.env.AZURE_SPEECH_INACTIVITY_TIMEOUT_MS;
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

test('wavDurationSeconds: bytes → seconds for 16kHz mono s16le', () => {
    assert.strictEqual(wavDurationSeconds(44 + 6000 * 32000), 6000); // 100-min meeting
    assert.strictEqual(wavDurationSeconds(44), 0);
    assert.strictEqual(wavDurationSeconds(0), 0);
    assert.strictEqual(wavDurationSeconds(undefined), 0);
});

test('computeAzureTimeouts: 100-min meeting gets ~2x real-time + headroom', () => {
    const { overallMs, inactivityMs } = computeAzureTimeouts({ durationSeconds: 6000, env: {} });
    assert.strictEqual(overallMs, 6000 * 2000 + 5 * 60_000); // 12.3M ms ≈ 205 min
    assert.strictEqual(inactivityMs, 180_000);
});

test('computeAzureTimeouts: clamps to the 15-min floor and 4-h ceiling', () => {
    assert.strictEqual(computeAzureTimeouts({ durationSeconds: 10, env: {} }).overallMs, 15 * 60_000);
    assert.strictEqual(computeAzureTimeouts({ durationSeconds: 100 * 3600, env: {} }).overallMs, 4 * 3600_000);
});

test('computeAzureTimeouts: unknown duration → 30-min default; env overrides win', () => {
    assert.strictEqual(computeAzureTimeouts({ durationSeconds: 0, env: {} }).overallMs, 30 * 60_000);
    const env = { AZURE_SPEECH_TIMEOUT_MS: '120000', AZURE_SPEECH_INACTIVITY_TIMEOUT_MS: '999' };
    const t = computeAzureTimeouts({ durationSeconds: 6000, env });
    assert.strictEqual(t.overallMs, 120000);
    assert.strictEqual(t.inactivityMs, 999);
});

// ── Stubbed-SDK behavior ─────────────────────────────────────────────────────

test('clean session → full result, no truncation, cleanup ran', async () => {
    const out = await transcribeWithAzureSpeech('input.webm', { language: 'nl' });
    assert.strictEqual(out.segments.length, 2);
    assert.deepStrictEqual(out.segments[0], { speakerId: 'Guest-1', start: 0, end: 2, text: 'Hello everyone' });
    assert.strictEqual(out.text, 'Hello everyone Good to be here');
    assert.strictEqual(out.truncated, null);
    assert.strictEqual(fake.closed, 1, 'transcriber.close() must run');
    assert.deepStrictEqual(cleanupCalls, ['wav'], 'temp WAV cleanup must run');
});

test('inactivity watchdog with partial segments → resolves truncated, keeps partials', async () => {
    fake.scenario = 'stall-with-partials';
    process.env.AZURE_SPEECH_INACTIVITY_TIMEOUT_MS = '60';
    const out = await transcribeWithAzureSpeech('input.webm', { language: 'nl' });
    assert.strictEqual(out.segments.length, 1, 'the already-recognised segment survives');
    assert.strictEqual(out.truncated?.reason, 'inactivity');
    assert.strictEqual(out.truncated?.atSeconds, 2);
    assert.ok(fake.stopped >= 1, 'stopTranscribingAsync issued on trip');
    assert.strictEqual(fake.closed, 1);
    assert.deepStrictEqual(cleanupCalls, ['wav']);
});

test('stall with zero segments → rejects (nothing to salvage), still cleans up', async () => {
    fake.scenario = 'stall-no-segments';
    process.env.AZURE_SPEECH_INACTIVITY_TIMEOUT_MS = '60';
    await assert.rejects(
        () => transcribeWithAzureSpeech('input.webm', { language: 'nl' }),
        /stalled|timed out/i,
    );
    assert.strictEqual(fake.closed, 1, 'transcriber.close() must run on the failure path too');
    assert.deepStrictEqual(cleanupCalls, ['wav']);
});

test('missing credentials → clear error before any SDK work', async () => {
    const configStore = require('../../stores/configStore');
    const orig = configStore.getSecret;
    configStore.getSecret = async () => null;
    try {
        await assert.rejects(
            () => transcribeWithAzureSpeech('input.webm', { language: 'nl' }),
            /Azure Speech credentials not configured/,
        );
    } finally {
        configStore.getSecret = orig;
    }
});
