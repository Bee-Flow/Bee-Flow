// @typecheck
/**
 * Knowledge Bases — sources (K1).
 *
 * A source is *where* a KB's documents come from. This router is the whole
 * public surface of the model:
 *
 *   GET    /:id/sources                       — the KB's sources + counters
 *   POST   /:id/sources                       — create one (text | upload | webpage)
 *   POST   /:id/sources/:sid/files            — add files to an upload source (202)
 *   PATCH  /:id/sources/:sid                  — rename / change the refresh rule
 *   DELETE /:id/sources/:sid                  — remove it, its documents and their chunks
 *   POST   /:id/sources/:sid/refresh          — ask for a refresh now
 *   GET    /:id/sources/:sid/documents        — the source's documents (projected)
 *   GET    /:id/sources/:sid/documents/:docId — one document (projected)
 *
 * Mounted BEFORE routes/knowledgeBases/detail.js — order is semantics.
 *
 * Authorization: reads go through `canAccessKB`, writes through
 * `requirePermission('manage_knowledge')` + `canManageKB` + `blockIfSystemKB`.
 * Never the notebook owner-check: a KB is shared, a notebook is not.
 *
 * Two things this file deliberately does NOT do, because they belong to K3
 * (the refresh engine): it never walks a crawl, and it never runs a scheduled
 * refresh. `POST /refresh` only sets `next_refresh_at = now()`.
 */


// The policy and helpers live in sourcePolicy.js, the create/patch bodies in
// sourceSchemas.js, creating a source in sourceCreate.js and the file upload
// in sourceUploads.js. This file keeps the route table, in its order.

const express = require('express');
const log = require('../../telemetry/log');
const { HttpError } = require('../../core/http/errors');
const { validate } = require('../../core/http/validate');
const { z } = require('../../utils/zod');
const { worded } = require('../../core/http/schemaParts');
const router = express.Router();

const kbStore = require('../../stores/knowledgeBases');
const kbSourcesStore = require('../../stores/kbSources');
const { adoptOrphanDocuments } = require('../../stores/kb/adoptOrphanDocuments')(() => kbSourcesStore.initDB());
const { requireAuth, requirePermission } = require('../../auth');
const { getUserId } = require('./shared');
const { PROJECT_FILES_SOURCE_KIND } = require('../../core/kb/projectFilesKb');
const {
    CREATABLE_KINDS, REFRESH_MODES_BY_KIND, REFRESH_LABEL_KEYS, DEFAULT_DOC_PAGE, MAX_DOC_PAGE,
    helpers, resolveKb, resolveSource, publicSourceConfig, resolveCreators, mapSourceForApi, refreshPatchFor,
} = require('./sourcePolicy');
const { CreateSourceBody, PatchSourceBody } = require('./sourceSchemas');
const { createSource } = require('./sourceCreate');
const { acceptUploads, settleUploads, addFiles } = require('./sourceUploads');
// After the sibling modules: Node caches a relative require per directory,
// and the tests that cut this router's require seam rely on those modules
// binding their stores before docFilters (outside the seam) does.
const { statusFilter, piiFilter } = require('./docFilters');

/**
 * Paging is clamped, not refused: a page size out of range is still a page.
 *
 * `status`/`pii` are checked against the store's own vocabulary, not just
 * "is text" — buildDocumentFilters() (stores/knowledgeBases.js) drops any
 * status it does not recognise from its filter list, and with none left it
 * adds no status clause at all. `?status=eror` used to pass a bare-text
 * check and come back with the WHOLE source's documents under a 200, the
 * same failure routes/knowledgeBases/documents.js closed for the KB-wide
 * list. Comma-separated, like the store reads it: every entry must be a
 * real status, because an empty list after filtering is no filter at all.
 */
