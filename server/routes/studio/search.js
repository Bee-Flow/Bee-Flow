/**
 * GET /api/studio/search?q= — the Studio rail's name search.
 *
 *   → { query, tooShort, results: { <kind>: [{ id, name }] }, errors: [<kind>] }
 *
 * The sibling of routes/studio/counts.js and deliberately built to the same
 * three rules, because it answers the same question about the same nine
 * kinds — "what is there, that you may see":
 *
 *   1. Every kind applies the SAME gate its list route sits behind, and a
 *      kind the caller may not see is OMITTED. The response never 403s as a
 *      whole: a 403 would tell a Community org there is something to find.
 *   2. Every kind searches the SAME list its list route returns — the store
 *      function is named per kind below — and filters that by name. Org
 *      scoping is NOT enough on its own and a single generic
 *      `WHERE organization_id = $1 AND name ILIKE $2` would leak across five
 *      kinds at once: datatables carry per-table grades, apps and webpages an
 *      audience context, meeting notes shared_with/shared_groups, agents a
 *      manage_agents permission with org narrowing, knowledge bases a group
 *      filter. So each kind goes through the function that already decides
 *      what that user may see.
 *   3. Every kind runs inside its own try/catch — and a kind that THREW is
 *      named in `errors`, not silently dropped. This is the difference this
 *      endpoint exists to keep: a search list that comes out of a failure is
 *      not "no matches". Dropping the kind quietly would let a store outage
 *      read as an answer ("that automation does not exist"), and on a privacy
 *      product a screen that makes a claim it cannot support is a bug. The
 *      client says so on screen; see StudioSearchOverlay.
 *
 * A GATED kind and a FAILED kind are both absent from `results`, and they are
 * told apart by `errors` — never by the absence itself. A kind that was
 * searched successfully and matched nothing is present as an EMPTY ARRAY, so
 * "searched, nothing" and "not yours to search" are two different shapes.
 *
 * NOT CACHED, unlike counts. The key would be the query string, so a cache
 * would hold one entry per keystroke per user for no reuse, and counts.js's
 * in-memory Map is already 5000 entries per process. The response carries
 * `Cache-Control: private, no-store` for the same reason it does there: no
 * browser cache stacked on top of a per-user answer.
 *
 * Queries shorter than MIN_QUERY_LENGTH touch NO store at all (`tooShort`),
 * so an empty search box costs nothing.
 *
 * Mounted at /api/studio behind requireAuth (server/index.js) — the same
 * mount counts.js sits on; the route re-checks the session so a bare mount
 * cannot leak.
 *
 * Dependencies are injectable (`createSearchRouter(deps)`) so the test
 * exercises the gating/omission/error contract without a database.
 *
 * ── What a caller may send ─────────────────────────────────────────────────
 * `?q=` and nothing else, `.strict()`. Anything else used to become the empty
 * query, answered 200 `tooShort: true` — "type at least two characters" — to
 * a caller who had typed a word: `?query=invoice` (the wrong key) and
 * `?q=a&q=b` (the key twice) both did that. `?kind=apps` searched all nine
 * kinds as if it had narrowed them.
 *
 * A q over MAX_QUERY_LENGTH is still CLAMPED rather than refused: the overlay
 * has no maxLength and says "Search is unavailable right now" for any non-2xx,
 * so a refusal would report an outage to somebody who pasted a long name.
 */

'use strict';

const express = require('express');
const { z } = require('zod');

const { validate } = require('../../core/http/validate');

// The gate helpers and the lazy dependency factory are shared with the other
// /api/studio aggregates — see routes/studio/shared.js.
const {
    makeLazyDeps, userIdOf, moduleActive, licenceAllows, capability, permission,
    solutionsGate, visibleKnowledgeBasesFor, visibleSolutionsFor,
} = require('./shared');
const log = require('../../telemetry/log');

