/**
 * Voiceprint enrollment + selection.
 *
 * Two jobs, both scoped to pyannoteAI:
 *   1. ENROLL — turn ~25s of one person reading a passage into an opaque
 *      biometric template (`POST /v1/voiceprint`).
 *   2. SELECT — pick which of an organisation's templates to send with a
 *      meeting's identification job (the API caps a job at 50).
 *
 * Enrollment audio is transcoded to 16 kHz mono WAV rather than FLAC — the one
 * place this path deliberately differs from transcription. Uncompressed PCM
 * gives an EXACT duration from the byte count (no ffprobe, which
 * @ffmpeg-installer doesn't ship) and lets a pure-JS pass measure how much of
 * the clip is actually voice. Both matter because pyannote's ceiling is a hard
 * 30 seconds and `useAudioRecorder`'s `elapsed` is a drifting wall-clock
 * counter, not an encoded duration.
 *
 * The audio itself is never persisted: it exists as a temp file for the ffmpeg
 * hop and is unlinked by the caller in a `finally`.
 */

'use strict';

const fs = require('fs');
const configStore = require('../../stores/configStore');
const { preprocessForStt } = require('./audioPreprocess');
const pyannoteApi = require('./pyannoteApi');
const { DIARIZATION_MODEL } = require('./pyannoteModels');
const voiceprintStore = require('../../stores/voiceprintStore');
const log = require('../../telemetry/log');

// pyannote accepts at most 30s of enrollment audio. 28 leaves a second of
// slack for a late timer tick and container overhead, and is also what the
// browser hard-stops at.
const MAX_ENROLL_SECONDS = Number(process.env.VOICEPRINT_MAX_SECONDS) || 28;
const MIN_ENROLL_SECONDS = Number(process.env.VOICEPRINT_MIN_SECONDS) || 12;
const TARGET_ENROLL_SECONDS = Number(process.env.VOICEPRINT_TARGET_SECONDS) || 25;
// This check exists for ONE failure mode: a muted or dead microphone, where
// enrolling would produce a template that mis-names people for a year. It is
// deliberately generous about pauses — an earlier "at least half the clip must
// be voiced" rule rejected normal read-aloud speech, which is roughly half
// silence. Six seconds of actual speech is plenty to model a voice.
const MIN_VOICED_SECONDS = Number(process.env.VOICEPRINT_MIN_VOICED_SECONDS) || 6;
// Essentially digital silence — nothing reached the microphone at all.
const MIN_PEAK_AMPLITUDE = 0.01;
// The `/identify` request rejects a template longer than this.
const MAX_VOICEPRINT_CHARS = 20000;
const MAX_VOICEPRINTS_PER_JOB = 50;
const VOICEPRINT_POLL_CAP_MS = Number(process.env.PYANNOTE_VOICEPRINT_POLL_TIMEOUT_MS) || 120_000;

const LIMITS = {
    minSeconds: MIN_ENROLL_SECONDS,
    targetSeconds: TARGET_ENROLL_SECONDS,
    maxSeconds: MAX_ENROLL_SECONDS,
};

/** Error with a stable machine code the UI turns into a localized message. */
function enrollError(code, message) {
    const err = new Error(message || code);
    err.code = code;
    return err;
}

/**
 * Is per-person voiceprint matching usable right now?
 *
 * One place, used by the router, the settings UI and the transcription
 * pipeline, so "only when pyannoteAI is used" can never drift between them.
 *
 * @param {{organizationId?: string|null}} [user]
 * @returns {Promise<{available: boolean, reason: string|null, provider: string}>}
 */
async function isVoiceprintAvailable(user = null) {
    const provider = (await configStore.getConfig('transcription_provider')) || 'voxtral';
    if (provider !== 'pyannote') return { available: false, reason: 'provider_not_pyannote', provider };
    if (!(await pyannoteApi.hasPyannoteKey())) return { available: false, reason: 'no_api_key', provider };
    if ((await configStore.getConfig('voiceprint_matching_enabled')) === false) {
        return { available: false, reason: 'feature_disabled', provider };
    }
    // A voiceprint is encrypted under the org's vault key and only ever
    // matched within that org — it is meaningless for an org-less account.
    if (user && !user.organizationId) return { available: false, reason: 'no_organization', provider };
    return { available: true, reason: null, provider };
}

// ── Enrollment audio analysis ────────────────────────────────────────

/**
 * Parse a 16-bit PCM WAV and report duration + how much of it is voice.
 *
 * Chunk-walks rather than assuming a 44-byte header: ffmpeg emits a LIST/INFO
 * chunk on some builds, and a fixed offset would then read metadata as audio.
 *
 * @param {Buffer} buffer
 * @returns {{seconds: number, voicedFraction: number, peak: number, sampleRate: number}}
 * @throws {Error & {code}} when the buffer isn't a PCM WAV we can read.
 */
