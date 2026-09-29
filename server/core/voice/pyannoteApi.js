/**
 * pyannoteAI (api.pyannote.ai) — low-level HTTP primitives.
 *
 * Extracted from `pyannoteClient.js` when speaker identification landed: three
 * different jobs (`/diarize`, `/identify`, `/voiceprint`) now share the same
 * auth resolution, media staging and polling, and two of them must run against
 * ONE uploaded media object. Keeping the staging inline in the transcription
 * function would have meant re-transcoding and re-uploading the same audio for
 * the second job — and, worse, two independently-uploaded copies would have
 * had no guaranteed shared clock to reconcile their diarizations against.
 *
 * Everything here is transport. No business rules, no config beyond the API
 * key/base URL, so both the transcription path and the enrollment path can
 * depend on it without a cycle.
 *
 * Docs (verified 2026-07):
 *   POST /media/input   {url:"media://key"}  → {url: <presigned PUT>}   (object lives ≥24h)
 *   POST /diarize       {url, model, transcription?, ...}               → {jobId}
 *   POST /identify      {url, model, voiceprints[], matching{}, ...}    → {jobId}
 *   POST /voiceprint    {url, model}                                    → {jobId}
 *   GET  /jobs/{id}     → {status, output}
 */

'use strict';

const crypto = require('crypto');
const configStore = require('../../stores/configStore');
const log = require('../../telemetry/log');

const DEFAULT_API_URL = 'https://api.pyannote.ai/v1';
// Overridable so tests don't sleep 5s between polls.
const POLL_INTERVAL_MS = Number(process.env.PYANNOTE_POLL_INTERVAL_MS) || 5000;

const MIME_BY_EXT = {
    '.flac': 'audio/flac', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4',
    '.webm': 'audio/webm',
};

const TERMINAL_STATUSES = ['succeeded', 'failed', 'canceled'];

/** Strip the API key (and any long token) from an error string. */
function redact(message) {
    return String(message || '').replace(/[A-Za-z0-9_\-]{20,}/g, '[REDACTED]');
}

/**
 * Poll ceiling for a pyannote job, scaled to the audio duration (precision-2 +
 * transcription runs a good bit slower than real-time). Clamped to [15min, 2h];
 * 30min when the duration is unknown. Env override: PYANNOTE_POLL_TIMEOUT_MS.
 *
 * @param {{durationSeconds?: number, env?: object}} [opts]
 * @returns {{pollCapMs: number}}
 */
function computePyannoteTimeouts({ durationSeconds = 0, env = process.env } = {}) {
    const override = Number(env.PYANNOTE_POLL_TIMEOUT_MS);
    if (override > 0) return { pollCapMs: override };
    const dur = Number(durationSeconds) || 0;
    if (!dur) return { pollCapMs: 30 * 60_000 };
    const clamp = (v) => Math.min(2 * 3600_000, Math.max(15 * 60_000, v));
    // ~2x real-time headroom for queue + processing.
    return { pollCapMs: clamp(dur * 2000) };
}

/** Rough duration estimate from encoded byte size (only used to size the poll cap). */
function wavlikeDurationSeconds(bytes, ext) {
    const bps = { '.flac': 16000, '.wav': 32000, '.mp3': 16000, '.ogg': 8000, '.opus': 8000, '.m4a': 12000, '.mp4': 12000 }[ext];
    return bps && bytes > 0 ? Math.round(bytes / bps) : 0;
}

/**
 * Resolve the API key + base URL. Env wins over the encrypted config store so
 * a deployment can pin a key without touching the DB.
 *
 * @returns {Promise<{apiKey: string, base: string, headers: object}>}
 * @throws when no key is configured (message is user-facing).
 */
async function resolvePyannoteAuth() {
    const apiKey = process.env.PYANNOTE_API_KEY || await configStore.getSecret('pyannote_api_key');
    if (!apiKey) {
        throw new Error('Pyannote API key not configured. Add it in Admin → Integrations → Transcription.');
    }
    const base = (process.env.PYANNOTE_API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
    return { apiKey, base, headers: { Authorization: `Bearer ${apiKey}` } };
}

/** True when a pyannote API key is configured (no throw, for availability probes). */
async function hasPyannoteKey() {
    try {
        if (process.env.PYANNOTE_API_KEY) return true;
        return !!(await configStore.getSecret('pyannote_api_key'));
    } catch (_) {
        return false;
    }
}

/**
 * Reserve a `media://` slot and PUT the bytes to the presigned URL.
 *
 * The returned URL can be referenced by MULTIPLE jobs for at least 24h — which
 * is what lets a diarization and an identification job run against the exact
 * same audio, and therefore the same timeline.
 *
 * @param {Buffer} bytes
 * @param {string} ext  lower-case extension, for the content type
 * @param {{base: string, headers: object}} auth
 * @returns {Promise<string>} the `media://…` URL
 */
async function uploadMedia(bytes, ext, auth) {
    const objectKey = `beeflow/${Date.now()}-${crypto.randomUUID()}`;
    const mediaUrl = `media://${objectKey}`;

    const inputResp = await fetch(`${auth.base}/media/input`, {
        method: 'POST',
        headers: { ...auth.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: mediaUrl }),
    });
    if (!inputResp.ok) {
        const t = await inputResp.text().catch(() => '');
        throw new Error(`pyannote media/input failed (${inputResp.status}): ${redact(t).slice(0, 200)}`);
    }
    const { url: presignedPut } = await inputResp.json();
    if (!presignedPut) throw new Error('pyannote media/input returned no upload URL.');

    const putResp = await fetch(presignedPut, {
        method: 'PUT',
        headers: { 'Content-Type': MIME_BY_EXT[ext] || 'application/octet-stream' },
        body: bytes,
    });
    if (!putResp.ok) {
        const t = await putResp.text().catch(() => '');
        throw new Error(`pyannote media upload failed (${putResp.status}): ${redact(t).slice(0, 200)}`);
    }
    return mediaUrl;
}

