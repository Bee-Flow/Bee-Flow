/**
 * Transcription Tools — Multi-provider meeting transcription with diarization
 *
 * Supported providers:
 *   - voxtral   : Mistral Voxtral (voxtral-mini-latest) — cloud, best accuracy
 *   - azure     : Azure AI Speech (Whisper model, SDK push-stream)
 *   - whisperx  : Self-hosted WhisperX HTTP API — fully private, no data leaves your server
 *
 * All providers:
 *   • Return per-segment diarization (who said what)
 *   • Feed results into a Claude speaker-name identification step
 *   • Sanitise errors so API keys are never exposed in logs
 *
 * Security:
 *   • API keys are NEVER logged
 *   • All secrets retrieved from AES-256-GCM encrypted configStore
 *   • Audio buffers are held in memory only, never written to disk by this module
 *   • Temporary SDK push-stream is destroyed immediately after transcription
 */

'use strict';

const configStore = require('../stores/configStore');
const fs = require('fs');
const os = require('os');
const path = require('path');
const log = require('../telemetry/log');

// ffmpeg helper — installed via @ffmpeg-installer/ffmpeg
let ffmpeg;
try {
    const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
    ffmpeg = require('fluent-ffmpeg');
    ffmpeg.setFfmpegPath(ffmpegInstaller.path);
} catch (_) {
    ffmpeg = null; // ffmpeg not available, Azure will attempt raw stream (WAV only)
}

// ─── Tool Definitions ──────────────────────────────────────────────────────────

const TRANSCRIPTION_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'transcribe_audio',
            description:
                'Transcribe an uploaded audio file using AI. Returns a formatted transcript with speaker ' +
                'diarization (who said what), timestamps, and segment-level detail. ' +
                'Supports up to 3 hours of audio. Best for: meeting recordings, interviews, calls, voice notes. ' +
                'The audio file must be uploaded as an attachment to the message.',
            parameters: {
                type: 'object',
                properties: {
                    language: {
                        type: 'string',
                        description:
                            'Language code for transcription (e.g. "nl" for Dutch, "en" for English, ' +
                            '"de" for German, "fr" for French). Default: "nl"',
                    },
                    context_terms: {
                        type: 'string',
                        description:
                            'Comma-separated list of domain-specific terms to help the model recognise ' +
                            '(e.g. "AFAS, Bflow, N8N, Ondernemers Kompas"). Improves accuracy for company ' +
                            'names, products, jargon.',
                    },
                    timestamp_granularity: {
                        type: 'string',
                        enum: ['segment', 'word'],
                        description:
                            'Level of timestamp detail. "segment" (default) gives per-sentence timestamps, ' +
                            '"word" gives per-word timestamps.',
                    },
                },
                required: [],
            },
        },
    },
];

// ─── Helpers ───────────────────────────────────────────────────────────────────

function formatTime(seconds) {
    if (seconds == null) return '00:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0)
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Build a diagnostic error message for a non-succeeded Azure batch job.
 *
 * Azure surfaces the real failure reason (bad content URL, unsupported format,
 * quota, …) in `pollData.properties.error.{code,message}`. The poll loop only
 * reads `pollData.status`, so without this the user just sees the terminal
 * status word. Fall back to the generic hint when no error detail is present.
 *
 * @param {object} pollData - the parsed Azure transcription job poll response
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
 * Merge consecutive segments from the same speaker for cleaner output.
 */
function mergeSegments(segments) {
    if (!segments || segments.length === 0) return [];
    const merged = [];
    for (const seg of segments) {
        const last = merged[merged.length - 1];
        if (last && seg.speakerId === last.speakerId) {
            last.end = seg.end;
            last.text += ' ' + (seg.text || '').trim();
        } else {
            merged.push({
                speakerId: seg.speakerId || 'Unknown',
                start: seg.start,
                end: seg.end,
                text: (seg.text || '').trim(),
            });
        }
    }
    return merged;
}

/**
 * Resolve the active audio attachment from the context.
 * Returns { audioData: Buffer, audioFileName: string } or throws an error string.
 */
async function resolveAudioAttachment(context) {
    const { attachments } = context;
    if (!attachments || attachments.length === 0) {
        throw 'No audio file found. Please upload an audio file (MP3, WAV, M4A, OGG, WEBM, FLAC) as an attachment to your message.';
    }

    const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.ogg', '.webm', '.flac', '.mp4', '.mpeg'];
    const audioAttachment = attachments.find((a) => {
        const ext = (a.name || a.filename || '').toLowerCase();
        return (
            AUDIO_EXTENSIONS.some((e) => ext.endsWith(e)) ||
            (a.type && a.type.startsWith('audio/'))
        );
    });

    if (!audioAttachment) {
        throw 'No audio file found. Please upload an audio file (MP3, WAV, M4A, OGG, WEBM, FLAC) as an attachment to your message.';
    }

    const audioFileName = audioAttachment.name || audioAttachment.filename || 'audio.mp3';
    let audioData = null;

    if (audioAttachment.path) {
        try {
            audioData = await fs.promises.readFile(audioAttachment.path);
        } catch (readErr) {
            throw `Could not read audio file: ${readErr.message}`;
        }
    } else if (audioAttachment.url) {
        try {
            const resp = await fetch(audioAttachment.url);
            if (!resp.ok) throw new Error(resp.statusText);
            audioData = Buffer.from(await resp.arrayBuffer());
        } catch (fetchErr) {
            throw `Could not download audio file: ${fetchErr.message}`;
        }
    } else if (audioAttachment.data || audioAttachment.content) {
        const raw = audioAttachment.data || audioAttachment.content;
        audioData = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'base64');
    }

    if (!audioData) {
        throw 'Could not read audio data from the attachment. Please try re-uploading the file.';
    }

    return { audioData, audioFileName };
}

