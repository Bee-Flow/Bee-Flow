/** @typedef {import('../core/llm/webSearchInferenceResolver').InferenceEntry} InferenceEntry */
/** @typedef {import('./kbSearchShaping').KbChunk} KbChunk */
/**
 * Knowledge Base Search Tool
 *
 * Gives agents the ability to explicitly search their configured knowledge base
 * with any query. Useful when the automatic KB search (which uses the user's
 * message as the query) isn't sufficient — e.g., after reading an email,
 * the agent can search the KB with the email's topic to find relevant context.
 */
// @typecheck
require('../stores/configStore');
const { getServiceHeaders } = require('../core/serviceAuth');
const { recordSidecarCall } = require('../telemetry/metrics');
const { toCitation } = require('../core/kb/citation');
const { withOriginalFlags } = require('../core/kb/originals.mts');
const { KB_GET_ORIGINAL_TOOL, executeKbGetOriginal, agentVisibleKbIds } = require('./kbOriginalTool');
const log = require('../telemetry/log');
const { logSearch, attachHandle } = require('../core/kb/queryLog/hook.mts');
const { fallback } = require('../utils/bestEffort');
const {
    smallTalkCore, scoredResults, dedupeNearDuplicates, stripRepeatedHeadings, labelSections,
} = require('./kbSearchShaping');

/** @type {Array<Record<string, any>>} */ const KB_SEARCH_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'kb_search',
            description: `Search the internal knowledge base for relevant context, procedures, policies, or previous similar interactions.

WHEN TO USE:
- Before drafting a reply to a question about a real topic, policy, or procedure.
- When the user asks for specific factual details you don't already have in context.

WHEN TO SKIP:
- Greetings / small-talk ("hi", "thanks", "how are you").
- Trivial confirmations ("ok", "got it").
- Anything already answered by text in the current message or earlier in this conversation.

SEARCH STRATEGY — ONE FOCUSED QUERY BY DEFAULT:
1. Make a single well-formed keyword query that captures the core topic. If the result is relevant, USE IT and move on — do not run additional searches.
2. Only run a second search if the first returned zero results. Use broader synonyms or an adjacent category term.
3. Do NOT run more than 2 searches per user turn. Additional searches waste tokens and delay the user.

QUERY FORMAT:
- 2–5 keywords. Not full sentences. Not email fragments.
- Strip names, dates, and specific identifiers — search the underlying topic.
- BAD: "Hilverzorg AI update werkt niet meer" → GOOD: "update werkt niet applicatie"
- BAD: "Hoi, kun je me helpen met inloggen" → GOOD: "inloggen probleem account"
- KB docs are often titled by category (e.g. "Facturatie", "Account", "E-mail", "Netwerk", "Hardware", "Applicatie", "Toegang"). Putting a likely category word IN the single query helps — you don't need a separate category-only search.

EMAIL ARCHIVE KBs:
- If the KB is an email archive (docs titled "{Sender} — {Subject}"), you can query by sender name/email, subject keywords, or date fragments — the From/To/Date/Subject metadata header is indexed alongside the body.
- Example queries: "Joost fix bevestigd", "invoice mistral maart", "openwebui bug".`,
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Core topic keywords (1-4 words) OR a single category label. Not a full sentence. Examples: "factuur ontbreekt", "Facturatie", "outlook crash", "Account".'
                    },
                    top_k: {
                        type: 'integer',
                        description: 'Number of results (1-10, default 5)'
                    }
                },
                required: ['query']
            }
        }
    },
];

// kb_fetch is only exposed to the LLM when KB_PREVIEW_MODE is on. In that
// mode, kb_search returns only short previews; the agent uses kb_fetch on the
// 1–3 chunks it wants to quote. Saves ~70 % of tokens on the typical turn.
const KB_FETCH_TOOL = {
    type: 'function',
    function: {
        name: 'kb_fetch',
        description: `Fetch the FULL text of up to 3 KB chunks you previewed via kb_search.

WHEN TO USE:
- After a kb_search, pick at most 3 chunks whose title/section/preview look most relevant to the user's question, and call kb_fetch with their chunk_ids.
- DO NOT call kb_fetch on every previewed chunk — only the ones you intend to quote / reason over. Each fetched chunk costs ~750 tokens.
- If the preview already tells you the answer, DO NOT fetch — answer directly.`,
        parameters: {
            type: 'object',
            properties: {
                chunk_ids: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'chunk_id values from a recent kb_search result. Max 3 per call.',
                    maxItems: 3
                }
            },
            required: ['chunk_ids']
        }
    }
};

