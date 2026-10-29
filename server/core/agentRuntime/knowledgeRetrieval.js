// @typecheck
/**
 * The retrieval half of the agent knowledge search (./knowledgeSearch): the
 * search query, the call to the local store or the search service, the
 * document-level metadata and the metadata-aware score boost.
 *
 * The KB provider resolver and the local search are handed in as `kb`
 * ({ resolveProvider(), localKBIngest() }, lazy) by ./knowledgeSearch: they
 * sit in the server's large import cycle, which this module stays out of.
 */
const { getServiceHeaders } = require('../serviceAuth');
const log = require('../../telemetry/log');

/**
 * Query preprocessing: extract the search intent from the user message
 * (English and Dutch lead-ins stripped). Falls back to the message itself
 * when what is left is too short to search on.
 */
function searchQueryFrom(userMessage) {
    const searchQuery = userMessage
        .replace(/^(hey|hi|hello|hoi|hallo|beste)\s*[,!.]?\s*/i, '')
        .replace(/^(can you|could you|would you|please|kun je|kunt u|wil je|zou je)\s*/i, '')
        .replace(/^(tell me about|explain|describe|what is|what are|how do|how does|wat is|wat zijn|hoe werkt|hoe kan)\s*/i, '')
        .replace(/^(i want to know about|i need info on|ik wil weten over|ik zoek informatie over)\s*/i, '')
        .replace(/^(wat kan je|wat kun je|wat kunt u|what can you)\s+(vinden|vertellen|zeggen|weten|me vertellen)\s+(over|about|van|op)?\s*/i, '')
        .replace(/^(wat|welke|hoeveel)\s+(kan|kun|kunt|zijn|is|staat|staan)\s+(er|je|jij|u|ik|we|wij)\s+/i, '')
        .replace(/\?+$/g, '')
        .replace(/^(voor ons event|voor mij|voor ons|for us|for me|for our)\s*/i, '')
        .trim();
    return searchQuery.length < 5 ? userMessage : searchQuery;
}

/** One retrieved chunk in the shape the ranking and the prompt read. */
function toKnowledgeResult(c, score) {
    // Prefer title over opaque internal URIs (n8n://, etc.)
    const srcUri = c.source_uri || '';
    const isInternalUri = srcUri.startsWith('n8n://') || srcUri.startsWith('internal://');
    const displaySource = (isInternalUri && c.title) ? c.title : (srcUri || c.title || 'KB');
    return {
        content: c.content,
        metadata: { source: displaySource, type: 'kb_chunk', source_uri: srcUri, document_id: c.document_id },
        score,
    };
}

/**
 * Search the knowledge bases. Uses the local KB path (in-process pgvector +
 * RRF + reranker) or the remote search-service; local is the default for
 * fresh installs that have no SEARCH_SERVICE_URL. A failed search is logged
 * and yields no results.
 */
async function fetchKnowledgeResults({ userId, kbIds, userMessage }, kb) {
    const results = [];
    try {
        const { resolveKbProvider } = kb.resolveProvider();
        const kbProvider = await resolveKbProvider();
        const useAzure = kbProvider === 'local';
        const searchQuery = searchQueryFrom(userMessage);

        if (useAzure) {
            // ── Local search path (Azure) ──────────────────────────
            // Search locally-ingested chunks directly from PostgreSQL
            const { searchLocally } = kb.localKBIngest();
            const chunks = await searchLocally(userId, kbIds, searchQuery, { topK: 5 });
            results.push(...chunks.map(c => toKnowledgeResult(c, c.score || 0)));
        } else {
            // ── Search-service path ─────────────────────────────────
            const searchUrl = process.env.SEARCH_SERVICE_URL || 'https://services.beeflow.nl';

            const searchRes = await fetch(`${searchUrl}/tools/kb-search`, {
                method: 'POST',
                headers: getServiceHeaders(),
                body: JSON.stringify({
                    tenant_id: userId,
                    kb_ids: kbIds,
                    query: searchQuery,
                    top_k: 8,
                    rerank: true,
                    use_azure: false,
                }),
                signal: AbortSignal.timeout(15000),
            });

            if (searchRes.ok) {
                const searchData = /** @type {any} */ (await searchRes.json());
                const chunks = searchData.chunks || searchData.results || [];
                results.push(...chunks.map(c => toKnowledgeResult(c, c.score || c.rerank_score || 0)));
            }
        }
    } catch (searchErr) {
        log.warn('[KnowledgeSearch] KB search failed:', /** @type {Error} */ (searchErr).message);
    }
    return results;
}

