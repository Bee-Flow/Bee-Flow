// @typecheck strict
'use strict';

/**
 * ── ALL DOCUMENTS OF ONE SOURCE AWAY, CHUNKS FIRST ──────────────────
 *
 * `documents.source_id` references `kb_sources` with `ON DELETE CASCADE` (stores/knowledgeBases.js).
 * As soon as the source row falls, Postgres sweeps every document row along, including the rows that
 * `deleteDocumentChunks` never went past. Only that function cleans up the vectors (local `kb_chunks`
 * AND `DELETE /kb/documents/{id}` on the search service), so a skipped row leaves its embeddings behind
 * for good: the text is gone from the screen and still findable in search. In a privacy product that IS the bug.
 *
 * One page of 200 is not enough for that: at 201 documents one stays behind, without anything going wrong
 * that could be reported. Hence the ROUNDS loop. After every round the list is taken again from the start,
 * not with a rising offset, because the previous round has already removed its own rows from the result set;
 * a rising offset would skip rows.
 *
 * ── WHY THIS IS ITS OWN MODULE ──────────────────────────────────────
 * This cleanup stood twice separately: once WITH a loop in
 * routes/knowledgeBases/sources.js, and once WITHOUT a loop in
 * routes/transcriptions/usage.js, where the comment moreover claimed to do the same as the KB route.
 * Two paths that must do the same thing should share the same code; this is that code.
 *
 * ── THE STORES COME IN, THEY ARE NOT REQUIRED ───────────────────────
 * `kbStore` and `deleteDocumentChunks` are parameters. Two reasons:
 * stores/knowledgeBases.js starts its own `initDB()` at module load, and
 * routes/transcriptions/usage.js requires its stores precisely in the handler, so a require here
 * would bypass that care through the back door. And it keeps this loop testable without a database:
 * both callers already have the two in hand at the moment they need it.
 *
 * ── "DONE" IS AN ANSWER, NOT AN ASSUMPTION ─────────────────────────
 * The loop stops for three reasons, and only one of them means "empty":
 *   - a round came back empty             → `complete: true`
 *   - a full round removed nothing        → `complete: false` (stop instead of looping
 *     over documents that refuse to go)
 *   - the round limit is reached          → `complete: false`
 * The caller MUST read `complete` before it removes the source row: if it does not, the FK cascades
 * away exactly the rows that were left behind. `errors` being empty is not the same as done: the
 * round limit throws nothing.
 */

/** Zoveel documenten per ronde opvragen, en zoveel ronden maximaal. */
const PAGE = 200;
const MAX_ROUNDS = 200;

/**
 * Remove the chunks and document rows of one knowledge-base source.
 *
 * Does NOT remove the SOURCE itself: that is a decision of the caller, and it should only be taken
 * once `complete` is true.
 *
 * @param {PurgeSourceArgs} p  `kbStore` is stores/knowledgeBases (or a double); `deleteDocumentChunks`
 *   core/kb/kbIngestionHelpers.deleteDocumentChunks; `kbId` the knowledge base in which the source sits;
 *   `sourceId` the `kb_sources.id`; `tenantId` the owner of the knowledge base (`knowledge_bases.tenant_id`);
 *   `pageSize` documents per round (default 200); `maxRounds` a hard upper bound on the rounds (default 200)
 * @returns {Promise<{deleted: number, errors: Array<{documentId: string, error: string}>, complete: boolean}>}
 */
async function purgeSourceDocuments({
    kbStore, deleteDocumentChunks, kbId, sourceId, tenantId,
    pageSize = PAGE, maxRounds = MAX_ROUNDS,
} = /** @type {PurgeSourceArgs} */ ({})) {
    // Without the two, nothing can be cleaned up. Throw instead of an empty-and-done answer:
    // the latter would let the caller remove the source while not a single chunk has gone yet.
    if (!kbStore || typeof kbStore.listDocuments !== 'function') {
        throw new Error('purgeSourceDocuments: kbStore.listDocuments is required');
    }
    if (typeof deleteDocumentChunks !== 'function') {
        throw new Error('purgeSourceDocuments: deleteDocumentChunks is required');
    }
    // An EMPTY source id is not "all sources", it is a programming error.
    // `buildDocumentFilters` (stores/knowledgeBases.js:79) adds the clause `source_id = ?` only if
    // `filters.sourceId` is truthy; the comment beneath it explains that trap itself: null "is falsy
    // and would silently match EVERY document". Without these two lines a third caller with a missing id
    // would sweep the WHOLE knowledge base empty and then be told "done". The same goes for `kbId`:
    // without a knowledge base there is no bound to stay within.
    if (typeof kbId !== 'string' || !kbId.trim()) {
        throw new Error('purgeSourceDocuments: kbId is required — an empty one is not "every knowledge base"');
    }
    if (typeof sourceId !== 'string' || !sourceId.trim()) {
        throw new Error('purgeSourceDocuments: sourceId is required — an empty one would match EVERY document');
    }

    const perRound = Number(pageSize) > 0 ? Number(pageSize) : PAGE;
    const rounds = Number(maxRounds) > 0 ? Number(maxRounds) : MAX_ROUNDS;

    let deleted = 0;
    /** @type {{ documentId: string, error: string }[]} */
    const errors = [];
    let complete = false;

    for (let round = 0; round < rounds; round++) {
        const docs = await kbStore.listDocuments(kbId, { limit: perRound, filters: { sourceId } });
        if (!docs || docs.length === 0) { complete = true; break; }
        let removedThisRound = 0;
        for (const doc of docs) {
            try {
                // skipSnapshot: this is a SOURCE-driven deletion. A copy per cleanup in kb_document_versions fills an
                // audit table that has no wipe path: precisely the opposite of what is needed here.
                await deleteDocumentChunks(kbId, doc.id, tenantId, { skipSnapshot: true });
                deleted++;
                removedThisRound++;
            } catch (err) {
                // One row per document: a document that refuses again every round should not appear six times in
                // the list. The FIRST error stays: that is the one closest to the cause.
                if (!errors.some(e => e.documentId === doc.id)) {
                    errors.push({ documentId: doc.id, error: err.message });
                }
            }
        }
        // Nothing came off in a full round: stop, and do NOT report done.
        if (removedThisRound === 0) break;
    }

    return { deleted, errors, complete };
}

module.exports = { purgeSourceDocuments, PAGE, MAX_ROUNDS };

/**
 * @typedef {{ kbStore: Partial<typeof import('../../stores/knowledgeBases')>,
 *   deleteDocumentChunks: typeof import('./kbReingest').deleteDocumentChunks, kbId: string, sourceId: string,
 *   tenantId: string, pageSize?: number, maxRounds?: number }} PurgeSourceArgs
 */
