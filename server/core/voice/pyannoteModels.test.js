/**
 * pyannoteAI model selection.
 *
 * The product override pyannoteAI's own default STT model with
 * `faster-whisper-large-v3-turbo` for every language. That is large-v3 with the
 * decoder pruned 32→4 layers ("a minor quality degradation", per OpenAI), and
 * on the same Open ASR Leaderboard suite it averages 7.83% WER against
 * Parakeet v3's 6.34%. Dutch and English — this product's two main languages —
 * were both getting the weaker model.
 *
 * Parakeet is not a drop-in replacement: it covers 25 European languages, so
 * five of the product's fourteen (tr, ja, zh, ko, ar) would break outright.
 * Hence per-language selection, which is also the only way the meeting's
 * `language` can reach pyannote at all — transcriptionConfig takes a model and
 * nothing else.
 *
 * Run: cd server && node --test core/voice/pyannoteModels.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    DIARIZATION_MODEL, PARAKEET, WHISPER_TURBO,
    pickTranscriptionModel, isValidTranscriptionModel, TRANSCRIPTION_MODELS,
} = require('./pyannoteModels');

test('diarization uses pyannoteAI\'s best model', () => {
    // community-1 is weaker; live-1 is streaming-only. There is no third option.
    assert.strictEqual(DIARIZATION_MODEL, 'precision-2');
});

test('the two languages this product cares about get the STRONGER model', () => {
    assert.strictEqual(pickTranscriptionModel('nl'), PARAKEET);
    assert.strictEqual(pickTranscriptionModel('en'), PARAKEET);
});

test('every product language resolves to a model that supports it', () => {
    // The full picker list from agent-hub/src/config/meetingNotesConfig.ts.
    const supported = ['nl', 'en', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'ru'];
    const unsupported = ['tr', 'ja', 'zh', 'ko', 'ar'];

    for (const code of supported) {
        assert.strictEqual(pickTranscriptionModel(code), PARAKEET, `${code} should use Parakeet`);
    }
    for (const code of unsupported) {
        // Parakeet cannot do these at all — using it would not be "slightly
        // worse", it would be broken.
        assert.strictEqual(pickTranscriptionModel(code), WHISPER_TURBO, `${code} must fall back to Whisper`);
    }
});

test('regional variants resolve on the base language', () => {
    for (const code of ['nl-NL', 'nl_BE', 'en-GB', 'EN-US', 'de-CH']) {
        assert.strictEqual(pickTranscriptionModel(code), PARAKEET, code);
    }
    assert.strictEqual(pickTranscriptionModel('zh-Hans'), WHISPER_TURBO);
});

test('an unknown or missing language falls back to the model that covers everything', () => {
    // Guessing Parakeet here could mean no transcript at all; Whisper's 99
    // languages make a wrong guess cost accuracy instead.
    for (const code of [null, undefined, '', '  ', 'xx', 'klingon']) {
        assert.strictEqual(pickTranscriptionModel(code), WHISPER_TURBO, JSON.stringify(code));
    }
});

test('an admin override wins over the language', () => {
    assert.strictEqual(pickTranscriptionModel('nl', WHISPER_TURBO), WHISPER_TURBO);
    assert.strictEqual(pickTranscriptionModel('ja', PARAKEET), PARAKEET);
});

test('a junk override is IGNORED rather than sent to the API', () => {
    // Sending an unknown model 400s the whole job. A silently automatic choice
    // beats no transcription — and the config route rejects it on the way in.
    assert.strictEqual(pickTranscriptionModel('nl', 'whisper-tiny'), PARAKEET);
    assert.strictEqual(pickTranscriptionModel('ja', 'not-a-model'), WHISPER_TURBO);
    assert.strictEqual(pickTranscriptionModel('nl', ''), PARAKEET);
});

test('the validator matches exactly what the API accepts', () => {
    assert.deepStrictEqual(TRANSCRIPTION_MODELS, [PARAKEET, WHISPER_TURBO]);
    assert.ok(isValidTranscriptionModel(PARAKEET));
    assert.ok(isValidTranscriptionModel(WHISPER_TURBO));
    assert.ok(!isValidTranscriptionModel('whisper-large-v3'));
    assert.ok(!isValidTranscriptionModel(''));
    assert.ok(!isValidTranscriptionModel(null));
});