/**
 * Batch-load document-level metadata for every chunk that has a source_uri.
 * Mutates the result objects in-place, adding `docMeta`, `threadId`, `from`,
 * `subject`, `date`, `hasAttachments` for email-sourced chunks.
 */
async function enrichResultsWithDocMetadata(results, kbIds) {
    if (!Array.isArray(kbIds) || kbIds.length === 0) return;
    const uris = Array.from(new Set(results
        .map(r => r.metadata?.source_uri)
        .filter(Boolean)));
    if (uris.length === 0) return;
    try {
        const { getAll } = require('../../db');
        const rows = await getAll(
            `SELECT source_uri, metadata, source_type FROM documents
             WHERE knowledge_base_id = ANY($1::uuid[]) AND source_uri = ANY($2::text[])`,
            [kbIds, uris]
        );
        const byUri = new Map();
        for (const row of rows) byUri.set(row.source_uri, row);
        for (const r of results) {
            const uri = r.metadata?.source_uri;
            const row = uri && byUri.get(uri);
            if (!row) continue;
            r.docMeta = row.metadata || {};
            r.sourceType = row.source_type;
            if (row.metadata?.threadId) r.metadata.threadId = row.metadata.threadId;
            if (row.metadata?.from) r.metadata.from = row.metadata.from;
            if (row.metadata?.subject) r.metadata.subject = row.metadata.subject;
            if (row.metadata?.date) r.metadata.date = row.metadata.date;
            if (row.metadata?.hasAttachments) r.metadata.hasAttachments = true;
        }
    } catch (err) {
        log.warn('[KnowledgeSearch] Metadata enrichment failed:', /** @type {Error} */ (err).message);
    }
}

function tokenize(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s@._-]+/gu, ' ')
        .split(/\s+/)
        .filter(t => t.length > 2);
}

/**
 * Apply metadata-aware score boosts. Caps extra at +0.10 to avoid overriding
 * semantic similarity entirely.
 *
 *   +0.03 per subject keyword hit (cap 0.06)
 *   +0.05 when sender mentioned in the query
 *   +0.05 for attachment results when the query mentions attachment/file/bijlage
 */
function applyMetadataBoost(results, userMessage) {
    if (!results || !results.length) return;
    const qTokens = new Set(tokenize(userMessage));
    if (qTokens.size === 0) return;
    const wantsAttachment = /\b(attachment|attach|file|bijlage|bijlagen|anhang|pdf|xlsx|spreadsheet|document)\b/i.test(userMessage || '');

    for (const r of results) {
        const md = r.docMeta;
        if (!md) continue;
        let bump = 0;

        if (md.subject) {
            const subjTokens = new Set(tokenize(md.subject));
            let hits = 0;
            for (const t of qTokens) if (subjTokens.has(t)) hits++;
            if (hits > 0) bump += Math.min(0.06, 0.03 * hits);
        }

        if (md.from) {
            const fromTokens = new Set(tokenize(md.from));
            for (const t of qTokens) { if (fromTokens.has(t)) { bump += 0.05; break; } }
        }

        if (wantsAttachment && md.hasAttachments) bump += 0.05;

        if (bump > 0) {
            r.score = (r.score || 0) + Math.min(0.10, bump);
            r.metadataBoost = Math.min(0.10, bump);
        }
    }
}

module.exports = { searchQueryFrom, fetchKnowledgeResults, enrichResultsWithDocMetadata, applyMetadataBoost };

/**
 * @typedef {{ source?: string, type?: string, source_uri?: string, document_id?: string, threadId?: string, from?: string, subject?: string, date?: string, hasAttachments?: boolean }} KnowledgeResultMeta
 * @typedef {{ content: string, metadata: KnowledgeResultMeta, score: number, docMeta?: Record<string, any>, sourceType?: string, metadataBoost?: number }} KnowledgeResult
 * @typedef {{ content?: string, source_uri?: string, title?: string, document_id?: string, score?: number, rerank_score?: number }} RetrievedChunk
 * @typedef {{ resolveProvider: () => typeof import('../kb/resolveProvider'), localKBIngest: () => typeof import('../kb/localKBIngest') }} KbSearchDeps
 */