const DocumentsQuery = z.object({
    limit: z.coerce.number().catch(DEFAULT_DOC_PAGE)
        .transform((n) => Math.min(Math.max(Math.trunc(n) || DEFAULT_DOC_PAGE, 1), MAX_DOC_PAGE))
        .prefault(DEFAULT_DOC_PAGE),
    offset: z.coerce.number().catch(0)
        .transform((n) => Math.max(Math.trunc(n) || 0, 0))
        .prefault(0),
    // Shared with routes/knowledgeBases/documents.js — see ./docFilters.
    status: statusFilter().optional(),
    pii: piiFilter().optional(),
    q: worded('The search term must be text.').trim().max(200).optional(),
}).strict();

function parseDocFilters(req, sourceId) {
    return {
        sourceId,
        status: req.query.status || undefined,
        pii: req.query.pii || undefined,
        q: req.query.q || undefined,
    };
}

// ── GET /:id/sources ────────────────────────────────────────────────

router.get('/:id/sources', requireAuth, async (req, res) => {
    const kb = await resolveKb(req, res);
    if (!kb) return;

    // Documents from before the source model have no source and would be
    // invisible here while the overview counts them: adopt them first. Scoped
    // to this KB; a failure must not take the listing down.
    // Never on a system base or a project's files base: they are read-only here.
    try {
        if (!kbStore.isSystemKB(kb) && kb.source_kind !== PROJECT_FILES_SOURCE_KIND) {
            await adoptOrphanDocuments(kb.id);
        }
    } catch (e) {
        log.warn('[KB] Adopting source-less documents failed:', e.message);
    }
    const sources = await kbSourcesStore.listByKb(kb.id);
    const counts = sources.length > 0
        ? await kbStore.countsBySource(sources.map(s => s.id))
        : {};
    const creators = await resolveCreators(sources.map(s => s.createdBy));
    const items = sources.map(s => mapSourceForApi(s, counts[s.id], creators));

    const totals = items.reduce((acc, s) => ({
        sourceCount: acc.sourceCount + 1,
        autoRefreshCount: acc.autoRefreshCount + (s.refreshMode !== 'manual' ? 1 : 0),
        errorSourceCount: acc.errorSourceCount + (s.status === 'error' ? 1 : 0),
        documentCount: acc.documentCount + s.documentCount,
        processedCount: acc.processedCount + s.processedCount,
        redactedCount: acc.redactedCount + s.redactedCount,
        skippedCount: acc.skippedCount + s.skippedCount,
        errorCount: acc.errorCount + s.errorCount,
        duplicateCount: acc.duplicateCount + s.duplicateCount,
        piiFoundCount: acc.piiFoundCount + s.piiFoundCount,
        totalChunks: acc.totalChunks + s.totalChunks,
    }), {
        sourceCount: 0, autoRefreshCount: 0, errorSourceCount: 0, documentCount: 0,
        processedCount: 0, redactedCount: 0, skippedCount: 0, errorCount: 0,
        duplicateCount: 0, piiFoundCount: 0, totalChunks: 0,
    });

    res.json({ sources: items, totals });
});
// ── POST /:id/sources ───────────────────────────────────────────────

router.post('/:id/sources', requireAuth, requirePermission('manage_knowledge'), validate({ body: CreateSourceBody }), createSource);

// ── POST /:id/sources/:sid/files ────────────────────────────────────

router.post('/:id/sources/:sid/files', requireAuth, requirePermission('manage_knowledge'), acceptUploads, addFiles);

// ── PATCH /:id/sources/:sid ─────────────────────────────────────────
// ── PATCH /:id/sources/:sid ─────────────────────────────────────────

