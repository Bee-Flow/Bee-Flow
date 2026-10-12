// @typecheck
/**
 * Native PDF alongside extracted text: the ONE place that decides whether a
 * chat turn may ship the original PDF bytes to the model as a `document`
 * content part (next to the extracted text, never instead of it).
 *
 * The part is Claude-shaped (`{ type:'document', source:{ type:'base64', … } }`);
 * the OpenAI and Azure adapters translate it into a Responses `input_file`
 * (core/providers/openaiContent.js). It lives in the current turn's messages
 * only: the persisted user message carries the attachment sidecar (storage URL
 * + extracted text), and history hydration rebuilds text/image blocks from
 * that, never a document part, so the bytes are not replayed on later turns.
 *
 * Privacy rule: a raw PDF carries what the text scan never saw (embedded
 * scans and images, annotations, form fields, hidden layers, metadata such as
 * the author). So whenever the Privacy Shield is active for the turn, in ANY
 * mode and even when the scan found nothing, only the extracted text travels.
 */

const log = require('../../telemetry/log');

/**
 * Provider TYPES whose API reads a native PDF. Decided on the stored provider
 * type, not on an adapter guessed from a URL: an OpenAI-compatible proxy that
 * happens to resolve to the OpenAI adapter does not necessarily accept files.
 */
const NATIVE_PDF_PROVIDER_TYPES = new Set(['claude', 'anthropic', 'openai', 'azure']);

/**
 * Decoded size cap per PDF. Azure rejects a request whose files exceed 50 MB
 * combined (and base64 inflates by a third on the wire); Anthropic's request
 * limit is 32 MB. 20 MB decoded keeps a single document under both.
 */
const NATIVE_PDF_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Is the Privacy Shield scanning attachments for this turn? Same switch as
 * attachmentScanner's own gate (`orgShield.enabled` is the only master flag).
 * @param {{ enabled?: boolean } | null | undefined} shield
 */
function isShieldActive(shield) {
    return !!shield?.enabled;
}

/**
 * @param {object} p
 * @param {string} [p.providerType]       The stored provider type of the turn's model.
 * @param {boolean} [p.supportsDocuments] adapter.supportsDocuments(modelId).
 * @param {boolean} [p.shieldActive]      Privacy Shield active for this turn (any mode).
 * @param {boolean} [p.tokenised]         The extracted text was tokenised/redacted.
 * @param {number} [p.bytes]              Decoded PDF size in bytes.
 * @returns {{ send: boolean, reason: string | null }}
 */
function nativePdfDecision({ providerType, supportsDocuments, shieldActive, tokenised, bytes }) {
    if (shieldActive) return { send: false, reason: 'privacy_shield_active' };
    if (tokenised) return { send: false, reason: 'text_redacted' };
    if (!NATIVE_PDF_PROVIDER_TYPES.has(String(providerType || '').toLowerCase())) return { send: false, reason: 'provider_type' };
    if (!supportsDocuments) return { send: false, reason: 'model_without_file_input' };
    if (!Number.isFinite(bytes) || !bytes || bytes <= 0) return { send: false, reason: 'empty' };
    if (bytes > NATIVE_PDF_MAX_BYTES) return { send: false, reason: 'too_large' };
    return { send: true, reason: null };
}

/** @param {Parameters<typeof nativePdfDecision>[0]} p */
function acceptsNativePdf(p) {
    return nativePdfDecision(p).send;
}

/**
 * The document part for this PDF, or null when it must not be sent (the reason
 * is logged, without the filename). `base64Data` is the bare base64 payload,
 * no data-URL prefix.
 *
 * @param {object} p
 * @param {{ supportsDocuments?: (modelId: string) => boolean } | null | undefined} p.adapter
 * @param {string} p.modelId
 * @param {string} [p.providerType]
 * @param {boolean} [p.shieldActive]
 * @param {boolean} [p.tokenised]
 * @param {string} p.base64Data
 * @param {string} [p.mediaType]
 * @param {string} [p.filename]
 * @param {string} [p.tag]  Log prefix, e.g. 'DirectChat'.
 */
function nativePdfPart({ adapter, modelId, providerType, shieldActive, tokenised, base64Data, mediaType, filename, tag = 'NativePdf' }) {
    const supportsDocuments = typeof adapter?.supportsDocuments === 'function' && !!adapter.supportsDocuments(modelId);
    const bytes = typeof base64Data === 'string' ? Buffer.byteLength(base64Data, 'base64') : 0;
    const { send, reason } = nativePdfDecision({ providerType, supportsDocuments, shieldActive, tokenised, bytes });
    if (!send) {
        // Provider type alone is the everyday case (Mistral, Google, local, …): not worth a line.
        if (reason !== 'provider_type' && reason !== 'empty') {
            log.info(`[${tag}] Native PDF not attached (reason=${reason}, provider=${providerType || 'n/a'}, model=${modelId || 'n/a'}, bytes=${bytes}); extracted text only`);
        }
        return null;
    }
    return {
        type: 'document',
        title: filename || 'document.pdf',
        source: { type: 'base64', media_type: mediaType && mediaType.includes('pdf') ? mediaType : 'application/pdf', data: base64Data },
    };
}

module.exports = {
    NATIVE_PDF_PROVIDER_TYPES,
    NATIVE_PDF_MAX_BYTES,
    isShieldActive,
    nativePdfDecision,
    acceptsNativePdf,
    nativePdfPart,
};
