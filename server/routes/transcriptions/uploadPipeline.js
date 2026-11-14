// @typecheck strict
/**
 * Transcriptions: the background pipeline of POST / (upload).
 *
 * Runs after the 202: transcribe (with the on-device to cloud fallback),
 * name speakers, summarise, extract artifacts, then write the finished note.
 * Extracted from upload.js. Each phase takes what it reads and returns what it
 * produced; the route owns the response and the failure handling.
 */

const fs = require('fs');
const log = require('../../telemetry/log');
const configStore = require('../../stores/configStore');
const transcriptionStore = require('../../stores/transcriptionStore');
const { asM4aIfAdts } = require('../../core/voice/audioPreprocess');
const { resolveDefaultTemplateForReq, VOXTRAL_TIMEOUT_MS } = require('./shared');
const { nameSpeakers, buildTranscriptOrThrow } = require('../../usecases/transcriptions/speakerNaming');
const { stampForTemplate } = require('../../core/meetingNotes/summaryStamp');
const { fallback, ignoreGone } = require('../../utils/bestEffort');
const { HttpError } = require('../../core/http/errors');

/**
 * Tell the stuck-note reaper this run is alive (transcriptionStore.heartbeatProcessing):
 * it measures silence, not meeting length. Best-effort; false when it could not.
 * @param {string} transcriptionId
 * @returns {Promise<boolean>}
 */
function beatProcessing(transcriptionId) {
    return transcriptionStore.heartbeatProcessing(transcriptionId)
        .catch((e) => fallback('routes/transcriptions/uploadPipeline:heartbeat', e, false));
}
// Meeting-notes pipeline helpers (model tiers, diarization naming, summary /
// title / action-item generation) live in a shared module so the background
// Nextcloud Talk auto-ingest can reuse the exact same logic.
const {
    generateMeetingSummary,
    generateMeetingTitle,
    extractMeetingArtifacts,
    generateChapters,
    generateSpeakerSummaries,
    applySpeakerSummaries,
    toContextBias,
    buildPipelineNotices,
    artifactsUsable,
    transcribeWithWhisperX,
    transcribeWithScaleway,
} = require('../../core/meetingNotes/summaryHelpers');

/** @typedef {{ from: string, to: string, reason: string, message: string }} ProviderFallback */
/** @typedef {Extract<Awaited<ReturnType<typeof extractMeetingArtifacts>>, { ok: true }>} UsableArtifacts artifacts that passed artifactsUsable */
/** @typedef {{ matched: number, considered: number, truncated: boolean, failed: boolean, detail: Array<{ speakerId: string, label: string, userId: string|null, name: string, seconds: number, share: number, confidence: number|null, decision: string }> }} VoiceprintInfo */

/**
 * In-process Whisper-base on CPU (privacy / no-cloud path). When the recording
 * exceeds the on-device cap, fall back to a configured cloud engine so the
 * upload doesn't dead-end: Voxtral is preferred (no extra setup once a Mistral
 * key is present), WhisperX is the self-hosted alternative, then Azure.
 * @returns {Promise<{ response: { text: string, segments: Array<{ speakerId: string, start: number, end: number, text: string }> }|null, provider: string, providerFallback: ProviderFallback|null }>}
 *   `response` is null when the caller must continue with the returned cloud `provider`.
 * @param {{ filePath: string, language: string }} input
 */
