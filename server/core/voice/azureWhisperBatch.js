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
const {
    computeWhisperBatchTimeouts, flacDurationSeconds, azureDiarizationSpeakers, whisperBatchJobProperties,
    pollWhisperBatchJob, whisperBatchPollDelayMs,
} = require('./whisperBatchWait.mts');
const { whisperTempKey } = require('./whisperTempAudio.mts');

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
        // The key carries the time it is written: the sweep in whisperTempAudio.mts removes a copy this process never got to delete.
        const uploadKey = whisperTempKey(audioFileName);
        const uploadMime = 'audio/flac';
        const uploadExt = '.flac';
        log.info(`[Transcription:AzureWhisper] Conditioned to FLAC: ${(inputBytes / 1024).toFixed(0)} KB → ${(uploadBuffer.length / 1024).toFixed(0)} KB`);

        const { pollCapMs, urlTtlSeconds, estimatedSeconds, jobTimeToLive } = computeWhisperBatchTimeouts({
            bytes: uploadBuffer.length, ext: uploadExt, durationSeconds: flacDurationSeconds(uploadBuffer),
        });

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
            properties: whisperBatchJobProperties({ numSpeakers, durationSeconds: estimatedSeconds, jobTimeToLive }),
        };

        if (!jobBody.properties.diarization) {
            log.warn(`[Transcription:AzureWhisper] ~${Math.round((estimatedSeconds || 0) / 60)} minutes of audio is past Azure's 240-minute limit for a speaker range; separating two voices only`);
        }
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

module.exports = {
    runAzureWhisperBatch, formatAzureBatchFailure, computeWhisperBatchTimeouts, azureDiarizationSpeakers,
    pollWhisperBatchJob, whisperBatchPollDelayMs, flacDurationSeconds, whisperBatchJobProperties,
};
