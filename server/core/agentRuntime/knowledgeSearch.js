const configStore = require('../../stores/configStore');
const { getServiceHeaders } = require('../serviceAuth');
const { getAll } = require('../../db');
const { userHasBetaFeature } = require('../entitlements/betaFeatures');
const log = require('../../telemetry/log');
const { fetchKnowledgeResults, enrichResultsWithDocMetadata, applyMetadataBoost } = require('./knowledgeRetrieval');
const {
    contentTokenSet, jaccardSimilarity, hasCalibratedReranker, rankKnowledgeResults,
    trimPassages, passageSource, knowledgePromptBlock, NO_RESULTS_BLOCK, EMPTY_KB_BLOCK,
} = require('./knowledgeRanking');

// The KB provider and the local search, lazily, for ./knowledgeRetrieval
// (which stays out of the server's large import cycle).
const KB_SEARCH = {
    resolveProvider: () => require('../kb/resolveProvider'),
    localKBIngest: () => require('../kb/localKBIngest'),
};

// Mirror of routes/knowledgeBases.js — kept here too so the agent runtime
// doesn't have to import a routes-layer constant. Slugs identify a
// system-managed KB by its `system_slug` and 1:1 to a beta-feature id.
const SYSTEM_KB_BETA_SLUGS = new Set();

/**
 * Drop any system-managed KB ids from `kbIds` whose `system_slug` is not in
 * the requesting user's enabled beta features. Returns the filtered id list.
 * Returns the input unchanged when no system KBs are referenced — cheap path
 * for the common case where an agent only uses ordinary user/org KBs.
 */
async function filterSystemKBsForUser(kbIds, userId, session) {
    if (!Array.isArray(kbIds) || kbIds.length === 0) return kbIds;
    let rows;
    try {
        rows = await getAll(
            `SELECT id, system_slug FROM knowledge_bases
             WHERE id = ANY($1::uuid[]) AND source_kind = 'system_managed'`,
            [kbIds]
        );
    } catch (_) { return kbIds; }
    if (!rows || rows.length === 0) return kbIds;
    // Check each referenced system slug via the resolver (userHasBetaFeature →
    // resolveEntitlements) so the per-org access ceiling binds it — including a
    // global admin (governingOrgId) — instead of the raw "admins get all betas" list.
    const referencedSlugs = [...new Set(rows.map(r => r.system_slug).filter(s => s && SYSTEM_KB_BETA_SLUGS.has(s)))];
    const enabled = new Set();
    for (const slug of referencedSlugs) {
        try { if (await userHasBetaFeature(userId, slug, session || null)) enabled.add(slug); }
        catch (_) { /* treat as disabled on failure */ }
    }
    const denied = new Set(
        rows
            .filter(r => r.system_slug && SYSTEM_KB_BETA_SLUGS.has(r.system_slug) && !enabled.has(r.system_slug))
            .map(r => String(r.id))
    );
    if (denied.size === 0) return kbIds;
    const filtered = kbIds.filter(id => !denied.has(String(id)));
    log.info(`[KnowledgeSearch] Dropped ${denied.size} system KB(s) (beta feature not enabled for user)`);
    return filtered;
}

// Greetings / small-talk patterns that should NEVER trigger a KB lookup.
// Kept intentionally broad — false negatives are cheap (just an extra search),
// false positives would hide real queries.
const GREETING_RE = /^(h(i|ey|ello|oi|allo|oi+)|yo|sup|goedemorgen|goedemiddag|goedenavond|goedendag|dag|bedankt|dankjewel|thanks|thank you|ok(ay)?|yes|no|ja|nee|sure|cool|nice|great|good morning|good afternoon|good evening|how are you|hoe gaat het|alles goed|what'?s up|how'?s it going)[\s!.,?]*$/i;

const { filterKbIdsForEmbed } = require('../kb/kbVisibility');
const { askerContext } = require('../kb/askerContext');
const { visibleKbIdsFor, coerceTestAs } = require('./testAs');

/**
 * Narrow an agent's configured knowledge bases to what may answer THIS turn.
 *
 * `userId` is falsy only on one path: an unauthenticated visitor to an
 * embedded agent (every other route requires a session before it gets here —
 * see routes/agents/chat.js, "No userId (unauthenticated embed guest) +
 * is_published → allow"). There is no person to evaluate, so the rule shifts
 * rather than the identity: the OWNER chose these bases, but only the ones
 * their organisation published to itself may face the public internet. A
 * draft is unfinished and a group-restricted base was restricted on purpose.
 *
 * Note this is NOT keyed on `agent.embed_enabled`: an org member chatting
 * with an embeddable agent through the normal UI is still a person, and gets
 * the bases they may actually read — including their own drafts.
 *
 * `testAs` (A1c) narrows the first branch a second time, to what a member of
 * one group would see. It can only take bases away — see `./testAs`.
 */
