/**
 * pyannoteAI (api.pyannote.ai) — all-in-one speaker-attributed transcription,
 * optionally with per-person speaker identification.
 *
 * Unlike the Azure Whisper batch path this needs NO publicly-reachable object
 * storage: pyannoteAI hosts its own temporary media store (`media://` URLs,
 * valid ≥24h), so the flow is upload-to-pyannote → submit → poll → map. One
 * job returns both diarization and transcription (precision-3 + a Whisper/
 * Parakeet STT), so it is a full provider like Voxtral/Azure, not a
 * diarizer that has to be paired with a separate transcription engine.
 *
 * SPEAKER IDENTIFICATION (voiceprints)
 * `/identify` cannot transcribe — pyannote's docs are explicit: "Transcription
 * cannot be used with speaker identification jobs yet." So when the recording
 * org has enrolled voiceprints we submit a SECOND job. Both jobs reference the
 * SAME `media://` object (uploaded once), which is what gives their two
 * independent diarizations a shared clock to be reconciled against, and they
 * are polled concurrently so wall-clock is max(diarize, identify), not the sum.
 *
 * Identification is a garnish, never the critical path: if the identify job
 * fails, times out or 402s, the transcript is returned exactly as it would
 * have been without the feature. Only the diarize job can fail a meeting.
 *
 * Docs (verified 2026-07): POST /media/input → presigned PUT; POST /diarize
 * with transcription:true → {jobId}; GET /jobs/{id} → output.turnLevel-
 * Transcription [{speaker,start,end,text}] (seconds). Language is auto-detected.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const configStore = require('../../stores/configStore');
const { preprocessForStt } = require('./audioPreprocess');
const pyannoteApi = require('./pyannoteApi');
const log = require('../../telemetry/log');

const {
    redact, computePyannoteTimeouts, wavlikeDurationSeconds,
    resolvePyannoteAuth, uploadMedia, submitJob, pollJob,
} = pyannoteApi;

const { DIARIZATION_MODEL, pickTranscriptionModel } = require('./pyannoteModels');
// pyannote's own greedy-assignment floor. It DEFAULTS TO 0, which would label
// every unenrolled participant with whichever colleague scored least badly —
// so it is always sent explicitly.
const DEFAULT_IDENTIFY_THRESHOLD = 50;

/**
 * Map a succeeded job's `output` to Bee Flow's segment shape.
 *
 * Prefers turn-level transcription (one row per speaker turn, exactly our
 * shape); falls back to word-level (kept as-is; the shared post-processing
 * merges consecutive same-speaker rows) and finally to diarization-only
 * (no text) so a transcription-less result still yields speaker lanes.
 *
 * @param {object} output
 * @returns {Array<{speakerId: string, start: number, end: number, text: string}>}
 */
function mapPyannoteOutput(output) {
    const rows = output?.turnLevelTranscription?.length
        ? output.turnLevelTranscription
        : (output?.wordLevelTranscription?.length
            ? output.wordLevelTranscription
            : (output?.diarization || []));
    return (Array.isArray(rows) ? rows : [])
        .map((r) => ({
            speakerId: r.speaker || 'Unknown',
            start: Number(r.start) || 0,
            end: Number(r.end) || 0,
            text: (r.text || '').trim(),
        }))
        .filter((r) => r.end > r.start);
}

/**
 * Turns to reconcile identification against. Prefer the job's own
 * `diarization` rows — those are the acoustic turns, unsmeared by the STT's
 * sentence segmentation — and fall back to the mapped transcript segments when
 * a diarization-only array isn't present.
 */
function diarizationTurns(output, segments) {
    const rows = output?.diarization;
    if (Array.isArray(rows) && rows.length) {
        return rows
            .map((r) => ({ speakerId: r.speaker || 'Unknown', start: Number(r.start) || 0, end: Number(r.end) || 0 }))
            .filter((r) => r.end > r.start);
    }
    return segments.map((s) => ({ speakerId: s.speakerId, start: s.start, end: s.end }));
}

