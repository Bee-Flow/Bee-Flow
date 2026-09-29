/**
 * Knowledge Bases — retrieval.
 *
 * POST /search — search one, several or (with no kb_ids) every KB the caller
 * can reach, via the local vector store or the search-service.
 *
 * ── ONLY "NOTHING" MEANS "EVERYTHING" ───────────────────────────────
 * Leaving kb_ids out is a real request: the mobile app's global search sends
 * `kb_ids: []` on purpose (BFSF-216). The old `Array.isArray(kb_ids) ? … : []`
 * made every OTHER shape mean the same thing, so one id sent as a string, the
 * camelCase `kbIds`, or `['']` from a picker with nothing picked all searched
 * every base the caller can reach, under a 200 that looked like the narrow
 * answer. Absent, null and [] still mean "all"; anything else that is not a
 * list of ids is a 400 that names it.
 *
 * `top_k` is bounded by the search service's own 1–50 (the Python service
 * enforces it with a 422, which this route passed on as a 502). On the local
 * path there was no bound at all, and a non-number never failed: `topK * 2`
 * became NaN, the vector query's `LIMIT NaN` was swallowed by its catch, and
 * `slice(0, NaN)` emptied the candidates — so `"top_k": "ten"` answered "no
 * passages found" under the same 200 as a search that genuinely found none.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const kbStore = require('../../stores/knowledgeBases');
const configStore = require('../../stores/configStore');
const { requireAuth, resolveUserOrgIds } = require('../../auth');
const { getServiceHeaders } = require('../../core/serviceAuth');
const { validate } = require('../../core/http/validate');
const { HttpError } = require('../../core/http/errors');
const { z } = require('zod');
const {
    SEARCH_SERVICE_URL,
    getUserId,
    resolveUserGroups,
    resolveIsOrgAdmin,
} = require('./shared');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });
/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

const DEFAULT_TOP_K = 8;
/** search-service/app/models.py SimpleSearchRequest: `top_k` is 1–50 there. */
const MAX_TOP_K = 50;
const MAX_QUERY_CHARS = 2000;

const QUERY_TEXT = 'Say what to search for.';
const KB_IDS_TEXT = 'kb_ids is a list of knowledge base ids. Leave it out to search every knowledge base you can reach.';
const KB_ID_TEXT = 'Each entry in kb_ids is a knowledge base id.';
const TOP_K_TEXT = `top_k is a whole number of passages, 1 to ${MAX_TOP_K}.`;

const SearchBody = bodyOf({
    query: worded(QUERY_TEXT).trim().min(1, QUERY_TEXT)
        .max(MAX_QUERY_CHARS, `A search is at most ${MAX_QUERY_CHARS} characters.`),
    // A knowledge base id is a UUID column; anything else used to reach
    // Postgres as `$1::uuid[]` and come back as a 500.
    kb_ids: z.array(worded(KB_ID_TEXT).uuid(KB_ID_TEXT), { invalid_type_error: KB_IDS_TEXT }).nullish(),
    // "5" always worked — JavaScript multiplied it locally and pydantic's lax
    // mode took it remotely — so digits in a string still count; null is
    // still "the default". Only what never worked is refused.
    top_k: z.preprocess(
        (v) => (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : v),
        z.number({ invalid_type_error: TOP_K_TEXT }).int(TOP_K_TEXT).min(1, TOP_K_TEXT).max(MAX_TOP_K, TOP_K_TEXT),
    ).nullish(),
});

// ── Search ──────────────────────────────────────────────────────────

/**
 * Search across one or more KBs via search-service
 */
