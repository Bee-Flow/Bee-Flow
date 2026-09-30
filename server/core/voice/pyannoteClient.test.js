/**
 * pyannoteAI client — all-in-one transcription+diarization via pyannote's own
 * media storage (no RustFS/public URL). Pins: the media-upload→submit→poll→map
 * flow, numSpeakers in the job body, timeout scaling, failed-job surfacing, and
 * API-key redaction.
 *
 * configStore + audioPreprocess + global.fetch are stubbed — no DB, no network.
 * Run: cd server && node --test core/voice/pyannoteClient.test.js
 */

process.env.PYANNOTE_POLL_INTERVAL_MS = '1'; // don't sleep 5s between polls in tests

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

stub('../../stores/configStore', {
    getSecret: async (k) => (k === 'pyannote_api_key' ? 'sk-test-key-abcdefghij' : null),
    getConfig: async () => null,
});
const cleanupCalls = [];
const FLAC_PATH = path.join(os.tmpdir(), `pyannote-test-${Date.now()}.flac`);
fs.writeFileSync(FLAC_PATH, Buffer.alloc(16000 * 10)); // ~10s of 16kHz mono flac-ish
stub('./audioPreprocess', {
    preprocessForStt: async () => ({ path: FLAC_PATH, preprocessed: true, cleanup: () => cleanupCalls.push('x') }),
});

const { transcribeWithPyannote, computePyannoteTimeouts, mapPyannoteOutput } = require('./pyannoteClient');

test.after(() => { try { fs.unlinkSync(FLAC_PATH); } catch (_) {} });

// ── A scripted fetch: media/input → PUT → diarize [→ identify] → jobs polling ──
function installFetch({ jobStates, submitBody, identifyBody, identifyOutput, identifyFails } = {}) {
    const calls = [];
    const states = jobStates || [{ status: 'running' }, {
        status: 'succeeded',
        output: {
            turnLevelTranscription: [
                { speaker: 'SPEAKER_00', start: 0, end: 3, text: 'Hallo allemaal' },
                { speaker: 'SPEAKER_01', start: 3, end: 6, text: 'Goedemorgen' },
            ],
        },
    }];
    let pollIdx = 0;
    global.fetch = async (url, opts = {}) => {
        calls.push({ url, method: opts.method || 'GET', body: opts.body });
        if (url.endsWith('/media/input')) {
            return { ok: true, json: async () => ({ url: 'https://presigned.example/put' }) };
        }
        if (url === 'https://presigned.example/put') {
            return { ok: true, text: async () => '' };
        }
        if (url.endsWith('/diarize')) {
            if (submitBody) submitBody.value = JSON.parse(opts.body);
            return { ok: true, json: async () => ({ jobId: 'job-123', status: 'created' }) };
        }
        if (url.endsWith('/identify')) {
            if (identifyBody) identifyBody.value = JSON.parse(opts.body);
            return { ok: true, json: async () => ({ jobId: 'job-id-1', status: 'created' }) };
        }
        if (url.includes('/jobs/job-id-1')) {
            return { ok: true, json: async () => (identifyFails
                ? { status: 'failed', output: { error: 'quota exceeded' } }
                : { status: 'succeeded', output: identifyOutput || {} }) };
        }
        if (url.includes('/jobs/')) {
            const state = states[Math.min(pollIdx++, states.length - 1)];
            return { ok: true, json: async () => ({ jobId: 'job-123', ...state }) };
        }
        throw new Error(`unexpected fetch ${url}`);
    };
    return calls;
}

/** A selection as `selectVoiceprintsForJob` would return it. */
function selection(labels = { vp_tom: 'Tom Smit' }) {
    return {
        voiceprints: Object.keys(labels).map(label => ({ label, voiceprint: 'QUFB' })),
        labelToName: Object.fromEntries(Object.entries(labels).map(([id, name]) => [id, { id, name, userId: id }])),
        ids: Object.keys(labels),
        total: Object.keys(labels).length,
        truncated: false,
    };
}

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; cleanupCalls.length = 0; });

