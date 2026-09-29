/**
 * Azure AI Speech (ConversationTranscriber) — shared transcription core.
 *
 * Single implementation behind both the meeting-notes upload/reprocess routes
 * and the chat `transcribe_audio` tool (routes/transcriptions.js and
 * integrations/transcriptionTools.js each used to carry their own near-copy,
 * both with a fixed 10-minute timeout that killed every long meeting and threw
 * away the segments already received).
 *
 * Timeout model, sized for long recordings:
 *  - an OVERALL cap derived from the audio duration (the service processes a
 *    pushed file at roughly real-time, so a 1h40m meeting legitimately needs
 *    hours, not minutes), and
 *  - an INACTIVITY watchdog that trips when the service stops producing
 *    events — a genuine stall is detected in minutes regardless of length.
 *
 * When a timeout trips after speech was already recognised, the partial result
 * is RETURNED (with a `truncated` marker) instead of discarded: 95 minutes of
 * a 100-minute meeting is a usable note, zero minutes is not.
 */

const fs = require('fs');
const configStore = require('../../stores/configStore');
const { preprocessForStt } = require('./audioPreprocess');
const log = require('../../telemetry/log');

/** BCP-47 locales per product language code; unknown codes fall back to xx-XX. */
const AZURE_LOCALE_MAP = {
    nl: 'nl-NL', en: 'en-US', de: 'de-DE', fr: 'fr-FR',
    es: 'es-ES', it: 'it-IT', pt: 'pt-PT', pl: 'pl-PL',
    sv: 'sv-SE', da: 'da-DK', fi: 'fi-FI', nb: 'nb-NO',
    tr: 'tr-TR', ja: 'ja-JP', zh: 'zh-CN', ko: 'ko-KR',
    ar: 'ar-SA', ru: 'ru-RU',
};

const WAV_HEADER_BYTES = 44;
const WAV_BYTES_PER_SECOND = 16000 * 2; // 16 kHz mono s16le

/** Duration of a 16kHz mono s16le WAV from its byte size — no ffprobe needed. */
function wavDurationSeconds(wavBytes) {
    const bytes = Number(wavBytes) || 0;
    return Math.max(0, Math.floor((bytes - WAV_HEADER_BYTES) / WAV_BYTES_PER_SECOND));
}

function clamp(value, lo, hi) {
    return Math.min(hi, Math.max(lo, value));
}

/**
 * Timeouts for a ConversationTranscriber run.
 *
 * Overall cap: 2× real-time plus 5 minutes of connection/queue headroom,
 * clamped to [15 min, 4 h]; 30 min when the duration is unknown. The
 * inactivity watchdog is what actually catches stalls, so the cap only has to
 * be generous enough to never cut off a healthy run.
 *
 * @param {{durationSeconds?: number, env?: object}} [opts]
 * @returns {{overallMs: number, inactivityMs: number}}
 */
function computeAzureTimeouts({ durationSeconds = 0, env = process.env } = {}) {
    const overallOverride = Number(env.AZURE_SPEECH_TIMEOUT_MS);
    const inactivityOverride = Number(env.AZURE_SPEECH_INACTIVITY_TIMEOUT_MS);
    const overallMs = overallOverride > 0
        ? overallOverride
        : (Number(durationSeconds) > 0
            ? clamp(Number(durationSeconds) * 2000 + 5 * 60_000, 15 * 60_000, 4 * 3600_000)
            : 30 * 60_000);
    const inactivityMs = inactivityOverride > 0 ? inactivityOverride : 180_000;
    return { overallMs, inactivityMs };
}

function redactSecrets(message) {
    return String(message || '')
        .replace(/[A-Za-z0-9_\-]{32,}/g, '[REDACTED]')
        .replace(/key[=:]\S+/gi, 'key=[REDACTED]');
}

/**
 * Transcribe an audio file with Azure AI Speech (diarized).
 *
 * @param {string} inputPath  Any audio file ffmpeg can read.
 * @param {{language?: string, contextTerms?: string}} [opts]
 * @returns {Promise<{
 *   text: string,
 *   segments: Array<{speakerId: string, start: number, end: number, text: string}>,
 *   durationSeconds: number,
 *   truncated: null | {reason: 'inactivity'|'overall_timeout', atSeconds: number},
 * }>}
 * @throws on missing credentials, audio conversion failure, service errors,
 *   or when the run ends without a single recognised segment.
 */
