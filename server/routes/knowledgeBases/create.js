// @typecheck noImplicitAny
/**
 * Knowledge Bases — creation.
 *
 * POST /             — create a manual KB in the caller's organisation
 * POST /:id/duplicate — copy a KB shell (no documents) for a new use case
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const kbStore = require('../../stores/knowledgeBases');
const { requireAuth, requirePermission, assertUserCanUseOrg } = require('../../auth');
const { getUserId, canAccessKB, sanitizeUsageContexts } = require('./shared');
const { validate } = require('../../core/http/validate');
const { z, typeError } = require('../../utils/zod');
const { worded } = require('../../core/http/schemaParts');

// ── What a caller may send ──────────────────────────────────────────
//
// `.strict()`: a key this router does not read is a client bug, and
// answering 201 to it means the knowledge base is made without the setting
// the person typed, with nothing on screen to say so. `sourceKind` is the
// one to watch — anything made here is a manual KB, and a caller asking for
// another kind should hear so rather than be quietly overruled.

const NAME_TEXT = 'A knowledge base needs a name.';
const CreateKbBody = z.object({
    name: worded(NAME_TEXT).trim().min(1, NAME_TEXT).max(200, 'A name is at most 200 characters.'),
    description: worded('A description must be text.').nullish(),
    // Whether the caller may use this organisation is assertUserCanUseOrg's
    // answer; all the schema says is that an id arrived as text.
    organizationId: worded('organizationId is the id of an organisation.').trim().min(1).nullish(),
    categoryId: worded('categoryId is the id of a category.').trim().min(1).nullish(),
    icon: worded('An icon must be text.').trim().max(64, 'An icon is at most 64 characters.').nullish(),
    usageContexts: z.array(worded('Each usage context must be text.'),
        { error: typeError({ invalid: 'usageContexts is a list of contexts.' }) }).nullish(),
}).strict();

const WITH_SOURCES = 'withSources is "1" to copy the sources too.';
const DuplicateQuery = z.object({
    withSources: worded(WITH_SOURCES).trim().min(1, WITH_SOURCES).optional(),
}).strict();

/**
 * Create a new KB (auto-assigns to user's organization)
 */
router.post('/', requireAuth, requirePermission('manage_knowledge'), validate({ body: CreateKbBody }), async (/** @type {import('express').Request<{}, any, import('zod').infer<typeof CreateKbBody>, import('qs').ParsedQs>} */ req, res) => {
    const userId = getUserId(req);
    const { name, description, organizationId, categoryId, icon, usageContexts } = req.body;

    // Validate the user actually belongs to the requested org (or assign
    // their primary org). Trusting organizationId from the body would let
    // any member create KBs in other orgs.
    let assignOrgId;
    assignOrgId = await assertUserCanUseOrg(req, organizationId);

    const cleanedContexts = sanitizeUsageContexts(usageContexts);

    // sourceKind is intentionally NOT taken from the request body — anything
    // created via this route is a manual KB. The webpage/notebook auto-create
    // paths call kbStore.createKB() directly with sourceKind set.
    const kb = await kbStore.createKB(
        userId,
        name,
        description || '',
        assignOrgId || null,
        {
            categoryId: categoryId || null,
            icon: icon || null,
            sourceKind: 'manual',
            ...(cleanedContexts ? { usageContexts: cleanedContexts } : {}),
        }
    );
    res.status(201).json(kb);
});