/**
 * Use the configured fast-tier LLM to map speaker IDs → real names.
 *
 * @param {string[]} speakerIds   - All unique speaker IDs from diarisation
 * @param {string}   language     - Recording language (for context)
 * @param {string[]} formattedLines - Formatted transcript lines for context
 * @param {string}  [userName]    - Logged-in user's display name (used as anchor hint)
 */
async function identifySpeakerNames(speakerIds, language, formattedLines, userName) {
    try {
        const llmClient = require('../core/llm/llmClient');

        // Resolve fast tier model (same pattern as compaction.js)
        let modelId = 'tier:fast';
        try {
            const tiers = await configStore.getConfig('chat_model_tiers') || {};
            modelId = tiers['fast']?.modelId || 'gemini-2.0-flash-lite';
        } catch (_) {
            modelId = 'gemini-2.0-flash-lite';
        }

        const speakerList = speakerIds.join(', ');
        const userHint = userName
            ? `\n\nIMPORTANT HINT: The person who made this recording is named "${userName}". Look at the conversation content to identify which speaker is most likely "${userName}" — they are probably the one speaking most or initiating the conversation. Prioritize this name assignment.`
            : '';

        const systemPrompt = `You are an expert transcript analyst specializing in speaker diarization.

Your task: Map EVERY speaker ID to a real person's first name.

Key rules:
1. Diarization often creates MULTIPLE IDs for ONE person. A meeting with 3 people may have 10+ speaker IDs.
2. Group speaker IDs who sound similar, speak consecutively, or share speaking patterns.
3. Assign a FIRST NAME to every speaker ID — never return null or empty.
4. If you cannot determine a name, use "Speaker A", "Speaker B", etc.
5. Multiple IDs MUST map to the same name when they belong to the same person.${userHint}

Return ONLY a valid JSON object mapping every speaker ID to a name.
Example: {"Guest-1": "Tom", "Guest-2": "Tom", "Guest-3": "Gerard", "Guest-4": "Gerard"}
No explanation, no markdown, ONLY the JSON object.`;

        const userContent = `Speaker IDs: ${speakerList}
Language: ${language}

Transcript (first 20,000 characters):
${formattedLines.join('\n').substring(0, 20000)}`;

        const result = await llmClient.chat(modelId, [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
        ], { maxTokens: 512, temperature: 0 });

        const chatContent = (result.content || '').trim();
        const jsonMatch = chatContent.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;

        const nameMapping = JSON.parse(jsonMatch[0]);
        // Remove null/empty/literal-null values
        for (const [key, value] of Object.entries(nameMapping)) {
            if (!value || value === 'null' || value === 'unknown') delete nameMapping[key];
        }
        log.info(`[Transcription] Speaker names identified via ${modelId}: ${JSON.stringify(nameMapping)}`);
        return nameMapping;
    } catch (nameErr) {
        log.error('[Transcription] Speaker identification failed:', nameErr.message);
        return null;
    }
}


/**
 * Build the final result object shared by both providers.
 */
function buildResult({ audioFileName, language, merged, totalDuration, speakerMap, nameMapping }) {
    // Apply name mapping if available
    if (nameMapping) {
        for (const seg of merged) {
            if (nameMapping[seg.speakerId]) seg.speakerId = nameMapping[seg.speakerId];
        }
    }

    const formattedLines = merged.map((s) => {
        const start = formatTime(s.start);
        const end = formatTime(s.end);
        return `[${s.speakerId}] ${start} - ${end}: ${s.text}`;
    });

    return {
        success: true,
        fileName: audioFileName,
        language,
        duration: formatTime(totalDuration),
        durationSeconds: Math.round(totalDuration),
        speakerCount: Object.keys(speakerMap).length,
        segmentCount: merged.length,
        speakers: Object.entries(speakerMap).map(([id, data]) => ({
            id: nameMapping?.[id] || id,
            speakingTime: formatTime(data.duration),
            segments: data.segments,
        })),
        transcript: formattedLines.join('\n'),
        segments: merged.map((s) => ({
            speaker: s.speakerId,
            start: s.start,
            end: s.end,
            startFormatted: formatTime(s.start),
            endFormatted: formatTime(s.end),
            text: s.text,
        })),
    };
}

// ─── Provider: Voxtral (Mistral) ──────────────────────────────────────────────

