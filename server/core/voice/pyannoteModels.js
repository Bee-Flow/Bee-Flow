/**
 * Which pyannoteAI models to use, and why.
 *
 * DIARIZATION — `precision-3`, always, for /diarize, /identify and /voiceprint
 * alike. It is pyannoteAI's best: "Across our 15 benchmark datasets,
 * diarization error rate drops by 10.4% against Precision-2, from 16.02 to
 * 14.35", at the Precision-2 price. Precision-2 is deprecated in October 2026,
 * and a request that names it explicitly (as this constant did) does not move
 * with the API default, so the name is spelled out here rather than left to
 * the default. Precision-3 rejects the old frame-level `confidence` request
 * flag; the identify match scores we read arrive without it.
 * `community-1` is the weaker open-source model and `live-1` is streaming-only
 * (sub-300ms latency, for live captioning), so neither is a candidate for
 * meeting notes.
 *
 * TRANSCRIPTION — depends on the meeting language. pyannoteAI hosts exactly two
 * speech models, and neither wins everywhere:
 *
 *   parakeet-tdt-0.6b-v3        NVIDIA. 25 European languages. Purpose-built
 *   (pyannoteAI's default)      for them, and it shows: 4.85% WER on English
 *                               FLEURS and 6.34% average across the nine Open
 *                               ASR Leaderboard datasets, 7.48% on Dutch
 *                               FLEURS. Emits punctuation and capitalisation.
 *
 *   faster-whisper-large-v3-    OpenAI. 99 languages, so it is the only option
 *   turbo                       outside Parakeet's 25 — but it is large-v3 with
 *                               the decoder pruned from 32 layers to 4, which
 *                               OpenAI describe as "way faster, at the expense
 *                               of a minor quality degradation". It averages
 *                               7.83% on the same English suite.
 *
 * So Parakeet is the stronger model for every language it covers — including
 * Dutch and English, this product's two main ones — and Whisper is the fallback
 * that makes the rest work at all. Picking one globally means either handing
 * Dutch and English a measurably worse transcript, or breaking Japanese,
 * Chinese, Korean, Arabic and Turkish outright. So we pick per meeting.
 *
 * This is also the only thing the meeting's `language` can influence: pyannote's
 * `transcriptionConfig` accepts a model and nothing else — no language hint, no
 * prompt, no vocabulary — so the language selection the user makes at capture
 * reaches the API exclusively through this choice.
 *
 * Benchmarks are read speech; meeting audio is harder and ranks models
 * differently (Whisper turbo scores 16.13 on AMI against a 7.83 mean). Treat
 * PARAKEET_LANGUAGES as the default policy, not gospel — an admin can pin one
 * model for the whole instance, and both remain available.
 */

'use strict';

const DIARIZATION_MODEL = 'precision-3';

const PARAKEET = 'parakeet-tdt-0.6b-v3';
const WHISPER_TURBO = 'faster-whisper-large-v3-turbo';

/** Every transcription model pyannoteAI accepts. Anything else is a 400. */
const TRANSCRIPTION_MODELS = [PARAKEET, WHISPER_TURBO];

/**
 * The 25 European languages Parakeet v3 supports. Outside this set it cannot
 * be used at all, so the entry is the difference between a good transcript and
 * no transcript.
 */
const PARAKEET_LANGUAGES = new Set([
    'bg', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de', 'el', 'hu',
    'it', 'lv', 'lt', 'mt', 'pl', 'pt', 'ro', 'sk', 'sl', 'es', 'sv', 'ru', 'uk',
]);

/**
 * Pick the transcription model for a meeting.
 *
 * @param {string|null} language   BCP-47-ish code from the capture screen ('nl', 'en-GB', …).
 * @param {string|null} [override] Admin-pinned model; used when it is a model
 *   pyannote actually accepts. An unknown string is ignored rather than sent —
 *   it would fail the whole job, and a silently weaker model beats no transcript.
 * @returns {string} a member of TRANSCRIPTION_MODELS
 */
function pickTranscriptionModel(language, override = null) {
    if (override && TRANSCRIPTION_MODELS.includes(override)) return override;
    const base = String(language || '').trim().toLowerCase().split(/[-_]/)[0];
    // Unknown/absent language falls back to Whisper: it covers everything, so
    // guessing wrong costs some accuracy rather than the whole transcription.
    if (!base) return WHISPER_TURBO;
    return PARAKEET_LANGUAGES.has(base) ? PARAKEET : WHISPER_TURBO;
}

/** True when `model` is one pyannoteAI accepts (for admin-input validation). */
function isValidTranscriptionModel(model) {
    return TRANSCRIPTION_MODELS.includes(String(model || '').trim());
}

module.exports = {
    DIARIZATION_MODEL,
    PARAKEET,
    WHISPER_TURBO,
    TRANSCRIPTION_MODELS,
    PARAKEET_LANGUAGES,
    pickTranscriptionModel,
    isValidTranscriptionModel,
};