/**
 * Transcribe + diarize an audio file with pyannoteAI, and — when the recording
 * organisation has enrolled voiceprints — identify the speakers by voice.
 *
 * @param {string} inputPath  Any audio/video file ffmpeg can read.
 * @param {{language?: string, numSpeakers?: number|null,
 *          orgId?: string|null, recorderUserId?: string|null, attendees?: string[],
 *          voiceprints?: object|null}} [opts]
 *        `voiceprints` is the pre-resolved selection (used by tests and by
 *        callers that already loaded it); otherwise it is resolved from
 *        `orgId`. With neither, exactly one job is submitted — byte-identical
 *        behaviour to before identification existed.
 * @returns {Promise<{text: string, segments: Array<{speakerId,start,end,text}>, durationSeconds: number,
 *                    voiceprintMapping: Object<string,string>|null,
 *                    voiceprintRoster: string[],
 *                    voiceprintRuledOut: Object<string,string[]>|null,
 *                    voiceprintInfo: object|null}>}
 * @throws on missing key, upload/job/result errors, or when no speech is returned.
 */
async function transcribeWithPyannote(inputPath, {
    language = 'nl', numSpeakers = null,
    orgId = null, recorderUserId = null, attendees = [], voiceprints = null,
} = {}) {
    const auth = await resolvePyannoteAuth();
    // The meeting language picks the speech model — see pyannoteModels.js. This
    // is the ONLY thing `language` can influence: pyannote's transcriptionConfig
    // takes a model and nothing else, so there is no language hint to pass.
    const transcriptionModel = pickTranscriptionModel(
        language,
        await configStore.getConfig('pyannote_transcription_model'),
    );

    // Resolved before the upload so a selection failure can't strand a job.
    // Lazy require: voiceprintClient pulls in the DB, and this module is
    // exercised by DB-free unit tests.
    let selection = voiceprints;
    if (!selection && orgId) {
        try {
            const { selectVoiceprintsForJob } = require('./voiceprintClient');
            selection = await selectVoiceprintsForJob({ orgId, recorderUserId, attendees });
        } catch (e) {
            log.warn('[Pyannote] Voiceprint selection failed, continuing without identification:', redact(e.message));
            selection = null;
        }
    }
    const vpList = selection?.voiceprints || [];

    // Canonical audio-only FLAC (16kHz mono): strips any video track and normalises
    // the container so pyannote always gets decodable audio. Falls open to the
    // original file if ffmpeg is unavailable.
    const audio = await preprocessForStt(inputPath, { format: 'flac', label: 'pyannote' });
    const sendPath = audio.path;
    const ext = path.extname(sendPath).toLowerCase();

    try {
        const bytes = await fs.promises.readFile(sendPath);

        // ── Step 1+2: stage the audio ONCE (both jobs reference this object) ──
        const mediaUrl = await uploadMedia(bytes, ext, auth);

        // ── Step 3: submit the diarization + transcription job ──
        const jobBody = {
            url: mediaUrl,
            model: DIARIZATION_MODEL,
            transcription: true,
            transcriptionConfig: { model: transcriptionModel },
        };
        const n = Number(numSpeakers);
        if (Number.isFinite(n) && n >= 1) jobBody.numSpeakers = Math.min(Math.round(n), 50);

        log.info(`[Pyannote] Submitting job (lang ${language}, stt ${transcriptionModel}${jobBody.numSpeakers ? `, ${jobBody.numSpeakers} speakers` : ', auto speakers'}${vpList.length ? `, ${vpList.length} voiceprints` : ''})`);
        const diarizeJobId = await submitJob('/diarize', jobBody, auth);

        // ── Step 3b: submit the identification job against the SAME media ──
        let identifyJobId = null;
        if (vpList.length) {
            // An UNSET config must fall back to the default, not to 0.
            // `Number(null)` is 0, which is a perfectly valid threshold value —
            // and it happens to be the API's own dangerous default, where every
            // outside participant gets whichever colleague scored least badly.
            const rawThreshold = await configStore.getConfig('pyannote_identify_threshold');
            const parsed = rawThreshold === null || rawThreshold === undefined || rawThreshold === ''
                ? NaN
                : Number(rawThreshold);
            const identifyBody = {
                url: mediaUrl,
                model: DIARIZATION_MODEL,
                voiceprints: vpList,
                matching: {
                    threshold: Number.isFinite(parsed) && parsed >= 0 && parsed <= 100
                        ? parsed
                        : DEFAULT_IDENTIFY_THRESHOLD,
                    exclusive: true,
                },
                // No `confidence: true`: that is the frame-level score, which
                // nothing reads and precision-3 answers with an error. The
                // per-voiceprint match scores come back without asking.
                // Non-overlapping turns — cleaner arithmetic for the overlap vote.
                exclusive: true,
                ...(jobBody.numSpeakers ? { numSpeakers: jobBody.numSpeakers } : {}),
            };
            try {
                // NB: never log identifyBody — it carries up to 50 templates.
                identifyJobId = await submitJob('/identify', identifyBody, auth);
            } catch (e) {
                log.warn('[Pyannote] Identification job could not be submitted:', redact(e.message));
            }
        }

        // ── Step 4: poll both, concurrently ──
        const durationSeconds = wavlikeDurationSeconds(bytes.length, ext);
        const { pollCapMs } = computePyannoteTimeouts({ durationSeconds });
        const [diarRes, identRes] = await Promise.allSettled([
            pollJob(diarizeJobId, auth, { pollCapMs, label: 'diarize' }),
            identifyJobId ? pollJob(identifyJobId, auth, { pollCapMs, label: 'identify' }) : Promise.resolve(null),
        ]);
        if (diarRes.status === 'rejected') throw diarRes.reason;
        const job = diarRes.value;

        // ── Step 5: map output → segments ──
        const segments = mapPyannoteOutput(job.output);
        log.info(`[Pyannote] Completed — ${segments.length} segments`);
        if (segments.length === 0) {
            throw new Error('pyannote returned no speech. Check the audio and try again.');
        }

        // ── Step 6: reconcile identification (best effort) ──
        let voiceprintMapping = null;
        let voiceprintRoster = [];
        let voiceprintRuledOut = null;
        let voiceprintInfo = null;
        if (identifyJobId) {
            if (identRes.status === 'rejected') {
                log.warn('[Pyannote] Identification failed, keeping LLM speaker naming:', redact(identRes.reason?.message || String(identRes.reason)));
                voiceprintInfo = { matched: 0, considered: vpList.length, truncated: !!selection?.truncated, failed: true, detail: [] };
            } else {
                const { resolveVoiceprintMapping } = require('./voiceprintMatching');
                const result = resolveVoiceprintMapping(
                    diarizationTurns(job.output, segments),
                    identRes.value?.output,
                    selection?.labelToName || {},
                );
                voiceprintMapping = Object.keys(result.mapping).length ? result.mapping : null;
                voiceprintRoster = result.roster;
                voiceprintRuledOut = Object.keys(result.ruledOut).length ? result.ruledOut : null;
                voiceprintInfo = {
                    matched: Object.keys(result.mapping).length,
                    considered: vpList.length,
                    truncated: !!selection?.truncated,
                    failed: false,
                    detail: result.detail,
                };
                log.info(`[Pyannote] Voiceprints: ${voiceprintInfo.matched} speaker(s) named from ${vpList.length} template(s)`);
                if (result.matchedIds.length) {
                    // Feeds the "who is usually in this org's meetings" ranking.
                    try { require('../../stores/voiceprintStore').recordMatches(result.matchedIds); } catch (_) {}
                }
            }
        }

        const totalDuration = Math.max(durationSeconds, ...segments.map((s) => s.end || 0));
        return {
            text: segments.map((s) => s.text).filter(Boolean).join(' '),
            segments,
            durationSeconds: Math.round(totalDuration),
            voiceprintMapping,
            voiceprintRoster,
            voiceprintRuledOut,
            voiceprintInfo,
        };
    } catch (err) {
        throw new Error(redact(err.message));
    } finally {
        audio.cleanup();
    }
}

module.exports = {
    transcribeWithPyannote,
    // exported for unit tests (DB-free)
    computePyannoteTimeouts,
    mapPyannoteOutput,
    diarizationTurns,
    DEFAULT_IDENTIFY_THRESHOLD,
};