async function transcribeWithAzureSpeech(inputPath, { language = 'nl', contextTerms = '' } = {}) {
    const azureKey = await configStore.getSecret('azure_speech_key');
    const azureRegion = await configStore.getConfig('azure_speech_region');
    if (!azureKey || !azureRegion) {
        throw new Error('Azure Speech credentials not configured. Go to Admin → Integrations → Transcription.');
    }
    if (!/^[a-z0-9-]{2,32}$/.test(azureRegion)) {
        throw new Error('Invalid Azure Speech region format stored in configuration.');
    }

    const wav = await preprocessForStt(inputPath, { format: 'wav', label: 'azure-stt' });
    // preprocessForStt fails open (returns the original path); the SDK only
    // accepts 16kHz WAV, so a failed conversion of a non-WAV source is fatal.
    if (!wav.preprocessed && !String(inputPath).toLowerCase().endsWith('.wav')) {
        throw new Error('Audio conversion for Azure Speech failed. Check the recording format, or pick another provider.');
    }

    const durationSeconds = wavDurationSeconds(statSizeOrZero(wav.path));
    const { overallMs, inactivityMs } = computeAzureTimeouts({ durationSeconds });

    const locale = AZURE_LOCALE_MAP[language] || `${language}-${String(language).toUpperCase()}`;
    const sdk = require('microsoft-cognitiveservices-speech-sdk');

    const speechConfig = sdk.SpeechConfig.fromSubscription(azureKey, azureRegion);
    const rawSegments = [];
    let truncated = null;
    let transcriber = null;

    try {
        speechConfig.speechRecognitionLanguage = locale;
        speechConfig.requestWordLevelTimestamps();
        // Detailed output provides higher accuracy & word-level confidence.
        speechConfig.outputFormat = sdk.OutputFormat.Detailed;
        // Don't censor/filter words — we want the raw transcription.
        if (speechConfig.setProfanity) speechConfig.setProfanity(sdk.ProfanityOption.Raw);
        // Allow longer pauses within a sentence before it's considered complete
        // (default 500ms fragments sentences), and up to 10s of initial silence.
        speechConfig.setProperty('Speech_SegmentationSilenceTimeoutMs', '3000');
        speechConfig.setProperty('SpeechServiceConnection_InitialSilenceTimeoutMs', '10000');

        const audioConfig = sdk.AudioConfig.fromWavFileInput(await fs.promises.readFile(wav.path));
        transcriber = new sdk.ConversationTranscriber(speechConfig, audioConfig);

        if (contextTerms) {
            try {
                const phraseList = sdk.PhraseListGrammar.fromRecognizer(transcriber);
                String(contextTerms).split(/[,;\n]/).map(t => t.trim()).filter(Boolean)
                    .forEach(term => phraseList.addPhrase(term));
            } catch (_) { /* PhraseListGrammar may not work with ConversationTranscriber */ }
        }

        log.info(`[AzureSpeech] Transcribing (locale ${locale}, ~${durationSeconds}s audio, cap ${Math.round(overallMs / 60000)}m, watchdog ${Math.round(inactivityMs / 1000)}s)`);

        await new Promise((resolve, reject) => {
            let settled = false;
            let overallTimer = null;
            let inactivityTimer = null;

            const settle = (fn, arg) => {
                if (settled) return;
                settled = true;
                clearTimeout(overallTimer);
                clearTimeout(inactivityTimer);
                fn(arg);
            };

            const trip = (reason) => {
                if (settled) return;
                try { transcriber.stopTranscribingAsync(() => {}, () => {}); } catch (_) {}
                if (rawSegments.length > 0) {
                    // Salvage: everything recognised so far becomes the result.
                    truncated = { reason, atSeconds: rawSegments[rawSegments.length - 1].end };
                    log.warn(`[AzureSpeech] ${reason} after ${rawSegments.length} segments — returning partial transcript up to ${truncated.atSeconds.toFixed(0)}s`);
                    settle(resolve);
                } else {
                    settle(reject, new Error(reason === 'inactivity'
                        ? `Azure Speech stalled: no recognition activity for ${Math.round(inactivityMs / 1000)}s before any speech was recognised.`
                        : 'Azure Speech timed out before any speech was recognised.'));
                }
            };

            const armInactivity = () => {
                clearTimeout(inactivityTimer);
                inactivityTimer = setTimeout(() => trip('inactivity'), inactivityMs);
            };

            overallTimer = setTimeout(() => trip('overall_timeout'), overallMs);
            armInactivity();

            // Interim hypotheses count as liveness even before a final segment lands.
            transcriber.transcribing = () => armInactivity();
            transcriber.transcribed = (_s, e) => {
                armInactivity();
                if (e.result.reason === sdk.ResultReason.RecognizedSpeech && e.result.text) {
                    rawSegments.push({
                        speakerId: e.result.speakerId || 'Unknown',
                        start: e.result.offset / 10_000_000,
                        end: (e.result.offset + e.result.duration) / 10_000_000,
                        text: e.result.text.trim(),
                    });
                }
            };
            transcriber.canceled = (_s, e) => {
                if (e.reason === sdk.CancellationReason.Error) {
                    settle(reject, new Error(`Azure Speech error: ${redactSecrets(e.errorDetails)}`));
                } else {
                    settle(resolve);
                }
            };
            transcriber.sessionStopped = () => settle(resolve);
            transcriber.startTranscribingAsync(
                () => {},
                (err) => settle(reject, new Error(`Azure start failed: ${redactSecrets(err?.message || String(err))}`)),
            );
        });
    } finally {
        try { if (transcriber) transcriber.close(); } catch (_) {}
        try { if (speechConfig.close) speechConfig.close(); } catch (_) {}
        wav.cleanup();
    }

    log.info(`[AzureSpeech] Returned ${rawSegments.length} segments${truncated ? ` (truncated: ${truncated.reason})` : ''}`);
    if (rawSegments.length === 0) {
        throw new Error('Azure Speech returned no speech. Check language setting and audio quality.');
    }

    return {
        text: rawSegments.map(s => s.text).join(' '),
        segments: rawSegments.map(s => ({ speakerId: s.speakerId, start: s.start, end: s.end, text: s.text })),
        durationSeconds,
        truncated,
    };
}

function statSizeOrZero(p) {
    try { return fs.statSync(p).size; } catch (_) { return 0; }
}

module.exports = {
    transcribeWithAzureSpeech,
    // exported for unit tests (DB-free)
    wavDurationSeconds,
    computeAzureTimeouts,
    AZURE_LOCALE_MAP,
};
