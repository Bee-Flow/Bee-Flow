// @typecheck
/**
 * Transcriptions: the pipeline phases of a reprocess run.
 *
 * Extracted from reprocess.js so the route handler stays short. Two phases:
 *   - `transcribeStoredAudio`: run the saved audio through the note's provider;
 *   - `analyseTranscript`: speaker naming, summary, chapters and artifacts,
 *     merged with what the note already holds.
 * Both only read their arguments and return what they computed; the claim, the
 * conditional write and the failure handling stay in reprocess.js.
 */

const log = require('../../telemetry/log');
const { fallback } = require('../../utils/bestEffort');
const fs = require('fs');
const configStore = require('../../stores/configStore');
const { asM4aIfAdts } = require('../../core/voice/audioPreprocess');
const { resolveDefaultTemplateForReq, VOXTRAL_TIMEOUT_MS } = require('./shared');
const { lookupUserName, nameSpeakers, buildTranscriptOrThrow } = require('./speakerNaming');
const { stampForTemplate } = require('../../core/meetingNotes/summaryStamp');
const { leadingNotices, withNotices, summaryFailedNotice } = require('./noteText.mts');
const {
    generateMeetingSummary,
    extractMeetingArtifacts,
    generateChapters,
    generateSpeakerSummaries,
    buildPipelineNotices,
    artifactsUsable,
    transcribeWithWhisperX,
    transcribeWithScaleway,
} = require('../../core/meetingNotes/summaryHelpers');
const { mergeRegeneratedActionItems, mergeRegeneratedNotes } = require('../../core/meetingNotes/actionItems');

/** @typedef {{ audioPath: string, fileName: string, language: string | null }} TranscribeWithVoxtralArgs */
/**
 * Mistral Voxtral: a stored .aac from the phone goes over as .m4a.
 * @param {TranscribeWithVoxtralArgs} param0
 */
async function transcribeWithVoxtral({ audioPath, fileName, language }) {
    const apiKey = await configStore.getSecret('mistral_api_key');
    if (!apiKey) throw new Error('Mistral API key not configured');

    const { createVoxtralClient } = require('../../core/meetingNotes/voxtralClient');
    const client = createVoxtralClient(apiKey, { timeoutMs: VOXTRAL_TIMEOUT_MS });

    const voxtralAudio = await asM4aIfAdts(audioPath, fileName);
    /** @type {NonSharedBuffer} */
    let fileContent;
    try {
        fileContent = await fs.promises.readFile(voxtralAudio.path);
    } finally {
        voxtralAudio.cleanup();
    }

    return client.audio.transcriptions.complete({
        model: 'voxtral-mini-2602',
        file: { fileName: voxtralAudio.fileName, content: fileContent },
        diarize: true,
        language,
        timestampGranularities: ['segment'],
    });
}

/**
 * Transcribe the saved audio with the given provider.
 * @returns {Promise<{ response: any, truncationNotice: any, voiceprintMapping: any,
 *   voiceprintRoster: string[], voiceprintRuledOut: any, voiceprintInfo: any }>}
 */
async function transcribeStoredAudio({ provider, audioPath, fileName, language, numSpeakers, transcription, userId }) {
    let response;
    /** @type {{ reason: 'inactivity' | 'overall_timeout'; atSeconds: number; } | null} */
    let truncationNotice = null;
    /** @type {{ [x: string]: string; } | null} */
    let voiceprintMapping = null;
    /** @type {string[]} */
    let voiceprintRoster = [];
    /** @type {{ [x: string]: string[]; } | null} */
    let voiceprintRuledOut = null;
    let voiceprintInfo = null;

    if (provider === 'local') {
        // The note was transcribed on-device by choice; never silently move
        // it to a cloud provider on reprocess.
        const { transcribeLocally } = require('../../core/voice/localWhisper');
        const local = await transcribeLocally(audioPath, { language });
        if (!local) {
            throw new Error('Local transcription model is not available. Try again, or pick a cloud provider.');
        }
        response = { text: local.text, segments: local.segments };
    } else if (provider === 'whisperx') {
        response = await transcribeWithWhisperX(audioPath, fileName, language, '');
    } else if (provider === 'scaleway') {
        response = await transcribeWithScaleway(audioPath, fileName, language, '');
    } else if (provider === 'azure') {
        const { transcribeWithAzureSpeech } = require('../../core/voice/azureSpeech');
        const az = await transcribeWithAzureSpeech(audioPath, { language });
        truncationNotice = az.truncated;
        response = { text: az.text, segments: az.segments };
    } else if (provider === 'whisper_azure') {
        const { runAzureWhisperBatch } = require('../../integrations/transcriptionTools');
        response = await runAzureWhisperBatch({ filePath: audioPath, fileName, language, numSpeakers });
    } else if (provider === 'pyannote') {
        const { transcribeWithPyannote } = require('../../core/voice/pyannoteClient');
        // Org comes from the NOTE, not from the caller: resolveUserOrgFromReq
        // picks an arbitrary element of a multi-org user's set, and choosing
        // which organisation's biometric templates leave the building must
        // never be non-deterministic.
        const p = await transcribeWithPyannote(audioPath, {
            language, numSpeakers,
            orgId: transcription.organizationId || null,
            recorderUserId: transcription.ownerId || userId,
            attendees: transcription.attendees || [],
        });
        response = p;
        voiceprintMapping = p.voiceprintMapping;
        voiceprintRoster = p.voiceprintRoster || [];
        voiceprintRuledOut = p.voiceprintRuledOut;
        voiceprintInfo = p.voiceprintInfo;
    } else {
        response = await transcribeWithVoxtral({ audioPath, fileName, language });
    }
    return { response, truncationNotice, voiceprintMapping, voiceprintRoster, voiceprintRuledOut, voiceprintInfo };
}