/** Per kind. Nine kinds × 8 is the whole response; the rail lists a few. */
const MAX_PER_KIND = 8;
/** Below this, no store is touched at all. */
const MIN_QUERY_LENGTH = 2;
/** Hard cap on what we accept, so the ILIKE pattern stays bounded. */
const MAX_QUERY_LENGTH = 200;

// Lazily-required production dependencies. Each is the module its list route
// already uses; nothing here is new data access.
const DEFAULT_LOADERS = {
    modules: () => require('../../modules'),
    license: () => require('../../license/middleware'),
    entitlements: () => require('../../core/entitlements/entitlements'),
    permissions: () => require('../../auth/permissions'),
    auth: () => require('../../auth'),
    audience: () => require('../../auth/audience'),
    datatableAccess: () => require('../../auth/datatableAccess'),
    automationCore: () => require('../../stores/automationStore/core'),
    datatableStore: () => require('../../stores/datatableStore'),
    studioAppStore: () => require('../../stores/studioAppStore'),
    webpageStore: () => require('../../stores/webpageStore'),
    skillStore: () => require('../../stores/skillStore'),
    userStore: () => require('../../stores/userStore'),
    kbStore: () => require('../../stores/knowledgeBases'),
    kbShared: () => require('../knowledgeBases/shared'),
    transcriptionsShared: () => require('../transcriptions/shared'),
    db: () => require('../../db'),
    projectStore: () => require('../../stores/projectStore'),
    configStore: () => require('../../stores/configStore'),
};

const makeDefaultDeps = () => makeLazyDeps(DEFAULT_LOADERS);

const Q_TEXT = 'q is the text to search for, sent once.';
const SearchQuery = z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object({
        q: z.string({ invalid_type_error: Q_TEXT }).optional(),
    }, {
        errorMap: (issue, ctx) => ({
            message: issue.code === z.ZodIssueCode.unrecognized_keys
                ? `The search takes only q, the text to look for (got ${issue.keys.map((k) => `"${k}"`).join(', ')}).`
                : ctx.defaultError,
        }),
    }).strict(),
);

/** The session check, ahead of the schema: a caller without one hears 401, not 400. */
const requireSession = (req, res, next) => (req.session?.isAuthenticated && userIdOf(req)
    ? next()
    : res.status(401).json({ error: 'Not authenticated' }));

/** The display name of a row, whatever the store called it; '' when unknown. */
function nameOf(row) {
    if (!row || typeof row !== 'object') return '';
    const v = row.name ?? row.title ?? row.fileName ?? row.file_name ?? null;
    return typeof v === 'string' ? v : '';
}

/**
 * Escape the two LIKE wildcards (and the escape character itself) so a query
 * of "100%" searches for "100%" instead of "100 followed by anything", and a
 * query of "_" does not match every single-character name. Postgres's default
 * LIKE escape IS the backslash; the ESCAPE clause below says so out loud.
 */
