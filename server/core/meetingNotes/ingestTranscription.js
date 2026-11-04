// @typecheck
/**
 * The transcription step of the Meeting Notes ingest (./ingestRecordingCore.js):
 * which provider runs (request → admin config → voxtral), and the call to it.
 * A platform transcript (Teams VTT) skips the call; the pyannote provider also
 * answers which speakers its voiceprints recognised.
 */

'use strict';

const fs = require('fs');

const configStore = require('../../stores/configStore');
const { transcribeWithWhisperX, transcribeWithScaleway, toContextBias } = require('./summaryHelpers');
const { IngestError, safeUnlink } = require('./ingestShared');

/**
 * Provider selection: the request (when the workspace allows that engine),
 * then the admin config, then voxtral. A requested engine the admin did not
 * allow, or one this pipeline does not know, is refused with 403
 * `provider_not_allowed` — the same answer as the upload route — instead of
 * either reaching a third party the admin excluded or silently falling back.
 */
async function chooseProvider(requestedProvider, transcriptResponse) {
    const reqP = String(requestedProvider || '').trim().toLowerCase();
    // A platform transcript (Teams VTT) is not sent anywhere: no engine runs.
    if (transcriptResponse) return reqP || 'platform_transcript';
    const { resolveRequestedProvider } = require('./transcriptionProviderPolicy');
    const { provider, refusal } = await resolveRequestedProvider(reqP);
    if (refusal) {
        throw new IngestError('That transcription engine is not enabled for this workspace.', {
            code: 'provider_not_allowed', status: 403,
        });
    }
    return provider;
}

/** @typedef {{ filePath: string, fileName: string, language: string | null, contextTerms: string }} TranscribeWithVoxtralArgs */
/**
 * Voxtral, the fallback when no other engine is chosen.
 * @param {TranscribeWithVoxtralArgs} param0
 */
async function transcribeWithVoxtral({ filePath, fileName, language, contextTerms }) {
    const apiKey = await configStore.getSecret('mistral_api_key');
    if (!apiKey) {
        safeUnlink(filePath);
        throw new IngestError('Mistral API key not configured.', { code: 'missing_mistral_key', status: 400 });
    }
    const client = require('./voxtralClient').createVoxtralClient(apiKey);
    // Mistral does not list `.aac` among its formats: a raw ADTS recording (the
    // phone's crash-safe format, synced into Nextcloud) goes over as .m4a, the
    // same repack the upload and reprocess pipelines do.
    const { asM4aIfAdts } = require('../voice/audioPreprocess');
    const audio = await asM4aIfAdts(filePath, fileName);
    try {
        // A File backed by the file on disk: the SDK appends it to the multipart
        // form as-is, so the recording is read from disk while it is sent instead
        // of being copied into memory first (it buffers a stream or Buffer whole).
        const { contentTypeForAudio } = require('./savedAudioStore');
        const blob = await fs.openAsBlob(audio.path, { type: contentTypeForAudio(audio.fileName) });
        const file = new File([blob], audio.fileName, { type: blob.type });
        const contextBias = toContextBias(contextTerms);
        return await client.audio.transcriptions.complete({
            model: 'voxtral-mini-2602',
            file,
            diarize: true, language,
            timestampGranularities: ['segment'],
            ...(contextBias.length ? { contextBias } : {}),
        });
    } finally {
        audio.cleanup();
    }
}

/**
 * Transcribe with the chosen provider.
 * @returns {Promise<{ response: { text?: string, segments?: any[] }, truncated: ?{ atSeconds: number }, voiceprint: { mapping, roster, ruledOut, info } }>}
 *   `voiceprint` is filled by the pyannote provider only.
 */
async function transcribe(provider, { filePath, fileName, language, contextTerms, orgId, userId, participantNames, transcriptResponse }) {
    const voiceprint = { mapping: null, roster: [], ruledOut: null, info: null };
    if (transcriptResponse) {
        return { response: { text: transcriptResponse.text || '', segments: transcriptResponse.segments || [] }, voiceprint, truncated: null };
    }
    if (provider === 'local') {
        const { transcribeLocally } = require('../voice/localWhisper');
        const local = await transcribeLocally(filePath, { language });
        if (!local) {
            safeUnlink(filePath);
            throw new IngestError('Local transcription unavailable. Pick a cloud provider.', { code: 'local_whisper_unavailable', status: 503 });
        }
        return { response: { text: local.text, segments: local.segments }, voiceprint, truncated: null };
    }
    if (provider === 'whisperx') return { response: await transcribeWithWhisperX(filePath, fileName, language, contextTerms || ''), voiceprint, truncated: null };
    if (provider === 'scaleway') return { response: await transcribeWithScaleway(filePath, fileName, language, contextTerms || ''), voiceprint, truncated: null };
    if (provider === 'azure') {
        // Azure AI Speech, same call as the upload route; a partial transcript
        // carries `truncated`, which becomes a notice on the summary.
        const { transcribeWithAzureSpeech } = require('../voice/azureSpeech');
        const az = await transcribeWithAzureSpeech(filePath, { language, contextTerms: contextTerms || '' });
        return { response: { text: az.text, segments: az.segments }, voiceprint, truncated: az.truncated || null };
    }
    if (provider === 'whisper_azure') {
        // Azure Whisper Batch: raw segments, the shared post-processing does the rest.
        const { runAzureWhisperBatch } = require('../voice/azureWhisperBatch');
        const w = await runAzureWhisperBatch({ filePath, fileName, language });
        return { response: { text: w.text, segments: w.segments }, voiceprint, truncated: null };
    }
    if (provider === 'pyannote') {
        // Self-staging via pyannote's own media store — works for auto-import
        // paths too (no public URL needed, unlike whisper_azure).
        // Talk/Meet supply the attendee roster automatically, which is also
        // the best possible prioritiser when an org has more enrolled
        // members than one identify job can carry.
        const { transcribeWithPyannote } = require('../voice/pyannoteClient');
        const p = await transcribeWithPyannote(filePath, {
            language, orgId, recorderUserId: userId, attendees: participantNames,
        });
        return {
            response: p,
            truncated: null,
            voiceprint: { mapping: p.voiceprintMapping, roster: p.voiceprintRoster || [], ruledOut: p.voiceprintRuledOut, info: p.voiceprintInfo },
        };
    }
    return { response: await transcribeWithVoxtral({ filePath, fileName, language, contextTerms }), voiceprint, truncated: null };
}

module.exports = { chooseProvider, transcribe };

/** @typedef {Awaited<ReturnType<typeof import('../voice/pyannoteClient').transcribeWithPyannote>>} PyannoteResult */

/**
 * @typedef {{ mapping: PyannoteResult['voiceprintMapping'] | null, roster: string[],
 *   ruledOut: PyannoteResult['voiceprintRuledOut'] | null, info: PyannoteResult['voiceprintInfo'] | null }} Voiceprint
 */

/**
 * @typedef {{ filePath: string, fileName: string, language: string, contextTerms?: string, orgId?: string | null,
 *   userId?: string, participantNames?: string[], transcriptResponse?: { text?: string, segments?: any[] } | null }} TranscribeArgs
 */