async function handleVoxtralTranscription(args, context) {
    // Key retrieved from encrypted store — never logged
    const apiKey = await configStore.getSecret('mistral_api_key');
    if (!apiKey) {
        return {
            error: 'Mistral API key not configured. Add it in Admin → AI Config → API Keys.',
        };
    }

    let audioData, audioFileName;
    // If called directly from the upload route, args.filePath is the temp file on disk
    if (args.filePath) {
        try {
            audioData = await fs.promises.readFile(args.filePath);
            audioFileName = args.fileName || require('path').basename(args.filePath);
        } catch (e) {
            return { error: `Could not read audio file: ${e.message}` };
        }
    } else {
        try {
            ({ audioData, audioFileName } = await resolveAudioAttachment(context));
        } catch (errMsg) {
            return { error: errMsg };
        }
    }

    const language = args.language || 'nl';
    const contextTerms = args.context_terms || '';
    const granularity = args.timestamp_granularity || 'segment';

    log.info(
        `[Transcription:Voxtral] Transcribing "${audioFileName}" (${(audioData.length / (1024 * 1024)).toFixed(1)} MB), lang: ${language}`
    );

    try {
        const client = require('../core/meetingNotes/voxtralClient').createVoxtralClient(apiKey);

        const transcriptionOptions = {
            model: 'voxtral-mini-latest',
            file: { fileName: audioFileName, content: audioData },
            diarize: true,
            language,
            timestampGranularities: [granularity],
        };
        if (contextTerms) transcriptionOptions.prompt = contextTerms;

        const response = await client.audio.transcriptions.complete(transcriptionOptions);
        log.info(
            `[Transcription:Voxtral] Completed — ${(response.segments || []).length} raw segments`
        );

        const rawSegments = response.segments || [];
        const merged = mergeSegments(rawSegments);

        const speakerMap = {};
        for (const seg of merged) {
            if (!speakerMap[seg.speakerId])
                speakerMap[seg.speakerId] = { duration: 0, segments: 0 };
            speakerMap[seg.speakerId].duration += (seg.end || 0) - (seg.start || 0);
            speakerMap[seg.speakerId].segments += 1;
        }

        const totalDuration =
            rawSegments.length > 0 ? Math.max(...rawSegments.map((s) => s.end || 0)) : 0;

        const formattedLines = merged.map((s) => {
            return `[${s.speakerId}] ${formatTime(s.start)} - ${formatTime(s.end)}: ${s.text}`;
        });

        const nameMapping = await identifySpeakerNames(
            Object.keys(speakerMap),
            language,
            formattedLines,
            args.userName
        );

        return buildResult({ audioFileName, language, merged, totalDuration, speakerMap, nameMapping });
    } catch (err) {
        // Sanitise error: strip any key-like tokens from message
        const safeMsg = (err.message || '').replace(/[A-Za-z0-9_\-]{32,}/g, '[REDACTED]');
        log.error('[Transcription:Voxtral] Error:', safeMsg);
        if (err.message?.includes('rate_limit')) {
            return {
                error: 'Rate limit reached for Voxtral. Please try again in a few moments.',
            };
        }
        return { error: `Transcription failed: ${safeMsg}` };
    }
}

// ─── Provider: Azure AI Speech ────────────────────────────────────────────────

/**
 * Chat-tool wrapper around the shared ConversationTranscriber core
 * (`core/voice/azureSpeech.js`: duration-aware timeouts, inactivity watchdog,
 * partial-transcript salvage, cleanup on all paths). This function only adapts
 * attachment → file on the way in and the result → chat-tool shape on the way
 * out; the upload/reprocess routes call the core directly.
 */
async function handleAzureTranscription(args, context) {
    let inputPath = args.filePath || null;
    let tempInputPath = null;
    let audioFileName = args.fileName || (inputPath ? path.basename(inputPath) : 'audio.mp3');

    if (!inputPath) {
        let audioData;
        try {
            ({ audioData, audioFileName } = await resolveAudioAttachment(context));
        } catch (errMsg) {
            return { error: errMsg };
        }
        tempInputPath = path.join(os.tmpdir(), `azure-in-${Date.now()}`);
        await fs.promises.writeFile(tempInputPath, audioData);
        inputPath = tempInputPath;
    }

    const language = args.language || 'nl';
    log.info(`[Transcription:Azure] Transcribing "${audioFileName}", lang: ${language}`);

    try {
        const { transcribeWithAzureSpeech } = require('../core/voice/azureSpeech');
        const az = await transcribeWithAzureSpeech(inputPath, {
            language,
            contextTerms: args.context_terms || '',
        });

        const merged = mergeSegments(az.segments);

        const speakerMap = {};
        for (const seg of merged) {
            if (!speakerMap[seg.speakerId])
                speakerMap[seg.speakerId] = { duration: 0, segments: 0 };
            speakerMap[seg.speakerId].duration += (seg.end || 0) - (seg.start || 0);
            speakerMap[seg.speakerId].segments += 1;
        }

        const totalDuration = az.segments.length > 0 ? Math.max(...az.segments.map((s) => s.end || 0)) : 0;

        const formattedLines = merged.map((s) =>
            `[${s.speakerId}] ${formatTime(s.start)} - ${formatTime(s.end)}: ${s.text}`
        );

        const nameMapping = await identifySpeakerNames(Object.keys(speakerMap), language, formattedLines, args.userName);

        const result = buildResult({ audioFileName, language, merged, totalDuration, speakerMap, nameMapping });
        if (az.truncated) {
            result.warning = `Transcription stopped early at ${formatTime(az.truncated.atSeconds)} — the rest of the recording is missing.`;
        }
        return result;
    } catch (err) {
        const safeMsg = (err.message || '')
            .replace(/[A-Za-z0-9_\-]{32,}/g, '[REDACTED]')
            .replace(/key[=:]\S+/gi, 'key=[REDACTED]');
        log.error('[Transcription:Azure] Error:', safeMsg);
        return { error: `Azure transcription failed: ${safeMsg}` };
    } finally {
        if (tempInputPath) { try { fs.unlinkSync(tempInputPath); } catch (_) {} }
    }
}


// ─── Provider: pyannoteAI (all-in-one diarization + transcription) ─────────────

/**
 * Chat-tool wrapper around the shared pyannote core
 * (`core/voice/pyannoteClient.js`). Adapts attachment → file in and the result
 * → chat-tool shape out; the upload/reprocess routes call the core directly.
 */
