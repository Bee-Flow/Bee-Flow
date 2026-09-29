/**
 * Search service — Node.js implementation of the hosted Python
 * search-service HTTP surface. Mounted at `/api/search` and meant
 * to be reached via SEARCH_SERVICE_URL=https://server.<host>/api/search
 * so the existing clients (`server/integrations/agentSearchTools.js`,
 * `server/core/kbIngestionHelpers.js`) work unchanged.
 *
 * Endpoints:
 *   GET  /health
 *   POST /embed
 *   POST /rerank
 *   POST /tools/kb-search
 *   POST /tools/search        (web modes via Serper.dev; kb modes via searchLocally)
 *   POST /kb/ingest/json
 *
 * Wire format mirrors `search-service/app/routers/*` so a customer can
 * swap their SEARCH_SERVICE_URL from the hosted Python service to this
 * URL with no other change.
 *
 * ── What a caller may send ─────────────────────────────────────────────
 *
 * Every body and query is `.strict()` — which is what the Python service
 * has done all along: its request models are `extra="forbid"`
 * (search-service/app/models.py). This twin let everything through instead,
 * and on a SEARCH router the silent fallbacks pointed outward:
 *
 *   - `POST /tools/search {"query": "…", "mode": "kb_only"}` — or "KB", or any
 *     other mode it did not know — became `mode: 'web'`, and the query went
 *     to Serper.dev (Google) with a 200. A question meant for the internal
 *     knowledge base left the building because of a typo. Python answers 422.
 *   - A KB scope in the Python shape, `kb_scope: {tenant_id,
 *     knowledge_base_ids}`, was never read, so `mode: 'auto'` searched the
 *     web instead of the knowledge base, and `mode` omitted (Python's default
 *     is 'auto') did the same. This twin now reads kb_scope beside its own
 *     flat `tenant_id`/`kb_ids`, and defaults to 'auto' like Python — which,
 *     without a KB scope, is still a web search answered `mode_used: 'web'`.
 *   - `POST /embed {"kind": "Query"}` embedded the query as a PASSAGE: a
 *     different instruction prefix, and quietly worse retrieval.
 *
 * Keys a caller sends for the Python service that this twin does not use —
 * `rerank`, `use_azure`, `azure_*`, `inference_routing`, the `response`
 * block, `web.fetch_top_n` — are declared and ignored, exactly as Python
 * declares `inference_routing`. Their values are not policed here: this twin
 * never reads them, and the admin-configured values the web-search tool
 * forwards would otherwise start failing a search that works today.
 */

const express = require('express');
const router = express.Router();

const { cpuEmbed, CPU_EMBED_MODEL_ID, CPU_EMBED_DIM } = require('../core/embed/cpuEmbed');
const { rerankCpu, CPU_RERANK_MODEL_ID } = require('../core/rerank/cpuCrossEncoder');
const { ingestLocally, searchLocally, getDocumentContent, deleteChunksLocally } = require('../core/kb/localKBIngest');
const configStore = require('../stores/configStore');
const { validate } = require('../core/http/validate');
const { z } = require('zod');

// ─── What a caller may send ─────────────────────────────────────

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });
/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());
const choice = (values, message) => z.enum(values, { errorMap: () => ({ message }) });
const texts = (message) => z.array(worded(message), { required_error: message, invalid_type_error: message }).min(1, message);
const id = (message) => worded(message).min(1, message);
// Coerced, like pydantic's lax mode: "5" is 5 on the Python side too.
const count = (message) => z.coerce.number({ invalid_type_error: message }).int(message).min(1, message);
/** Sent for the Python service, unused by this twin: declared, never policed. */
const ignored = z.unknown();

const QUERY_TEXT = 'query is the text to search for.';
const TENANT_TEXT = 'tenant_id is the owner of the knowledge bases (a user id).';
const KB_IDS_TEXT = 'kb_ids is a non-empty list of knowledge base ids.';

const EmbedBody = bodyOf({
    texts: texts('texts is a non-empty list of strings.'),
    kind: choice(['query', 'passage'], 'kind is "query" or "passage".').optional(),
});

const RerankBody = bodyOf({
    query: id(QUERY_TEXT),
    documents: texts('documents is a non-empty list of strings.'),
    top_n: count('top_n is a whole number of results, at least 1.').nullish(),
});