async function visibleKbIdsForTurn(kbIds, { agent, userId, testAs = null }) {
    if (!kbIds.length) return [];
    if (userId) {
        return visibleKbIdsFor(kbIds, {
            userId, testAs, context: 'agent_chat', agentId: agent?.id || null,
        });
    }
    // An embed visitor has no identity to narrow, so there is nothing to
    // simulate — and answering as the OWNER under a group's label would be
    // the widest reading of a request that only ever narrows.
    if (coerceTestAs(testAs)) return [];
    const ownerId = agent?.owner_id || null;
    if (!ownerId) return [];
    const owner = await askerContext(ownerId);
    return filterKbIdsForEmbed(kbIds, {
        ownerUserId: ownerId, ownerOrgIds: owner.orgIds, agentId: agent?.id || null,
    });
}


/**
 * The knowledge-base block for an agent turn's system prompt ('' when there
 * is nothing to add). Retrieval lives in ./knowledgeRetrieval, the ranking,
 * trim and prompt wording in ./knowledgeRanking.
 */
async function performKnowledgeSearch({ agent, userId, userMessage, isStrictKnowledge, onEvent, session, testAs = null, stripPassages = null }) {
    const rawKbIds = agent.config?.knowledge_base_ids || [];
    /**
     * TWO filters, and they answer different questions.
     *
     * `filterSystemKBsForUser` asks whether the org's licence has the beta
     * that surfaces a system knowledge base. `filterKbIdsForUser` (K5) asks
     * whether THIS PERSON may read this base at all — the question the
     * picker answers when the agent is configured, and the one the runtime
     * did not ask again afterwards.
     *
     * Without the second, a base shared with the Sales group and attached to
     * an agent the whole organisation may talk to answered questions for
     * everyone, with citations — and an embedded agent answered the public
     * internet from whatever its owner happened to attach.
     */
    const licensedIds = await filterSystemKBsForUser(rawKbIds, userId, session);
    const kbIds = await visibleKbIdsForTurn(licensedIds, { agent, userId, testAs });

    // ── Skip KB search for greetings / small-talk ───────────────────
    // These never carry search intent and always return low-quality matches.
    const trimmedInput = (userMessage || '').trim();
    if (GREETING_RE.test(trimmedInput)) {
        log.info(`[KnowledgeSearch] Skipping KB search — greeting/small-talk detected: "${trimmedInput}"`);
        // In strict-knowledge mode, still let the agent respond naturally to greetings
        // (the "no results" prompt would be confusing for a simple "hi")
        return '';
    }

    const allKnowledgeResults = kbIds.length > 0
        ? await fetchKnowledgeResults({ userId, kbIds, userMessage }, KB_SEARCH)
        : [];

    if (allKnowledgeResults.length === 0) {
        if (!isStrictKnowledge) return '';
        return kbIds.length === 0 ? EMPTY_KB_BLOCK : NO_RESULTS_BLOCK;
    }

    // Enrich with document-level metadata (sender/threadId/attachments) so
    // we can apply metadata-aware scoring boosts and thread-aware retrieval.
    await enrichResultsWithDocMetadata(allKnowledgeResults, kbIds);
    applyMetadataBoost(allKnowledgeResults, userMessage);

    const { filtered, topResults, hasReranker } = await rankKnowledgeResults(allKnowledgeResults, configStore);
    log.info(`[KnowledgeSearch] Results: ${filtered.length} after filters → ${topResults.length} after dedup (hasReranker=${hasReranker}, includeRefs=${agent.config?.includeSourceReferences})`);

    const anyChunkTruncated = trimPassages(topResults);

    // The caller's Privacy Shield strip (contextEnrichment, BFSF-354):
    // these passages reach the prompt and the citations without a tool
    // call. Rewrites `content` in place, before either is built, and hands
    // back the source labels after the same scan.
    const strippedLabels = (stripPassages && topResults.length > 0)
        ? await stripPassages(topResults, passageSource) : null;

    if (topResults.length === 0) {
        return isStrictKnowledge ? NO_RESULTS_BLOCK : '';
    }

    const includeRefs = agent.config?.includeSourceReferences === true;
    const block = knowledgePromptBlock({ topResults, labels: strippedLabels, includeRefs, isStrictKnowledge, anyChunkTruncated });

    if (includeRefs && onEvent) {
        // One citation shape, built in core/kb/citation.js. Four places
        // used to roll their own here — same idea, three different
        // heading regexes, and one of them sent the passage under a key
        // the overlay does not read.
        const { toCitations } = require('../kb/citation');
        onEvent('kb_sources', { sources: toCitations(topResults, { kind: 'unknown' }) });
    }
    return block;
}