async function handlePyannoteTranscription(args, context) {
    let inputPath = args.filePath || null;
    let tempInputPath = null;
    let audioFileName = args.fileName || (inputPath ? path.basename(inputPath) : 'audio.mp3');

    if (!inputPath) {
        let audioData;
        try {
            ({ audioData, audioFileName } = await resolveAudioAttachment(context));
        } catch (errMsg) {
            return { error: errMsg };
        }
        tempInputPath = path.join(os.tmpdir(), `pyannote-in-${Date.now()}`);
        await fs.promises.writeFile(tempInputPath, audioData);
        inputPath = tempInputPath;
    }

    const language = args.language || 'nl';
    try {
        // The org is read from the CALLER'S OWN user row, never from a request
        // param or a multi-org set: it decides whose biometric templates leave
        // the building, so it has to be unambiguous.
        let orgId = null;
        try {
            const { getUser } = require('../stores/userStore');
            orgId = (await getUser(context.userId))?.organizationId || null;
        } catch (_) { /* no org context → no identification, transcription unaffected */ }

        const { transcribeWithPyannote } = require('../core/voice/pyannoteClient');
        const p = await transcribeWithPyannote(inputPath, { language, orgId, recorderUserId: context.userId });

        const merged = mergeSegments(p.segments);
        const speakerMap = {};
        for (const seg of merged) {
            if (!speakerMap[seg.speakerId]) speakerMap[seg.speakerId] = { duration: 0, segments: 0 };
            speakerMap[seg.speakerId].duration += (seg.end || 0) - (seg.start || 0);
            speakerMap[seg.speakerId].segments += 1;
        }
        const formattedLines = merged.map((s) => `[${s.speakerId}] ${formatTime(s.start)} - ${formatTime(s.end)}: ${s.text}`);
        // This module's local identifySpeakerNames is the older 4-arg variant
        // (no org, no roster) — deliberately left alone. Voiceprint pins are
        // merged over its answer instead, so a voice match always wins.
        const llmMapping = await identifySpeakerNames(Object.keys(speakerMap), language, formattedLines, args.userName);
        const nameMapping = p.voiceprintMapping
            ? { ...(llmMapping || {}), ...p.voiceprintMapping }
            : llmMapping;
        return buildResult({ audioFileName, language, merged, totalDuration: p.durationSeconds, speakerMap, nameMapping });
    } catch (err) {
        const safeMsg = (err.message || '').replace(/[A-Za-z0-9_\-]{20,}/g, '[REDACTED]');
        log.error('[Transcription:Pyannote] Error:', safeMsg);
        return { error: `Pyannote transcription failed: ${safeMsg}` };
    } finally {
        if (tempInputPath) { try { fs.unlinkSync(tempInputPath); } catch (_) {} }
    }
}


// ─── Provider: Azure Whisper Batch (Speech REST API v3.2) ─────────────────────

/**
 * Duration-scaled limits for an Azure Whisper batch run.
 *
 * The old fixed limits (10-min poll cap, 15-min download URL) were shorter
 * than the batch turnaround for long recordings, so exactly the meetings this
 * provider exists for timed out. Estimate the audio duration from byte size
 * and format, and size both the poll ceiling and the URL TTL from it. The URL
 * must outlive the job's queue time — Azure may only fetch the audio when the
 * job starts running.
 *
 * @param {{bytes?: number, ext?: string, env?: object}} [opts]
 * @returns {{pollCapMs: number, urlTtlSeconds: number, estimatedSeconds: number|null}}
 */
