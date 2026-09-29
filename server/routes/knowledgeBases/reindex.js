/**
 * Knowledge Bases — re-index.
 *
 * POST /:id/reindex — rebuild chunks and re-embed every document in a KB.
 * The one time this is genuinely needed is an embedding-model switch: the
 * vectors already stored were produced by a different model and no longer
 * sit in the same space as a new query's.
 *
 * ── IT IS NOT A BUTTON ANY MORE ─────────────────────────────────────
 * "Re-index" left the Studio with K2. It describes the retrieval
 * implementation rather than the person's material, and offering it as a
 * verb taught every owner that a knowledge base is a thing you periodically
 * have to repair. The ROUTE stays — an operator switching embedding models
 * needs it, and so does the admin surface — behind `manage_knowledge`.
 *
 * ── AND IT NO LONGER HAS AN INGEST PIPELINE OF ITS OWN ──────────────
 * This file used to carry a second copy of the whole ingest: re-fetch web
 * pages, branch on Azure vs local vs search-service, call the search service
 * directly, patch chunk counts by hand. That copy drifted — it was the last
 * place still writing `source_uri` in snake_case, so every re-indexed chunk
 * lost its citation link (fixed in K1), and it knew nothing about document
 * status, so a skipped file stayed skipped forever.
 *
 * Now it drives `core/kb/sources.syncSource` once per source, with
 * `reason:'reembed'`. That is the same engine the schedule and "Refresh now"
 * use, so re-indexing cannot drift from refreshing again: a web source is
 * re-fetched, an upload or text source is re-chunked from its stored text,
 * and every document keeps its id — which is what stops a re-index from
 * invalidating every citation ever made.
 *
 * Documents that belong to NO source (rows predating the source model, or
 * ingested through a wrapper before the backfill ran) are reported rather
 * than silently skipped: the honest answer is "these need the backfill
 * migration", not a success count that quietly excludes them.
 *
 * ── IT TAKES NO BODY, AND SAYS SO ───────────────────────────────────
 * A re-index is always the whole knowledge base: every source, re-fetched and
 * re-embedded. The body used to be ignored, so `{ "sourceIds": [...] }` or
 * `{ "dryRun": true }` started exactly that full pass under a 200. A key that
 * reads as if it narrows the work is refused now instead.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const kbStore = require('../../stores/knowledgeBases');
const kbSourcesStore = require('../../stores/kbSources');
const { requireAuth, requirePermission } = require('../../auth');
const { canAccessKB, blockIfSystemKB } = require('./shared');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

/** Express 5 leaves `req.body` undefined without a body; the Studio sends none. */
const NoBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({}).strict());

// ── Re-index ────────────────────────────────────────────────────────

router.post('/:id/reindex', requireAuth, requirePermission('manage_knowledge'), validate({ body: NoBody }), async (req, res) => {
    const kb = await kbStore.getKB(req.params.id);
    if (!kb) return res.status(404).json({ error: 'KB not found' });
    if (!(await canAccessKB(req, kb))) return res.status(403).json({ error: 'Access denied' });
    if (blockIfSystemKB(kb, res)) return;

    const { syncSource } = require('../../core/kb/sources');
    const sources = await kbSourcesStore.listByKb(kb.id);

    const results = { reindexed: 0, failed: 0, details: [] };
    for (const source of sources) {
        try {
            const r = await syncSource(source, {
                reason: 'reembed',
                // A re-index is a deliberate operator action, not a tick:
                // it may take as long as it takes rather than yielding to
                // a schedule that is not running.
                timeBudgetMs: 10 * 60_000,
            });
            if (r.skipped) {
                results.details.push({ source_id: source.id, name: source.name, status: 'skipped', reason: r.skipped });
                continue;
            }
            results.reindexed += (r.added || 0) + (r.updated || 0);
            results.failed += r.failed || 0;
            results.details.push({
                source_id: source.id, name: source.name, status: 'reembedded',
                added: r.added, updated: r.updated, unchanged: r.unchanged, removed: r.removed, failed: r.failed,
            });
        } catch (e) {
            results.failed += 1;
            results.details.push({ source_id: source.id, name: source.name, status: 'error', reason: e.message });
        }
    }

    // Rows no source owns cannot be driven through the engine. Say so.
    const orphanCount = await kbStore.countDocuments(kb.id, { noSource: true }).catch(() => 0);
    const orphans = Number(orphanCount) || 0;

    log.info(`[KB] Re-index of "${kb.name}": ${results.reindexed} document(s) across ${sources.length} source(s), ${results.failed} failed`);

    res.json({
        success: true,
        reindexed: results.reindexed,
        failed: results.failed,
        sources: sources.length,
        // Not an error, but not nothing either: these documents were NOT
        // re-embedded and a caller that reports only `reindexed` would
        // claim a complete pass over a knowledge base that still holds
        // vectors from the old model.
        unattached: orphans,
        details: results.details,
    });
});

module.exports = router;
