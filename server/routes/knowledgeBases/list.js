/**
 * Knowledge Bases — listing.
 *
 * GET /          — every KB the caller can reach (personal + org-scoped)
 * GET /published — the org-published subset, drafts excluded
 *
 * ── A FILTER THAT DID NOT PARSE USED TO MEAN "NO FILTER" ────────────
 * `?context=` is how a picker asks for only the bases its owner allowed on
 * that surface. listFilterFromQuery reads anything it does not recognise as
 * null, and null means unfiltered: `?context=agnet` handed the agent picker
 * every base, including those switched off for agents, and a misspelled key
 * (`?contxt=agent`) did the same. The same key given twice arrived as an array
 * and threw on `.trim()` — a 500 for the whole list. `?includeAuto=true` read
 * as "no". All of those are 400s now that name the parameter; the values the
 * pickers send are unchanged, and so is the Agent Hub's `?t=` cache-buster.
 */

const express = require('express');
const router = express.Router();
const kbStore = require('../../stores/knowledgeBases');
const { requireAuth, resolveUserOrgIds } = require('../../auth');
const {
    getUserId,
    resolveUserGroups,
    resolveIsOrgAdmin,
    resolveEnabledSystemSlugs,
    listFilterFromQuery,
    VALID_USAGE_CONTEXTS,
} = require('./shared');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

const SURFACES = [...VALID_USAGE_CONTEXTS];

/**
 * One usage context, as listFilterFromQuery reads it: trimmed, and an empty
 * value is no filter — which is what it has always been.
 */
const surface = (name) => z.preprocess(
    (v) => (typeof v === 'string' ? (v.trim() || undefined) : v),
    z.enum(SURFACES, { errorMap: () => ({ message: `${name} is one of: ${SURFACES.join(', ')}.` }) }).optional(),
);

const INCLUDE_AUTO_TEXT = 'includeAuto is 1 or 0 (true and false work too).';
const ListQuery = z.object({
    context: surface('context'),
    excludeContext: surface('excludeContext'),
    // listFilterFromQuery asks `=== '1'`, so every "yes" reaches it as that.
    // An empty value stays what it was: absent.
    includeAuto: z.preprocess(
        (v) => (v === '' ? undefined : v),
        z.enum(['1', '0', 'true', 'false'], { errorMap: () => ({ message: INCLUDE_AUTO_TEXT }) })
            .transform((v) => (v === '1' || v === 'true' ? '1' : '0'))
            .optional(),
    ),
    // The Agent Hub adds ?t=<Date.now()> to dodge caches; it means nothing here.
    t: z.string().optional(),
}).strict();

// ── KB CRUD ─────────────────────────────────────────────────────────

/**
 * List all KBs accessible to the current user (personal + org-scoped)
 */
router.get('/', requireAuth, validate({ query: ListQuery }), async (req, res) => {
    const userId = getUserId(req);
    const orgIds = await resolveUserOrgIds(req);
    const isOrgAdmin = await resolveIsOrgAdmin(req);
    const systemSlugs = await resolveEnabledSystemSlugs(req);
    const kbs = await kbStore.listKBs(userId, orgIds, { ...listFilterFromQuery(req), systemSlugs, isOrgAdmin });
    const userGroups = await resolveUserGroups(req);
    // Owners always see drafts; org admins see every org KB (incl. drafts);
    // regular org members see only published KBs that pass shared_groups.
    const filtered = kbStore.filterByGroupAccess(kbs, userId, userGroups, { orgIds, isOrgAdmin });
    res.json(filtered);
});

/**
 * List org-published KBs (mirrors /api/agents/published). Drafts are excluded.
 */
router.get('/published', requireAuth, validate({ query: ListQuery }), async (req, res) => {
    const userId = getUserId(req);
    const orgIds = await resolveUserOrgIds(req);
    const userGroups = await resolveUserGroups(req);
    const systemSlugs = await resolveEnabledSystemSlugs(req);
    const kbs = await kbStore.listKBs(userId, orgIds, { ...listFilterFromQuery(req), systemSlugs });
    const accessible = kbStore.filterByGroupAccess(kbs, userId, userGroups);
    // Only KBs that are explicitly published (drafts owned by the user are dropped here)
    res.json(accessible.filter(kb => !!kb.is_published));
});
module.exports = router;
