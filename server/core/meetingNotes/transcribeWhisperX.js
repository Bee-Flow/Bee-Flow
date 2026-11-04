// @typecheck strict
/**
 * Transport to the self-hosted WhisperX service (transcription + diarization).
 *
 * Split out of `summaryHelpers.js`, which re-exports `transcribeWithWhisperX`.
 */

const fs = require('fs');
const { fetch: undiciFetch, Agent, FormData: UndiciFormData } = require('undici');
const log = require('../../telemetry/log');

// /transcribe runs ASR AND diarization on the whole recording in one request;
// on a CPU WhisperX a long meeting takes far longer than 10 minutes (the
// /diarize call alone gets 30). Configurable, 0 = no limit.
const DEFAULT_WHISPERX_TIMEOUT_MS = 30 * 60_000;

/** @returns {number} ms; 0 means unlimited */
function whisperxTimeoutMs() {
    const raw = process.env.WHISPERX_TIMEOUT_MS;
    if (raw === undefined || raw === '') return DEFAULT_WHISPERX_TIMEOUT_MS;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_WHISPERX_TIMEOUT_MS;
}

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
    // There is deliberately NO hosted default here. Falling back to
    // a hardcoded https://services.beeflow.nl/whisperx would mean a
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

    const form = new UndiciFormData();
    form.append('file', await fs.openAsBlob(filePath), fileName);
    form.append('language', language);
    form.append('diarize', 'true');
    if (contextTerms) form.append('context_terms', contextTerms);

    log.info(`[Transcriptions] Sending to WhisperX at ${whisperxUrl}/transcribe ...`);

    const apiKey = process.env.SERVICES_API_KEY;
    const timeoutMs = whisperxTimeoutMs();
    // The service answers only when it is done, so the HTTP client's own
    // header/body timeouts (5 minutes by default) must follow the same budget,
    // or they cut the request off long before the deadline above.
    const dispatcher = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
    /** @type {{ segments?: Array<Record<string, any>>, text?: string, device?: string, processingTime?: number, [key: string]: any }} WhisperX /transcribe */
    let data;
    try {
        const resp = await undiciFetch(`${whisperxUrl}/transcribe`, {
            method: 'POST',
            body: form,
            headers: apiKey ? { 'X-API-Key': apiKey } : {},
            dispatcher,
            ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
        });

        if (!resp.ok) {
            const errText = await resp.text().catch(() => resp.statusText);
            throw new Error(`WhisperX service error (${resp.status}): ${errText}`);
        }
        data = /** @type {typeof data} */ (await resp.json());
    } finally {
        dispatcher.close().catch((err) => log.debug('whisperx dispatcher close', err));
    }
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

module.exports = { transcribeWithWhisperX, whisperxTimeoutMs };
