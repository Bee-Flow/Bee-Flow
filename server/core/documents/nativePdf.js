// @typecheck strict
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
 * Page caps for the document block. Anthropic rejects a PDF of more than 100
 * pages on a model with a 200K window, and more than 600 pages otherwise; the
 * extracted text still travels, so a longer file is read from that alone.
 */
const NATIVE_PDF_MAX_PAGES_SMALL_WINDOW = 100;
const NATIVE_PDF_MAX_PAGES = 600;
const SMALL_WINDOW_TOKENS = 200_000;

/**
 * @param {number | undefined} contextWindow the model's window in tokens, when known
 * @returns {number}
 */
function maxNativePdfPages(contextWindow) {
    // Unknown window: assume the small one, the cap that is never too generous.
    return contextWindow && contextWindow > SMALL_WINDOW_TOKENS ? NATIVE_PDF_MAX_PAGES : NATIVE_PDF_MAX_PAGES_SMALL_WINDOW;
}

/** @param {string} modelId */
function contextWindowOf(modelId) {
    try {
        return require('../llm/contextPolicy').contextWindowFor(modelId);
    } catch {
        return undefined;
    }
}

/**
 * Is the Privacy Shield scanning attachments for this turn? Same switch as
 * attachmentScanner's own gate (`orgShield.enabled` is the only master flag).
 * @param {{ enabled?: boolean } | null | undefined} shield
 */
function isShieldActive(shield) {
    return !!shield?.enabled;
}

/**
 * @param {{ providerType?: string, supportsDocuments?: boolean, shieldActive?: boolean, tokenised?: boolean,
 *   bytes?: number, pages?: number, contextWindow?: number }} p `pages`: page count when extraction knew it;
 *   `contextWindow`: the model's window in tokens; `providerType`: The stored provider type of the turn's model;
 *   `supportsDocuments`: adapter.supportsDocuments(modelId); `shieldActive`: Privacy Shield active for
 *   this turn (any mode); `tokenised`: The extracted text was tokenised/redacted; `bytes`: Decoded PDF
 *   size in bytes
 * @returns {{ send: boolean, reason: string | null }}
 */
function nativePdfDecision({ providerType, supportsDocuments, shieldActive, tokenised, bytes, pages, contextWindow }) {
    if (shieldActive) return { send: false, reason: 'privacy_shield_active' };
    if (tokenised) return { send: false, reason: 'text_redacted' };
    if (!NATIVE_PDF_PROVIDER_TYPES.has(String(providerType || '').toLowerCase())) return { send: false, reason: 'provider_type' };
    if (!supportsDocuments) return { send: false, reason: 'model_without_file_input' };
    if (!Number.isFinite(bytes) || !bytes || bytes <= 0) return { send: false, reason: 'empty' };
    if (bytes > NATIVE_PDF_MAX_BYTES) return { send: false, reason: 'too_large' };
    if (Number.isFinite(pages) && /** @type {number} */ (pages) > maxNativePdfPages(contextWindow)) return { send: false, reason: 'too_many_pages' };
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
 * @param {{ adapter: { supportsDocuments?: (modelId: string) => boolean } | null | undefined, modelId: string,
 *   providerType?: string, shieldActive?: boolean, tokenised?: boolean, base64Data: string,
 *   mediaType?: string, filename?: string, pages?: number, tag?: string }} p `pages`: page count from extraction; `tag`: Log prefix, e.g. 'DirectChat'
 */
function nativePdfPart({ adapter, modelId, providerType, shieldActive, tokenised, base64Data, mediaType, filename, pages, tag = 'NativePdf' }) {
    const supportsDocuments = typeof adapter?.supportsDocuments === 'function' && !!adapter.supportsDocuments(modelId);
    const bytes = typeof base64Data === 'string' ? Buffer.byteLength(base64Data, 'base64') : 0;
    const { send, reason } = nativePdfDecision({ providerType, supportsDocuments, shieldActive, tokenised, bytes, pages, contextWindow: pages ? contextWindowOf(modelId) : undefined });
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
    NATIVE_PDF_MAX_PAGES,
    NATIVE_PDF_MAX_PAGES_SMALL_WINDOW,
    isShieldActive,
    nativePdfDecision,
    acceptsNativePdf,
    nativePdfPart,
};