const WHISPER_BATCH_BYTES_PER_SECOND = {
    '.wav': 32000, '.flac': 16000, '.mp3': 16000,
    '.m4a': 12000, '.mp4': 12000, '.ogg': 8000, '.opus': 8000,
};
function computeWhisperBatchTimeouts({ bytes, ext, env = process.env } = {}) {
    const bps = WHISPER_BATCH_BYTES_PER_SECOND[String(ext || '').toLowerCase()];
    const estimatedSeconds = bps && Number(bytes) > 0 ? Math.round(Number(bytes) / bps) : null;
    const override = Number(env.WHISPER_AZURE_POLL_TIMEOUT_MS);
    const clampMs = (v) => Math.min(60 * 60_000, Math.max(15 * 60_000, v));
    const pollCapMs = override > 0
        ? override
        : (estimatedSeconds ? clampMs(estimatedSeconds * 1000) : 30 * 60_000);
    const urlTtlSeconds = Math.round(pollCapMs / 1000) + 900;
    return { pollCapMs, urlTtlSeconds, estimatedSeconds };
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
    const storageStore = require('../stores/storageStore');
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

    if (!audioData) {
        if (!filePath) throw new Error('runAzureWhisperBatch requires filePath or audioData.');
        audioData = await fs.promises.readFile(filePath);
    }
    const audioFileName = fileName || (filePath ? path.basename(filePath) : 'audio.mp3');

    const { AZURE_LOCALE_MAP } = require('../core/voice/azureSpeech');
    const locale = AZURE_LOCALE_MAP[language] || `${language}-${language.toUpperCase()}`;

    log.info(`[Transcription:AzureWhisper] Transcribing "${audioFileName}" (${(audioData.length / (1024 * 1024)).toFixed(1)} MB), locale: ${locale}`);

    const tempInputPath = path.join(os.tmpdir(), `azwhi-in-${Date.now()}`);
    await fs.promises.writeFile(tempInputPath, audioData);
    let audioCleanup = () => {};
    let rustfsKey = null;
    let transcriptionJobUrl = null;

    try {
        // ── Step 1: transcode to canonical 16kHz mono FLAC ──
        // ALWAYS, regardless of source container. The upload UI accepts video/*,
        // and passing a .mp4/.m4a video (or an exotic codec) straight through is
        // what produced "InvalidData — the recordings URI contains invalid data":
        // Azure fetched the bytes but couldn't decode them as audio. FLAC is
        // lossless, compact, audio-only (strips any video track) and reliably
        // decodable by Azure batch.
        const { preprocessForStt } = require('../core/voice/audioPreprocess');
        const conditioned = await preprocessForStt(tempInputPath, { format: 'flac', label: 'azwhi' });
        audioCleanup = conditioned.cleanup;
        if (!conditioned.preprocessed) {
            throw new Error('Could not transcode the audio to a format Azure can decode (ffmpeg unavailable). Try another provider.');
        }
        const uploadBuffer = await fs.promises.readFile(conditioned.path);
        const uploadKey = `transcription-tmp/${Date.now()}-${audioFileName.replace(/[^a-zA-Z0-9._-]/g, '_')}.flac`;
        const uploadMime = 'audio/flac';
        const uploadExt = '.flac';
        log.info(`[Transcription:AzureWhisper] Conditioned to FLAC: ${(audioData.length / 1024).toFixed(0)} KB → ${(uploadBuffer.length / 1024).toFixed(0)} KB`);

        const { pollCapMs, urlTtlSeconds, estimatedSeconds } = computeWhisperBatchTimeouts({ bytes: uploadBuffer.length, ext: uploadExt });

        // ── Step 2: Upload to RustFS, generate public temp URL ──
        // Azure's batch API needs to download the audio from a public URL.
        // RustFS presigned URLs point to localhost:9000 (unreachable by Azure),
        // so we use an HMAC-signed temporary public URL through the BeeFlow server proxy.
        rustfsKey = uploadKey;
        await storageStore.uploadFile(rustfsKey, uploadBuffer, uploadMime);
        const { generateTempDownloadUrl } = require('../utils/tempDownloadUrl');
        const audioUrl = generateTempDownloadUrl(rustfsKey, urlTtlSeconds);
        log.info(`[Transcription:AzureWhisper] Uploaded to RustFS: ${rustfsKey} (${(uploadBuffer.length / 1024).toFixed(0)} KB, ~${estimatedSeconds ?? '?'}s audio, poll cap ${Math.round(pollCapMs / 60000)}m)`);

        // ── Step 3: Discover the Whisper model UUID via paginated API ──
        // Azure only returns 100 oldest models per page; Whisper is near the end.
        const speechApiBase = `https://${speechRegion}.api.cognitive.microsoft.com/speechtotext/v3.2`;

        log.info('[Transcription:AzureWhisper] Discovering Whisper model in region', speechRegion, '...');
        let whisperModels = [];
        let skip = 0;
        const pageSize = 100;
        while (true) {
            const modelsUrl = `${speechApiBase}/models/base?skip=${skip}&top=${pageSize}`;
            const modelsResp = await fetch(modelsUrl, {
                headers: { 'Ocp-Apim-Subscription-Key': speechKey },
            });
            if (!modelsResp.ok) throw new Error(`Failed to list Azure models: HTTP ${modelsResp.status}`);
            const modelsData = await modelsResp.json();
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
        // TTL is generous because the job is explicitly DELETEd in `finally`.
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
                timeToLive: 'PT4H',
            },
        };

        log.info('[Transcription:AzureWhisper] Submitting batch job...');
        const createResp = await fetch(`${speechApiBase}/transcriptions`, {
            method: 'POST',
            headers: { 'Ocp-Apim-Subscription-Key': speechKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(jobBody),
        });
        if (!createResp.ok) {
            const errText = await createResp.text().catch(() => '');
            throw new Error(`Azure Whisper job creation failed (${createResp.status}): ${errText.replace(/[A-Za-z0-9_\-]{32,}/g, '[REDACTED]').substring(0, 300)}`);
        }
        const job = await createResp.json();
        transcriptionJobUrl = job.self;
        log.info(`[Transcription:AzureWhisper] Job created: ${transcriptionJobUrl.split('/').pop()}`);

        // ── Step 5: Poll until Succeeded or Failed ──
        const pollStart = Date.now();
        let jobStatus = 'Running';
        let pollData = null;
        while (jobStatus === 'Running' || jobStatus === 'NotStarted') {
            if (Date.now() - pollStart > pollCapMs)
                throw new Error(`Azure Whisper batch job timed out after ${Math.round(pollCapMs / 60000)} minutes.`);
            await new Promise(r => setTimeout(r, 5000));
            const pollResp = await fetch(transcriptionJobUrl, { headers: { 'Ocp-Apim-Subscription-Key': speechKey } });
            if (!pollResp.ok) throw new Error(`Polling failed: HTTP ${pollResp.status}`);
            pollData = await pollResp.json();
            jobStatus = pollData.status;
            log.info(`[Transcription:AzureWhisper] Status: ${jobStatus} (${Math.round((Date.now() - pollStart) / 1000)}s)`);
        }
        if (jobStatus !== 'Succeeded') {
            const jobErr = pollData?.properties?.error;
            if (jobErr) log.error(`[Transcription:AzureWhisper] Job ${jobStatus}: ${jobErr.code || '?'} — ${jobErr.message || ''}`);
            throw new Error(formatAzureBatchFailure(pollData));
        }

        // ── Step 5: Fetch result ──
        const filesResp = await fetch(`${transcriptionJobUrl}/files`, { headers: { 'Ocp-Apim-Subscription-Key': speechKey } });
        if (!filesResp.ok) throw new Error(`Fetching result files failed: HTTP ${filesResp.status}`);
        const filesData = await filesResp.json();
        const resultFile = (filesData.values || []).find(f => f.kind === 'Transcription');
        if (!resultFile?.links?.contentUrl) throw new Error('No transcription result file in Azure job output.');
        const resultResp = await fetch(resultFile.links.contentUrl);
        if (!resultResp.ok) throw new Error(`Downloading result failed: HTTP ${resultResp.status}`);
        const resultData = await resultResp.json();

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
        try { fs.unlinkSync(tempInputPath); } catch (_) {}
        try { audioCleanup(); } catch (_) {}
        try {
            if (rustfsKey) { const ss = require('../stores/storageStore'); await ss.deleteFile(rustfsKey); log.info('[Transcription:AzureWhisper] Temp audio deleted from RustFS'); }
        } catch (_) {}
        try {
            if (transcriptionJobUrl && speechKey) await fetch(transcriptionJobUrl, { method: 'DELETE', headers: { 'Ocp-Apim-Subscription-Key': speechKey } });
        } catch (_) {}
    }
}