// Duplicate a Knowledge Base's structure. Copies the KB shell —
// name ("Copy of …"), description, category, icon and usage contexts — into a
// new manual KB owned by the requester. Documents are NOT copied (their chunks
// + embeddings live in the search service); the user adds/swaps sources for the
// new use case. Requires manage_knowledge + read access to the source KB.
//
// `?withSources=1` (K5) also copies the SOURCES, which then fetch their own
// content on the next refresh — current, rather than a snapshot of somebody
// else's last run.
router.post('/:id/duplicate', requireAuth, requirePermission('manage_knowledge'), validate({ query: DuplicateQuery }), async (/** @type {import('express').Request<{ id: string }, any, any, import('zod').infer<typeof DuplicateQuery>>} */ req, res) => {
    const userId = getUserId(req);
    const source = await kbStore.getKB(req.params.id);
    if (!source) return res.status(404).json({ error: 'Knowledge base not found' });
    if (!await canAccessKB(req, source)) return res.status(404).json({ error: 'Knowledge base not found' });

    // Personal KBs (organization_id null) copy as personal; org KBs stay in
    // the same org when the requester may use it, else fall back to personal.
    let assignOrgId = source.organization_id || null;
    if (assignOrgId) {
        try { assignOrgId = await assertUserCanUseOrg(req, assignOrgId); } catch (_) { assignOrgId = null; }
    }

    let usageContexts = null;
    try { usageContexts = Array.isArray(source.usage_contexts) ? source.usage_contexts : JSON.parse(source.usage_contexts || 'null'); } catch (_) { usageContexts = null; }

    const copy = await kbStore.createKB(
        userId,
        `Copy of ${source.name}`.slice(0, 200),
        source.description || '',
        assignOrgId || null,
        {
            categoryId: source.category_id || null,
            icon: source.icon || null,
            sourceKind: 'manual',
            ...(Array.isArray(usageContexts) ? { usageContexts } : {}),
        }
    );
    /**
     * `?withSources=1` — copy the SOURCES too, and let them fetch.
     *
     * Documents are still not copied, and that is the point rather than a
     * limitation: a source knows how to produce its documents, so a copied
     * webpage or Nextcloud folder refills itself on its first refresh with
     * content that is current rather than a snapshot of somebody else's
     * last run. Copying the documents would duplicate the chunks and the
     * embeddings in the search service for text that is about to be
     * replaced anyway.
     *
     * A `text` source is the exception — its content IS its config, so it
     * copies whole and re-embeds. An `upload` source has nothing to fetch
     * (its documents came from files somebody dragged in), so it is
     * skipped: an empty upload source in the copy would look like a broken
     * one rather than an absent one.
     *
     * Best-effort per source: the copy already exists by the time this
     * runs, and failing the response over one source that would not copy
     * would leave the person with a knowledge base they were told they did
     * not get.
     */
    let sourcesCopied = 0;
    if (req.query.withSources === '1') {
        try {
            const kbSourcesStore = require('../../stores/kbSources');
            const { stripUnauthorizedTranscriptOrigin } = require('../../core/kb/transcriptOrigin');
            const sources = await kbSourcesStore.listByKb(source.id);
            for (const src of (sources || [])) {
                if (src.kind === 'upload') continue;
                try {
                    /**
                     * ── THE CONFIG IS NOT ALWAYS JUST CONTENT ────────
                     * A `text` source can carry an ASSERTION:
                     * `config.metadata.transcriptionId` pins the line onto
                     * the timeline of that meeting — the run bar,
                     * the Used-by tab and the delete gate of
                     * the note all read it. The right that this route
                     * demands (`manage_knowledge` + read access to the
                     * SOURCE knowledge base) is read access to a published
                     * knowledge base, and that says nothing about the meeting
                     * to which that line points. Without this sieve
                     * anyone with an org-wide KB in view could, with one
                     * `?withSources=1`, paste a line onto the private
                     * meeting of a colleague — repeatably, and
                     * visible to that colleague on screen.
                     *
                     * The SOURCE simply copies along (that is content the
                     * caller may read); only the claim is dropped if he
                     * may not see that meeting — or if we could not
                     * establish it.
                     */
                    const safeConfig = await stripUnauthorizedTranscriptOrigin(src.config, userId);
                    await kbSourcesStore.create({
                        knowledgeBaseId: copy.id,
                        kind: src.kind,
                        name: src.name || '',
                        config: safeConfig,
                        // The schedule copies with the source: an author
                        // duplicating a base that refreshes nightly means
                        // the copy to refresh nightly. `nextRefreshAt` is
                        // deliberately left for the arming logic to set,
                        // so the copy does not inherit a due time that has
                        // already passed and fire the moment it exists.
                        refreshMode: src.refreshMode || 'manual',
                        refreshCron: src.refreshCron || null,
                        refreshTz: src.refreshTz || null,
                        createdBy: userId,
                    });
                    sourcesCopied += 1;
                } catch (e) {
                    log.warn(`[KB] Duplicate: source "${src.name || src.kind}" did not copy: ${e.message}`);
                }
            }
        } catch (e) {
            // No kb_sources table on this install, or the list failed. The
            // shell copy stands.
            log.warn('[KB] Duplicate: sources unavailable:', e.message);
        }
    }

    res.status(201).json({ ...copy, sourcesCopied });
});
module.exports = router;