/**
 * Submit a job.
 *
 * NOTE: the body is never logged. An `/identify` body carries up to 50
 * biometric templates; even an error path must not spill them.
 *
 * @param {string} pathname  '/diarize' | '/identify' | '/voiceprint'
 * @param {object} body
 * @param {{base: string, headers: object}} auth
 * @returns {Promise<string>} jobId
 */
async function submitJob(pathname, body, auth) {
    const resp = await fetch(`${auth.base}${pathname}`, {
        method: 'POST',
        headers: { ...auth.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        throw new Error(`pyannote job creation failed (${resp.status}): ${redact(t).slice(0, 200)}`);
    }
    const { jobId } = await resp.json();
    if (!jobId) throw new Error('pyannote job creation returned no jobId.');
    return jobId;
}

/** HTTP statuses that mean "ask again", not "give up". */
const RETRIABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
/** Consecutive transport failures tolerated before abandoning a job. */
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

/**
 * Poll a job until it reaches a terminal status.
 *
 * A 90-minute meeting means roughly a thousand sequential GETs. Treating every
 * one of them as fatal meant a single 503 or dropped socket 80 minutes in threw
 * away a job that was still running and already paid for — and the retry
 * re-uploads and pays again. Transient failures are now retried with backoff;
 * only an answer that will not change (401/403/404) is terminal.
 *
 * @param {string} jobId
 * @param {{base: string, headers: object}} auth
 * @param {{pollCapMs: number, label?: string}} opts
 * @returns {Promise<object>} the succeeded job
 * @throws on timeout, repeated transport failure, or a failed/canceled job.
 */
async function pollJob(jobId, auth, { pollCapMs, label = 'job' } = {}) {
    const started = Date.now();
    let consecutiveFailures = 0;
    while (true) {
        if (Date.now() - started > pollCapMs) {
            throw new Error(`pyannote ${label} job timed out after ${Math.round(pollCapMs / 60000)} minutes.`);
        }
        // Back off after a failure so a struggling API is not hammered, but
        // keep the steady-state cadence unchanged.
        const wait = consecutiveFailures > 0
            ? Math.min(POLL_INTERVAL_MS * (2 ** consecutiveFailures), 60_000)
            : POLL_INTERVAL_MS;
        await new Promise((r) => setTimeout(r, wait));

        let job;
        try {
            const jobResp = await fetch(`${auth.base}/jobs/${jobId}`, { headers: auth.headers });
            if (!jobResp.ok) {
                if (!RETRIABLE_STATUSES.has(jobResp.status)) {
                    // 401/403/404 — the answer will not change by asking again.
                    throw new Error(`pyannote ${label} poll failed: HTTP ${jobResp.status}`);
                }
                throw Object.assign(new Error(`HTTP ${jobResp.status}`), { retriable: true });
            }
            job = await jobResp.json();
        } catch (err) {
            // A thrown fetch is a network blip; an explicitly retriable status
            // is the API asking us to wait. Anything else is terminal.
            const retriable = err.retriable || !err.message?.startsWith(`pyannote ${label} poll failed`);
            if (!retriable) throw err;
            consecutiveFailures++;
            if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
                throw new Error(`pyannote ${label} poll failed ${consecutiveFailures} times in a row: ${redact(err.message)}`);
            }
            log.warn(`[Pyannote] ${label} poll attempt failed (${consecutiveFailures}/${MAX_CONSECUTIVE_POLL_FAILURES}): ${redact(err.message)} — retrying`);
            continue;
        }
        consecutiveFailures = 0;

        if (TERMINAL_STATUSES.includes(job.status)) {
            if (job.status !== 'succeeded') {
                const detail = job.output?.error || job.error || job.status;
                throw new Error(`pyannote ${label} job ${job.status}: ${redact(String(detail)).slice(0, 200)}`);
            }
            return job;
        }
        log.info(`[Pyannote] ${label} status: ${job.status} (${Math.round((Date.now() - started) / 1000)}s)`);
    }
}

module.exports = {
    DEFAULT_API_URL,
    POLL_INTERVAL_MS,
    MIME_BY_EXT,
    redact,
    computePyannoteTimeouts,
    wavlikeDurationSeconds,
    resolvePyannoteAuth,
    hasPyannoteKey,
    uploadMedia,
    submitJob,
    pollJob,
};
