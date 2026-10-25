// @typecheck
/**
 * Hybrid Scaleway transcription: ffmpeg transcode/split, the Scaleway Whisper
 * call (chunked, retried, partial-tolerant) and the local diarization merge.
 *
 * Split out of `summaryHelpers.js`, which re-exports `transcribeWithScaleway`
 * and the ffmpeg argument builders (for tests).
 */

const fs = require('fs');
const { assignSpeakersByOverlap } = require('./transcriptArtifacts');
const log = require('../../telemetry/log');
const { buildAudioArgs, runFfmpeg } = require('../media/ffmpeg');
const { bestEffort } = require('../../utils/bestEffort');

// Scaleway's audio endpoint only accepts these container formats; anything else
// (webm/opus, m4a/aac, mp4) is transcoded to mp3 first.
const SCALEWAY_AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.ogg', '.oga', '.mpga']);

/**
 * @param {string} filePath
 * @param {string} outPath
 */
function scalewayTranscodeArgs(filePath, outPath) {
    return buildAudioArgs({ input: filePath, output: outPath, channels: 1, sampleRate: 16000, format: 'mp3' });
}

/**
 * @param {string} filePath
 * @param {string} listPath
 * @param {string} chunkPattern
 * @param {number} chunkSeconds
 */
function scalewaySplitArgs(filePath, listPath, chunkPattern, chunkSeconds) {
    return buildAudioArgs({
        input: filePath,
        output: chunkPattern,
        channels: 1,
        sampleRate: 16000,
        outputOptions: [
            '-f', 'segment',
            '-segment_time', String(chunkSeconds),
            '-reset_timestamps', '1',
            '-segment_list', listPath,
            '-segment_list_type', 'csv',
        ],
    });
}

/**
 * Transcode `filePath` to a temp mp3 if its format isn't Scaleway-accepted. Returns {path, cleanup}.
 * @param {string} filePath
 */
async function ensureScalewayFormat(filePath) {
    const path = require('path');
    const ext = path.extname(filePath).toLowerCase();
    if (SCALEWAY_AUDIO_EXTS.has(ext)) return { path: filePath, cleanup: null };

    const os = require('os');
    const crypto = require('crypto');
    // randomUUID, not a millisecond stamp: several uploads transcode
    // concurrently in one process and shared the same output path.
    const outPath = path.join(os.tmpdir(), `scaleway-stt-${crypto.randomUUID()}.mp3`);
    try {
        await runFfmpeg(scalewayTranscodeArgs(filePath, outPath));
    } catch (err) {
        // ffmpeg writes as it goes, so a failed transcode leaves a partial mp3
        // behind and the caller never gets a `cleanup` to call.
        try { fs.unlinkSync(outPath); } catch (err) { bestEffort('core/meetingNotes/transcribeScaleway:ensureScalewayFormat', err); /* never created */ }
        throw err;
    }
    return { path: outPath, cleanup: () => { try { fs.unlinkSync(outPath); } catch (err) { bestEffort('core/meetingNotes/transcribeScaleway:cleanup', err); /* ignore */ } } };
}

/**
 * Split audio into ~chunkSeconds mp3 chunks (16 kHz mono, Scaleway-safe), using
 * ffmpeg's segment muxer with a CSV segment list so each chunk's EXACT start
 * offset is read back (no cumulative drift from assuming fixed lengths).
 * Returns { chunks:[{path,start}], cleanup }.
 * @param {string} filePath
 * @param {number} chunkSeconds
 */