// search-service/app/models.py SimpleSearchRequest, plus what this twin reads.
const KbSearchBody = bodyOf({
    tenant_id: id(TENANT_TEXT),
    kb_ids: z.array(id(KB_IDS_TEXT), { required_error: KB_IDS_TEXT, invalid_type_error: KB_IDS_TEXT }).min(1, KB_IDS_TEXT),
    query: id(QUERY_TEXT),
    // Capped at 50 below, as before: a caller asking topK + 2 is not wrong.
    top_k: z.coerce.number({ invalid_type_error: 'top_k is a whole number of chunks.' })
        .int('top_k is a whole number of chunks.').min(1, 'top_k is at least 1.').nullish(),
    rerank: ignored,
    use_azure: ignored,
    azure_endpoint: ignored,
    azure_key: ignored,
    azure_model: ignored,
    inference_routing: ignored,
});

const MODES = ['web', 'web_fast', 'kb', 'auto'];
const MODE_TEXT = `mode is one of: ${MODES.join(', ')}.`;
const kbIdList = z.array(id(KB_IDS_TEXT), { invalid_type_error: KB_IDS_TEXT });

// search-service/app/models.py SearchRequest, plus this twin's own flat scope.
const SearchBody = bodyOf({
    query: id(QUERY_TEXT).max(2000, 'query is at most 2000 characters.'),
    mode: choice(MODES, MODE_TEXT).default('auto'),
    web: z.object({
        max_results: count('web.max_results is a whole number of results, 1 to 20.')
            .max(20, 'web.max_results is a whole number of results, 1 to 20.').optional(),
        fetch_top_n: ignored,
        allow_js_fallback: ignored,
    }, { invalid_type_error: 'web is an object of web-search options.' }).strict().optional(),
    kb: z.object({
        top_k_final: count('kb.top_k_final is a whole number of chunks, 1 to 50.')
            .max(50, 'kb.top_k_final is a whole number of chunks, 1 to 50.').optional(),
        top_k_vector: ignored,
        top_k_fts: ignored,
        use_reranker: ignored,
        // This twin's older spelling of the scope, still read.
        tenant_id: id(TENANT_TEXT).optional(),
        kb_ids: kbIdList.optional(),
    }, { invalid_type_error: 'kb is an object of knowledge-base options.' }).strict().optional(),
    kb_scope: z.object({
        tenant_id: id(TENANT_TEXT),
        knowledge_base_ids: kbIdList.optional(),
    }, { invalid_type_error: 'kb_scope is { tenant_id, knowledge_base_ids }.' }).strict().nullish(),
    response: ignored,
    tenant_id: id(TENANT_TEXT).optional(),
    kb_ids: kbIdList.optional(),
});

const IngestBody = bodyOf({
    tenant_id: id(TENANT_TEXT),
    knowledge_base_id: id('knowledge_base_id is the id of the knowledge base.'),
    document_id: id('document_id is the id of the document.'),
    content: id('content is the document text.'),
    title: worded('title must be text.').nullish(),
    source_uri: worded('source_uri must be text.').nullish(),
    lang: worded('lang is a language code, or "auto".').nullish(),
    use_azure: ignored,
    azure_endpoint: ignored,
    azure_key: ignored,
    azure_model: ignored,
});

// The handler keeps its own "is required" answers for these two, word for
// word as the Python service's contract has them; the schema pins the keys.
const ContentQuery = z.object({ tenant_id: worded(TENANT_TEXT).optional() }).strict();
const scopeOf = () => ({
    tenant_id: worded(TENANT_TEXT).optional(),
    knowledge_base_id: worded('knowledge_base_id is the id of the knowledge base.').optional(),
});
const DeleteQuery = z.object(scopeOf()).strict();
const DeleteBody = bodyOf(scopeOf());

// ─── Auth middleware ────────────────────────────────────────────
// Mirrors the guard-service contract: if SERVICES_API_KEY is set,
// callers must present it via X-API-Key. /health is always public.
function apiKeyAuth(req, res, next) {
    if (req.path === '/health') return next();
    const expected = process.env.SERVICES_API_KEY;
    if (!expected) return next(); // unset → open (dev / single-node)
    if (req.get('X-API-Key') === expected) return next();
    return res.status(401).json({ error: 'invalid or missing X-API-Key' });
}

router.use(express.json({ limit: '20mb' }));
router.use(apiKeyAuth);