/**
 * Build the batch `diarization` property from an optional speaker count.
 * Exact count → minCount=maxCount=N; unknown → 1..35. maxCount must be < 36.
 */
function azureDiarizationSpeakers(numSpeakers) {
    const n = Number(numSpeakers);
    if (Number.isFinite(n) && n >= 1) {
        const c = Math.min(Math.round(n), 35);
        return { speakers: { minCount: c, maxCount: c } };
    }
    return { speakers: { minCount: 1, maxCount: 35 } };
}

/**
 * Chat-tool wrapper: attachment → runAzureWhisperBatch → chat-tool shape.
 */
async function handleAzureWhisperTranscription(args, context) {
    let filePath = args.filePath || null;
    let audioData = null;
    let audioFileName = args.fileName || (filePath ? path.basename(filePath) : 'audio.mp3');

    if (!filePath) {
        try {
            ({ audioData, audioFileName } = await resolveAudioAttachment(context));
        } catch (errMsg) {
            return { error: errMsg };
        }
    }
    const language = args.language || 'nl';

    try {
        const batch = await runAzureWhisperBatch({ filePath, audioData, fileName: audioFileName, language });

        const merged = mergeSegments(batch.segments);
        const speakerMap = {};
        for (const seg of merged) {
            if (!speakerMap[seg.speakerId]) speakerMap[seg.speakerId] = { duration: 0, segments: 0 };
            speakerMap[seg.speakerId].duration += (seg.end || 0) - (seg.start || 0);
            speakerMap[seg.speakerId].segments += 1;
        }
        const formattedLines = merged.map(s => `[${s.speakerId}] ${formatTime(s.start)} - ${formatTime(s.end)}: ${s.text}`);
        const nameMapping = await identifySpeakerNames(Object.keys(speakerMap), language, formattedLines, args.userName);
        return buildResult({ audioFileName, language, merged, totalDuration: batch.durationSeconds, speakerMap, nameMapping });
    } catch (err) {
        const safeMsg = (err.message || '').replace(/[A-Za-z0-9_\-]{32,}/g, '[REDACTED]').replace(/key[=:]\S+/gi, 'key=[REDACTED]');
        log.error('[Transcription:AzureWhisper] Error:', safeMsg);
        return { error: `Azure Whisper transcription failed: ${safeMsg}` };
    }
}


// ─── Provider: WhisperX (self-hosted) ────────────────────────────────────────

/**
 * Call a self-hosted WhisperX HTTP API.
 * Expected API contract (same as faster-whisper-server / whisperx-server):
 *
 *   POST {url}/transcribe
 *   Content-Type: multipart/form-data
 *   Body: { audio: <file>, language: "nl", diarize: true }
 *
 *   Response:
 *   { segments: [{ speaker: "SPEAKER_00", start: 0.5, end: 2.1, text: "Hello" }] }
 *
 * Also compatible with the OpenAI-compatible /v1/audio/transcriptions endpoint
 * when running locally (e.g. Faster Whisper Server).
 *
 * Security: URL is stored via configStore secret. No API key required for
 * internal/private deployments, but an optional bearer token is supported.
 */
