/**
 * Voiceprint enrollment + selection.
 *
 * Pins the things that would be expensive or dangerous to get wrong:
 *   - the feature is INERT unless pyannoteAI is the active provider,
 *   - a clip that is too short / too long / silent never reaches pyannote,
 *   - labels sent to pyannote are opaque ids, never people's names,
 *   - selection respects the 50-template API cap and ranks who is likely present.
 *
 * configStore + voiceprintStore + audioPreprocess + global.fetch are stubbed —
 * no DB, no network.
 * Run: cd server && node --test core/voice/voiceprintClient.test.js
 */

process.env.PYANNOTE_POLL_INTERVAL_MS = '1';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

let config = {};
stub('../../stores/configStore', {
    getConfig: async (k) => (k in config ? config[k] : null),
    getSecret: async (k) => (k === 'pyannote_api_key' ? 'sk-test-key-abcdefghij' : null),
});

let orgMeta = [];
let blobs = [];
stub('../../stores/voiceprintStore', {
    DEFAULT_PROVIDER: 'pyannote',
    listOrgVoiceprintMeta: async () => orgMeta,
    loadVoiceprintBlobs: async (ids) => blobs.filter(b => ids.includes(b.id)),
});

// ── A real 16kHz mono PCM WAV so analyseEnrollmentWav has something to read ──
function makeWav(seconds, { silent = false, sampleRate = 16000, dutyCycle = 1 } = {}) {
    const frames = Math.round(seconds * sampleRate);
    const data = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i++) {
        // A 200Hz tone at a realistic speech level, or digital silence.
        // `dutyCycle` simulates the pauses in real read-aloud speech: 0.5 means
        // one second of tone, one second of silence, repeating.
        const inPause = dutyCycle < 1 && ((i / sampleRate) % 2) >= dutyCycle * 2;
        const v = (silent || inPause) ? 0 : Math.round(Math.sin((i / sampleRate) * 2 * Math.PI * 200) * 8000);
        data.writeInt16LE(v, i * 2);
    }
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
    header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write('data', 36); header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
}

const WAV_PATH = path.join(os.tmpdir(), `voiceprint-test-${Date.now()}.wav`);
let preprocessed = true;
stub('./audioPreprocess', {
    preprocessForStt: async (_p, opts) => {
        preprocessCalls.push(opts);
        return { path: WAV_PATH, preprocessed, cleanup: () => cleanupCalls.push('x') };
    },
});
const preprocessCalls = [];
const cleanupCalls = [];

const vc = require('./voiceprintClient');

test.after(() => { try { fs.unlinkSync(WAV_PATH); } catch (_) {} });

const realFetch = global.fetch;
test.beforeEach(() => {
    config = { transcription_provider: 'pyannote' };
    orgMeta = []; blobs = []; preprocessed = true;
    preprocessCalls.length = 0; cleanupCalls.length = 0;
    fs.writeFileSync(WAV_PATH, makeWav(25));
});
test.afterEach(() => { global.fetch = realFetch; });

function installFetch({ voiceprint = 'VGhpcy1pcy1hLXZvaWNlcHJpbnQ=', jobStatus = 'succeeded', jobError } = {}) {
    const calls = [];
    global.fetch = async (url, opts = {}) => {
        calls.push({ url, method: opts.method || 'GET', body: opts.body });
        if (url.endsWith('/media/input')) return { ok: true, json: async () => ({ url: 'https://presigned.example/put' }) };
        if (url === 'https://presigned.example/put') return { ok: true, text: async () => '' };
        if (url.endsWith('/voiceprint')) return { ok: true, json: async () => ({ jobId: 'vp-job-1' }) };
        if (url.includes('/jobs/')) {
            return { ok: true, json: async () => (jobStatus === 'succeeded'
                ? { status: 'succeeded', output: { voiceprint } }
                : { status: jobStatus, output: { error: jobError } }) };
        }
        throw new Error(`unexpected fetch ${url}`);
    };
    return calls;
}

// ── Availability ─────────────────────────────────────────────────────

test('availability: inert unless pyannoteAI is the active provider', async () => {
    config = { transcription_provider: 'voxtral' };
    assert.deepStrictEqual(
        await vc.isVoiceprintAvailable({ organizationId: 'org-1' }),
        { available: false, reason: 'provider_not_pyannote', provider: 'voxtral' },
    );
});

test('availability: an account without an organisation cannot enrol', async () => {
    // A template is encrypted under the ORG's vault key and only ever matched
    // within that org, so it is meaningless for a consumer account.
    const r = await vc.isVoiceprintAvailable({ organizationId: '' });
    assert.strictEqual(r.available, false);
    assert.strictEqual(r.reason, 'no_organization');
});

test('availability: the instance kill switch turns it off', async () => {
    config = { transcription_provider: 'pyannote', voiceprint_matching_enabled: false };
    const r = await vc.isVoiceprintAvailable({ organizationId: 'org-1' });
    assert.strictEqual(r.reason, 'feature_disabled');
});