async function transcribeOnDevice({ filePath, language }) {
    const { transcribeLocally } = require('../../core/voice/localWhisper');
    try {
        const local = await transcribeLocally(filePath, { language });
        if (!local) {
            // Post-202: fail the note (the catch handles it), never res.* again.
            throw new HttpError(503, 'local_model_unavailable', 'Local transcription model is not available. Try again, or pick a cloud provider.');
        }
        return { response: { text: local.text, segments: local.segments }, provider: 'local', providerFallback: null };
    } catch (err) {
        if (err.code !== 'local_whisper_too_long') throw err;
        const mistralKey = await configStore.getSecret('mistral_api_key');
        // whisperx_url is stored encrypted (setSecret) — getConfig
        // would hand back the raw ciphertext, which is truthy and
        // so "worked" here by accident.
        const whisperxUrl = process.env.WHISPERX_URL || await configStore.getSecret('whisperx_url');
        const azureKey = await configStore.getSecret('azure_speech_key');
        const azureRegion = await configStore.getConfig('azure_speech_region');
        /** @type {string[]} */
        const configured = [];
        if (mistralKey) configured.push('voxtral');
        if (whisperxUrl) configured.push('whisperx');
        if (azureKey && azureRegion) configured.push('azure');

        if (!configured.length) {
            throw new HttpError(503, 'no_cloud_engine', /** @type {Error} */ (err).message + '. No cloud provider is configured — ask an admin to enable Voxtral, WhisperX or Azure, or split the recording.');
        }
        // The fallback decides which third party the WHOLE recording goes to,
        // so it answers to the same allow-list as an engine the user picks.
        // Taking whichever key exists would send long meetings to Mistral as
        // soon as a Mistral key is set up for chat, even for an admin who
        // narrowed transcription to 'local'.
        const { resolveAllowedProviders } = require('./uploadIntake');
        const allowed = await resolveAllowedProviders(true);
        const cloud = configured.find((p) => p !== 'local' && allowed.includes(p)) || null;
        if (!cloud) {
            throw new HttpError(503, 'no_cloud_engine', /** @type {Error} */ (err).message + '. No cloud engine is enabled for this workspace — split the recording, or ask an admin.');
        }
        log.info(`[Transcriptions] Local cap exceeded — falling back to ${cloud}`);
        return {
            response: null,
            provider: cloud,
            providerFallback: { from: 'local', to: cloud, reason: 'too_long', message: /** @type {Error} */ (err).message },
        };
    }
}

/**
 * Voxtral (cloud, default). The only engine that needs the bytes in memory.
 * @param {{ filePath: string, fileName: string, language: string, contextTerms?: string }} input
 */
async function transcribeWithVoxtral({ filePath, fileName, language, contextTerms }) {
    const apiKey = await configStore.getSecret('mistral_api_key');
    if (!apiKey) {
        try { fs.unlinkSync(filePath); } catch (_) { ignoreGone('routes/transcriptions/uploadPipeline:unlinkUpload', _); }
        throw new HttpError(503, 'engine_not_configured', 'Mistral API key not configured. Go to Admin → AI Config → API Keys.');
    }

    const { createVoxtralClient } = require('../../core/meetingNotes/voxtralClient');
    const client = createVoxtralClient(apiKey, { timeoutMs: VOXTRAL_TIMEOUT_MS });

    // The phone's crash-safe .aac goes over as .m4a (audioPreprocess.asM4aIfAdts).
    // nosemgrep: ajinabraham.njsscan.traversal.path_traversal.generic_path_traversal -- filePath is the random name multer wrote under uploadsDir, and the repack is a fresh os.tmpdir() file: no client-supplied path is read
    const voxtralAudio = await asM4aIfAdts(filePath, fileName);
    /** @type {NonSharedBuffer} */
    let fileContent;
    try {
        fileContent = await fs.promises.readFile(voxtralAudio.path);
    } finally {
        voxtralAudio.cleanup();
    }
    /** @type {Parameters<typeof client.audio.transcriptions.complete>[0]} */
    const transcriptionOptions = {
        model: 'voxtral-mini-2602',
        file: { fileName: voxtralAudio.fileName, content: fileContent },
        diarize: true,
        language,
        timestampGranularities: /** @type {Array<'segment'>} */ (['segment']),
    };
    const contextBias = toContextBias(contextTerms);
    if (contextBias.length) transcriptionOptions.contextBias = contextBias;

    return client.audio.transcriptions.complete(transcriptionOptions);
}

/**
 * The cloud and self-hosted engines. @returns the response plus engine extras.
 *
 * @param {string} provider
 * @param {{ filePath: string, fileName: string, language: string, contextTerms?: string, numSpeakers?: number|null, userOrgId?: string|null, userId?: string, attendees?: string[] }} input
 */
