// @typecheck
/**
 * Transport to the self-hosted WhisperX service (transcription + diarization).
 *
 * Split out of `summaryHelpers.js`, which re-exports `transcribeWithWhisperX`.
 */

const fs = require('fs');
const log = require('../../telemetry/log');

/**
 * Transcribe with the self-hosted WhisperX service. Returns a
 * Voxtral-compatible `{ text, segments:[{text,start,end,speakerId}] }` shape.
 * @param {fs.PathLike} filePath
 * @param {string} fileName
 * @param {string | Blob} language
 * @param {string | Blob} contextTerms
 */
async function transcribeWithWhisperX(filePath, fileName, language, contextTerms) {
    // Deployment wiring (compose/k8s) wins; otherwise honour the URL an admin
    // set in Admin → Integrations → Transcription, which is stored encrypted
    // and must therefore be read with getSecret, not getConfig.
    //
    // There is deliberately NO hosted default here. This used to fall back to
    // a hardcoded https://services.beeflow.nl/whisperx, which meant a
    // self-hoster who configured WhisperX in the admin UI but left
    // WHISPERX_URL empty had their meeting audio uploaded to our servers —
    // contradicting the "no data leaves your server" promise of this provider.
    // (It 404'd there anyway: that host's ingress only serves /api/search.)
    const configStore = require('../../stores/configStore');
    const whisperxUrl = process.env.WHISPERX_URL || await configStore.getSecret('whisperx_url');
    if (!whisperxUrl) {
        throw new Error(
            'WhisperX URL not configured. Set WHISPERX_URL, or add your self-hosted '
            + 'WhisperX URL under Admin → Integrations → Transcription.'
        );
    }

    const form = new FormData();
    form.append('file', await fs.openAsBlob(filePath), fileName);
    form.append('language', language);
    form.append('diarize', 'true');
    if (contextTerms) form.append('context_terms', contextTerms);

    log.info(`[Transcriptions] Sending to WhisperX at ${whisperxUrl}/transcribe ...`);

    const apiKey = process.env.SERVICES_API_KEY;
    const resp = await fetch(`${whisperxUrl}/transcribe`, {
        method: 'POST',
        body: form,
        headers: apiKey ? { 'X-API-Key': apiKey } : {},
        signal: AbortSignal.timeout(600000), // 10 minutes for long files
    });

    if (!resp.ok) {
        const errText = await resp.text().catch(() => resp.statusText);
        throw new Error(`WhisperX service error (${resp.status}): ${errText}`);
    }

    const data = /** @type {{ segments?: Array<Record<string, any>>, text?: string, device?: string, processingTime?: number, [key: string]: any }} WhisperX /transcribe */ (await resp.json());
    log.info(`[Transcriptions] WhisperX: ${data.segments?.length || 0} segments, ${data.device}, processed in ${data.processingTime}s`);

    return {
        text: data.text || '',
        segments: (data.segments || []).map(seg => ({
            text: seg.text,
            start: seg.start,
            end: seg.end,
            speakerId: seg.speakerId || 'speaker_0',
        })),
    };
}

module.exports = { transcribeWithWhisperX };