// ─── Health ─────────────────────────────────────────────────────
router.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        embed: { model: CPU_EMBED_MODEL_ID, dim: CPU_EMBED_DIM },
        rerank: { model: CPU_RERANK_MODEL_ID },
    });
});

// ─── /embed ─────────────────────────────────────────────────────
// Body: { texts: string[], kind?: 'query' | 'passage' }
// Returns: { vectors, dim, model }
router.post('/embed', validate({ body: EmbedBody }), async (req, res) => {
    const { texts, kind = 'passage' } = req.body;
    const vectors = await cpuEmbed(texts, { kind });
    if (vectors.length === 0) {
        return res.status(503).json({ error: 'embedding model not available' });
    }
    res.json({ vectors, dim: vectors[0].length, model: CPU_EMBED_MODEL_ID });
});

// ─── /rerank ────────────────────────────────────────────────────
// Body: { query: string, documents: string[], top_n?: int }
// Returns: { reranked: [{ index, relevance_score }], model }
router.post('/rerank', validate({ body: RerankBody }), async (req, res) => {
    const { query, documents, top_n } = req.body;
    const reranked = await rerankCpu(query, documents, top_n || null);
    if (reranked.length === 0) {
        return res.status(503).json({ error: 'reranker not available' });
    }
    res.json({ reranked, model: CPU_RERANK_MODEL_ID });
});

// ─── /tools/kb-search ───────────────────────────────────────────
// Body: { tenant_id, kb_ids: string[], query, top_k?, rerank? }
// Returns: { query, chunks: [{ content, title?, source_uri?, score }], total }
router.post('/tools/kb-search', validate({ body: KbSearchBody }), async (req, res) => {
    const { tenant_id, kb_ids, query, top_k } = req.body;
    const out = await searchLocally(tenant_id, kb_ids, query, { topK: Math.min(top_k || 10, 50) });
    const chunks = Array.isArray(out?.chunks) ? out.chunks : Array.isArray(out) ? out : [];
    const mapped = chunks.map(c => ({
        content: c.content || c.text || '',
        title: c.title || c.heading || null,
        source_uri: c.source_uri || c.sourceUri || null,
        score: typeof c.score === 'number' ? c.score : (c.relevance_score ?? 0),
    }));
    res.json({ query, chunks: mapped, total: mapped.length });
});

// ─── Web search via Serper.dev ──────────────────────────────────
async function resolveSerperKey(req) {
    if (req.get('X-Serper-Key')) return req.get('X-Serper-Key');
    try {
        const k = await configStore.getSecret('serper_api_key');
        if (k) return k;
    } catch (_) { /* fall through */ }
    return process.env.SERPER_API_KEY || null;
}

async function serperSearch(query, maxResults, serperKey) {
    const resp = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: maxResults }),
        signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Serper HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    const data = await resp.json();
    const organic = Array.isArray(data.organic) ? data.organic : [];
    // Map to the shape `agentSearchTools.js` expects (title, url, score, markdown).
    return organic.slice(0, maxResults).map((r, i) => ({
        source_type: 'web',
        title: r.title || 'Untitled',
        url: r.link || '',
        score: 1 - (i / Math.max(1, maxResults)),
        markdown: r.snippet || '',
        snippet: r.snippet || '',
        citations: r.link ? [{ url: r.link, title: r.title || '' }] : [],
        metadata: { cache_hit: false, fetched_at: new Date().toISOString() },
    }));
}