if (process.env.KB_PREVIEW_MODE === 'true') {
    KB_SEARCH_TOOLS.push(KB_FETCH_TOOL);
}

// kb_get_original: the uploaded file itself, for the bases that keep one (integrations/kbOriginalTool.js).
KB_SEARCH_TOOLS.push(KB_GET_ORIGINAL_TOOL);

// ─── Tool Execution ────────────────────────────────────────────

async function executeKbFetchTool(args, context = {}) {
    const kbQueryCache = require('../core/agentRuntime/kbQueryCache');
    const conversationId = kbQueryCache.scopeFor(context.conversationId, context.userId);
    let ids = Array.isArray(args?.chunk_ids) ? args.chunk_ids : [];
    ids = ids.slice(0, 3); // Hard server-side cap; description also says max 3.

    if (ids.length === 0) return { error: 'kb_fetch requires chunk_ids' };

    const hits = [];
    const misses = [];
    for (const id of ids) {
        const cached = kbQueryCache.getChunk(conversationId, id);
        if (cached) {
            hits.push({ chunk_id: id, title: cached.title, section: cached.section, content: cached.content });
        } else {
            misses.push(id);
        }
    }

    // Only chunks a kb_search by THIS asker in this conversation returned are
    // served: that search already applied the asker's knowledge-base
    // visibility. An id the cache does not hold is answered with "run
    // kb_search again".
    if (misses.length > 0) {
        log.info(`[KBFetch] ${misses.length} chunk id(s) not in this conversation's search results`);
    }

    if (hits.length === 0) {
        return { error: 'None of the requested chunk_ids were found. They may belong to a previous conversation — run kb_search again.' };
    }

    return { chunks: hits };
}

/**
 * One kb_search through the search service: the chunks it found, or the tool
 * error when it answered with a failure status. A network failure throws.
 * The sidecar call is recorded either way.
 * @param {string} userId  the tenant the search runs for
 * @param {string[]} kbIds  the bases the person may read
 * @param {string} query
 * @param {number} topK
 * @returns {Promise<{ chunks?: KbChunk[], error?: string }>}
 */
async function searchViaService(userId, kbIds, query, topK) {
    const searchUrl = process.env.SEARCH_SERVICE_URL || 'https://services.beeflow.nl';
    // Resolve the admin's Web-Search Inference Routing config so the
    // search-service knows which backend to use per task. Falls back
    // to the service's own env defaults when unresolved.
    /** @type {{ embed: InferenceEntry; rerank: InferenceEntry; cleanup: InferenceEntry; } | null} */
    let inferenceRouting = null;
    try {
        const { resolveInferenceTargetsWithSecrets } = require('../core/llm/webSearchInferenceResolver');
        inferenceRouting = await resolveInferenceTargetsWithSecrets();
    } catch (err) { fallback('integrations/kbSearchTools:executeKbSearchTool', err); /* non-fatal */ }
    const sidecarT0 = Date.now();
    /** @type {Response} */
    let searchRes;
    try {
        searchRes = await fetch(`${searchUrl}/tools/kb-search`, {
            method: 'POST',
            headers: getServiceHeaders(),
            body: JSON.stringify({
                tenant_id: userId,
                kb_ids: kbIds,
                query,
                top_k: topK,
                rerank: true,
                inference_routing: inferenceRouting,
            }),
            signal: AbortSignal.timeout(15000)
        });
    } catch (netErr) {
        recordSidecarCall({ service: 'search', status: 'error', durationMs: Date.now() - sidecarT0 });
        throw netErr;
    }

    if (!searchRes.ok) {
        recordSidecarCall({ service: 'search', status: 'error', durationMs: Date.now() - sidecarT0 });
        log.warn(`[KBSearch] Search-service error: ${searchRes.status}`);
        return { error: `Knowledge base search failed (${searchRes.status})` };
    }
    recordSidecarCall({ service: 'search', status: 'ok', durationMs: Date.now() - sidecarT0 });

    const searchData = await searchRes.json();
    return { chunks: searchData.chunks || searchData.results || [] };
}

/**
 * The chunks whose document still exists in one of the bases (a chunk without
 * a document id is kept). On a database failure the filter is skipped and the
 * chunks come back as they were.
 * @param {KbChunk[]} chunks
 * @param {string[]} kbIds
 * @returns {Promise<KbChunk[]>}
 */
