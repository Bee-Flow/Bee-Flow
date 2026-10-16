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
const { runAzureWhisperBatch, formatAzureBatchFailure, computeWhisperBatchTimeouts, azureDiarizationSpeakers } = require('../core/voice/azureWhisperBatch');
const {
    formatTime, maxSegmentEnd, finalizeTranscript,
} = require('./transcription/finalize');

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
        return await finalizeTranscript({
            segments: rawSegments,
            audioFileName,
            language,
            totalDuration: maxSegmentEnd(rawSegments),
            identifyNames: (ids, lines) => identifySpeakerNames(ids, language, lines, args.userName),
        });
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

        const result = await finalizeTranscript({
            segments: az.segments,
            audioFileName,
            language,
            totalDuration: maxSegmentEnd(az.segments),
            identifyNames: (ids, lines) => identifySpeakerNames(ids, language, lines, args.userName),
        });
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

        return await finalizeTranscript({
            segments: p.segments,
            audioFileName,
            language,
            totalDuration: p.durationSeconds,
            // This module's local identifySpeakerNames is the older 4-arg variant
            // (no org, no roster) — deliberately left alone. Voiceprint pins are
            // merged over its answer instead, so a voice match always wins.
            identifyNames: async (ids, lines) => {
                const llmMapping = await identifySpeakerNames(ids, language, lines, args.userName);
                return p.voiceprintMapping
                    ? { ...(llmMapping || {}), ...p.voiceprintMapping }
                    : llmMapping;
            },
        });
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

        return await finalizeTranscript({
            segments: batch.segments,
            audioFileName,
            language,
            totalDuration: batch.durationSeconds,
            identifyNames: (ids, lines) => identifySpeakerNames(ids, language, lines, args.userName),
        });
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

        return await finalizeTranscript({
            segments: rawSegments,
            audioFileName,
            language,
            totalDuration: maxSegmentEnd(rawSegments),
            identifyNames: (ids, lines) => identifySpeakerNames(ids, language, lines, args.userName),
        });

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

        return await finalizeTranscript({
            segments: rawSegments,
            audioFileName,
            language,
            totalDuration: maxSegmentEnd(rawSegments),
            identifyNames: (ids, lines) => identifySpeakerNames(ids, language, lines, args.userName),
        });
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

        return await finalizeTranscript({
            segments: rawSegments,
            audioFileName,
            language,
            totalDuration: response.durationSec || maxSegmentEnd(rawSegments),
            // Asking an LLM who "speaker_0" is, when there is only ever one speaker,
            // spends a model call to learn nothing.
            identifyNames: (ids, lines) => (ids.length > 1
                ? identifySpeakerNames(ids, language, lines, args.userName)
                : {}),
        });
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