async function handleWhisperXTranscription(args, context) {
    const whisperUrl = await configStore.getSecret('whisperx_url');
    if (!whisperUrl || !whisperUrl.trim()) {
        return {
            error:
                'WhisperX URL not configured. Add the self-hosted URL in ' +
                'Admin → Integrations → Meeting Transcription.',
        };
    }

    // Validate URL format — must be http(s):// to prevent SSRF to arbitrary schemes
    let parsedUrl;
    try {
        parsedUrl = new URL(whisperUrl.trim());
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            throw new Error('Invalid protocol');
        }
    } catch (_) {
        return { error: 'WhisperX URL must be a valid http:// or https:// address.' };
    }

    // Optional bearer token for secured deployments
    const whisperToken = await configStore.getSecret('whisperx_token');

    let audioData, audioFileName;
    try {
        ({ audioData, audioFileName } = await resolveAudioAttachment(context));
    } catch (errMsg) {
        return { error: errMsg };
    }

    const language = args.language || 'nl';

    log.info(
        `[Transcription:WhisperX] Transcribing "${audioFileName}" (${(audioData.length / (1024 * 1024)).toFixed(1)} MB), lang: ${language}, url: ${parsedUrl.hostname}`
    );

    try {
        // Build multipart form body
        const FormData = (await import('form-data')).default;
        const form = new FormData();
        form.append('audio', audioData, { filename: audioFileName, contentType: 'application/octet-stream' });
        form.append('language', language);
        form.append('diarize', 'true');
        // Also append OpenAI-compat field names for wider server support
        form.append('file', audioData, { filename: audioFileName, contentType: 'application/octet-stream' });
        form.append('model', 'whisper-1');

        const headers = { ...form.getHeaders() };
        if (whisperToken) {
            headers['Authorization'] = `Bearer ${whisperToken}`;
        }

        // Try /transcribe first; fall back to /v1/audio/transcriptions
        const baseUrl = parsedUrl.origin + parsedUrl.pathname.replace(/\/+$/, '');
        const primaryEndpoint = `${baseUrl}/transcribe`;
        const fallbackEndpoint = `${baseUrl}/v1/audio/transcriptions`;

        let resp = null;
        let data = null;

        // Abort signal: 5 minutes max
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5 * 60 * 1000);

        try {
            resp = await fetch(primaryEndpoint, {
                method: 'POST',
                headers,
                body: form,
                signal: controller.signal,
            });
            if (!resp.ok && resp.status === 404) {
                // Try OpenAI-compat endpoint
                resp = await fetch(fallbackEndpoint, {
                    method: 'POST',
                    headers,
                    body: form,
                    signal: controller.signal,
                });
            }
        } finally {
            clearTimeout(timeoutId);
        }

        if (!resp.ok) {
            const errBody = await resp.text().catch(() => '');
            const safeBody = errBody.replace(/[A-Za-z0-9_\-]{32,}/g, '[REDACTED]').substring(0, 200);
            return { error: `WhisperX server returned HTTP ${resp.status}: ${safeBody}` };
        }

        data = await resp.json();

        // Normalise response — support both { segments: [...] } and { text, segments: [...] }
        const rawSegments = (data.segments || []).map((seg) => ({
            speakerId: seg.speaker || seg.speakerId || 'Unknown',
            start: typeof seg.start === 'number' ? seg.start : parseFloat(seg.start) || 0,
            end: typeof seg.end === 'number' ? seg.end : parseFloat(seg.end) || 0,
            text: (seg.text || seg.transcript || '').trim(),
        })).filter(s => s.text);

        if (rawSegments.length === 0) {
            return {
                error:
                    'WhisperX returned no speech segments. Ensure the audio is clear and the server is running with diarization enabled.',
            };
        }

        log.info(`[Transcription:WhisperX] Completed — ${rawSegments.length} raw segments`);

        const merged = mergeSegments(rawSegments);
        const speakerMap = {};
        for (const seg of merged) {
            if (!speakerMap[seg.speakerId]) speakerMap[seg.speakerId] = { duration: 0, segments: 0 };
            speakerMap[seg.speakerId].duration += (seg.end || 0) - (seg.start || 0);
            speakerMap[seg.speakerId].segments += 1;
        }
        const totalDuration = rawSegments.length > 0 ? Math.max(...rawSegments.map(s => s.end || 0)) : 0;
        const formattedLines = merged.map(s =>
            `[${s.speakerId}] ${formatTime(s.start)} - ${formatTime(s.end)}: ${s.text}`
        );
        const nameMapping = await identifySpeakerNames(Object.keys(speakerMap), language, formattedLines, args.userName);

        return buildResult({ audioFileName, language, merged, totalDuration, speakerMap, nameMapping });

    } catch (err) {
        if (err.name === 'AbortError') {
            return { error: 'WhisperX transcription timed out (5 minutes). The file may be too large.' };
        }
        const safeMsg = (err.message || '').replace(/[A-Za-z0-9_\-]{32,}/g, '[REDACTED]');
        log.error('[Transcription:WhisperX] Error:', safeMsg);
        return { error: `WhisperX transcription failed: ${safeMsg}` };
    }
}

async function handleScalewayTranscription(args, context) {
    const apiKey = await configStore.getSecret('scaleway_api_key');
    if (!apiKey) {
        return { error: 'Scaleway API key not configured. Add it in Admin → Integrations → Transcription (Scaleway).' };
    }

    let audioData, audioFileName;
    try {
        ({ audioData, audioFileName } = await resolveAudioAttachment(context));
    } catch (errMsg) {
        return { error: errMsg };
    }

    const language = args.language || 'nl';
    // transcribeWithScaleway works from a file path (it may transcode); stage the buffer.
    const tmpPath = path.join(os.tmpdir(), `scaleway-tool-${Date.now()}-${audioFileName}`);
    try {
        fs.writeFileSync(tmpPath, audioData);
        const { transcribeWithScaleway } = require('../core/meetingNotes/summaryHelpers');
        const response = await transcribeWithScaleway(tmpPath, audioFileName, language, args.contextTerms || '');

        const rawSegments = (response.segments || []).map((seg) => ({
            speakerId: seg.speakerId || 'Unknown',
            start: typeof seg.start === 'number' ? seg.start : parseFloat(seg.start) || 0,
            end: typeof seg.end === 'number' ? seg.end : parseFloat(seg.end) || 0,
            text: (seg.text || '').trim(),
        })).filter(s => s.text);
        if (rawSegments.length === 0) return { error: 'Scaleway returned no speech segments.' };

        const merged = mergeSegments(rawSegments);
        const speakerMap = {};
        for (const seg of merged) {
            if (!speakerMap[seg.speakerId]) speakerMap[seg.speakerId] = { duration: 0, segments: 0 };
            speakerMap[seg.speakerId].duration += (seg.end || 0) - (seg.start || 0);
            speakerMap[seg.speakerId].segments += 1;
        }
        const totalDuration = Math.max(...rawSegments.map(s => s.end || 0));
        const formattedLines = merged.map(s => `[${s.speakerId}] ${formatTime(s.start)} - ${formatTime(s.end)}: ${s.text}`);
        const nameMapping = await identifySpeakerNames(Object.keys(speakerMap), language, formattedLines, args.userName);
        return buildResult({ audioFileName, language, merged, totalDuration, speakerMap, nameMapping });
    } catch (err) {
        const safeMsg = (err.message || '').replace(/[A-Za-z0-9_\-]{32,}/g, '[REDACTED]');
        log.error('[Transcription:Scaleway] Error:', safeMsg);
        return { error: `Scaleway transcription failed: ${safeMsg}` };
    } finally {
        try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
    }
}