async function dropOrphanChunks(chunks, kbIds) {
    try {
        const { getAll } = require('../db');
        const dbDocs = await getAll('SELECT id FROM documents WHERE knowledge_base_id = ANY($1::uuid[])', [kbIds]);
        const validDocIds = new Set(dbDocs.map(d => String(d.id).toLowerCase()));
        const before = chunks.length;
        const kept = chunks.filter(c => !c.document_id || validDocIds.has(String(c.document_id).toLowerCase()));
        if (kept.length < before) {
            log.info(`[KBSearch] Orphan filter: removed ${before - kept.length} orphaned chunks`);
        }
        return kept;
    } catch (filterErr) {
        log.warn('[KBSearch] Orphan filter failed, skipping:', /** @type {Error} */ (filterErr).message);
        return chunks;
    }
}

/**
 * @param {string} toolName
 */
async function executeKbSearchTool(toolName, args, context = {}) {
    if (toolName === 'kb_fetch') {
        return await executeKbFetchTool(args, context);
    }
    if (toolName === 'kb_get_original') {
        return await executeKbGetOriginal(args, context);
    }
    if (toolName !== 'kb_search') {
        return { error: `Unknown KB search tool: ${toolName}` };
    }

    const { query, top_k } = args;
    if (!query) return { error: 'query is required' };

    // ── Greeting / small-talk guard (smallTalkCore) ─────────────────
    const queryCore = smallTalkCore(query);
    if (queryCore !== null) {
        log.info(`[KBSearch] Skipped — greeting/small-talk: "${query}" (core: "${queryCore}")`);
        return {
            _action: 'kb_sources',
            _sources: [],
            query,
            resultCount: 0,
            results: [],
            instruction: 'No search needed for greetings. Respond naturally.'
        };
    }

    const { userId, agentId } = context;

    // The agent's bases, narrowed to the ones THIS person may read (and the "Test as" group, in a preview).
    const kbIds = await agentVisibleKbIds(context);

    if (kbIds.length === 0) {
        return {
            results: [],
            message: 'No knowledge base configured for this agent. An admin can add knowledge bases in the agent settings.'
        };
    }

    const topK = Math.min(Math.max(parseInt(top_k) || 5, 1), 10);
    const retrievalT0 = Date.now();

    // Per-asker, per-conversation cache: the same question asked again skips
    // the whole retrieval stack. The bucket is the asker's own (a shared thread
    // has several askers with different bases); the key is the normalised
    // query, top_k, the preview mode and the sorted kb_ids.
    const kbQueryCache = require('../core/agentRuntime/kbQueryCache');
    const conversationId = kbQueryCache.scopeFor(context.conversationId, userId);
    const previewMode = process.env.KB_PREVIEW_MODE === 'true';
    const cacheQuery = `${query}|top_k=${topK}|preview=${previewMode}`;
    const cached = kbQueryCache.get(conversationId, cacheQuery, kbIds);
    if (cached) {
        log.info(`[KBSearch] Cache HIT: conv=${context.conversationId} "${query}" → ${cached._sources?.length || 0} chunks`);
        return cached;
    }

    log.info(`[KBSearch] Searching ${kbIds.length} KBs: "${query}" (top_k=${topK}, agent=${agentId})`);

    try {
        const { resolveKbProvider } = require('../core/kb/resolveProvider');
        const kbProvider = await resolveKbProvider();
        /** @type {any[] & { _orphanFiltered?: boolean }} */ let chunks = [];

        if (kbProvider === 'local') {
            // ── Local search path (in-process pgvector + RRF + reranker) ──
            const { searchLocally } = require('../core/kb/localKBIngest');
            const localResults = await searchLocally(userId, kbIds, query, { topK });
            chunks = localResults;
        } else {
            // ── Search-service path ────────────────────────────────
            const searched = await searchViaService(userId, kbIds, query, topK);
            if (searched.error) return searched;
            chunks = searched.chunks;
        }

        // ── Filter Orphaned Chunks ────────────────────────────────────
        // searchLocally() already filters orphans (returns ._orphanFiltered = true).
        // Only run this for the search-service path which doesn't do its own filtering.
        if (chunks.length > 0 && !chunks._orphanFiltered && chunks.some(c => c.document_id)) {
            chunks = await dropOrphanChunks(chunks, kbIds);
        }

        // Reranker scores below ~0.35 are noise (UI clutter, wasted tokens); KB_MIN_SCORE overrides.
        const parsedMin = parseFloat(process.env.KB_MIN_SCORE);
        const scoreThreshold = Number.isFinite(parsedMin) ? parsedMin : 0.35;

        const preFilterCount = chunks.length;
        const results = scoredResults(chunks, scoreThreshold);
        if (preFilterCount > results.length) {
            log.info(`[KBSearch] Score filter (>= ${scoreThreshold}): kept ${results.length}/${preFilterCount}`);
        }

        // ── Near-duplicate deduplication, then repeated heading breadcrumbs ──
        const dedupResults = dedupeNearDuplicates(results);
        const MAX_CHUNK_CHARS = 3000;
        stripRepeatedHeadings(dedupResults, MAX_CHUNK_CHARS);

        // KB query log: what the search found, before the score filter; the handle rides on the payload.
        const queryLogHandle = context.log
            ? await logSearch({}, context.log, { kbIds, query, chunks, retrievalMs: Date.now() - retrievalT0 })
            : null;

        const topScore = chunks.length > 0 ? Math.max(...chunks.map(c => c.score || c.rerank_score || 0)) : 0;
        log.info(`[KBSearch] Found ${dedupResults.length} results (from ${chunks.length} chunks, deduped from ${results.length}, threshold=${scoreThreshold}, topScore=${topScore.toFixed(4)})`);

        // Build per-chunk section label (deepest heading + short snippet) once and reuse.
        // The rows first learn which base their document sits in and whether its file is kept: what lets a chip offer the download.
        const annotated = labelSections(await withOriginalFlags(dedupResults));

        // Stash every chunk in the per-conversation cache so kb_fetch can
        // resolve full content by chunk_id on a later tool call.
        kbQueryCache.setChunks(conversationId, annotated.map(({ r, sectionLabel }) => ({
            chunk_id: r.chunk_id,
            title: r.source_url || r.title,
            section: sectionLabel,
            content: r.content,
            source_uri: r.source_uri || r.source_url || '',
        })));

        const payload = {
            // UI-only: full-content cards with score/type the side panel renders.
            _action: 'kb_sources',
            // The shared citation shape (core/kb/citation.js): the same fields
            // the agent-chat, notebook and direct-chat panels read, so a chip
            // means the same thing wherever it appears — and now carries the
            // ids that let it be clicked.
            _sources: annotated.map(({ r, sectionLabel }, i) =>
                toCitation({ ...r, section: sectionLabel }, { index: i, kind: 'kb_chunk' })),
            query,
            // LLM-facing: trimmed.
            //   - default: full content, minus score/type (Phase 1)
            //   - KB_PREVIEW_MODE=true: first ~220 chars only; agent calls kb_fetch
            //     for the chunks it actually wants to use (Phase 2)
            results: annotated.map(({ r, sectionLabel }) => {
                const base = {
                    chunk_id: r.chunk_id,
                    title: r.source_url || r.title,
                    section: sectionLabel,
                    // What kb_get_original takes; `has_original` tells the model whether asking is worth a call.
                    document_id: r.document_id ?? null,
                    has_original: r.has_original === true,
                };
                if (previewMode) {
                    const preview = (r.content || '').slice(0, 220);
                    return {
                        ...base,
                        preview,
                        length: (r.content || '').length,
                    };
                }
                return { ...base, content: r.content };
            }),
        };
        kbQueryCache.set(conversationId, cacheQuery, kbIds, payload);
        // The cached object stays handle-free: a cache hit is not a new search.
        return queryLogHandle ? attachHandle({ ...payload }, queryLogHandle) : payload;

    } catch (err) {
        log.error(`[KBSearch] Error:`, /** @type {Error} */ (err).message);
        return { error: `Knowledge base search unavailable: ${/** @type {Error} */ (err).message}` };
    }
}

/**
 * @param {string} toolName
 */
function isKbSearchTool(toolName) {
    // kb_fetch is only offered in preview mode, so only claimed there.
    return toolName === 'kb_search' || toolName === 'kb_get_original' || (toolName === 'kb_fetch' && process.env.KB_PREVIEW_MODE === 'true');
}

module.exports = {
    KB_SEARCH_TOOLS,
    executeKbSearchTool,
    isKbSearchTool,
};

/**
 * @typedef {{ query?: string, top_k?: number | string, chunk_ids?: string[] }} KbSearchArgs
 * @typedef {{ conversationId?: string, userId?: string, agentId?: string, testAs?: unknown, log?: import('../core/kb/queryLog/hook.mts').LogOption | null }} KbSearchContext  testAs: the raw "Test as" metadata (core/agentRuntime/testAs.js coerces it)
 */