async function transcribeWithEngine(provider, { filePath, fileName, language, contextTerms, numSpeakers, userOrgId, userId, attendees }) {
    /** @type {{ truncationNotice: {reason: string, atSeconds: number}|null, voiceprintMapping: Record<string, string>|null, voiceprintRoster: string[], voiceprintRuledOut: Record<string, string[]>|null, voiceprintInfo: VoiceprintInfo|null }} */
    const extras = { truncationNotice: null, voiceprintMapping: null, voiceprintRoster: [], voiceprintRuledOut: null, voiceprintInfo: null };
    let response;
    if (provider === 'whisperx') {
        // WhisperX (self-hosted)
        response = await transcribeWithWhisperX(filePath, fileName, language, contextTerms);
    } else if (provider === 'scaleway') {
        // Scaleway Whisper large-v3 (cloud) + local diarization
        response = await transcribeWithScaleway(filePath, fileName, language, contextTerms);
    } else if (provider === 'azure') {
        // Azure AI Speech (shared ConversationTranscriber core). Duration-aware
        // timeouts + partial-transcript salvage live in core/voice/azureSpeech.js,
        // shared with the chat tool and reprocess.
        const { transcribeWithAzureSpeech } = require('../../core/voice/azureSpeech');
        const az = await transcribeWithAzureSpeech(filePath, { language, contextTerms });
        extras.truncationNotice = az.truncated;
        response = { text: az.text, segments: az.segments };
    } else if (provider === 'whisper_azure') {
        // Azure Whisper Batch (REST API v3.2). Raw segments only: the shared
        // post-processing owns naming, summary, action items and chapters,
        // exactly like every other provider.
        const { runAzureWhisperBatch } = require('../../integrations/transcriptionTools');
        const w = await runAzureWhisperBatch({ filePath, fileName, language, numSpeakers });
        response = { text: w.text, segments: w.segments };
    } else if (provider === 'pyannote') {
        // pyannoteAI (all-in-one diarization + transcription). Self-staging via
        // pyannote's own media store. Also the only provider that can identify
        // speakers by voiceprint; the client submits that second job only when
        // this org has enrolled members, so orgs that never enroll pay nothing extra.
        const { transcribeWithPyannote } = require('../../core/voice/pyannoteClient');
        const p = await transcribeWithPyannote(filePath, {
            language, numSpeakers,
            orgId: userOrgId, recorderUserId: userId, attendees,
        });
        response = { text: p.text, segments: p.segments };
        extras.voiceprintMapping = p.voiceprintMapping;
        extras.voiceprintRoster = p.voiceprintRoster || [];
        extras.voiceprintRuledOut = p.voiceprintRuledOut;
        extras.voiceprintInfo = /** @type {VoiceprintInfo|null} */ (p.voiceprintInfo);
    } else {
        response = await transcribeWithVoxtral({ filePath, fileName, language, contextTerms });
    }
    return { response, ...extras };
}

/**
 * Transcribe the uploaded audio with the chosen engine.
 * `providerFallback` tracks an automatic engine switch (local to cloud). The 202
 * is long gone by then, so it is surfaced as a notice line on the note's summary.
 *
 * @param {{ provider: string } & { filePath: string, fileName: string, language: string, contextTerms?: string, numSpeakers?: number|null, userOrgId?: string|null, userId?: string, attendees?: string[] }} args
 */
async function transcribeUpload({ provider, ...input }) {
    /** @type {ProviderFallback|null} */
    let providerFallback = null;
    if (provider === 'local') {
        const local = await transcribeOnDevice({ filePath: input.filePath, language: input.language });
        provider = local.provider;
        providerFallback = local.providerFallback;
        if (local.response) {
            return {
                response: local.response, provider, providerFallback, truncationNotice: /** @type {{reason: string, atSeconds: number}|null} */ (null),
                voiceprintMapping: /** @type {Record<string, string>|null} */ (null), voiceprintRoster: /** @type {string[]} */ ([]), voiceprintRuledOut: /** @type {Record<string, string[]>|null} */ (null), voiceprintInfo: /** @type {VoiceprintInfo|null} */ (null),
            };
        }
    }
    const engine = await transcribeWithEngine(provider, input);
    return { provider, providerFallback, ...engine };
}

/**
 * Naming, summary, title, chapters and artifacts for a fresh transcription.
 * @param {{ req: import('express').Request, transcriptionId: string, userId: string, userOrgId: string | null, userName: string | null, language: string, attendees: string[], numSpeakers: number | null, title: string, transcribed: Awaited<ReturnType<typeof transcribeUpload>> }} input
 * @returns everything `finishUpload` needs.
 */