router.patch('/:id/sources/:sid', requireAuth, requirePermission('manage_knowledge'), validate({ body: PatchSourceBody }), async (req, res, next) => {
    try {
        const kb = await resolveKb(req, res, { manage: true });
        if (!kb) return;
        const source = await resolveSource(kb, req, res);
        if (!source) return;

        const { name, refresh } = req.body;
        const patch = refreshPatchFor(refresh, source.kind);
        if (name !== undefined) patch.name = name;
        // Switching back to manual clears the schedule so no stale cron fires.
        if (patch.refreshMode === 'manual') {
            if (patch.refreshCron === undefined) patch.refreshCron = null;
            patch.nextRefreshAt = null;
        }

        /**
         * Switching TO a schedule (or editing one) has to arm it.
         *
         * `next_refresh_at` is the ONLY thing `claimDue` looks at, so a
         * source saved with a perfectly good cron and a null next-run is a
         * source that silently never refreshes — and the UI would show its
         * schedule the whole time, which is worse than showing nothing. The
         * timestamp is computed from the row as it will be AFTER this patch,
         * not as it is now, or editing the cron of an already-scheduled
         * source would arm the old one.
         *
         * `live` is deliberately excluded: it is answered from its upstream
         * at query time (K8) and a due timestamp would put it in the tick's
         * way forever.
         */
        const nextMode = patch.refreshMode ?? source.refreshMode;
        if (nextMode !== 'manual' && nextMode !== 'live' && patch.nextRefreshAt === undefined) {
            const scheduleTouched = patch.refreshMode !== undefined
                || patch.refreshCron !== undefined
                || patch.refreshTz !== undefined;
            if (scheduleTouched) {
                const { nextRefreshFor } = require('../../core/kb/sources');
                patch.nextRefreshAt = nextRefreshFor({
                    refreshMode: nextMode,
                    refreshCron: patch.refreshCron !== undefined ? patch.refreshCron : source.refreshCron,
                    refreshTz: patch.refreshTz !== undefined ? patch.refreshTz : source.refreshTz,
                });
            }
        }

        const updated = await kbSourcesStore.update(source.id, patch);
        const counts = await kbStore.countsBySource([source.id]);
        res.json({ source: mapSourceForApi(updated, counts[source.id], await resolveCreators([updated.createdBy])) });
    } catch (e) {
        if (e instanceof HttpError) return next(e);
        if (e.code === 'invalid_refresh_mode' || e.code === 'invalid_status') {
            return res.status(400).json({ error: e.message, code: e.code });
        }
        log.error('[KB] Update source error:', e.message);
        next(e);
    }
});

// ── DELETE /:id/sources/:sid ────────────────────────────────────────