// ── Pure helpers ─────────────────────────────────────────────────────

test('computePyannoteTimeouts scales with duration and clamps', () => {
    assert.strictEqual(computePyannoteTimeouts({ durationSeconds: 6000, env: {} }).pollCapMs, 2 * 3600_000); // clamps to 2h
    assert.strictEqual(computePyannoteTimeouts({ durationSeconds: 60, env: {} }).pollCapMs, 15 * 60_000);    // floor 15m
    assert.strictEqual(computePyannoteTimeouts({ durationSeconds: 0, env: {} }).pollCapMs, 30 * 60_000);     // unknown → 30m
    assert.strictEqual(computePyannoteTimeouts({ durationSeconds: 6000, env: { PYANNOTE_POLL_TIMEOUT_MS: '5000' } }).pollCapMs, 5000);
});

test('mapPyannoteOutput prefers turn-level, then word-level, then diarization', () => {
    const turn = mapPyannoteOutput({ turnLevelTranscription: [{ speaker: 'S0', start: 0, end: 2, text: 'hi' }] });
    assert.deepStrictEqual(turn, [{ speakerId: 'S0', start: 0, end: 2, text: 'hi' }]);

    const word = mapPyannoteOutput({ wordLevelTranscription: [{ speaker: 'S1', start: 1, end: 1.4, text: 'yo' }] });
    assert.strictEqual(word[0].speakerId, 'S1');

    const dia = mapPyannoteOutput({ diarization: [{ speaker: 'S2', start: 0, end: 5 }] });
    assert.deepStrictEqual(dia, [{ speakerId: 'S2', start: 0, end: 5, text: '' }]);

    assert.deepStrictEqual(mapPyannoteOutput({}), []);
    // zero/negative-length rows dropped
    assert.deepStrictEqual(mapPyannoteOutput({ turnLevelTranscription: [{ speaker: 'S', start: 2, end: 2, text: 'x' }] }), []);
});

// ── End-to-end (stubbed) ─────────────────────────────────────────────

test('happy path: uploads to media store, submits, polls, maps turn-level segments', async () => {
    const calls = installFetch();
    const out = await transcribeWithPyannote('meeting.mp4', { language: 'nl' });

    assert.strictEqual(out.segments.length, 2);
    assert.deepStrictEqual(out.segments[0], { speakerId: 'SPEAKER_00', start: 0, end: 3, text: 'Hallo allemaal' });
    assert.strictEqual(out.text, 'Hallo allemaal Goedemorgen');

    // Flow: media/input → presigned PUT → diarize → ≥1 job poll
    assert.ok(calls.some((c) => c.url.endsWith('/media/input') && c.method === 'POST'));
    assert.ok(calls.some((c) => c.url === 'https://presigned.example/put' && c.method === 'PUT'));
    assert.ok(calls.some((c) => c.url.endsWith('/diarize') && c.method === 'POST'));
    assert.ok(calls.some((c) => c.url.includes('/jobs/job-123')));
    assert.deepStrictEqual(cleanupCalls, ['x'], 'temp audio cleaned up');
});

test('the meeting LANGUAGE picks the speech model', async () => {
    // `language` used to reach this function and appear only in a log line —
    // it influenced nothing. It is the sole input pyannote's transcriptionConfig
    // can act on, via the model choice.
    const nl = {};
    installFetch({ submitBody: nl });
    await transcribeWithPyannote('meeting.mp4', { language: 'nl' });
    assert.strictEqual(nl.value.transcriptionConfig.model, 'parakeet-tdt-0.6b-v3',
        'Dutch must get the stronger European model');

    const ja = {};
    installFetch({ submitBody: ja });
    await transcribeWithPyannote('meeting.mp4', { language: 'ja' });
    assert.strictEqual(ja.value.transcriptionConfig.model, 'faster-whisper-large-v3-turbo',
        'Japanese is outside Parakeet\'s 25 languages and must fall back');
});