/** Names the owner typed in the speaker editor. */
function manualSpeakerNames(transcription) {
    return (transcription.speakers || [])
        .filter((s) => s && s.source === 'manual' && typeof s.id === 'string' && s.id.trim())
        .map((s) => s.id.trim());
}

/**
 * The lists a reprocess writes back. The artifact pass is re-run, but a failed
 * pass keeps what the note had, and a person's own entries always survive.
 */
function mergeArtifactLists(transcription, artifacts, usable) {
    // Re-extraction replaces the AI's action items, and only those: an action a
    // person typed has no timestamp to invalidate. Survivors keep their text and
    // destination and give up their anchors into the replaced transcript.
    const mergedActionItems = mergeRegeneratedActionItems(
        transcription.actionItems, artifacts.actionItems,
        { transcriptChanged: true, keepAiItems: !usable },
    );
    // Same rule for decisions and questions: a decision a person picked off a
    // transcript line is theirs, and re-transcribing is no reason to delete it.
    const mergedDecisions = mergeRegeneratedNotes(
        transcription.decisions, artifacts.decisions,
        { field: 'decisions', transcriptChanged: true, keepAiNotes: !usable },
    );
    const mergedQuestions = mergeRegeneratedNotes(
        transcription.questions, artifacts.questions,
        { field: 'questions', transcriptChanged: true, keepAiNotes: !usable },
    );
    return { mergedActionItems, mergedDecisions, mergedQuestions };
}

/**
 * The summary a reprocess writes, and its template stamp.
 *
 * generateMeetingSummary answers '' when its call failed (a 429, a time-out):
 * that is a failed step, not an empty meeting. Writing it through replaced a
 * completed note's summary with nothing, under status 'completed' and without
 * a word. The previous summary (its own notices stripped: they describe the
 * replaced run) then stays, and the caller adds a notice that says so.
 *
 * The summary is rewritten otherwise, so the template stamp is set again, also
 * when the answer is "no template": a stale stamp would put a template name on
 * text that template never produced. A summary kept from before keeps the
 * stamp of the template that DID write it.
 * @param {string} generated
 * @param {{ transcript?: string, summary?: string, summaryTemplateId?: string | null, summaryTemplateVersion?: number | null }} transcription
 * @param {Parameters<typeof stampForTemplate>[0]} defaultTemplate
 */
function summaryOrPrevious(generated, transcription, defaultTemplate) {
    if (String(generated || '').trim()) {
        return { summary: generated, summaryStamp: stampForTemplate(defaultTemplate), summaryFailed: false, keptPrevious: false };
    }
    const previous = transcription.transcript ? leadingNotices(transcription.summary).body : '';
    if (!previous) {
        return { summary: '', summaryStamp: stampForTemplate(defaultTemplate), summaryFailed: true, keptPrevious: false };
    }
    return {
        summary: previous,
        summaryStamp: { summaryTemplateId: transcription.summaryTemplateId || null, summaryTemplateVersion: transcription.summaryTemplateVersion || null },
        summaryFailed: true,
        keptPrevious: true,
    };
}

/**
 * Report that this run is still alive (transcriptionStore.heartbeatProcessing)
 * and stop it when its claim is gone: reaped as stuck, or the note deleted
 * meanwhile. Throws `claim_lost`; the route's catch then writes nothing,
 * because finishProcessing only lands while the claim is held. A database
 * hiccup on the heartbeat itself does not stop the run.
 * @param {string | null | undefined} transcriptionId
 */
