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

const NAMED_PROVIDERS = ['voxtral', 'whisperx', 'scaleway', 'azure', 'whisper_azure', 'pyannote'];

/** Provider selection: the request, then the admin config, then voxtral. */
async function chooseProvider(requestedProvider, transcriptResponse) {
    const localEnabled = (await configStore.getConfig('local_whisper_enabled')) !== false;
    let provider = await configStore.getConfig('transcription_provider') || 'voxtral';
    const reqP = String(requestedProvider || '').trim().toLowerCase();
    if (transcriptResponse) provider = reqP || 'platform_transcript';
    else if (reqP === 'local' && localEnabled) provider = 'local';
    else if (NAMED_PROVIDERS.includes(reqP)) provider = reqP;
    return provider;
}

/** Voxtral, the fallback when no other engine is chosen. */
async function transcribeWithVoxtral({ filePath, fileName, language, contextTerms }) {
    const apiKey = await configStore.getSecret('mistral_api_key');
    if (!apiKey) {
        safeUnlink(filePath);
        throw new IngestError('Mistral API key not configured.', { code: 'missing_mistral_key', status: 400 });
    }
    const client = require('./voxtralClient').createVoxtralClient(apiKey);
    const fileContent = fs.readFileSync(filePath);
    const contextBias = toContextBias(contextTerms);
    return client.audio.transcriptions.complete({
        model: 'voxtral-mini-2602',
        file: { fileName, content: fileContent },
        diarize: true, language,
        timestampGranularities: ['segment'],
        ...(contextBias.length ? { contextBias } : {}),
    });
}

/**
 * Transcribe with the chosen provider.
 * @returns {Promise<{ response: { text, segments }, truncated: ?{ atSeconds: number }, voiceprint: { mapping, roster, ruledOut, info } }>}
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