test('availability: all conditions met', async () => {
    const r = await vc.isVoiceprintAvailable({ organizationId: 'org-1' });
    assert.deepStrictEqual(r, { available: true, reason: null, provider: 'pyannote' });
});

// ── WAV analysis ─────────────────────────────────────────────────────

test('analyseEnrollmentWav measures duration exactly and detects speech', () => {
    const r = vc.analyseEnrollmentWav(makeWav(25));
    assert.strictEqual(Math.round(r.seconds), 25);
    assert.ok(r.voicedSeconds > 20, `expected mostly voiced, got ${r.voicedSeconds}s`);
});

test('analyseEnrollmentWav reports silence as unvoiced', () => {
    const r = vc.analyseEnrollmentWav(makeWav(25, { silent: true }));
    assert.strictEqual(r.voicedSeconds, 0);
    assert.strictEqual(r.peak, 0);
});

test('analyseEnrollmentWav rejects a non-WAV buffer with a code', () => {
    assert.throws(() => vc.analyseEnrollmentWav(Buffer.alloc(10)), (e) => e.code === 'enroll_failed');
});

// ── Enrollment ───────────────────────────────────────────────────────

test('enrollment: uploads, submits, polls, returns the template, cleans up', async () => {
    const calls = installFetch();
    const out = await vc.createVoiceprint('rec.webm', { language: 'nl' });

    assert.strictEqual(out.voiceprint, 'VGhpcy1pcy1hLXZvaWNlcHJpbnQ=');
    assert.strictEqual(out.model, 'precision-3');
    assert.strictEqual(Math.round(out.durationSeconds), 25);
    assert.ok(calls.some(c => c.url.endsWith('/media/input')));
    assert.ok(calls.some(c => c.url.endsWith('/voiceprint') && c.method === 'POST'));
    assert.deepStrictEqual(cleanupCalls, ['x'], 'the temp audio is always cleaned up');
});

test('enrollment: the 30s ceiling is enforced at transcode time', async () => {
    installFetch();
    await vc.createVoiceprint('rec.webm', {});
    assert.strictEqual(preprocessCalls[0].maxSeconds, 28, 'clipped two seconds under pyannote\'s hard limit');
    assert.strictEqual(preprocessCalls[0].format, 'wav', 'WAV so the duration is exact and RMS is readable');
});

test('enrollment: a clip under the floor never reaches pyannote', async () => {
    fs.writeFileSync(WAV_PATH, makeWav(6));
    const calls = installFetch();
    await assert.rejects(() => vc.createVoiceprint('rec.webm', {}), (e) => e.code === 'too_short');
    assert.strictEqual(calls.length, 0, 'no network call for a clip we already know is unusable');
});

test('enrollment: an over-long clip is refused (ffmpeg-less box, untrimmed audio)', async () => {
    // preprocessForStt never throws — without ffmpeg it hands back the ORIGINAL
    // file, so the duration check is the only thing standing between a 5-minute
    // recording and a 400 from pyannote.
    fs.writeFileSync(WAV_PATH, makeWav(45));
    installFetch();
    await assert.rejects(() => vc.createVoiceprint('rec.webm', {}), (e) => e.code === 'too_long');
});

test('enrollment: a silent recording is refused', async () => {
    fs.writeFileSync(WAV_PATH, makeWav(25, { silent: true }));
    installFetch();
    await assert.rejects(() => vc.createVoiceprint('rec.webm', {}), (e) => e.code === 'too_quiet');
});

test('enrollment: NORMAL SPEECH WITH PAUSES IS ACCEPTED', async () => {
    // Regression. The first silence check demanded that half the clip be
    // voiced, which reads as a reasonable rule and is not: reading a passage
    // aloud is roughly half pauses, so it rejected real recordings from people
    // speaking loudly and clearly. What matters is how much SPEECH is present.
    fs.writeFileSync(WAV_PATH, makeWav(25, { dutyCycle: 0.4 }));
    // `stats` comes from feeding this test's own synthetic WAV bytes through
    // the real analyseEnrollmentWav() — a behavioural call, not a source
    // read; the source-text counter cannot tell the two apart because both
    // happen to go through readFileSync.
    const stats = vc.analyseEnrollmentWav(fs.readFileSync(WAV_PATH));
    assert.ok(stats.voicedFraction < 0.5, `fixture must sit under the old 50% rule (was ${stats.voicedFraction})`);

    installFetch();
    const out = await vc.createVoiceprint('rec.webm', {});
    assert.ok(out.voiceprint, 'a clip with ~10s of speech across 25s must enrol');
});

test('enrollment: an oversized template fails now, not at the first meeting', async () => {
    installFetch({ voiceprint: 'x'.repeat(20001) });
    await assert.rejects(() => vc.createVoiceprint('rec.webm', {}), (e) => e.code === 'voiceprint_too_large');
});

test('enrollment: a failed job is mapped to a usable error code', async () => {
    installFetch({ jobStatus: 'failed', jobError: 'audio contains multiple speakers' });
    await assert.rejects(
        () => vc.createVoiceprint('rec.webm', {}),
        (err) => {
            assert.strictEqual(vc.mapEnrollError(err).code, 'multiple_speakers');
            return true;
        },
    );
});