// ─── /tools/search ──────────────────────────────────────────────
// Body matches the hosted Python service so existing clients work unchanged.
// modes: web | web_fast | kb | auto (the default, as in Python)
router.post('/tools/search', validate({ body: SearchBody }), async (req, res) => {
    const body = req.body;
    const { query, mode } = body;
    const maxResults = body.web?.max_results || 5;

    // KB mode → searchLocally
    if (mode === 'kb' || mode === 'auto') {
        // Python's shape (kb_scope) first, then this twin's two older spellings.
        const tenantId = body.kb_scope?.tenant_id || body.tenant_id || body.kb?.tenant_id;
        const kbIds = body.kb_scope?.knowledge_base_ids || body.kb_ids || body.kb?.kb_ids || [];
        if (tenantId && kbIds.length > 0) {
            const out = await searchLocally(tenantId, kbIds, query, {
                topK: body.kb?.top_k_final || 10,
            });
            const chunks = Array.isArray(out?.chunks) ? out.chunks : Array.isArray(out) ? out : [];
            if (chunks.length > 0 || mode === 'kb') {
                return res.json({
                    query,
                    mode_used: 'kb',
                    results: chunks.map(c => ({
                        source_type: 'kb',
                        title: c.title || c.heading || 'KB chunk',
                        url: c.source_uri || c.sourceUri || '',
                        score: typeof c.score === 'number' ? c.score : (c.relevance_score ?? 0),
                        markdown: c.content || c.text || '',
                        citations: [],
                        metadata: { cache_hit: false },
                    })),
                });
            }
            // auto fell through with 0 KB hits → continue to web
        } else if (mode === 'kb') {
            return res.status(400).json({ error: 'kb mode requires tenant_id and kb_ids' });
        }
    }

    // Web modes: Serper.dev snippets
    const serperKey = await resolveSerperKey(req);
    if (!serperKey) {
        return res.status(503).json({ error: 'serper_api_key not configured (set via Admin → AI Config or SERPER_API_KEY env)' });
    }
    const results = await serperSearch(query, maxResults, serperKey);
    // NOTE: this is the "web_fast" wire shape — snippets only, no full-page
    // fetch + readability extraction. Acceptable for the initial drop;
    // the hosted Python service also degrades to this when fetching fails.
    return res.json({ query, mode_used: mode === 'auto' ? 'web' : mode, results });
});

// ─── /kb/ingest/json ────────────────────────────────────────────
// Body: { tenant_id, knowledge_base_id, document_id, content, title?, source_uri?, lang? }
// Returns: { document_id, chunks_created, status: 'ok' }
router.post('/kb/ingest/json', validate({ body: IngestBody }), async (req, res) => {
    const { tenant_id, knowledge_base_id, document_id, content, title, source_uri, lang } = req.body;
    const result = await ingestLocally(tenant_id, knowledge_base_id, document_id, content, {
        title: title || '',
        sourceUri: source_uri || '',
        lang: lang || 'auto',
    });
    const chunksCreated = result?.chunks_created ?? result?.chunksCreated ?? result?.chunkCount ?? 0;
    res.json({ document_id, chunks_created: chunksCreated, status: 'ok' });
});

// ─── /kb/{kb_id}/documents/{document_id}/content ────────────────
// Query: tenant_id (required)
// Returns: { document_id, content, chunk_count }
//
// Mirrors search-service/app/routers/ingest.py get_document_content. The
// re-index path (routes/knowledgeBases/reindex.js) calls this to recover a
// document's text when the KB is served by the search-service; without it that
// call 404'd and every non-local re-index reported "Failed to get existing
// content".
router.get('/kb/:kbId/documents/:documentId/content', validate({ query: ContentQuery }), async (req, res) => {
    const tenantId = req.query.tenant_id;
    if (!tenantId) return res.status(400).json({ error: 'tenant_id is required' });
    const content = await getDocumentContent(tenantId, req.params.kbId, req.params.documentId);
    if (!content) return res.status(404).json({ error: 'No chunks found for document' });
    res.json({
        document_id: req.params.documentId,
        content,
        chunk_count: content.split('\n\n').length,
    });
});

// ─── DELETE /kb/documents/{document_id} ─────────────────────────
// Query or body: tenant_id, knowledge_base_id (both required)
// Returns: { status: 'ok', document_id }
//
// Also mirrors the Python service (delete_document). Note the shape: the
// document id is the ONLY path segment — there is no /kb/{kb}/documents/{doc}/chunks
// route on either implementation, which is why the callers in
// core/kb/kbIngestionHelpers.js and routes/knowledgeBases/detail.js were
// deleting nothing at all before K1.
router.delete('/kb/documents/:documentId', validate({ query: DeleteQuery, body: DeleteBody }), async (req, res) => {
    const body = req.body;
    const tenantId = req.query.tenant_id || body.tenant_id;
    const kbId = req.query.knowledge_base_id || body.knowledge_base_id;
    if (!tenantId || !kbId) {
        return res.status(400).json({ error: 'tenant_id and knowledge_base_id are required' });
    }
    await deleteChunksLocally(tenantId, kbId, req.params.documentId);
    res.json({ status: 'ok', document_id: req.params.documentId });
});

module.exports = router;