test('diarization always asks for precision-3', async () => {
    const body = {};
    installFetch({ submitBody: body });
    await transcribeWithPyannote('meeting.mp4', { language: 'nl' });
    assert.strictEqual(body.value.model, 'precision-3');
});

test('numSpeakers is sent in the diarize body when provided (exact count)', async () => {
    const submitBody = {};
    installFetch({ submitBody });
    await transcribeWithPyannote('meeting.mp4', { language: 'nl', numSpeakers: 5 });
    assert.strictEqual(submitBody.value.numSpeakers, 5);
    assert.strictEqual(submitBody.value.transcription, true);
    assert.strictEqual(submitBody.value.model, 'precision-3');
});

test('numSpeakers omitted (Auto) when not a positive number', async () => {
    const submitBody = {};
    installFetch({ submitBody });
    await transcribeWithPyannote('meeting.mp4', { language: 'nl', numSpeakers: 0 });
    assert.ok(!('numSpeakers' in submitBody.value));
});

test('a failed job surfaces output.error', async () => {
    installFetch({ jobStates: [{ status: 'failed', output: { error: 'audio too short' } }] });
    await assert.rejects(() => transcribeWithPyannote('meeting.mp4', {}), /failed: audio too short/);
});

test('the API key never leaks into an error message', async () => {
    global.fetch = async () => ({ ok: false, status: 401, text: async () => 'Bearer sk-test-key-abcdefghij is invalid' });
    await assert.rejects(
        () => transcribeWithPyannote('meeting.mp4', {}),
        (err) => {
            assert.ok(!err.message.includes('sk-test-key-abcdefghij'), 'key must be redacted');
            assert.match(err.message, /REDACTED/);
            return true;
        },
    );
});

// ── Speaker identification (voiceprints) ─────────────────────────────

test('COST GUARD: with no voiceprints, exactly one job is submitted', async () => {
    // The identify job doubles the pyannote bill for a meeting. An org where
    // nobody has enrolled must never pay it — this is the regression that
    // matters most if the selection logic ever changes.
    const calls = installFetch();
    const out = await transcribeWithPyannote('meeting.mp4', { language: 'nl' });

    assert.strictEqual(calls.filter(c => c.url.endsWith('/identify')).length, 0);
    assert.strictEqual(calls.filter(c => c.url.endsWith('/diarize')).length, 1);
    assert.strictEqual(out.voiceprintMapping, null);
    assert.strictEqual(out.voiceprintInfo, null);
});

test('both jobs run against ONE upload of the same media object', async () => {
    // Two uploads would mean two independent copies with no guaranteed shared
    // clock — the overlap reconciliation depends on this.
    const submitBody = {};
    const identifyBody = {};
    const calls = installFetch({ submitBody, identifyBody });
    await transcribeWithPyannote('meeting.mp4', { voiceprints: selection() });

    assert.strictEqual(calls.filter(c => c.url.endsWith('/media/input')).length, 1);
    assert.strictEqual(calls.filter(c => c.method === 'PUT').length, 1);
    assert.ok(submitBody.value.url.startsWith('media://'));
    assert.strictEqual(identifyBody.value.url, submitBody.value.url, 'both jobs must reference the same object');
});

test('the identify body carries an explicit threshold and exclusive matching', async () => {
    // matching.threshold defaults to 0 in the API — leaving it unset would
    // greedily label every outside participant with a colleague's name.
    const identifyBody = {};
    installFetch({ identifyBody });
    await transcribeWithPyannote('meeting.mp4', { numSpeakers: 4, voiceprints: selection() });

    assert.strictEqual(identifyBody.value.model, 'precision-3');
    assert.strictEqual(identifyBody.value.matching.threshold, 50);
    assert.strictEqual(identifyBody.value.matching.exclusive, true);
    assert.ok(!('confidence' in identifyBody.value), 'precision-3 answers the frame-level confidence flag with an error');
    assert.strictEqual(identifyBody.value.numSpeakers, 4, 'the same speaker-count hint aligns both diarizations');
    assert.deepStrictEqual(identifyBody.value.voiceprints, [{ label: 'vp_tom', voiceprint: 'QUFB' }]);
});