async function splitForScaleway(filePath, chunkSeconds) {
    const path = require('path');
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scw-chunks-'));
    const listPath = path.join(dir, 'list.csv');
    // Everything below writes INTO `dir`, so any failure must remove the whole
    // directory — a long recording that fails mid-split otherwise leaves tens
    // of megabytes of chunks behind on every retry.
    try {
    await runFfmpeg(scalewaySplitArgs(filePath, listPath, path.join(dir, 'chunk_%03d.mp3'), chunkSeconds));
    // CSV rows: filename,start,end (seconds, relative to the source).
    const rows = fs.readFileSync(listPath, 'utf8').trim().split('\n').filter(Boolean);
    const chunks = rows.map(line => {
        const [fname, start] = line.split(',');
        return { path: path.join(dir, fname), start: parseFloat(start) || 0 };
    });
    return { chunks, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { bestEffort('core/meetingNotes/transcribeScaleway:cleanup#2', err); /* ignore */ } } };
    } catch (err) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { bestEffort('core/meetingNotes/transcribeScaleway:splitForScaleway', err); /* ignore */ }
        throw err;
    }
}

/**
 * Run up to `limit` async tasks concurrently, preserving input order.
 * @param {{ path: string; start: number; }[]} items
 * @param {number} limit
 */
async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) { const i = cursor++; out[i] = await fn(items[i], i); }
    }));
    return out;
}

/** One Scaleway transcription call for a single Scaleway-safe file. Returned
 *  segment timestamps are relative to THAT file. Retries with backoff on 429
 *  (Scaleway's audio-seconds-per-minute quota) and transient gateway errors,
 * @param {string} sendPath
 *  honouring Retry-After — this is what paces concurrent chunks under the quota. */
async function scalewayCallOnce(sendPath, cfg) {
    const path = require('path');
    const maxRetries = Number(process.env.SCALEWAY_MAX_RETRIES) || 8;
    for (let attempt = 0; ; attempt++) {
        const form = new FormData();
        form.append('file', await fs.openAsBlob(sendPath), path.basename(sendPath));
        form.append('model', cfg.model);
        if (cfg.language) form.append('language', cfg.language);
        form.append('response_format', 'verbose_json');
        form.append('timestamp_granularities[]', 'segment');
        if (cfg.contextTerms) form.append('prompt', String(cfg.contextTerms)); // biases glossary spelling
        const resp = await fetch(`${cfg.baseUrl}/v1/audio/transcriptions`, {
            method: 'POST',
            body: form,
            headers: { Authorization: `Bearer ${cfg.apiKey}` },
            signal: AbortSignal.timeout(Number(process.env.SCALEWAY_TIMEOUT_MS) || 600000),
        });
        if (resp.ok) {
            const data = /** @type {{ segments?: Array<{ text?: string, start?: number, end?: number }>, text?: string }} */ (await resp.json());
            const segs = (data.segments || [])
                .map(s => ({ text: (s.text || '').trim(), start: s.start, end: s.end }))
                .filter(s => s.text);
            return { segments: segs, text: data.text || segs.map(s => s.text).join(' ') };
        }
        const retriable = resp.status === 429 || resp.status === 503 || resp.status === 504;
        if (retriable && attempt < maxRetries) {
            const retryAfter = Number(resp.headers.get('retry-after'));
            const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
                ? retryAfter * 1000
                : Math.min(60000, 2000 * 2 ** attempt); // 2s,4s,8s… capped at 60s
            await new Promise(r => setTimeout(r, waitMs));
            continue;
        }
        const errText = await resp.text().catch(() => resp.statusText);
        throw new Error(`Scaleway transcription error (${resp.status}): ${errText}`);
    }
}

/**
 * Hybrid transcription: Scaleway cloud Whisper large-v3 for the transcript,
 * local pyannote (community-1) for speaker diarization, merged by time overlap.
 *
 * Scaleway (GDPR-EU, GPU, serverless) is fast but does not diarize; the local
 * WhisperX/diarization service does only diarization here (its `/diarize`
 * endpoint), so audio egress to the cloud buys speed while speaker labels come
 * from the on-prem model. Returns the same
 * `{ text, segments:[{text,start,end,speakerId}] }` shape as the other providers.
 *
 * Requires `scaleway_api_key`. Speaker labels require a diarizer URL
 * (`WHISPERX_URL` or the encrypted `whisperx_url` secret); without one the
 * transcript is returned with a single `speaker_0`.
 * @param {string} filePath
 * @param {string} fileName
 */