test('enrollment: the API key never leaks into an error message', async () => {
    global.fetch = async () => ({ ok: false, status: 401, text: async () => 'Bearer sk-test-key-abcdefghij rejected' });
    await assert.rejects(
        () => vc.createVoiceprint('rec.webm', {}),
        (err) => {
            assert.ok(!err.message.includes('sk-test-key-abcdefghij'));
            return true;
        },
    );
});

// ── Name resolution ──────────────────────────────────────────────────

test('display names fall back sensibly and never come out empty', () => {
    assert.strictEqual(vc.displayNameFor({ displayName: 'Tom Smit' }), 'Tom Smit');
    assert.strictEqual(vc.displayNameFor({ firstName: 'Jan', lastName: 'de Vries' }), 'Jan de Vries');
    assert.strictEqual(vc.displayNameFor({ email: 'ewald@beeflow.nl' }), 'ewald');
    assert.ok(vc.displayNameFor({ userId: 'abcdef123' }).length > 0);
});

test('identical names are disambiguated — two colleagues must never merge', () => {
    const rows = [
        { userId: 'a', displayName: 'Jan Jansen', lastName: 'Jansen' },
        { userId: 'b', displayName: 'Jan Jansen', lastName: 'Jansen', email: 'jan2@x.nl' },
    ];
    const names = vc.disambiguateNames(rows).map(r => r.name);
    assert.notStrictEqual(names[0], names[1], `both resolved to ${names[0]}`);
});

test('name comparison ignores case and diacritics', () => {
    assert.strictEqual(vc.normalizeName('  Renée   VAN DÍJK '), 'renee van dijk');
});

// ── Selection ────────────────────────────────────────────────────────

function meta(n, extra = {}) {
    return { id: `vp_${n}`, userId: `u${n}`, displayName: `Person ${n}`, matchCount: 0, createdAt: '2026-01-01T00:00:00Z', lastMatchedAt: null, ...extra };
}

test('selection: no org, or an org with nobody enrolled, submits no identify job', async () => {
    assert.deepStrictEqual((await vc.selectVoiceprintsForJob({ orgId: null })).voiceprints, []);
    orgMeta = [];
    assert.deepStrictEqual((await vc.selectVoiceprintsForJob({ orgId: 'org-1' })).voiceprints, []);
});

test('selection: inert when the provider is not pyannote — zero extra cost', async () => {
    config = { transcription_provider: 'voxtral' };
    orgMeta = [meta(1)];
    blobs = [{ id: 'vp_1', userId: 'u1', voiceprint: 'AAA' }];
    assert.deepStrictEqual((await vc.selectVoiceprintsForJob({ orgId: 'org-1' })).voiceprints, []);
});

test('selection: labels are opaque ids, never the person\'s name', async () => {
    orgMeta = [meta(1, { displayName: 'Tom Smit' })];
    blobs = [{ id: 'vp_1', userId: 'u1', voiceprint: 'AAA' }];
    const r = await vc.selectVoiceprintsForJob({ orgId: 'org-1' });
    assert.deepStrictEqual(r.voiceprints, [{ label: 'vp_1', voiceprint: 'AAA' }]);
    assert.strictEqual(r.labelToName.vp_1.name, 'Tom Smit');
    // The name must not travel in the request body at all.
    assert.ok(!JSON.stringify(r.voiceprints).includes('Tom'));
});

test('selection: the recorder ranks first, then the attendee list', async () => {
    orgMeta = [
        meta(1, { displayName: 'Ann Bakker' }),
        meta(2, { displayName: 'Tom Smit' }),
        meta(3, { displayName: 'Ewald de Groot' }),
    ];
    blobs = orgMeta.map(m => ({ id: m.id, userId: m.userId, voiceprint: 'AAA' }));
    const r = await vc.selectVoiceprintsForJob({ orgId: 'org-1', recorderUserId: 'u3', attendees: ['tom'] });
    assert.deepStrictEqual(r.ids, ['vp_3', 'vp_2', 'vp_1']);
});

test('selection: caps at the API\'s 50 templates and reports the truncation', async () => {
    orgMeta = Array.from({ length: 60 }, (_, i) => meta(i));
    blobs = orgMeta.map(m => ({ id: m.id, userId: m.userId, voiceprint: 'AAA' }));
    const r = await vc.selectVoiceprintsForJob({ orgId: 'org-1' });
    assert.strictEqual(r.voiceprints.length, 50);
    assert.strictEqual(r.total, 60);
    assert.strictEqual(r.truncated, true);
});

test('selection: an undecryptable template is skipped, not fatal', async () => {
    orgMeta = [meta(1), meta(2)];
    blobs = [{ id: 'vp_2', userId: 'u2', voiceprint: 'AAA' }]; // vp_1 failed to decrypt
    const r = await vc.selectVoiceprintsForJob({ orgId: 'org-1' });
    assert.deepStrictEqual(r.ids, ['vp_2']);
});