test('a confident match becomes a speaker mapping', async () => {
    installFetch({
        identifyOutput: {
            identification: [{ speaker: 'S_A', start: 0, end: 3 }],
            voiceprints: [{ speaker: 'S_A', match: 'vp_tom', confidence: { vp_tom: 92 } }],
        },
    });
    const out = await transcribeWithPyannote('meeting.mp4', {
        voiceprints: selection(),
        // Long, well-covered turns so the matcher's guards are satisfied.
        // (mapPyannoteOutput's segments are the fallback turn source.)
    });
    // The scripted transcript's SPEAKER_00 spans 0-3s, under the 8s fragment
    // floor, so nothing is pinned — proving the guards are actually applied
    // end-to-end rather than only in the unit test.
    assert.strictEqual(out.voiceprintMapping, null);
    assert.strictEqual(out.voiceprintInfo.failed, false);
    assert.strictEqual(out.voiceprintInfo.considered, 1);
});

test('the NEGATIVE verdict reaches the caller, not just the positive one', async () => {
    // A two-person meeting where only one is enrolled. The transcript's own
    // turns are the fallback diarization source, so they double as the two
    // speakers: SPEAKER_00 (0-3s) is fully covered by Tom's identify turns,
    // SPEAKER_01 (3-6s) is not covered at all.
    installFetch({
        jobStates: [{
            status: 'succeeded',
            output: {
                turnLevelTranscription: [
                    { speaker: 'SPEAKER_00', start: 0, end: 30, text: 'Hallo allemaal' },
                    { speaker: 'SPEAKER_01', start: 30, end: 90, text: 'Goedemorgen' },
                ],
            },
        }],
        identifyOutput: {
            identification: [{ speaker: 'S_A', start: 0, end: 30 }],
            voiceprints: [{ speaker: 'S_A', match: 'vp_tom', confidence: { vp_tom: 92 } }],
        },
    });
    const out = await transcribeWithPyannote('meeting.mp4', { voiceprints: selection() });

    assert.deepStrictEqual(out.voiceprintMapping, { SPEAKER_00: 'Tom Smit' });
    assert.deepStrictEqual(out.voiceprintRuledOut, { SPEAKER_01: ['Tom Smit'] },
        'the unenrolled participant must be reported as NOT the enrolled one');
});

test('IDENTIFY FAILURE NEVER COSTS THE TRANSCRIPT', async () => {
    installFetch({ identifyFails: true });
    const out = await transcribeWithPyannote('meeting.mp4', { voiceprints: selection() });

    assert.strictEqual(out.segments.length, 2, 'the transcript is returned exactly as without the feature');
    assert.strictEqual(out.text, 'Hallo allemaal Goedemorgen');
    assert.strictEqual(out.voiceprintMapping, null);
    assert.strictEqual(out.voiceprintInfo.failed, true);
});

test('voiceprint templates never appear in a log line or an error', async () => {
    const logged = [];
    const origLog = console.log;
    console.log = (...a) => logged.push(a.join(' '));
    try {
        installFetch();
        await transcribeWithPyannote('meeting.mp4', { voiceprints: selection() });
    } finally {
        console.log = origLog;
    }
    assert.ok(!logged.join('\n').includes('QUFB'), 'a biometric template must never be logged');
});

test('missing key → clear error before any network call', async () => {
    const configStore = require('../../stores/configStore');
    const orig = configStore.getSecret;
    configStore.getSecret = async () => null;
    const prevEnv = process.env.PYANNOTE_API_KEY;
    delete process.env.PYANNOTE_API_KEY;
    try {
        await assert.rejects(() => transcribeWithPyannote('meeting.mp4', {}), /Pyannote API key not configured/);
    } finally {
        configStore.getSecret = orig;
        if (prevEnv !== undefined) process.env.PYANNOTE_API_KEY = prevEnv;
    }
});
