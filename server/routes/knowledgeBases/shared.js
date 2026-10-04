/**
 * Knowledge Bases — shared route helpers.
 *
 * Everything the KB sub-routers under routes/knowledgeBases/ have in common:
 * the system-KB beta resolution, the usage-context query helpers, the SSRF
 * screening used by every caller-influenced fetch, and the access/management
 * guards. Module-level state (SEARCH_SERVICE_URL, SYSTEM_KB_BETA_SLUGS) lives
 * here and nowhere else.
 *
 * No request schema lives here: this file declares no route. The query helpers
 * (`context`, `excludeContext`, `includeAuto`) read what the KB list route's
 * own query schema has already let through.
 */

const kbStore = require('../../stores/knowledgeBases');
const { resolveUserOrgIds, hasPermission, resolveUserGroups: resolveUserGroupsById } = require('../../auth');
const { userHasBetaFeature } = require('../../core/entitlements/betaFeatures');
const { PROJECT_FILES_SOURCE_KIND } = require('../../core/kb/projectFilesKb');
require('../../core/kb/kbIngestionHelpers');
require('../../utils/ssrfGuard');
const log = require('../../telemetry/log');

// Beta-feature ids that map 1:1 to a system_slug on a system-managed KB. The
// chat KB picker should only surface a system KB when the user's org has the
// matching beta feature enabled. New system KBs append a slug here.
const SYSTEM_KB_BETA_SLUGS = [];

async function resolveEnabledSystemSlugs(req) {
    const userId = req.session?.user?.id;
    if (!userId) return [];
    // Route through the resolver (userHasBetaFeature delegates to resolveEntitlements)
    // so a system KB's beta respects the per-org access ceiling — including for a
    // global admin (orgAvailable via governingOrgId), not the raw "admins get all
    // betas" list. "Disabled in the menu ⇒ hidden" then holds for the Legal KB too.
    const enabled = [];
    for (const slug of SYSTEM_KB_BETA_SLUGS) {
        try { if (await userHasBetaFeature(userId, slug, req.session)) enabled.push(slug); }
        catch (_) { /* skip this slug on resolve failure */ }
    }
    return enabled;
}

const SEARCH_SERVICE_URL = process.env.SEARCH_SERVICE_URL || 'https://services.beeflow.nl';

/**
 * Where a knowledge base may be picked.
 *
 * 'ai_step' (K1) is the automation ai-step picker. It is deliberately its own
 * context and not folded into 'agent': an org that switches a KB off for agents
 * must not silently switch it off for every automation that already reads it.
 * migrations/kb-sources-backfill.js grants 'ai_step' to every KB that has
 * 'agent' plus every KB id an automation actually references.
 */
// One definition, in core, because the link-time checks
// (routes/agents/crud.js, core/kb/automationKbCheck.js) read the same set and
// a second copy is how 'ai_step' ends up valid in the picker and unknown to
// the check.
const { SURFACES } = require('../../core/kb/usageContexts');
const VALID_USAGE_CONTEXTS = new Set(SURFACES);

/** Parse the optional ?context= query into a single valid usage-context value, or null. */
function parseContextQuery(req) {
    const v = (req.query.context || '').trim();
    return VALID_USAGE_CONTEXTS.has(v) ? v : null;
}

/** Parse the optional ?excludeContext= query (inverse of ?context=). */
function parseExcludeContextQuery(req) {
    const v = (req.query.excludeContext || '').trim();
    return VALID_USAGE_CONTEXTS.has(v) ? v : null;
}

/** Build the listKBs filter options from request query (?context, ?excludeContext, ?includeAuto). */
function listFilterFromQuery(req) {
    return {
        sourceKind: req.query.includeAuto === '1' ? null : 'manual',
        usageContext: parseContextQuery(req),
        excludeContext: parseExcludeContextQuery(req),
    };
}

/** Validate + normalise a usageContexts payload from the client. */
function sanitizeUsageContexts(value) {
    if (!Array.isArray(value)) return null;
    const cleaned = Array.from(new Set(value.filter(v => VALID_USAGE_CONTEXTS.has(v))));
    return cleaned.length > 0 ? cleaned : null;
}

/**
 * The SSRF screening moved to `core/kb/fetchGuard.js`.
 *
 * The scheduled refresh engine (`core/kb/sources`) fetches the same
 * caller-supplied URLs this router does, and `core/` may not reach up into
 * `routes/` (layering.test.js pins that edge count and says never raise it).
 * Two copies of a security guard is the one duplication worth going out of
 * the way to avoid: the copy that does not get the next fix is the one an
 * attacker finds. Re-exported here so every existing caller and the pinned
 * `knowledgeBases.ssrf.test.js` are unchanged.
 */
