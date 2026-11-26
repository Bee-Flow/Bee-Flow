// @typecheck
/**
 * Azure Whisper batch transcription (Speech REST API v3.2): the raw diarized
 * segments. Lives in core/voice so the meeting-notes ingest (core) and the
 * upload/reprocess routes share it; integrations/transcriptionTools re-exports it.
 */

'use strict';

const { fetchFixedEndpoint } = require('../../utils/fixedEndpointFetch.mts');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const configStore = require('../../stores/configStore');
const log = require('../../telemetry/log');
const { bestEffort, ignoreGone } = require('../../utils/bestEffort');

/**
 * Build a diagnostic error message for a non-succeeded Azure batch job.
 *
 * Azure surfaces the real failure reason (bad content URL, unsupported format,
 * quota, …) in `pollData.properties.error.{code,message}`. The poll loop only
 * reads `pollData.status`, so without this the user just sees the terminal
 * status word. Fall back to the generic hint when no error detail is present.
 *
 * @param {{ status?: string, properties?: { error?: { code?: string, message?: string } } } | null | undefined} pollData
 *   the parsed Azure transcription job poll response
 * @returns {string} a human-readable failure message (secret-free; the caller
 *   still runs it through the existing redaction before surfacing it)
 */
function formatAzureBatchFailure(pollData) {
    const status = pollData?.status || 'Failed';
    const err = pollData?.properties?.error;
    const code = err?.code;
    const message = err?.message;
    if (code || message) {
        const detail = [code, message].filter(Boolean).join(' — ');
        // InvalidData = Azure fetched the URL but the bytes weren't decodable
        // audio (or the public URL served an error page). Point at the real
        // cause instead of the raw Azure wording.
        const hint = /InvalidData/i.test(`${code} ${message}`)
            ? ' (Azure could not decode the audio at the temp URL — check SERVER_PUBLIC_HOST is publicly reachable and RustFS serves the file; or use the pyannote provider.)'
            : '';
        return `Azure Whisper batch job ${status}: ${detail}${hint}`;
    }
    return `Azure Whisper batch job ${status}. Check your Azure Speech resource.`;
}

/** @type {Record<string, number>} */
const WHISPER_BATCH_BYTES_PER_SECOND = {
    '.wav': 32000, '.flac': 16000, '.mp3': 16000,
    '.m4a': 12000, '.mp4': 12000, '.ogg': 8000, '.opus': 8000,
};
/**
 * Azure schedules batch jobs on a best-effort basis: at peak hours a job can
 * wait up to 30 minutes before it starts, and that wait already shows as
 * `Running`. Every job gets this much on top of its own audio.
 */
const WHISPER_BATCH_QUEUE_ALLOWANCE_MS = 30 * 60_000;
/** Without a size estimate, wait as for an hour of audio. */
const WHISPER_BATCH_UNKNOWN_AUDIO_MS = 60 * 60_000;
/** The longest wait computed here; WHISPER_AZURE_POLL_TIMEOUT_MS sets any other value. */
const WHISPER_BATCH_MAX_POLL_MS = 6 * 60 * 60_000;

/**
 * Duration-scaled limits for an Azure Whisper batch run.
 *
 * The wait is the queue allowance plus the length of the audio. Both parts
 * matter: with the audio length alone a five-minute recording times out while
 * it is still in Azure's queue, and with a ceiling of an hour a meeting of two
 * hours or more gets the same wait as one of an hour. The download URL and the
 * job's own lifetime at Azure follow the wait: the URL must outlive the queue
 * time (Azure may only fetch the audio when the job starts), and the result
 * must still exist when the job finishes near the end of the wait.
 *
 * @param {{bytes?: number, ext?: string, env?: NodeJS.ProcessEnv}} [opts]
 * @returns {{pollCapMs: number, urlTtlSeconds: number, estimatedSeconds: number|null, jobTimeToLive: string}}
 */
function computeWhisperBatchTimeouts({ bytes, ext, env = process.env } = {}) {
    const bps = WHISPER_BATCH_BYTES_PER_SECOND[String(ext || '').toLowerCase()];
    const estimatedSeconds = bps && Number(bytes) > 0 ? Math.round(Number(bytes) / bps) : null;
    const override = Number(env.WHISPER_AZURE_POLL_TIMEOUT_MS);
    const audioMs = estimatedSeconds ? estimatedSeconds * 1000 : WHISPER_BATCH_UNKNOWN_AUDIO_MS;
    const pollCapMs = override > 0
        ? override
        : Math.min(WHISPER_BATCH_MAX_POLL_MS, WHISPER_BATCH_QUEUE_ALLOWANCE_MS + audioMs);
    const urlTtlSeconds = Math.round(pollCapMs / 1000) + 900;
    const jobTimeToLive = `PT${Math.max(4, Math.ceil(pollCapMs / 3_600_000) + 1)}H`;
    return { pollCapMs, urlTtlSeconds, estimatedSeconds, jobTimeToLive };
}