router.post('/search', requireAuth, validate({ body: SearchBody }), async (req, res) => {
    const userId = getUserId(req);
    const { query } = req.body;
    const topK = req.body.top_k ?? DEFAULT_TOP_K;

    const orgIds = await resolveUserOrgIds(req);
    const userGroups = await resolveUserGroups(req);
    const isOrgAdmin = await resolveIsOrgAdmin(req);
    const { getAll } = require('../../db');

    // Global search (BFSF-216): when no kb_ids are supplied, search across
    // every KB the user can access instead of erroring. Explicit ids keep
    // the existing strict per-KB access check. Org admins may search every
    // KB in their org (incl. drafts / group-restricted) — same policy as the
    // KB list & per-id guards (canUserAccessKB opts.isOrgAdmin).
    let effectiveKbIds = req.body.kb_ids || [];
    if (effectiveKbIds.length === 0) {
        const all = await kbStore.listKBs(userId, orgIds, { isOrgAdmin });
        effectiveKbIds = (all || [])
            .filter(kb => kbStore.canUserAccessKB(kb, userId, orgIds, userGroups, { isOrgAdmin }))
            .map(kb => kb.id);
        if (effectiveKbIds.length === 0) {
            return res.json({ chunks: [], results: [], kb_ids: [] });
        }
    } else {
        const kbRows = await getAll(
            `SELECT * FROM knowledge_bases WHERE id = ANY($1::uuid[])`,
            [effectiveKbIds]
        );
        const foundIds = new Set(kbRows.map(r => String(r.id)));
        const missing = effectiveKbIds.find(id => !foundIds.has(String(id)));
        if (missing) {
            return res.status(403).json({ error: `Access denied for KB ${missing}` });
        }
        for (const kb of kbRows) {
            if (!kbStore.canUserAccessKB(kb, userId, orgIds, userGroups, { isOrgAdmin })) {
                return res.status(403).json({ error: `Access denied for KB ${kb.id}` });
            }
        }
    }

    const useAzure = !!(await configStore.getConfig('use_azure_doc_processing'));
    const { resolveKbProvider } = require('../../core/kb/resolveProvider');
    const kbProvider = await resolveKbProvider();
    const useLocalKB = useAzure || kbProvider === 'local';

    let results;
    if (useLocalKB) {
        const { searchLocally } = require('../../core/kb/localKBIngest');
        const localResults = await searchLocally(userId, effectiveKbIds, query, { topK });
        results = {
            chunks: localResults,
            results: localResults
        };
    } else {
        const searchRes = await fetch(`${SEARCH_SERVICE_URL}/tools/kb-search`, {
            method: 'POST',
            headers: getServiceHeaders(),
            body: JSON.stringify({
                tenant_id: userId,
                kb_ids: effectiveKbIds,
                query,
                top_k: topK,
                rerank: true
            }),
            signal: AbortSignal.timeout(30000)
        });

        if (!searchRes.ok) {
            // The service's own text is for the log, not the caller: it can be
            // a traceback, an internal host name, or the dump of the request
            // this route built.
            const detail = await searchRes.text().catch(() => '');
            log.warn(`[KB] search-service answered ${searchRes.status}: ${detail.slice(0, 500)}`);
            throw new HttpError(502, 'search_failed', 'The search service could not answer this search.');
        }

        results = await searchRes.json();
        
        // Format chunks correctly regardless of what key the search-service uses
        if (!results.chunks && results.results) {
            results.chunks = results.results;
        }
    }

    // ── Filter Orphaned Chunks ────────────────────────────────────
    // searchLocally() already filters orphans (._orphanFiltered = true).
    // Only run this for the search-service path.
    const allChunks = [...(results.chunks || []), ...(results.results || [])];
    const alreadyFiltered = (results.chunks || results.results || [])?._orphanFiltered;
    if (!alreadyFiltered && allChunks.length > 0 && allChunks.some(c => c.document_id)) {
        try {
            const { getAll } = require('../../db');
            const dbDocs = await getAll('SELECT id FROM documents WHERE knowledge_base_id = ANY($1::uuid[])', [effectiveKbIds]);
            const validDocIds = new Set(dbDocs.map(d => String(d.id).toLowerCase()));
            const filterFn = c => !c.document_id || validDocIds.has(String(c.document_id).toLowerCase());
            
            if (results.chunks && Array.isArray(results.chunks)) {
                results.chunks = results.chunks.filter(filterFn);
            }
            if (results.results && Array.isArray(results.results)) {
                results.results = results.results.filter(filterFn);
            }
        } catch (filterErr) {
            log.warn('[KB] Orphan filter failed, skipping:', filterErr.message);
        }
    }

    res.json(results);
});
module.exports = router;