async function keepClaim(transcriptionId) {
    if (!transcriptionId) return;
    const held = await require('../../stores/transcriptionStore').heartbeatProcessing(transcriptionId)
        .catch((e) => fallback('routes/transcriptions/reprocessPipeline:heartbeat', e, true));
    if (!held) {
        throw Object.assign(new Error(`Reprocess of ${transcriptionId}: the claim was lost (reaped or deleted)`), { code: 'claim_lost' });
    }
}

/**
 * Speaker naming, summary, chapters and artifacts for a fresh transcription.
 * @returns the transcript pieces plus everything the conditional write needs.
 */
async function analyseTranscript({ req, transcriptionId, transcription, userId, userOrgId, language, numSpeakers, transcribed }) {
    const { response, truncationNotice, voiceprintMapping, voiceprintRoster, voiceprintRuledOut, voiceprintInfo } = transcribed;

    let { merged, transcript, speakers, totalDuration } = buildTranscriptOrThrow(response);

    // Speaker identification: pass the stats rows so the model can tell real
    // participants from short diarization fragments.
    const reprocessUserName = await lookupUserName(userId);
    // Reuse the roster captured at upload: reprocessing without it would throw
    // away the strongest naming signal we have. The roster is the attendee
    // list (plus voiceprint names): a closed list. Names the OWNER typed go
    // separately as `knownNames`: candidates the model weighs, not attendees,
    // so a typo or a partial name never closes the list to the real attendees.
    const reprocessRoster = [...new Set([
        ...(transcription.attendees || []),
        ...voiceprintRoster,
    ])];
    ({ merged, transcript, speakers } = await nameSpeakers({
        merged, speakers, language, userName: reprocessUserName, userOrgId,
        roster: reprocessRoster, voiceprintMapping, voiceprintRuledOut, numSpeakers,
        knownNames: manualSpeakerNames(transcription),
    }));

    // Summary + timeline chapters + structured artifacts. The artifacts are
    // re-extracted too: the transcript is brand new, so the old items point at
    // timestamps that no longer exist.
    // A heartbeat between the LLM passes: the reaper measures silence, not
    // meeting length, and a run whose claim is gone stops spending here.
    await keepClaim(transcriptionId);
    const defaultTemplate = await resolveDefaultTemplateForReq(req, userId, userOrgId);
    const generated = await generateMeetingSummary(transcript, language, userOrgId, { templatePrompt: defaultTemplate?.prompt || null, userId });
    const { summary, summaryStamp, summaryFailed, keptPrevious } = summaryOrPrevious(generated, transcription, defaultTemplate);
    await keepClaim(transcriptionId);
    const chapters = await generateChapters(transcript, language, userOrgId, { userId });
    await keepClaim(transcriptionId);
    const artifacts = await extractMeetingArtifacts(transcript, language, userOrgId, {
        meetingDateIso: (transcription.createdAt || '').slice(0, 10) || null,
        personNames: [...speakers.map((s) => s.id), ...(transcription.attendees || [])],
        userId,
    });
    await keepClaim(transcriptionId);
    const speakerSummaries = await generateSpeakerSummaries(transcript, speakers.map((s) => s.id), language, userOrgId, { userId });

    // A failed extraction is not an empty meeting. extractMeetingArtifacts has
    // three outcomes (nothing agreed, an unparseable answer, a call that fell
    // over); writing the last two through would wipe the action items,
    // decisions and questions of a note that was already 'completed', with no
    // undo. `artifactsUsable` asks the VALUE, not a loose flag. On a failed
    // pass everything stays, minus the anchors into the replaced transcript.
    const usable = artifactsUsable(artifacts);
    if (!usable) {
        log.warn(`[Transcriptions] Reprocess ${transcriptionId}: artifact extraction failed — keeping the existing action items, decisions and questions.`);
    }
    const { mergedActionItems, mergedDecisions, mergedQuestions } = mergeArtifactLists(transcription, artifacts, usable);
    // Saving is half of it; saying so is the other half. Without this line a
    // failed pass is indistinguishable from a meeting where nothing was agreed.
    const notices = buildPipelineNotices({ truncated: truncationNotice, voiceprint: voiceprintInfo, artifactsFailed: !usable, language });
    if (summaryFailed) notices.push(summaryFailedNotice(language, keptPrevious));
    const finalSummary = withNotices(notices, summary || '');

    return {
        merged, transcript, speakers, totalDuration, chapters, artifacts, usable,
        speakerSummaries, summaryStamp, finalSummary,
        mergedActionItems, mergedDecisions, mergedQuestions,
    };
}

module.exports = { transcribeStoredAudio, analyseTranscript, keepClaim };

/** @typedef {NonNullable<Awaited<ReturnType<typeof import('../../stores/transcriptionStore').getTranscription>>>} TranscriptionNote */