/**
 * Quick KB search for non-agent contexts (direct chat, template chat).
 * Uses the same quality gates as agent KB search: greeting guard,
 * score threshold, Jaccard dedup, and content cap.
 *
 * @param {string} userId
 * @param {string[]} kbIds
 * @param {string} query — the user message
 * @param {object} [options]
 * @param {number} [options.topK=6] — max results to return
 * @param {number} [options.contentCap=3000] — max chars per chunk
 * @returns {Promise<Array<{title: string, content: string, score: number}>>}
 */
async function quickKBSearch(userId, kbIds, query, options = {}) {
    const { topK = 6, contentCap = 3000, session = null } = options;

    if (!kbIds || kbIds.length === 0 || !query) return [];

    // Greeting guard — don't waste API calls on "hi"
    const trimmed = (query || '').trim();
    if (GREETING_RE.test(trimmed)) return [];

    // Strip system KBs the user's org has no beta-feature entitlement to.
    kbIds = await filterSystemKBsForUser(kbIds, userId, session);
    if (kbIds.length === 0) return [];

    // The same decision the agent path and the /search route make, from the
    // same resolver: `kb_provider` when set, else the legacy Azure flag, else
    // "remote only when a search service is configured". This used to read the
    // Azure flag alone, so an install with `kb_provider = local` and a
    // SEARCH_SERVICE_URL in its environment ingested locally and then asked a
    // search service that was not running — every Test question answered
    // "nothing matched" for rows that were sitting in the local store.
    const { resolveKbProvider } = require('../kb/resolveProvider');
    const useLocal = (await resolveKbProvider()) === 'local';
    let chunks = [];

    try {
        if (useLocal) {
            const { searchLocally } = require('../kb/localKBIngest');
            chunks = await searchLocally(userId, kbIds, query, { topK: topK + 2 });
        } else {
            const searchUrl = process.env.SEARCH_SERVICE_URL || 'https://services.beeflow.nl';
            const searchRes = await fetch(`${searchUrl}/tools/kb-search`, {
                method: 'POST',
                headers: getServiceHeaders(),
                body: JSON.stringify({ tenant_id: userId, kb_ids: kbIds, query, top_k: topK + 2, rerank: true }),
                signal: AbortSignal.timeout(10000),
            });
            if (searchRes.ok) {
                const searchData = await searchRes.json();
                chunks = searchData.chunks || searchData.results || [];
            }
        }
    } catch (err) {
        log.warn('[quickKBSearch] KB search failed:', err.message);
        return [];
    }


    // Score threshold — the SAME rule as the agent path, including its
    // condition: 0.72 only when the scores are calibrated (Azure Cohere or
    // the GPU sidecar). Without one of those the scores are RRF fusion
    // values, typically 0.01–0.03, and a 0.72 floor throws every hit away —
    // which is what made "Test question" answer "nothing matched" on a base
    // whose rows the search had just found. See hasCalibratedReranker for why
    // the llama.cpp and CPU rerankers are deliberately NOT counted as calibrated.
    const MIN_RELEVANCE = (await hasCalibratedReranker(configStore)) ? 0.72 : 0.01;
    chunks = chunks.filter(c => (c.score || c.rerank_score || 0) >= MIN_RELEVANCE);

    // Jaccard dedup (same as kbSearchTools)
    const deduped = [];
    const dedupSets = [];
    for (const c of chunks) {
        const ts = contentTokenSet(c.content);
        if (!dedupSets.some(ex => jaccardSimilarity(ts, ex) >= 0.85)) {
            deduped.push(c);
            dedupSets.push(ts);
        }
    }

    // Cap and format. Everything a citation is built from rides along: the
    // ids that make a chip open its passage, the page or row range that makes
    // it checkable, and what a table row pulled in along its relations. These
    // used to be dropped here, so the ask route's citations arrived with no
    // document behind them.
    return deduped.slice(0, topK).map(c => ({
        title: c.title || c.source_uri || 'KB',
        content: (c.content || '').slice(0, contentCap),
        score: c.score || c.rerank_score || 0,
        source_uri: c.source_uri || '',
        ...(c.document_id != null ? { document_id: c.document_id } : {}),
        ...(c.chunk_id != null ? { chunk_id: c.chunk_id } : {}),
        ...(c.id != null ? { id: c.id } : {}),
        ...(c.page_start != null ? { page_start: c.page_start } : {}),
        ...(c.kind ? { kind: c.kind } : {}),
        ...(c.row_start != null ? { row_start: c.row_start, row_end: c.row_end } : {}),
        ...(c.occurred_at ? { occurred_at: c.occurred_at } : {}),
        ...(c.source_id != null ? { source_id: c.source_id } : {}),
        ...(Array.isArray(c.linked) && c.linked.length ? { linked: c.linked } : {}),
    }));
}

module.exports = { performKnowledgeSearch, quickKBSearch, visibleKbIdsForTurn };