function escapeLike(value) {
    return String(value).replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The SQL pattern for a contains-search. */
const likePattern = (q) => `%${escapeLike(q)}%`;

/** In-memory equivalent of the ILIKE above, for the store-backed kinds. */
function matchesName(row, needle) {
    return nameOf(row).toLowerCase().includes(needle);
}

/** `{ id, name }` — the two fields a result row needs, and nothing else. */
const toHit = (row) => ({ id: String(row.id), name: nameOf(row) });

/**
 * Rank the store-filtered rows: a name that STARTS with what was typed beats
 * one that merely contains it, and ties keep the store's own order (which is
 * already "most recent first" for every list this reads).
 */
function rankAndCap(rows, needle) {
    const scored = rows.map((row, i) => ({
        row,
        starts: nameOf(row).toLowerCase().startsWith(needle) ? 0 : 1,
        i,
    }));
    scored.sort((a, b) => (a.starts - b.starts) || (a.i - b.i));
    return scored.slice(0, MAX_PER_KIND).map(({ row }) => toHit(row));
}

// ── The kinds ─────────────────────────────────────────────────────────────
// key            — the same vocabulary GET /api/studio/counts uses, so the
//                  two endpoints name the nine kinds identically (the client
//                  maps a kind to its URL segment once, for both).
// gate(req, d)   — boolean: may this caller see the kind at all
// search(req, d, q) → rows (already scoped); named/capped by the caller
const KINDS = [
    {
        // routes/automation/crud.js GET / → automationStore.getAutomationsForUser
        // (`WHERE user_id = $1 AND kind = 'automation'`). Same predicate, plus
        // the title filter, and only the two columns a hit needs — the list
        // selects every routine's definition JSON, which a name search never
        // reads.
        key: 'automations',
        gate: async (req, d) => (await moduleActive(d, 'automation')) && (await licenceAllows(d, req, 'automations')),
        search: async (req, d, q) => d.automationCore.getAll(
            `SELECT id, title FROM automations
              WHERE user_id = $1 AND kind = 'automation' AND deleted_at IS NULL AND title ILIKE $2 ESCAPE '\\'
              ORDER BY updated_at DESC LIMIT $3`,
            [userIdOf(req), likePattern(q), MAX_PER_KIND],
        ),
    },
    {
        // routes/datatables.js GET / → every table in the caller's scopes
        // (personal AND organisation), kept when the caller holds any grade.
        // The grade check is the whole point: scope alone would list tables
        // inside the org that this person holds nothing on.
        key: 'datatables',
        gate: async (req, d) => (await moduleActive(d, 'automation')) && (await licenceAllows(d, req, 'automations')),
        search: async (req, d, q) => {
            const { resolveDatatablePrincipal, datatableScopesFor, gradeForPrincipal } = d.datatableAccess;
            const principal = await resolveDatatablePrincipal(req);
            const scopes = datatableScopesFor(principal);
            const all = [];
            for (const scope of scopes) all.push(...await d.datatableStore.listDatatablesForScope(scope));
            const named = all.filter((t) => matchesName(t, q));
            // Grants are read for the NAME MATCHES only: the grade check is
            // per table and the list can be long, and a table whose name does
            // not match is never a hit regardless of what you hold on it.
            const grants = await d.datatableStore.listGrantsForTables(named.map((t) => t.id));
            return named.filter((t) => !!gradeForPrincipal(t, grants.get(t.id) || [], principal));
        },
    },
    {
        // routes/studioApps.js GET / → getAccessibleStudioApps(userId, groups,
        // orgIds): your own plus every app published into your org/groups.
        key: 'apps',
        gate: async (req, d) => (await moduleActive(d, 'apps')) && (await capability(d, req, 'app_studio')),
        search: async (req, d, q) => {
            const { userId, orgIds, userGroups } = await d.audience.resolveAudienceContext(req);
            const orgIdArr = orgIds instanceof Set ? [...orgIds] : (Array.isArray(orgIds) ? orgIds : []);
            const apps = await d.studioAppStore.getAccessibleStudioApps(userId, userGroups, orgIdArr);
            return apps.filter((a) => matchesName(a, q));
        },
    },
    {
        // routes/webpages.js GET / → getAccessibleWebpages(userId, groups, orgIds).
        key: 'webpages',
        gate: async (req, d) => (await moduleActive(d, 'webpages')) && (await capability(d, req, 'webpages')),
        search: async (req, d, q) => {
            const { userId, orgIds, userGroups } = await d.audience.resolveAudienceContext(req);
            const orgIdArr = orgIds instanceof Set ? [...orgIds] : (Array.isArray(orgIds) ? orgIds : []);
            const pages = await d.webpageStore.getAccessibleWebpages(userId, userGroups, orgIdArr);
            return pages.filter((p) => matchesName(p, q));
        },
    },
    {
        // routes/agents/published.js GET /all — requirePermission('manage_agents'),
        // then every agent row narrowed to the caller's orgs (null = super
        // admin, no narrowing). The narrowing lives in the WHERE here, exactly
        // as it does in the counts query, so it cannot be forgotten in JS.
        key: 'agents',
        gate: (req, d) => permission(d, req, 'manage_agents'),
        search: async (req, d, q) => {
            const orgIds = await d.auth.resolveUserOrgIds(req);
            const base = `SELECT id, name FROM agents
                           WHERE owner_id NOT IN ('system', 'swarm') AND name ILIKE $1 ESCAPE '\\'`;
            if (orgIds === null) {
                return d.db.getAll(`${base} ORDER BY name ASC LIMIT $2`, [likePattern(q), MAX_PER_KIND]);
            }
            const ids = [...orgIds].filter(Boolean).map(String);
            // A member of no organisation sees no agent on /all either.
            if (ids.length === 0) return [];
            return d.db.getAll(
                `${base} AND organization_id = ANY($2::text[]) ORDER BY name ASC LIMIT $3`,
                [likePattern(q), ids, MAX_PER_KIND],
            );
        },
    },
    {
        // routes/skills.js GET / — requireCapability('skills') at the mount,
        // then getAvailableSkills(orgId, userId) with orgId re-read from the
        // user row (the route does the same).
        key: 'skills',
        gate: (req, d) => capability(d, req, 'skills'),
        search: async (req, d, q) => {
            const user = await d.userStore.getUser(userIdOf(req));
            const skills = await d.skillStore.getAvailableSkills(user?.organizationId || null, userIdOf(req));
            return skills.filter((s) => matchesName(s, q));
        },
    },
    {
        // routes/knowledgeBases/list.js GET / — ungated at the mount (Knowledge
        // base is Community): listKBs + filterByGroupAccess with the route's
        // default query filter (manual sources only).
        key: 'knowledge',
        gate: async () => true,
        // Zelfde keten als counts.js en attentionChecks.js — één plek: shared.js.
        search: async (req, d, q) => {
            const visible = await visibleKnowledgeBasesFor(req, d);
            return visible.filter((kb) => matchesName(kb, q));
        },
    },
    {
        // routes/transcriptions/notes.js GET / → getTranscriptions(userId,
        // { orgIds, userGroupIds, isSuperAdmin }). The visibility predicate is
        // the store's, verbatim from the counts query — own rows, legacy
        // per-user shares, published-to-my-org rows filtered by group — and it
        // is WRAPPED IN PARENTHESES before the name filter is ANDed on. Without
        // those brackets the trailing AND would bind to the last OR branch only
        // and the first two branches would return every row in the table.
        key: 'meetingNotes',
        gate: async (req, d) => (await moduleActive(d, 'meetingNotes')) && (await capability(d, req, 'meeting_notes')),
        search: async (req, d, q) => {
            const userId = userIdOf(req);
            const { orgIds, userGroupIds, isSuperAdmin } = await d.transcriptionsShared.resolveAccessContext(req);
            const params = [];
            let visibility;
            if (isSuperAdmin) {
                visibility = 'TRUE';
            } else {
                params.push(userId, JSON.stringify([userId]));
                const clauses = ['user_id = $1', 'shared_with @> $2::jsonb'];
                if (Array.isArray(orgIds) && orgIds.length > 0) {
                    params.push(orgIds);
                    const orgIdx = params.length;
                    if (Array.isArray(userGroupIds) && userGroupIds.length > 0) {
                        params.push(userGroupIds);
                        const groupIdx = params.length;
                        clauses.push(`(is_published = true AND organization_id = ANY($${orgIdx}::text[]) AND (shared_groups = '[]'::jsonb OR shared_groups ?| $${groupIdx}::text[]))`);
                    } else {
                        clauses.push(`(is_published = true AND organization_id = ANY($${orgIdx}::text[]) AND shared_groups = '[]'::jsonb)`);
                    }
                }
                visibility = clauses.join(' OR ');
            }
            params.push(likePattern(q));
            const nameIdx = params.length;
            params.push(MAX_PER_KIND);
            const limitIdx = params.length;
            const sql = `SELECT id, title, file_name FROM transcriptions
                          WHERE (${visibility})
                            AND (title ILIKE $${nameIdx} ESCAPE '\\' OR file_name ILIKE $${nameIdx} ESCAPE '\\')
                          ORDER BY created_at DESC LIMIT $${limitIdx}`;
            return d.db.getAll(sql, params);
        },
    },
    {
        // routes/projects.js GET /?kind=solution: Solutions plus the legacy
        // projects nobody has classified yet, never a collaborative project.
        // Gate and list are shared with counts.js (./shared.js).
        key: 'solutions',
        gate: solutionsGate,
        search: async (req, d, q) => (await visibleSolutionsFor(req, d)).filter((p) => matchesName(p, q)),
    },
];

const KIND_KEYS = Object.freeze(KINDS.map((k) => k.key));

/**
 * → { results, errors } — `errors` names every kind whose store threw. Those
 * kinds are absent from `results`, and the CALLER MUST SAY SO: an absent kind
 * that is not in `errors` means "not yours"; an absent kind that IS in
 * `errors` means "we could not look", and rendering the two the same way is
 * the fail-open this endpoint refuses.
 */
async function runSearch(req, d, q) {
    const needle = q.toLowerCase();
    const results = {};
    const errors = [];
    await Promise.all(KINDS.map(async (kind) => {
        try {
            if (!(await kind.gate(req, d))) return;
        } catch (err) {
            // A gate that cannot answer is NOT an open door: the kind is
            // dropped, and it is dropped LOUDLY so the caller can say the
            // list is incomplete.
            errors.push(kind.key);
            log.warn(`[StudioSearch] gate ${kind.key} failed:`, err?.message || err);
            return;
        }
        try {
            const rows = await kind.search(req, d, needle);
            results[kind.key] = rankAndCap(Array.isArray(rows) ? rows : [], needle);
        } catch (err) {
            errors.push(kind.key);
            log.warn(`[StudioSearch] ${kind.key} failed:`, err?.message || err);
        }
    }));
    errors.sort();
    return { results, errors };
}

function createSearchRouter(deps = null) {
    const d = deps || makeDefaultDeps();
    const router = express.Router();

    router.get('/search', requireSession, validate({ query: SearchQuery }), async (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        const q = (req.query.q ?? '').trim().slice(0, MAX_QUERY_LENGTH);
        if (q.length < MIN_QUERY_LENGTH) {
            // No store is touched. `tooShort` says which of the two empty
            // answers this is, so the overlay can prompt instead of claiming
            // there is nothing to find.
            return res.json({ query: q, tooShort: true, results: {}, errors: [] });
        }
        try {
            const { results, errors } = await runSearch(req, d, q);
            return res.json({ query: q, tooShort: false, results, errors });
        } catch (err) {
            // Defensive only: runSearch catches per KIND (gate and search
            // alike), so even a total outage comes back 200 with all nine
            // kinds in `errors` — which is the honest answer, and the one
            // search.test.js pins. This net is here for a failure BEFORE the
            // per-kind loop, and it 500s rather than returning an empty
            // `results`, because an empty result set is exactly the sentence
            // this endpoint must never say by accident.
            log.error('[StudioSearch] failed:', err?.message || err);
            return res.status(500).json({ error: 'Could not search' });
        }
    });

    return router;
}

const router = createSearchRouter();

module.exports = router;
module.exports.createSearchRouter = createSearchRouter;
module.exports.KIND_KEYS = KIND_KEYS;
module.exports.MAX_PER_KIND = MAX_PER_KIND;
module.exports.MIN_QUERY_LENGTH = MIN_QUERY_LENGTH;
module.exports.MAX_QUERY_LENGTH = MAX_QUERY_LENGTH;
module.exports.escapeLike = escapeLike;
module.exports.nameOf = nameOf;