async function analyseUpload({ req, transcriptionId, userId, userOrgId, userName, language, attendees, numSpeakers, title, transcribed }) {
    const { response, providerFallback, truncationNotice, voiceprintMapping, voiceprintRoster, voiceprintRuledOut, voiceprintInfo } = transcribed;

    let { merged, transcript, speakers, totalDuration } = buildTranscriptOrThrow(response);

    // A heartbeat between the LLM passes (beatProcessing).
    const beat = () => beatProcessing(transcriptionId);

    const named = await nameSpeakers({
        merged, speakers, language, userName, userId, userOrgId,
        roster: [...attendees, ...voiceprintRoster], voiceprintMapping, voiceprintRuledOut, numSpeakers,
    });
    ({ merged, transcript, speakers } = named);
    await beat();

    // The user told us how many people were in the room. Ending up with
    // fewer means two of them were given the same name and collapsed —
    // which is how a two-person meeting once came out as one speaker.
    // Reported, not auto-corrected: silently rewriting a name assignment is
    // worse than saying the count looks wrong.
    if (numSpeakers && speakers.length < numSpeakers) {
        log.warn(
            `[Transcriptions] ${transcriptionId}: ${speakers.length} speaker(s) after naming but ${numSpeakers} expected`
            + ` — names may have over-merged: ${JSON.stringify(named.filledMapping)}`
        );
    }

    // Generate the meeting summary. The whole template ROW, not just the
    // prompt: the note is stamped with it (which template, which version).
    // Without a default template the stamp stays empty: the built-in
    // first-generation prompt is none of the five built-in templates, so
    // there is nothing true to report.
    const defaultTemplate = await resolveDefaultTemplateForReq(req, userId, userOrgId);
    const summary = await generateMeetingSummary(transcript, language, userOrgId, { templatePrompt: defaultTemplate?.prompt || null, userId });
    await beat();

    // Always generate AI title from summary
    if (summary) {
        const aiTitle = await generateMeetingTitle(summary, language, userOrgId, { userId });
        if (aiTitle) title = aiTitle;
        await beat();
    }

    // Extract the structured artifacts (action items + due dates, decisions,
    // open questions, topic tags — one LLM pass) + topic chapters.
    const artifacts = await extractMeetingArtifacts(transcript, language, userOrgId, {
        meetingDateIso: new Date().toISOString().slice(0, 10),
        personNames: [...speakers.map((s) => s.id), ...(attendees || [])],
        userId,
    });
    await beat();
    const chapters = await generateChapters(transcript, language, userOrgId, { userId });
    await beat();
    // Per-speaker prose for the Insights panel, stored on the speaker rows.
    const speakerSummaries = await generateSpeakerSummaries(transcript, speakers.map((s) => s.id), language, userOrgId, { userId });

    // A FAILED ARTIFACT PASS IS NOT AN EMPTY MEETING. Writing
    // `artifacts.actionItems/decisions/questions` raw would turn a pass that fell
    // over or could not be parsed into a COMPLETED note claiming nothing was
    // agreed, although the pass never ran. The note is also visible and
    // editable while processing, so a decision someone recorded in the meantime
    // would be silently overwritten. Not writing is the right answer here:
    // `undefined` means "leave this column alone" to updateTranscription.
    const usable = artifactsUsable(artifacts);
    if (!usable) {
        log.warn(`[Transcriptions] Async note ${transcriptionId}: artifact extraction failed — leaving the artifact columns untouched.`);
    }

    // Engine fallback / truncation / a failed artifact pass all happen after
    // the 202, so the note's summary is the only place left to tell the user.
    const notices = buildPipelineNotices({ providerFallback, truncated: truncationNotice, voiceprint: voiceprintInfo, artifactsFailed: !usable, language });
    const finalSummary = notices.length ? `${notices.join('\n')}\n\n${summary || ''}`.trim() : summary;

    return { merged, transcript, speakers, totalDuration, title, artifacts, usable, chapters, speakerSummaries, finalSummary, defaultTemplate };
}

/**
 * The starting point of an upload run for the artifact window
 * (stores/transcription/artifactWindow.js): before any row could have been
 * written, because the note had none when the run began. In the window's own
 * format, so it compares as text against the rows' DB-clock stamps.
 */
const UPLOAD_RUN_START = '1970-01-01T00:00:00.000000Z';

/**
 * The patch that completes the 'processing' note.
 * @param {{ transcribed: Awaited<ReturnType<typeof transcribeUpload>>, analysis: Awaited<ReturnType<typeof analyseUpload>>, title: string, placeholderTitle: string, provider: string }} input
 */