function analyseEnrollmentWav(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 44) throw enrollError('enroll_failed', 'Enrollment audio is empty');
    if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
        throw enrollError('enroll_failed', 'Enrollment audio is not decodable WAV');
    }

    let offset = 12;
    let sampleRate = 16000;
    let channels = 1;
    let bitsPerSample = 16;
    let dataStart = -1;
    let dataLength = 0;

    while (offset + 8 <= buffer.length) {
        const id = buffer.toString('ascii', offset, offset + 4);
        const size = buffer.readUInt32LE(offset + 4);
        const body = offset + 8;
        if (id === 'fmt ' && body + 16 <= buffer.length) {
            channels = buffer.readUInt16LE(body + 2) || 1;
            sampleRate = buffer.readUInt32LE(body + 4) || 16000;
            bitsPerSample = buffer.readUInt16LE(body + 14) || 16;
        } else if (id === 'data') {
            dataStart = body;
            // A streamed WAV can carry a bogus size; trust the real remainder.
            dataLength = Math.min(size, buffer.length - body);
            break;
        }
        offset = body + size + (size % 2); // chunks are word-aligned
    }
    if (dataStart < 0 || dataLength <= 0) throw enrollError('enroll_failed', 'Enrollment audio has no PCM data');
    if (bitsPerSample !== 16) throw enrollError('enroll_failed', `Unsupported sample width ${bitsPerSample}`);

    const bytesPerFrame = 2 * channels;
    const frames = Math.floor(dataLength / bytesPerFrame);
    const seconds = frames / sampleRate;

    // 20ms windows, mono-mixed. Two-pass: measure the clip's own speech level,
    // then count windows near it — absolute thresholds fail on a quiet mic and
    // a hot mic alike.
    const windowFrames = Math.max(1, Math.round(sampleRate * 0.02));
    const rms = [];
    let peak = 0;
    for (let f = 0; f < frames; f += windowFrames) {
        const upto = Math.min(f + windowFrames, frames);
        let sum = 0;
        let n = 0;
        for (let i = f; i < upto; i++) {
            let s = 0;
            for (let c = 0; c < channels; c++) {
                s += buffer.readInt16LE(dataStart + i * bytesPerFrame + c * 2);
            }
            const v = (s / channels) / 32768;
            if (Math.abs(v) > peak) peak = Math.abs(v);
            sum += v * v;
            n++;
        }
        if (n) rms.push(Math.sqrt(sum / n));
    }
    if (!rms.length) return { seconds, voicedSeconds: 0, voicedFraction: 0, peak: 0, sampleRate };

    const sorted = [...rms].sort((a, b) => a - b);
    const speechLevel = sorted[Math.floor(sorted.length * 0.9)] || 0;
    // 15% of the clip's own speech level, with an absolute floor so a silent
    // recording can't define its own noise as "speech".
    const threshold = Math.max(0.005, speechLevel * 0.15);
    const voiced = rms.filter(v => v >= threshold).length;

    // Report voiced SECONDS, not just the fraction. Reading a passage aloud is
    // roughly half pauses — between words, and longer between sentences — so a
    // perfectly good 25s recording routinely lands near a 50% voiced fraction.
    // "How much speech is in here" is the question that actually matters, and
    // it doesn't punish someone for breathing.
    return {
        seconds,
        voicedSeconds: (voiced * windowFrames) / sampleRate,
        voicedFraction: voiced / rms.length,
        peak,
        sampleRate,
    };
}

/**
 * Enroll one speaker.
 *
 * @param {string} inputPath  Temp file holding the browser recording.
 * @param {{language?: string}} [opts]
 * @returns {Promise<{voiceprint: string, jobId: string, durationSeconds: number, model: string}>}
 * @throws {Error & {code}} see mapEnrollError for the codes.
 */
