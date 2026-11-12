// @typecheck strict
/**
 * kb_get_original: hand the person the ORIGINAL file of a knowledge-base document.
 *
 * `kb_search` finds passages; when the person wants "the contract itself" the agent calls this with the
 * `documentId` of a search result. The bytes come from the encrypted copy a base keeps when it opted in
 * (core/kb/originals.mts). The tool makes NO copy: the `file` card the chat shows under the reply
 * (core/agentRuntime/toolRound/sideChannels.js) links to `GET /api/kb/:id/documents/:docId/original`,
 * which checks the person's access to the base on every download.
 *
 * ── THE ASKER'S RIGHTS, NOT THE AGENT'S ─────────────────────────────
 * The document's base must be one of the agent's bases THAT THE PERSON MAY READ (`agentVisibleKbIds`, the
 * same narrowing as `kb_search`, including a "Test as" simulation). A document of any other base answers
 * exactly like a document that does not exist.
 */

const log = require('../telemetry/log');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @type {Record<string, any>} */
const KB_GET_ORIGINAL_TOOL = {
    type: 'function',
    function: {
        name: 'kb_get_original',
        description: `Give the user the ORIGINAL FILE of a knowledge-base document (the PDF, Word or Excel file itself, not its text).

WHEN TO USE:
- The user asks for the file, the original, "the document itself" or a download of something you found with kb_search.
- Pass the documentId from a kb_search result. Do not guess ids.

NOT EVERY DOCUMENT HAS ONE: only knowledge bases set to keep original files do. If there is none, say so and offer the text instead.
The file appears as a download card under your reply; you do not need to paste a link.`,
        parameters: {
            type: 'object',
            properties: {
                documentId: { type: 'string', description: 'The documentId of a kb_search result.' },
            },
            required: ['documentId'],
        },
    },
};

/**
 * The knowledge bases the agent has AND the asker may read. Any failure narrows to none, never widens.
 * @param {{ userId?: string, agentId?: string, testAs?: unknown }} context
 * @param {{ agentStore?: { getForRuntime: (id: string | undefined) => Promise<any> }, visibleKbIdsFor?: Function }} [deps]
 * @returns {Promise<string[]>}
 */
async function agentVisibleKbIds(context, deps = {}) {
    const { userId, agentId } = context;
    try {
        const agentStore = deps.agentStore || require('../stores/agentStore');
        const agent = await agentStore.getForRuntime(/** @type {string} */ (agentId));
        const kbIds = agent?.config?.knowledge_base_ids || [];
        /**
         * The bases are the AGENT's; the right to read them is the PERSON's.
         *
         * This tool is called mid-conversation on behalf of whoever is
         * talking, and `searchLocally` does no tenant filtering of its
         * own — its access boundary is this list. Without the filter, asking
         * an org-wide agent to "search the knowledge base" reached every base
         * anybody had attached to it.
         *
         * `visibleKbIdsFor` is that K5 filter, plus the "Test as · group X"
         * narrowing (A1c) when the turn is a preview. Both doors have to
         * honour it: filtering the auto-injected knowledge and leaving the
         * tool open would let the model fetch back exactly what the preview
         * just hid.
         */
        const visibleKbIdsFor = deps.visibleKbIdsFor || require('../core/agentRuntime/testAs').visibleKbIdsFor;
        return await visibleKbIdsFor(kbIds, {
            userId, testAs: context.testAs || null, context: 'kb_search', agentId,
        });
    } catch (e) {
        log.warn('[KBSearch] Could not load agent config:', /** @type {Error} */ (e).message);
        // A failure here must not leave a wider list than the one it was
        // meant to narrow.
        return [];
    }
}

/** The card kind: Office kinds the chat already renders, pdf, else a plain file. @param {string} mime @param {string} name */
function cardKind(mime, name) {
    const m = String(mime || '').toLowerCase();
    const ext = (/\.([A-Za-z0-9]{1,8})$/.exec(name) || [])[1]?.toLowerCase() || '';
    if (m.includes('wordprocessingml') || ext === 'docx') return 'word';
    if (m.includes('spreadsheetml') || ext === 'xlsx') return 'spreadsheet';
    if (m.includes('presentationml') || ext === 'pptx') return 'presentation';
    if (m === 'application/pdf' || ext === 'pdf') return 'pdf';
    return 'file';
}

/**
 * A stored original that may be handed out now. The same rule as the download route (core/kb/originals.mts
 * originalWithheldReason): no file while the base does not keep originals, or while redaction is in force
 * for the document. Any failure withholds.
 * @param {Record<string, any>} doc
 * @param {{ getKB: (id: string) => Promise<Record<string, any> | null> }} kbStore
 * @param {Record<string, any>} deps  test seam: originalWithheldReason
 * @returns {Promise<boolean>}
 */
async function originalServable(doc, kbStore, deps) {
    if (!doc.has_original) return false;
    try {
        const kb = await kbStore.getKB(String(doc.knowledge_base_id));
        if (!kb || String(kb.tenant_id) !== String(doc.tenant_id)) return false;
        const withheld = deps.originalWithheldReason || require('../core/kb/originals.mts').originalWithheldReason;
        return !(await withheld(kb, doc));
    } catch (e) {
        log.warn('[KBOriginal] Could not check the original:', /** @type {Error} */ (e).message);
        return false;
    }
}

/**
 * @param {{ documentId?: unknown }} args
 * @param {{ userId?: string, agentId?: string, testAs?: unknown }} context
 * @param {Record<string, any>} [deps]  test seams: kbStore, agentStore, visibleKbIdsFor
 */
async function executeKbGetOriginal(args, context, deps = {}) {
    const documentId = typeof args?.documentId === 'string' ? args.documentId.trim() : '';
    if (!UUID_RE.test(documentId)) return { error: 'documentId must be the documentId of a kb_search result.' };
    if (!context.userId) return { error: 'No user context for kb_get_original.' };

    const notFound = { error: 'Document not found in the knowledge bases you can read.' };
    const kbStore = deps.kbStore || require('../stores/knowledgeBases');
    const doc = await kbStore.getDocument(documentId);
    if (!doc) return notFound;
    const visible = await agentVisibleKbIds(context, deps);
    if (!visible.includes(String(doc.knowledge_base_id))) return notFound;
    if (!(await originalServable(doc, kbStore, deps))) {
        return { error: 'This document has no stored original (its knowledge base does not keep the uploaded files). Offer the text from kb_search instead.' };
    }

    const filename = String(doc.metadata?.originalFilename || doc.title || 'document');
    const mimeType = String(doc.original_mime || 'application/octet-stream');
    const size = doc.original_size == null ? null : Number(doc.original_size);
    // A link to the knowledge-base route, not a copy: the file stays the one
    // encrypted original, and every click checks the person's access to the
    // base again (a revoked share stops working at once).
    const url = `/api/kb/${encodeURIComponent(String(doc.knowledge_base_id))}/documents/${encodeURIComponent(String(doc.id))}/original`;
    return {
        success: true,
        downloadUrl: url,
        filename,
        size,
        // The card the chat shows under the reply, whatever the model writes.
        file: { kind: cardKind(mimeType, filename), name: filename, url, mimeType, size, source: 'kb_get_original' },
        message: `The original file "${filename}" is attached as a download card. Tell the user it is there.`,
    };
}

module.exports = { KB_GET_ORIGINAL_TOOL, executeKbGetOriginal, agentVisibleKbIds, cardKind };