const { guardedFetch } = require('../../core/kb/fetchGuard');

// Auth helper
const getUserId = (req) => req.session?.user?.id || null;

// Resolve user's group IDs (used for shared_groups filtering) — delegates
// to the audience home (auth/audience.js), the single source of truth for
// fresh-from-DB group resolution.
const resolveUserGroups = (req) => resolveUserGroupsById(getUserId(req));

// The KB access check + org-admin resolution now live in support/kbAccess.js so
// that every router which lets a client name a kb id (this one, notebooks)
// applies the identical policy and the guards can never drift.
const { canAccessKB, resolveIsOrgAdmin } = require('../../support/kbAccess');

/**
 * Management check for KB settings mutations (BFSF-214). Mirrors the
 * publish route's owner-or-manager policy but adds same-org scoping.
 * Does NOT grant content read access — GET/document/search routes keep
 * canAccessKB.
 */
async function canManageKB(req, kb) {
    const userId = getUserId(req);
    const orgIds = await resolveUserOrgIds(req);
    const hasPerm = await hasPermission(userId, 'manage_knowledge', req.session);
    return kbStore.canUserManageKB(kb, userId, orgIds, hasPerm);
}

/**
 * Guard for mutating routes. System-managed KBs are read-only — their content
 * is owned by Bee Flow and refreshed by the ingest script. Returns true and
 * sends a 403 when the request should be aborted, false otherwise.
 */
function blockIfSystemKB(kb, res) {
    if (kbStore.isSystemKB(kb)) {
        res.status(403).json({ error: 'System-managed knowledge bases are read-only' });
        return true;
    }
    // A project's files base is managed from its project, by the project's
    // role ladder (routes/projects/workspace.js); no generic route publishes,
    // renames, deletes or writes into it, whoever the caller is.
    if (kb && kb.source_kind === PROJECT_FILES_SOURCE_KIND) {
        res.status(403).json({ error: 'This knowledge base holds a project\'s files. Add or remove them from the project.' });
        return true;
    }
    return false;
}

// ── Sources (K1) ────────────────────────────────────────────────────

/**
 * Find-or-create the `kb_sources` row an ingest hangs its document off.
 *
 * Lives in `core/kb/sources/ensureSource.js` now. It was here, and
 * `integrations/kbIngestTools.js` reached up into this ROUTE module for it —
 * the one thing it needed from one. Re-exported so the KB routes keep calling
 * it by the name they always have.
 */
const { ensureKbSource } = require('../../core/kb/sources/ensureSource');

/**
 * Add the K1 aggregates to KB rows for the list endpoints: numeric counters,
 * `sourceCount`/`autoRefreshCount`/`lastRefreshAt` from kb_sources and the
 * camelCase `lastContentAt`.
 *
 * Additive only — every snake_case field mobile reads (document_count,
 * total_chunks, last_content_at, …) is left exactly where it was.
 */
async function decorateKbList(kbs) {
    const list = Array.isArray(kbs) ? kbs : [];
    if (list.length === 0) return list;
    let counts = {};
    try {
        counts = await require('../../stores/kbSources').countsByKb(list.map(k => k.id));
    } catch (e) {
        log.warn('[KB] Source counts unavailable for the KB list:', e.message);
        counts = {};
    }
    return list.map((kb) => {
        const c = counts[kb.id] || {};
        return {
            ...kb,
            documentCount: Number(kb.document_count || 0),
            documentCountAll: Number(kb.document_count_all || kb.document_count || 0),
            totalChunks: Number(kb.total_chunks || 0),
            sourceCount: Number(c.sourceCount || 0),
            autoRefreshCount: Number(c.autoRefreshCount || 0),
            lastRefreshAt: c.lastRefreshAt || null,
            lastContentAt: kb.last_content_at || null,
        };
    });
}

module.exports = {
    resolveEnabledSystemSlugs,
    SEARCH_SERVICE_URL,
    VALID_USAGE_CONTEXTS,
    listFilterFromQuery,
    sanitizeUsageContexts,
    guardedFetch,
    getUserId,
    resolveUserGroups,
    canAccessKB,
    resolveIsOrgAdmin,
    canManageKB,
    blockIfSystemKB,
    ensureKbSource,
    decorateKbList,
};