async function createVoiceprint(inputPath, { language = null } = {}) {
    const auth = await pyannoteApi.resolvePyannoteAuth();

    // WAV + a hard duration cap. `preprocessForStt` never throws (a
    // conditioning failure must not cost a user their transcription), so a box
    // without ffmpeg hands back the ORIGINAL, untrimmed file — which is why
    // the duration check below is not optional.
    const audio = await preprocessForStt(inputPath, {
        format: 'wav', label: 'voiceprint', maxSeconds: MAX_ENROLL_SECONDS,
    });

    try {
        const bytes = await fs.promises.readFile(audio.path);
        if (!audio.preprocessed) {
            throw enrollError('not_configured', 'Audio conditioning is unavailable on this server (ffmpeg missing), so a voice profile cannot be recorded safely.');
        }

        const stats = analyseEnrollmentWav(bytes);
        // Always log what we measured, including on rejection. Without this a
        // refusal is unexplainable from the server side — the user is told
        // "too quiet", and nobody can tell whether that was true.
        const measured = `${stats.seconds.toFixed(1)}s, ${stats.voicedSeconds.toFixed(1)}s voiced `
            + `(${Math.round(stats.voicedFraction * 100)}%), peak ${stats.peak.toFixed(3)}`;
        if (stats.seconds < MIN_ENROLL_SECONDS) {
            log.warn(`[Voiceprint] Rejected as too short — ${measured}`);
            throw enrollError('too_short');
        }
        if (stats.seconds > 30) {
            log.warn(`[Voiceprint] Rejected as too long — ${measured}`);
            throw enrollError('too_long');
        }
        if (stats.peak < MIN_PEAK_AMPLITUDE || stats.voicedSeconds < MIN_VOICED_SECONDS) {
            log.warn(`[Voiceprint] Rejected as too quiet — ${measured}`);
            throw enrollError('too_quiet');
        }

        const mediaUrl = await pyannoteApi.uploadMedia(bytes, '.wav', auth);
        log.info(`[Voiceprint] Submitting enrollment job — ${measured}`);
        const jobId = await pyannoteApi.submitJob('/voiceprint', { url: mediaUrl, model: DIARIZATION_MODEL }, auth);
        const job = await pyannoteApi.pollJob(jobId, auth, { pollCapMs: VOICEPRINT_POLL_CAP_MS, label: 'voiceprint' });

        const voiceprint = job?.output?.voiceprint;
        if (!voiceprint || typeof voiceprint !== 'string') throw enrollError('enroll_failed', 'pyannote returned no voiceprint');
        // Fail here rather than at the first meeting: /identify rejects the
        // whole job if any template exceeds this.
        if (voiceprint.length > MAX_VOICEPRINT_CHARS) throw enrollError('voiceprint_too_large');

        return { voiceprint, jobId, durationSeconds: Math.round(stats.seconds * 10) / 10, model: DIARIZATION_MODEL, language };
    } finally {
        audio.cleanup();
    }
}

/**
 * Translate a thrown enrollment error into a stable {code, status} the router
 * can return and the UI can localize. pyannote reports the interesting cases
 * (overlapping speakers, no speech) as free text on a failed job.
 */
function mapEnrollError(err) {
    if (err && err.code) {
        const status = {
            too_short: 400, too_long: 400, too_quiet: 400, consent_required: 400,
            voiceprint_too_large: 502, not_configured: 502, rate_limited: 503, timeout: 504,
        }[err.code] || 502;
        return { code: err.code, status };
    }
    const msg = String(err?.message || '').toLowerCase();
    if (/multiple speakers|more than one speaker|overlap/.test(msg)) return { code: 'multiple_speakers', status: 400 };
    if (/too short|no speech|no voice|silent/.test(msg)) return { code: 'too_short', status: 400 };
    if (/too long|duration|30 second/.test(msg)) return { code: 'too_long', status: 400 };
    if (/\(401\)|\(403\)|not configured|unauthor/.test(msg)) return { code: 'not_configured', status: 502 };
    if (/\(429\)|rate limit/.test(msg)) return { code: 'rate_limited', status: 503 };
    if (/timed out/.test(msg)) return { code: 'timeout', status: 504 };
    return { code: 'enroll_failed', status: 502 };
}

// ── Selection ────────────────────────────────────────────────────────

/** Best available human name for an enrolled member. */
function displayNameFor(row) {
    const parts = [row.firstName, row.lastName].filter(Boolean).join(' ').trim();
    const name = (row.displayName || parts || row.firstName || (row.email || '').split('@')[0] || '').trim();
    return name || `Collega ${String(row.userId || '').slice(0, 6)}`;
}

/**
 * Make every display name unique within one job.
 *
 * Two colleagues both showing as "Jan" would be summed into a single speaker
 * row by `applySpeakerNames` — two real people fused into one, which is the
 * worst failure this feature can produce. Cheaper to disambiguate here.
 */
function disambiguateNames(rows) {
    const counts = new Map();
    for (const r of rows) {
        const n = displayNameFor(r).toLowerCase();
        counts.set(n, (counts.get(n) || 0) + 1);
    }
    const used = new Set();
    return rows.map((r) => {
        let name = displayNameFor(r);
        if (counts.get(name.toLowerCase()) > 1) {
            const initial = (r.lastName || (r.email || '').split('@')[0] || '').trim().charAt(0).toUpperCase();
            let candidate = initial ? `${name} ${initial}.` : name;
            let n = 2;
            while (used.has(candidate.toLowerCase())) candidate = `${name} ${n++}`;
            name = candidate;
        }
        used.add(name.toLowerCase());
        return { ...r, name };
    });
}