function buildCompletionPatch({ transcribed, analysis, title, placeholderTitle, provider }) {
    const { response, voiceprintInfo } = transcribed;
    const { merged, transcript, speakers, totalDuration, artifacts, usable, chapters, speakerSummaries, finalSummary, defaultTemplate } = analysis;
    return {
        // The note was created empty at the start of this run, so every row in
        // its artifact columns now was written DURING the run (an action item
        // ticked or added through PATCH /:id while it was processing). The
        // window keeps those; without it the AI lists replaced them.
        ...(usable ? { artifactsSince: UPLOAD_RUN_START } : {}),
        status: 'completed',
        ...(title === placeholderTitle
            ? {}
            : { titleIfUnchanged: { title, expected: placeholderTitle } }),
        durationSeconds: Math.round(totalDuration),
        fullText: response.text || '',
        transcript,
        segments: merged,
        speakers: applySpeakerSummaries(speakers, speakerSummaries),
        summary: finalSummary,
        ...(usable ? {
            actionItems: /** @type {UsableArtifacts} */ (artifacts).actionItems,
            decisions: /** @type {UsableArtifacts} */ (artifacts).decisions,
            questions: /** @type {UsableArtifacts} */ (artifacts).questions,
            // Auto-topic tags fill the column only while it's still empty — a
            // user who tagged the note while it was processing keeps their tags.
            ...(/** @type {UsableArtifacts} */ (artifacts).tags.length ? { tagsIfEmpty: /** @type {UsableArtifacts} */ (artifacts).tags } : {}),
        } : {}),
        chapters,
        provider,
        voiceprintMatches: voiceprintInfo?.detail || [],
        // Which template and which version of it wrote this summary. Without a
        // default template both are null: there was no template, and nothing is
        // the right answer here.
        ...stampForTemplate(defaultTemplate),
    };
}

/**
 * Write the finished note, then announce it.
 * @param {{ transcriptionId: string, userId: string, userOrgId: string | null, transcribed: Awaited<ReturnType<typeof transcribeUpload>>, analysis: Awaited<ReturnType<typeof analyseUpload>>, provider: string, placeholderTitle: string }} input
 */
async function finishUpload({ transcriptionId, userId, userOrgId, transcribed, analysis, provider, placeholderTitle }) {
    const { merged, speakers, artifacts, usable } = analysis;
    // Fill in the 'processing' note with the finished result.
    const written = await transcriptionStore.updateTranscription(transcriptionId, userId, buildCompletionPatch({
        transcribed, analysis, title: analysis.title, placeholderTitle, provider,
    }));
    if (!written) {
        // The note was deleted while it was processing (DELETE /:id does not
        // wait for the run). Nothing to complete and nothing to announce: an
        // event for an id that does not resolve only starts automation runs
        // that fail.
        log.info(`[Transcriptions] Async note ${transcriptionId} is gone (deleted while processing) — result discarded`);
        return;
    }
    log.info(`[Transcriptions] Async note ${transcriptionId} completed — ${merged.length} segments, ${speakers.length} speakers, provider ${provider}`);
    // The tags the note ACTUALLY carries: tagsIfEmpty keeps tags someone set
    // while it was processing, and subscribers filter on these. The store
    // returns the column when it can; otherwise the AI tags it was filled with.
    const returned = /** @type {{ tags?: unknown }} */ (/** @type {unknown} */ (written));
    const storedTags = typeof returned === 'object' && Array.isArray(returned.tags)
        ? /** @type {string[]} */ (returned.tags)
        : (usable ? /** @type {UsableArtifacts} */ (artifacts).tags : []);

    // A browser recording or an uploaded file is a finished note like any
    // ingest, so `meeting.processed` subscribers (knowledge sources keyed on
    // a tag, automations) hear about it too. The one emission point lives in
    // ingestRecordingCore and never throws.
    try {
        require('../../core/meetingNotes/ingestRecordingCore').emitMeetingProcessed({
            transcriptionId,
            tags: storedTags,
            userId,
            orgId: userOrgId,
        });
    } catch (e) {
        log.warn('[Transcriptions] meeting.processed unavailable:', /** @type {Error} */ (e).message);
    }
}

module.exports = { transcribeUpload, analyseUpload, finishUpload, beatProcessing };