async function transcribeWithScaleway(filePath, fileName, language, contextTerms) {
    const configStore = require('../../stores/configStore');

    // Admin-UI key (encrypted) wins; env fallback for env-configured deployments.
    const apiKey = (await configStore.getSecret('scaleway_api_key')) || process.env.SCALEWAY_API_KEY;
    if (!apiKey) {
        throw new Error(
            'Scaleway API key not configured. Add it under '
            + 'Admin → Integrations → Transcription (Scaleway), or set SCALEWAY_API_KEY.'
        );
    }
    const baseUrl = (await configStore.getConfig('scaleway_url')) || process.env.SCALEWAY_URL || 'https://api.scaleway.ai';
    const model = (await configStore.getConfig('scaleway_model')) || 'whisper-large-v3';
    const cfg = { apiKey, baseUrl, model, language, contextTerms };

    // 1. Cloud transcription (verbose_json → per-segment timestamps). Scaleway's
    // endpoint times out on very long/large single requests (observed HTTP 504
    // "stream timeout" on a ~92 MB / 1h40 file), so split big inputs into chunks,
    // transcribe them in parallel, and stitch results back with each chunk's real
    // time offset. Thresholds are env-tunable.
    const fileSize = fs.statSync(filePath).size;
    const CHUNK_THRESHOLD = Number(process.env.SCALEWAY_CHUNK_THRESHOLD_BYTES) || 20 * 1024 * 1024;
    const CHUNK_SECONDS = Number(process.env.SCALEWAY_CHUNK_SECONDS) || 600;
    const CONCURRENCY = Number(process.env.SCALEWAY_CHUNK_CONCURRENCY) || 2;

    /** @type {({ text: string; start: number | undefined; end: number | undefined; })[]} */
    let rawSegments = [];
    let fullText = '';
    if (fileSize > CHUNK_THRESHOLD) {
        log.info(`[Transcriptions] Scaleway: ${(fileSize / 1e6).toFixed(0)} MB > threshold — splitting into ${CHUNK_SECONDS}s chunks`);
        const { chunks, cleanup } = await splitForScaleway(filePath, CHUNK_SECONDS);
        let failedChunks = 0;
        try {
            log.info(`[Transcriptions] Scaleway: ${chunks.length} chunks (up to ${CONCURRENCY} in parallel)`);
            // Partial-tolerant: a chunk that exhausts its retries (e.g. sustained
            // 429 quota) yields a flagged gap for its time range instead of
            // failing the whole job and throwing away every other chunk.
            const perChunk = await mapLimit(chunks, CONCURRENCY, async (ch, idx) => {
                try {
                    const r = await scalewayCallOnce(ch.path, cfg);
                    log.info(`[Transcriptions] Scaleway chunk ${idx + 1}/${chunks.length} @${ch.start.toFixed(0)}s: ${r.segments.length} segs`);
                    return r.segments.map(s => ({ text: s.text, start: (s.start || 0) + ch.start, end: (s.end || 0) + ch.start }));
                } catch (err) {
                    failedChunks++;
                    log.error(`[Transcriptions] Scaleway chunk ${idx + 1}/${chunks.length} @${ch.start.toFixed(0)}s FAILED — kept the other chunks: ${/** @type {Error} */ (err).message}`);
                    // `gap: true` marks this as a hole, not speech. Without it a
                    // failed chunk contributed a full CHUNK_SECONDS (10 min) of
                    // "speaking time" to whichever speaker the overlap matcher
                    // assigned it to, and the same 10 minutes to the meeting
                    // duration — so one failed chunk could hand a participant a
                    // fabricated 40% airtime share in the Insights panel.
                    return [{ text: '[audio section could not be transcribed]', start: ch.start, end: ch.start + CHUNK_SECONDS, gap: true }];
                }
            });
            rawSegments = perChunk.flat().sort((a, b) => (a.start || 0) - (b.start || 0));
        } finally {
            cleanup();
        }
        // Only hard-fail if EVERY chunk failed (else the note would be all gaps).
        if (failedChunks >= chunks.length) {
            throw new Error(`Scaleway transcription failed for all ${chunks.length} chunks`);
        }
        if (failedChunks > 0) {
            log.warn(`[Transcriptions] Scaleway: ${failedChunks}/${chunks.length} chunks failed; note has gaps for those sections.`);
        }
        fullText = rawSegments.map(s => s.text).join(' ');
    } else {
        const { path: sendPath, cleanup } = await ensureScalewayFormat(filePath);
        try {
            log.info(`[Transcriptions] Sending to Scaleway ${model} at ${baseUrl}/v1/audio/transcriptions ...`);
            const r = await scalewayCallOnce(sendPath, cfg);
            rawSegments = r.segments;
            fullText = r.text;
        } finally {
            if (cleanup) cleanup();
        }
    }

    // Map to the shared segment shape. If Scaleway ever returns text-only (no
    // segments), degrade to one segment (no diarization possible without times).
    let segments = rawSegments.map(s => ({ text: s.text, start: s.start, end: s.end, speakerId: 'speaker_0' }));
    if (!segments.length && fullText) {
        segments = [{ text: fullText, start: 0, end: 0, speakerId: 'speaker_0' }];
    }
    log.info(`[Transcriptions] Scaleway: ${segments.length} segments total`);

    // 2. Local diarization + overlap merge (best-effort — transcript still
    // returns if the diarizer is down; speakers just collapse to speaker_0).
    const diarizerUrl = process.env.WHISPERX_URL || await configStore.getSecret('whisperx_url');
    const canDiarize = diarizerUrl && segments.length && segments.some(s => (s.end || 0) > 0);
    if (canDiarize) {
        try {
            const timeout = Number(process.env.WHISPERX_DIARIZE_TIMEOUT_MS) || 1800000; // 30 min: CPU diarization of long meetings
            const form = new FormData();
            form.append('file', await fs.openAsBlob(filePath), fileName); // original file; /diarize decodes any format
            const apiSvcKey = process.env.SERVICES_API_KEY;
            log.info(`[Transcriptions] Diarizing via ${diarizerUrl}/diarize ...`);
            const resp = await fetch(`${diarizerUrl}/diarize`, {
                method: 'POST',
                body: form,
                headers: apiSvcKey ? { 'X-API-Key': apiSvcKey } : {},
                signal: AbortSignal.timeout(timeout),
            });
            if (!resp.ok) throw new Error(`diarizer ${resp.status}: ${await resp.text().catch(() => resp.statusText)}`);
            const dia = /** @type {{ speakers?: Array<{ start: number, end: number, speaker: string }> }} */ (await resp.json());
            const turns = dia.speakers || [];
            if (turns.length) {
                segments = assignSpeakersByOverlap(segments, turns);
                log.info(`[Transcriptions] Diarization merged: ${turns.length} turns → ${new Set(segments.map(s => s.speakerId)).size} speakers`);
            }
        } catch (err) {
            log.warn(`[Transcriptions] Scaleway hybrid diarization failed (transcript kept, no speakers): ${/** @type {Error} */ (err).message}`);
        }
    } else if (!diarizerUrl) {
        log.warn('[Transcriptions] No diarizer configured (WHISPERX_URL / whisperx_url) — Scaleway transcript has no speaker labels.');
    }

    return { text: fullText, segments };
}

module.exports = {
    transcribeWithScaleway,
    scalewayTranscodeArgs,
    scalewaySplitArgs,
};