router.delete('/:id/sources/:sid', requireAuth, requirePermission('manage_knowledge'), async (req, res) => {
    const kb = await resolveKb(req, res, { manage: true });
    if (!kb) return;
    const source = await resolveSource(kb, req, res);
    if (!source) return;

    // Chunks first. The FK cascades the documents rows when the source
    // goes, which would leave their embeddings searchable forever — in a
    // privacy product, deleted text that keeps answering questions is the
    // bug. The rounds loop that makes that true past the first page of 200
    // lives in core/kb/purgeSourceDocuments.js, shared with the meeting
    // notes unfile path (DELETE /api/transcriptions/:id/filed-lines) so the
    // two cannot drift apart again.
    const { purgeSourceDocuments } = require('../../core/kb/purgeSourceDocuments');
    const { deleted, errors, complete } = await purgeSourceDocuments({
        kbStore, deleteDocumentChunks: helpers().deleteDocumentChunks,
        kbId: kb.id, sourceId: source.id, tenantId: kb.tenant_id,
    });

    // DE BRON VALT PAS ALS DE OPRUIMING KLAAR IS. Deze route haalde de
    // bronrij ONVOORWAARDELIJK weg en meldde de mislukkingen erbij in
    // `errors` — met `success: true` erboven. Dat is fail-open op precies
    // het punt waar het pijn doet: de FK cascadeert dan juist de
    // documentrijen weg waar `deleteDocumentChunks` NIET langs is geweest,
    // en hun embeddings blijven doorzoekbaar zonder rij om ze aan te
    // wijzen. De prijs van de andere kant (een bron die blijft staan) is
    // een knop die je nog een keer indrukt; deze kant is onherstelbaar.
    // 409 en niet 500: er is niets stukgegaan aan onze kant, de toestand
    // laat het (nu) niet toe. Wat er wél af is staat in `deletedDocuments`.
    if (!complete) {
        log.warn('[KB] source kept, documents remain:', source.id, errors[0]?.error || 'documents remained after cleanup');
        return res.status(409).json({
            error: 'Some documents could not be removed, so the source was kept',
            code: 'purge_incomplete',
            deletedDocuments: deleted,
            errors,
        });
    }

    await kbSourcesStore.remove(source.id);

    // The datatable's "Used by" must stop naming this knowledge base, or
    // deleting the table would go on asking about a source that is gone.
    // Reconciled for the WHOLE knowledge base — `reconcileUsageFor` is
    // delete-then-insert per consumer, so handing it only what is left is
    // exactly right, and handing it one source would erase its siblings.
    if (source.kind === 'datatable') {
        try {
            const { resolveDatatableForStep } = require('../../core/automationRunner/datatableResolve');
            const { askerContext } = require('../../core/kb/askerContext');
            const asker = await askerContext(getUserId(req));
            const resolved = await resolveDatatableForStep(source.config?.datatableId, {
                userId: getUserId(req),
                orgId: [...asker.orgIds][0] || null,
                userGroupIds: asker.userGroups,
            }, { needed: 'viewer' });
            await require('../../core/kb/sources/datatable').reconcileUsage(kb.id, resolved.scope);
        } catch (e) {
            // The table may have been deleted first, which took its usage
            // rows with it. Nothing to reconcile, and nothing to report.
            log.warn('[KB] datatable usage not reconciled after source delete:', e.message);
        }
    }

    res.json({ success: true, deletedDocuments: deleted, errors });
});

// ── POST /:id/sources/:sid/refresh ──────────────────────────────────

router.post('/:id/sources/:sid/refresh', requireAuth, requirePermission('manage_knowledge'), async (req, res) => {
    const kb = await resolveKb(req, res, { manage: true });
    if (!kb) return;
    const source = await resolveSource(kb, req, res);
    if (!source) return;

    const updated = await kbSourcesStore.requestRefresh(source.id);
    res.status(202).json({
        queued: true,
        source: mapSourceForApi(updated || source, null, await resolveCreators([source.createdBy])),
    });
});

// ── GET /:id/sources/:sid/documents ─────────────────────────────────

router.get('/:id/sources/:sid/documents', requireAuth, validate({ query: DocumentsQuery }), async (req, res) => {
    const kb = await resolveKb(req, res);
    if (!kb) return;
    const source = await resolveSource(kb, req, res);
    if (!source) return;

    const { limit, offset } = req.query;
    const filters = parseDocFilters(req, source.id);

    // listDocuments/countDocuments read the projection — original_content
    // is not in DOCUMENT_COLUMNS and never reaches this response.
    const [documents, total] = await Promise.all([
        kbStore.listDocuments(kb.id, { limit, offset, filters }),
        kbStore.countDocuments(kb.id, filters),
    ]);
    res.json({ documents, total, limit, offset });
});

// ── GET /:id/sources/:sid/documents/:docId ──────────────────────────

router.get('/:id/sources/:sid/documents/:docId', requireAuth, async (req, res) => {
    const kb = await resolveKb(req, res);
    if (!kb) return;
    const source = await resolveSource(kb, req, res);
    if (!source) return;

    const doc = await kbStore.getDocument(req.params.docId);
    if (!doc || String(doc.knowledge_base_id) !== String(kb.id) || String(doc.source_id || '') !== String(source.id)) {
        return res.status(404).json({ error: 'Document not found', code: 'document_not_found' });
    }
    res.json({ document: doc });
});

module.exports = Object.assign(router, {
    CREATABLE_KINDS,
    REFRESH_MODES_BY_KIND,
    REFRESH_LABEL_KEYS,
    publicSourceConfig,
    settleUploads,
});
