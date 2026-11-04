// @typecheck strict
/**
 * The end of a knowledge-source pass (core/kb/sources/index.js syncSource):
 * removing what the source does not offer any more, and labelling the documents the
 * pass touched.
 */

/** @typedef {import('./index').SyncCtx} SyncCtx */
/** @typedef {import('./index').SyncDeps} SyncDeps */

/**
 * Gone: stored, still matchable, and the source does not offer it now.
 * Only when the pass actually COMPLETED — a cancelled or truncated pass
 * saw part of the source, and "I did not look" must never read as "it is
 * not there any more".
 *
 * `ctx.partial` is the adapter saying its LIST stopped short (a cap on
 * what it will enumerate). Not `truncated`: running again at once would
 * read the same short list, so the source keeps its schedule, and only
 * the deletions are held back.
 * @param {SyncCtx} ctx
 * @param {{ byExternalId: Map<string, { id: string }>, seen: Set<string>,
 *   counts: { removed: number, failed: number, cancelled?: unknown, truncated?: unknown } }} pass
 * @param {SyncDeps} deps
 */
async function removeUnseenDocuments(ctx, { byExternalId, seen, counts }, deps) {
    const { source, kb } = ctx;
    const complete = !counts.cancelled && !counts.truncated && !ctx.partial;
    if (ctx.partial) ctx.log(`source ${source.id}: the source listed only part of what it holds; nothing was removed`);
    if (!complete) return;
    for (const [externalId, doc] of byExternalId) {
        if (seen.has(externalId)) continue;
        try {
            await deps.helpers.deleteDocumentChunks(kb.id, doc.id, ctx.tenantId, { skipSnapshot: true });
            counts.removed += 1;
        } catch (e) {
            counts.failed += 1;
            ctx.log(`source ${source.id} delete ${doc.id} failed: ${/** @type {Error} */ (e).message}`);
        }
    }
}

/** How many summaries may be in flight at once. */
const SUMMARY_CONCURRENCY = 3;

/**
 * Write the "what the AI took from it" line for the documents this pass
 * touched.
 *
 * Bounded concurrency, and every failure swallowed: a label is a nicety and
 * the documents are already stored and searchable without one. A refresh that
 * failed because a summariser was rate-limited would be a refresh that failed
 * for no reason the person would accept.
 * @param {Array<{ docId: string, text: string, title: string }>} items
 * @param {SyncCtx} ctx
 * @param {SyncDeps} deps
 */
async function labelDocuments(items, ctx, deps) {
    if (!items.length) return;
    const summariser = deps.extractSummary || require('../extractSummary');
    let cursor = 0;
    const workers = Array.from({ length: Math.min(SUMMARY_CONCURRENCY, items.length) }, async () => {
        for (;;) {
            const i = cursor++;
            if (i >= items.length) return;
            const item = items[i];
            // Between labels, so a cancelled refresh stops summarising too.
            if (await deps.kbSourcesStore.isCancelRequested(ctx.source.id)) return;
            try {
                const r = await summariser.summarise({ text: item.text, title: item.title });
                if (r?.summary) await deps.kbStore.replaceDocumentContent(item.docId, { extractSummary: r.summary });
            } catch (e) {
                ctx.log(`summary for ${item.docId} skipped: ${/** @type {Error} */ (e).message}`);
            }
        }
    });
    await Promise.all(workers);
}

module.exports = { removeUnseenDocuments, labelDocuments };