/**
 * How long to wait before the next status poll. A job that is still running
 * after a few minutes is in the queue or on a long recording: asking every
 * five seconds for an hour is 700 requests and as many log lines for nothing.
 * @param {number} elapsedMs
 */
function whisperBatchPollDelayMs(elapsedMs) {
    if (elapsedMs < 2 * 60_000) return 5_000;
    if (elapsedMs < 15 * 60_000) return 15_000;
    return 30_000;
}

/**
 * Poll a batch job until Azure reports a final status, and return that last
 * poll response. Gives up after `pollCapMs` with an error coded `timeout`, so
 * a meeting import can tell "took too long" from "failed".
 *
 * @param {{
 *   jobUrl: string,
 *   speechKey: string,
 *   pollCapMs: number,
 *   sleep?: (ms: number) => Promise<unknown>,
 *   now?: () => number,
 *   fetchJob?: (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean, status: number, json: () => Promise<unknown> }>,
 * }} opts `sleep`, `now` and `fetchJob` are test seams
 * @returns {Promise<{ status?: string, properties?: { error?: { code?: string, message?: string } } }>}
 */
async function pollWhisperBatchJob({ jobUrl, speechKey, pollCapMs, sleep = (ms) => new Promise(r => setTimeout(r, ms)), now = Date.now, fetchJob = fetchFixedEndpoint }) {
    const pollStart = now();
    let loggedStatus = '';
    let loggedAt = pollStart;
    for (;;) {
        const elapsedMs = now() - pollStart;
        if (elapsedMs > pollCapMs) {
            throw Object.assign(
                new Error(`Azure Whisper batch job timed out after ${Math.round(pollCapMs / 60000)} minutes.`),
                { code: 'timeout' },
            );
        }
        await sleep(whisperBatchPollDelayMs(elapsedMs));
        const pollResp = await fetchJob(jobUrl, { headers: { 'Ocp-Apim-Subscription-Key': speechKey } });
        if (!pollResp.ok) throw new Error(`Polling failed: HTTP ${pollResp.status}`);
        const pollData = /** @type {{ status?: string, properties?: { error?: { code?: string, message?: string } } }} */ (await pollResp.json());
        const status = String(pollData.status);
        // A status change, and otherwise one line a minute: enough to see it is alive.
        if (status !== loggedStatus || now() - loggedAt >= 60_000) {
            log.info(`[Transcription:AzureWhisper] Status: ${status} (${Math.round((now() - pollStart) / 1000)}s)`);
            loggedStatus = status;
            loggedAt = now();
        }
        if (status !== 'Running' && status !== 'NotStarted') return pollData;
    }
}

/**
 * Run an Azure Whisper batch transcription and return RAW diarized segments.
 *
 * Flow:
 *  1. Native formats upload as-is; others are converted to OGG/Opus first
 *  2. Upload to RustFS (existing S3-compatible object storage) with an
 *     HMAC-signed temp URL through the BeeFlow proxy — RustFS must be
 *     reachable from the public internet for Azure to fetch it
 *  3. POST batch transcription job (Whisper model, diarization enabled)
 *  4. Poll every 5 s up to the duration-scaled cap
 *  5. Fetch + parse the result JSON
 *  6. `finally`: delete temp files, the RustFS object and the Azure job
 *
 * No merging or speaker naming happens here: the upload/reprocess routes feed
 * these segments through the shared post-processing (roster-aware naming,
 * chapters); the chat-tool wrapper below applies its own shaping.
 *
 * @param {{filePath?: string, audioData?: Buffer, fileName?: string, language?: string, numSpeakers?: number|null}} opts
 * @returns {Promise<{text: string, segments: Array<{speakerId: string, start: number, end: number, text: string}>, durationSeconds: number}>}
 * @throws on configuration, upload, job or result errors — callers decide the shape.
 */