/**
 * Local transcription for the tool path (NPU Whisper, CPU model as fallback).
 *
 * Until this existed, `transcribe_audio` — the tool chat, agents and automations
 * use — had no local option at all: every audio file an automation touched went
 * to a cloud provider, even on an install whose whole point is that data stays
 * put. The meeting-notes routes have had a `local` provider for a while; this
 * brings the fourth dispatcher in line with the other three.
 *
 * Single speaker by definition — neither local engine diarises — so this is the
 * right choice for voice notes, dictation and single-source recordings, and the
 * wrong one for a round-table meeting.
 */
async function handleLocalTranscription(args, context) {
    let audioData, audioFileName;
    try {
        ({ audioData, audioFileName } = await resolveAudioAttachment(context));
    } catch (errMsg) {
        return { error: errMsg };
    }

    const language = args.language || 'nl';
    // transcribeLocally works from a file path (it transcodes with ffmpeg);
    // stage the buffer exactly as the Scaleway handler does.
    const tmpPath = path.join(os.tmpdir(), `local-tool-${Date.now()}-${audioFileName}`);
    try {
        fs.writeFileSync(tmpPath, audioData);
        const { transcribeLocally } = require('../core/voice/localWhisper');
        const response = await transcribeLocally(tmpPath, { language });
        if (!response) {
            return { error: 'Local transcription is unavailable on this server. Configure a cloud transcription provider, or start the local speech service.' };
        }

        const rawSegments = (response.segments || []).map((seg) => ({
            speakerId: seg.speakerId || 'speaker_0',
            start: typeof seg.start === 'number' ? seg.start : parseFloat(seg.start) || 0,
            end: typeof seg.end === 'number' ? seg.end : parseFloat(seg.end) || 0,
            text: (seg.text || '').trim(),
        })).filter(s => s.text);
        if (rawSegments.length === 0) return { error: 'Local transcription returned no speech.' };

        const merged = mergeSegments(rawSegments);
        const speakerMap = {};
        for (const seg of merged) {
            if (!speakerMap[seg.speakerId]) speakerMap[seg.speakerId] = { duration: 0, segments: 0 };
            speakerMap[seg.speakerId].duration += (seg.end || 0) - (seg.start || 0);
            speakerMap[seg.speakerId].segments += 1;
        }
        const totalDuration = response.durationSec || Math.max(...rawSegments.map(s => s.end || 0));
        const speakers = Object.keys(speakerMap);
        // Asking an LLM who "speaker_0" is, when there is only ever one speaker,
        // spends a model call to learn nothing.
        const nameMapping = speakers.length > 1
            ? await identifySpeakerNames(speakers, language,
                merged.map(s => `[${s.speakerId}] ${formatTime(s.start)} - ${formatTime(s.end)}: ${s.text}`), args.userName)
            : {};
        return buildResult({ audioFileName, language, merged, totalDuration, speakerMap, nameMapping });
    } catch (err) {
        if (err?.code === 'local_whisper_too_long' || err?.code === 'npu_whisper_too_long') {
            return { error: `${err.message} Use a cloud transcription provider for recordings this long.` };
        }
        log.error('[Transcription:Local] Error:', err.message);
        return { error: `Local transcription failed: ${err.message}` };
    } finally {
        try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
    }
}

// ─── Tool Dispatch ─────────────────────────────────────────────────────────────

/** Providers an internal caller may force via `args.provider`. */
const KNOWN_PROVIDERS = ['voxtral', 'azure', 'whisper_azure', 'whisperx', 'scaleway', 'pyannote', 'local'];

async function executeTranscriptionTool(toolName, args, context = {}) {
    const { userId } = context;
    if (!userId) return { error: 'User context required for transcription.' };

    if (toolName === 'transcribe_audio') {
        // Honor an explicitly requested provider. The chat-tool schema does not
        // expose `provider`, so only trusted internal callers (upload/reprocess
        // routes) can set it — the admin default no longer silently overrides a
        // note's stored provider.
        const requested = String(args?.provider || '').trim().toLowerCase();
        const provider = KNOWN_PROVIDERS.includes(requested)
            ? requested
            : ((await configStore.getConfig('transcription_provider')) || 'voxtral');
        if (provider === 'azure') return handleAzureTranscription(args, context);
        if (provider === 'whisper_azure') return handleAzureWhisperTranscription(args, context);
        if (provider === 'whisperx') return handleWhisperXTranscription(args, context);
        if (provider === 'scaleway') return handleScalewayTranscription(args, context);
        if (provider === 'pyannote') return handlePyannoteTranscription(args, context);
        if (provider === 'local') return handleLocalTranscription(args, context);
        return handleVoxtralTranscription(args, context);
    }

    return { error: `Unknown transcription tool: ${toolName}` };
}

function isTranscriptionTool(toolName) {
    return ['transcribe_audio'].includes(toolName);
}

module.exports = {
    TRANSCRIPTION_TOOLS,
    executeTranscriptionTool,
    isTranscriptionTool,
    // Raw batch core, called directly by the upload/reprocess routes so
    // whisper_azure notes go through the shared post-processing.
    runAzureWhisperBatch,
    // exported for unit tests (DB-free)
    formatAzureBatchFailure,
    computeWhisperBatchTimeouts,
    azureDiarizationSpeakers,
};