/** Diacritic-insensitive, case-insensitive comparison key. */
function normalizeName(s) {
    return String(s || '')
        .normalize('NFD').replace(/\p{Diacritic}/gu, '')
        .toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Rank enrolled members by how likely they are to be in THIS recording, then
 * take the top `max`.
 *
 * The 50-template cap is a hard 400 from the API, so this is not an
 * optimisation — a 60-person org would otherwise get no identification at all.
 */
function rankCandidates(rows, { recorderUserId, attendees }) {
    const wanted = (attendees || []).map(normalizeName).filter(Boolean);
    const scored = rows.map((r) => {
        const norm = normalizeName(r.name);
        const first = norm.split(' ')[0];
        let rank = 3;
        // 0: whoever pressed record is definitionally in the room.
        if (recorderUserId && r.userId === recorderUserId) rank = 0;
        // 1: named on the attendee list the user (or Talk/Meet) supplied.
        else if (wanted.some(a => a === norm || a === first || norm.includes(a) || a.includes(norm))) rank = 1;
        // 2: recently matched — the cheapest good prior for "who meets here".
        else if (r.lastMatchedAt) rank = 2;
        return { ...r, rank };
    });
    scored.sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank;
        const at = a.lastMatchedAt ? new Date(a.lastMatchedAt).getTime() : 0;
        const bt = b.lastMatchedAt ? new Date(b.lastMatchedAt).getTime() : 0;
        if (at !== bt) return bt - at;
        if (a.matchCount !== b.matchCount) return b.matchCount - a.matchCount;
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
    return scored;
}

/**
 * Resolve the voiceprints to send with a meeting's identification job.
 *
 * Returns an EMPTY selection — meaning: submit only the diarization job, incur
 * no extra pyannote cost — whenever the feature is unavailable or nobody in
 * the org has enrolled.
 *
 * @param {{orgId: string|null, recorderUserId?: string|null, attendees?: string[], max?: number}} args
 * @returns {Promise<{voiceprints: Array<{label: string, voiceprint: string}>,
 *                    labelToName: Object<string, {id, name, userId}>,
 *                    ids: string[], total: number, truncated: boolean}>}
 */
async function selectVoiceprintsForJob({ orgId, recorderUserId = null, attendees = [], max = MAX_VOICEPRINTS_PER_JOB } = {}) {
    const empty = { voiceprints: [], labelToName: {}, ids: [], total: 0, truncated: false };
    if (!orgId) return empty;

    const { available } = await isVoiceprintAvailable();
    if (!available) return empty;

    const meta = await voiceprintStore.listOrgVoiceprintMeta(orgId);
    if (!meta.length) return empty;

    const named = disambiguateNames(meta);
    const ranked = rankCandidates(named, { recorderUserId, attendees });
    const limit = Math.max(1, Math.min(Number(max) || MAX_VOICEPRINTS_PER_JOB, MAX_VOICEPRINTS_PER_JOB));
    const chosen = ranked.slice(0, limit);
    const truncated = ranked.length > chosen.length;
    if (truncated) {
        log.info(`[Voiceprint] Org ${orgId} has ${ranked.length} templates — sending the ${chosen.length} most likely`);
    }

    const blobs = await voiceprintStore.loadVoiceprintBlobs(chosen.map(c => c.id), orgId);
    const byId = new Map(blobs.map(b => [b.id, b.voiceprint]));

    const voiceprints = [];
    const labelToName = {};
    for (const c of chosen) {
        const template = byId.get(c.id);
        if (!template) continue; // undecryptable — already logged by the store
        // The LABEL is the opaque row id, never the person's name: it keeps PII
        // out of the request body and out of any error pyannote echoes back,
        // and it can never collide or start with the banned "SPEAKER_" prefix.
        voiceprints.push({ label: c.id, voiceprint: template });
        labelToName[c.id] = { id: c.id, name: c.name, userId: c.userId };
    }

    return { voiceprints, labelToName, ids: voiceprints.map(v => v.label), total: ranked.length, truncated };
}

module.exports = {
    LIMITS,
    MAX_VOICEPRINTS_PER_JOB,
    MAX_VOICEPRINT_CHARS,
    isVoiceprintAvailable,
    createVoiceprint,
    selectVoiceprintsForJob,
    // pure, exported for tests
    analyseEnrollmentWav,
    mapEnrollError,
    displayNameFor,
    disambiguateNames,
    normalizeName,
    rankCandidates,
};