async function runAzureWhisperBatch({ filePath, audioData, fileName, language = 'nl', numSpeakers = null } = {}) {
    const speechKey = await configStore.getSecret('azure_speech_key');
    const speechRegion = await configStore.getConfig('azure_speech_region');

    if (!speechKey || !speechRegion) {
        throw new Error('Azure Speech key or region not configured. Add them in Admin → Integrations.');
    }
    if (!/^[a-z0-9-]{2,32}$/.test(speechRegion)) {
        throw new Error('Invalid Azure Speech region format stored in configuration.');
    }

    // Uses existing RustFS storageStore — no separate Azure Blob Storage needed.
    const storageStore = require('../../stores/storageStore');
    if (!storageStore.isAvailable()) {
        throw new Error('Azure Whisper requires RustFS object storage to be configured (RUSTFS_ENDPOINT / RUSTFS_ACCESS_KEY / RUSTFS_SECRET_KEY). Azure\'s servers need to download the audio file via a URL.');
    }
    // Azure fetches the audio from a PUBLIC URL we mint. If the server's public
    // host isn't set, that URL points at localhost — Azure gets nothing usable
    // and the job dies with a cryptic "InvalidData". Fail fast with the real
    // cause instead. (pyannote avoids this entirely — it hosts its own media.)
    const publicHost = process.env.SERVER_PUBLIC_HOST || '';
    if (!publicHost || /^localhost|^127\.|^0\.0\.0\.0/.test(publicHost)) {
        throw new Error('Azure Whisper needs a publicly reachable SERVER_PUBLIC_HOST so Azure can download the audio. It is unset or points at localhost. Set SERVER_PUBLIC_HOST, or use the pyannote provider (no public URL required).');
    }

    if (!audioData && !filePath) throw new Error('runAzureWhisperBatch requires filePath or audioData.');
    const inputBytes = audioData ? audioData.length : (await fs.promises.stat(/** @type {string} */ (filePath))).size;
    const audioFileName = fileName || (filePath ? path.basename(filePath) : 'audio.mp3');

    const { AZURE_LOCALE_MAP } = require('./azureSpeech');
    const locale = AZURE_LOCALE_MAP[language] || `${language}-${language.toUpperCase()}`;

    log.info(`[Transcription:AzureWhisper] Transcribing ${log.nameForLog(audioFileName)} (${(inputBytes / (1024 * 1024)).toFixed(1)} MB), locale: ${locale}`);

    // A file on disk goes to ffmpeg as it is; only a buffer needs a temp copy.
    // Both temp names are random: several jobs run at once in one process, and a
    // millisecond stamp let two of them share a file (one job transcribed the
    // other's audio, and its cleanup deleted the file under the other).
    /** @type {string | null} */
    let tempInputPath = null;
    if (audioData) {
        tempInputPath = path.join(os.tmpdir(), `azwhi-in-${crypto.randomUUID()}`);
        await fs.promises.writeFile(tempInputPath, audioData);
    }
    const sttInputPath = tempInputPath || /** @type {string} */ (filePath);
    let audioCleanup = () => {};
    /** @type {string | null} */
    let rustfsKey = null;
    /** @type {string | undefined | null} */
    let transcriptionJobUrl = null;

    try {
        // ── Step 1: transcode to canonical 16kHz mono FLAC ──
        // ALWAYS, regardless of source container. The upload UI accepts video/*,
        // and passing a .mp4/.m4a video (or an exotic codec) straight through is
        // what produced "InvalidData — the recordings URI contains invalid data":
        // Azure fetched the bytes but couldn't decode them as audio. FLAC is
        // lossless, compact, audio-only (strips any video track) and reliably
        // decodable by Azure batch.
        const { preprocessForStt } = require('./audioPreprocess');
        const conditioned = await preprocessForStt(sttInputPath, { format: 'flac', label: 'azwhi' });
        audioCleanup = conditioned.cleanup;
        if (!conditioned.preprocessed) {
            throw new Error('Could not transcode the audio to a format Azure can decode (ffmpeg unavailable). Try another provider.');
        }
        const uploadBuffer = await fs.promises.readFile(conditioned.path);
        const uploadKey = `transcription-tmp/${crypto.randomUUID()}-${audioFileName.replace(/[^a-zA-Z0-9._-]/g, '_')}.flac`;
        const uploadMime = 'audio/flac';
        const uploadExt = '.flac';
        log.info(`[Transcription:AzureWhisper] Conditioned to FLAC: ${(inputBytes / 1024).toFixed(0)} KB → ${(uploadBuffer.length / 1024).toFixed(0)} KB`);

        const { pollCapMs, urlTtlSeconds, estimatedSeconds, jobTimeToLive } = computeWhisperBatchTimeouts({ bytes: uploadBuffer.length, ext: uploadExt });

        // ── Step 2: Upload to RustFS, generate public temp URL ──
        // Azure's batch API needs to download the audio from a public URL.
        // RustFS presigned URLs point to localhost:9000 (unreachable by Azure),
        // so we use an HMAC-signed temporary public URL through the BeeFlow server proxy.
        rustfsKey = uploadKey;
        await storageStore.uploadFile(rustfsKey, uploadBuffer, uploadMime);
        const { generateTempDownloadUrl } = require('../../utils/tempDownloadUrl');
        const audioUrl = generateTempDownloadUrl(rustfsKey, urlTtlSeconds);
        log.info(`[Transcription:AzureWhisper] Uploaded to RustFS: ${rustfsKey} (${(uploadBuffer.length / 1024).toFixed(0)} KB, ~${estimatedSeconds ?? '?'}s audio, poll cap ${Math.round(pollCapMs / 60000)}m)`);

        // ── Step 3: Discover the Whisper model UUID via paginated API ──
        // Azure only returns 100 oldest models per page; Whisper is near the end.
        const speechApiBase = `https://${speechRegion}.api.cognitive.microsoft.com/speechtotext/v3.2`;

        log.info('[Transcription:AzureWhisper] Discovering Whisper model in region', speechRegion, '...');
        /** @type {{ displayName?: string; self?: string; }[]} */
        let whisperModels = [];
        let skip = 0;
        const pageSize = 100;
        while (true) {
            const modelsUrl = `${speechApiBase}/models/base?skip=${skip}&top=${pageSize}`;
            const modelsResp = await fetchFixedEndpoint(modelsUrl, {
                headers: { 'Ocp-Apim-Subscription-Key': speechKey },
            });
            if (!modelsResp.ok) throw new Error(`Failed to list Azure models: HTTP ${modelsResp.status}`);
            const modelsData = /** @type {{ values?: Array<{ displayName?: string, self?: string }> }} */ (await modelsResp.json());
            const vals = modelsData.values || [];
            const found = vals.filter(m => /whisper/i.test(m.displayName));
            if (found.length > 0) whisperModels.push(...found);
            if (vals.length < pageSize) break;
            skip += pageSize;
        }

        if (whisperModels.length === 0) {
            throw new Error(`No Whisper model found in Azure region '${speechRegion}'. Make sure the region supports Whisper batch transcription.`);
        }

        // Pick the latest Whisper model (highest date in displayName)
        whisperModels.sort((a, b) => b.displayName.localeCompare(a.displayName));
        const bestWhisper = whisperModels[0];
        log.info(`[Transcription:AzureWhisper] Using model: ${bestWhisper.displayName} (${bestWhisper.self})`);

        // ── Step 4: Create batch transcription job ──
        // The job is explicitly DELETEd in `finally`; its lifetime at Azure only
        // has to outlast the wait (computeWhisperBatchTimeouts).
        const jobBody = {
            contentUrls: [audioUrl],
            locale,
            displayName: `beeflow-${Date.now()}`,
            model: { self: bestWhisper.self },
            properties: {
                diarizationEnabled: true,
                // `diarizationEnabled` alone caps at 2 speakers. The modern
                // `diarization.speakers` unlocks 3–35 (max must be < 36). Use the
                // user's per-meeting count as an exact hint when given, else a
                // wide 1–35 range so real multi-speaker meetings get separated.
                diarization: azureDiarizationSpeakers(numSpeakers),
                punctuationMode: 'DictatedAndAutomatic',
                profanityFilterMode: 'None',
                timeToLive: jobTimeToLive,
            },
        };

        log.info('[Transcription:AzureWhisper] Submitting batch job...');
        const createResp = await fetchFixedEndpoint(`${speechApiBase}/transcriptions`, {
            method: 'POST',
            headers: { 'Ocp-Apim-Subscription-Key': speechKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(jobBody),
        });
        if (!createResp.ok) {
            const errText = await createResp.text().catch(() => '');
            throw new Error(`Azure Whisper job creation failed (${createResp.status}): ${errText.replace(/[A-Za-z0-9_\-]{32,}/g, '[REDACTED]').substring(0, 300)}`);
        }
        const job = /** @type {{ self?: string }} */ (await createResp.json());
        transcriptionJobUrl = job.self;
        log.info(`[Transcription:AzureWhisper] Job created: ${transcriptionJobUrl.split('/').pop()}`);

        // ── Step 5: Poll until Succeeded or Failed ──
        const pollData = await pollWhisperBatchJob({ jobUrl: transcriptionJobUrl, speechKey, pollCapMs });
        const jobStatus = pollData.status;
        if (jobStatus !== 'Succeeded') {
            const jobErr = pollData?.properties?.error;
            if (jobErr) log.error(`[Transcription:AzureWhisper] Job ${jobStatus}: ${jobErr.code || '?'} — ${jobErr.message || ''}`);
            throw new Error(formatAzureBatchFailure(pollData));
        }

        // ── Step 5: Fetch result ──
        const filesResp = await fetchFixedEndpoint(`${transcriptionJobUrl}/files`, { headers: { 'Ocp-Apim-Subscription-Key': speechKey } });
        if (!filesResp.ok) throw new Error(`Fetching result files failed: HTTP ${filesResp.status}`);
        const filesData = /** @type {{ values?: Array<{ kind?: string, links?: { contentUrl?: string } }> }} */ (await filesResp.json());
        const resultFile = (filesData.values || []).find(f => f.kind === 'Transcription');
        if (!resultFile?.links?.contentUrl) throw new Error('No transcription result file in Azure job output.');
        const resultResp = await fetchFixedEndpoint(resultFile.links.contentUrl, { timeoutPhase: 'headers' }); // the transcript of a long meeting is a large body
        if (!resultResp.ok) throw new Error(`Downloading result failed: HTTP ${resultResp.status}`);
        const resultData = /** @type {{ recognizedPhrases?: Array<any> }} */ (await resultResp.json());

        // ── Step 6: Normalise segments ──
        // recognizedPhrases[].speaker is an integer (1-based), convert to "Guest-N"
        const rawSegments = (resultData.recognizedPhrases || [])
            .filter(p => p.nBest?.[0]?.display?.trim())
            .map(p => ({
                speakerId: p.speaker != null ? `Guest-${p.speaker}` : 'Unknown',
                start: (p.offsetInTicks || 0) / 10_000_000,
                end: ((p.offsetInTicks || 0) + (p.durationInTicks || 0)) / 10_000_000,
                text: p.nBest[0].display.trim(),
            }));

        log.info(`[Transcription:AzureWhisper] Completed — ${rawSegments.length} phrases`);
        if (rawSegments.length === 0)
            throw new Error('Azure Whisper returned no speech. Ensure audio is clear and language is correct.');

        const totalDuration = Math.max(...rawSegments.map(s => s.end || 0));
        return {
            text: rawSegments.map(s => s.text).join(' '),
            segments: rawSegments,
            durationSeconds: Math.round(totalDuration),
        };
    } finally {
        try { if (tempInputPath) fs.unlinkSync(tempInputPath); } catch (_) { ignoreGone('voice/azureWhisperBatch:unlinkTempInput', _); }
        try { audioCleanup(); } catch (_) { bestEffort('core/voice/azureWhisperBatch:runAzureWhisperBatch', _); /* audio cleanup already done */ }
        try {
            if (rustfsKey) { const ss = require('../../stores/storageStore'); await ss.deleteFile(rustfsKey); log.info('[Transcription:AzureWhisper] Temp audio deleted from RustFS'); }
        } catch (_) { log.warn('temp audio could not be deleted from object storage', _); }
        try {
            if (transcriptionJobUrl && speechKey) await fetchFixedEndpoint(transcriptionJobUrl, { method: 'DELETE', headers: { 'Ocp-Apim-Subscription-Key': speechKey } });
        } catch (_) { log.warn('Azure transcription job could not be deleted', _); }
    }
}

/**
 * Build the batch `diarization` property from an optional speaker count.
 * Exact count → minCount=maxCount=N; unknown → 1..35. maxCount must be < 36.
 * @param {number | null} numSpeakers
 */
function azureDiarizationSpeakers(numSpeakers) {
    const n = Number(numSpeakers);
    if (Number.isFinite(n) && n >= 1) {
        const c = Math.min(Math.round(n), 35);
        return { speakers: { minCount: c, maxCount: c } };
    }
    return { speakers: { minCount: 1, maxCount: 35 } };
}


module.exports = {
    runAzureWhisperBatch, formatAzureBatchFailure, computeWhisperBatchTimeouts, azureDiarizationSpeakers,
    pollWhisperBatchJob, whisperBatchPollDelayMs,
};
