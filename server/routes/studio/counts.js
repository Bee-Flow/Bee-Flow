/**
 * GET /api/studio/counts — the numbers on the Studio rail.
 *
 *   → { counts: { automations, runs, datatables, apps, webpages, forms, agents,
 *                 skills, knowledge, meetingNotes, solutions }, makers }
 *
 * Every key but one is "how many of these exist"; `runs` is "how many runs in
 * the last 24 hours", because the row it labels opens a log rather than a
 * collection. Its entry below says so at the point somebody would notice.
 *
 * ONE gate-aware aggregate instead of nine list fetches (the rail used to
 * have no counts at all; the sidebar's recents panels read full lists, one of
 * which — /api/transcriptions — is capped at 25 and would report a wrong
 * number, and one of which — /agents/all — 403s for anyone without
 * manage_agents).
 *
 * Three rules, all of them about not becoming an entitlement oracle:
 *
 *   1. Every key applies the SAME gate its list route sits behind — module,
 *      licence feature, capability or org permission — and a key the caller
 *      may not see is OMITTED. The response never 403s as a whole: a 403
 *      would tell a Community org there is something to count.
 *   2. Every key is counted with the SAME scoping its list route uses (the
 *      route file and store function are named per kind below), so the rail
 *      never says "Tables 3" over a list that shows four. Where the list
 *      scoping lives in a store function the count calls that function and
 *      measures it; where the list is capped (transcriptions) the count is a
 *      COUNT(*) over the identical predicate.
 *   3. Every key is counted inside its own try/catch: one store falling over
 *      drops one number, never the response. A body with a dropped number is
 *      PARTIAL and is never cached: an omitted key is exactly the shape the
 *      client reads as "gated", so caching it would turn a transient store
 *      error into a minute of a rail entry silently missing.
 *
 * `makers` is the number of distinct owners across every counted kind — the
 * "Organisation X · 12 makers" figure on Studio Home.
 *
 * Cached 60s in memory per (org, user): the client polls at 30s, and a
 * fresh count on every poll for every open tab is the one cost that grows
 * with the number of people, not the number of things. The response is
 * `Cache-Control: private, no-store` on purpose — the server cache is the
 * only cache, so the client's visibilitychange catch-up fetch is never
 * answered by a browser cache stacked on top of it.
 *
 * Mounted at /api/studio behind requireAuth (server/index.js); the route
 * re-checks the session so a bare mount cannot leak.
 *
 * Dependencies are injectable (`createCountsRouter(deps)`) so the test
 * exercises the gating/omission/caching contract without a database.
 *
 * ── It takes no query, and says so ─────────────────────────────────────────
 * The query is `.strict()` and empty. `?scope=org` used to be answered 200
 * with the caller's OWN numbers — automations and runs are counted
 * `WHERE user_id = $1` — so a caller who asked for the organisation read
 * personal counts as the organisation's. StudioMap.jsx already refuses to
 * invent that parameter for exactly this reason; now the server refuses it too.
 */

'use strict';

const express = require('express');
const { z } = require('zod');

const { validate } = require('../../core/http/validate');

// The gate helpers and the lazy dependency factory are shared with the other
// /api/studio aggregates — see routes/studio/shared.js.
const {
    makeLazyDeps, userIdOf, orgIdOf, moduleActive, licenceAllows, capability, permission,
    visibleKnowledgeBasesFor,
} = require('./shared');
const log = require('../../telemetry/log');

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 5000;

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
    automationStore: () => require('../../stores/automationStore'),
    datatableStore: () => require('../../stores/datatableStore'),
    studioAppStore: () => require('../../stores/studioAppStore'),
    playbookStore: () => require('../../stores/playbookStore'),
    webpageStore: () => require('../../stores/webpageStore'),
    skillStore: () => require('../../stores/skillStore'),
    userStore: () => require('../../stores/userStore'),
    kbStore: () => require('../../stores/knowledgeBases'),
    kbShared: () => require('../knowledgeBases/shared'),
    transcriptionsShared: () => require('../transcriptions/shared'),
    db: () => require('../../db'),
    projectStore: () => require('../../stores/projectStore'),
    configStore: () => require('../../stores/configStore'),
    now: () => Date.now,
};

const makeDefaultDeps = () => makeLazyDeps(DEFAULT_LOADERS);

/** No parameters at all; each key it is sent is named back in the refusal. */
const NoQuery = z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object({}, {
        errorMap: (issue, ctx) => ({
            message: issue.code === z.ZodIssueCode.unrecognized_keys
                ? `The counts take no parameters — they are always your own view (got ${issue.keys.map((k) => `"${k}"`).join(', ')}).`
                : ctx.defaultError,
        }),
    }).strict(),
);

/** The session check, ahead of the schema: a caller without one hears 401, not 400. */
const requireSession = (req, res, next) => (req.session?.isAuthenticated && userIdOf(req)
    ? next()
    : res.status(401).json({ error: 'Not authenticated' }));

/** The owner id of a row, whatever the store called it; null when unknown. */
function ownerOf(row) {
    if (!row || typeof row !== 'object') return null;
    const v = row.ownerUserId ?? row.ownerId ?? row.owner_id ?? row.userId ?? row.user_id ?? row.tenant_id ?? null;
    return v == null ? null : String(v);
}

// ── The kinds ─────────────────────────────────────────────────────────────
// gate(req, d)  → boolean: may this caller see the key at all
// count(req, d) → { count, owners: string[] }
const KINDS = [
    {
        // routes/automation/crud.js GET / → automationStore.getAutomationsForUser
        // (`WHERE user_id = $1 AND kind = 'automation'`). A COUNT over the
        // same predicate on the same (tasks-DB) pool: the list selects the
        // definition JSON of every routine, which is the one column a count
        // never needs.
        key: 'automations',
        gate: async (req, d) => (await moduleActive(d, 'automation')) && (await licenceAllows(d, req, 'automations')),
        count: async (req, d) => {
            const row = await d.automationCore.getOne(
                `SELECT COUNT(*)::int AS n FROM automations WHERE user_id = $1 AND kind = 'automation' AND deleted_at IS NULL`,
                [userIdOf(req)],
            );
            const n = Number(row?.n) || 0;
            return { count: n, owners: n > 0 ? [String(userIdOf(req))] : [] };
        },
    },
    {
        // Studio → Runs & log (Track H2). The odd one out on this list, and
        // deliberately so, in two ways worth stating rather than discovering:
        //
        //   IT COUNTS EVENTS, NOT THINGS. Every other key answers "how many of
        //   these do you have"; this one answers "how many runs in the last 24
        //   hours", because that is what the row it labels opens onto — a log,
        //   not a collection. The window is the section's own default range.
        //
        //   IT IS THE CALLER'S OWN RUNS, matching the scope the section opens
        //   in ("my runs"). Counting the organisation here would put a number
        //   on the rail that the screen behind it does not show, for a caller
        //   who may not even be allowed the org scope — rule 2 of this file,
        //   applied to the one key whose list has two scopes.
        //
        // getRunCountForUserSince owns the predicate, so the count and the
        // list cannot drift apart in the way an inlined COUNT here would.
        key: 'runs',
        gate: async (req, d) => (await moduleActive(d, 'automation')) && (await licenceAllows(d, req, 'automations')),
        count: async (req, d) => {
            const sinceTs = new Date(d.now() - 24 * 3600 * 1000).toISOString();
            const n = await d.automationStore.getRunCountForUserSince(userIdOf(req), sinceTs);
            // No owners: every run counted here is the caller's, and they are
            // already a "maker" through whatever they built. Feeding them in
            // again would make `makers` say 1 for an organisation whose only
            // signal was that somebody's routine ran.
            return { count: Number(n) || 0, owners: [] };
        },
    },
    {
        // routes/automation/crud.js GET /forms → listFormPagesForOrg(orgOf(req),
        // userId), one entry per (automation, trigger) — the busiest page wins
        // — keeping only rows whose trigger still IS a form.
        key: 'forms',
        gate: async (req, d) => (await moduleActive(d, 'automation')) && (await licenceAllows(d, req, 'automations')),
        count: async (req, d) => {
            const principal = await d.datatableAccess.resolveDatatablePrincipal(req);
            const rows = await d.automationStore.listFormPagesForOrg(principal?.orgId || null, userIdOf(req));
            const byForm = new Map();
            for (const row of rows || []) {
                const key = `${row.automationId}::${row.triggerStepId || ''}`;
                const held = byForm.get(key);
                if (!held || (row.submissions || 0) > (held.submissions || 0)) byForm.set(key, row);
            }
            const forms = [];
            for (const row of byForm.values()) {
                const def = row.definition || {};
                const trigger = row.triggerStepId
                    ? [def.trigger, ...(def.triggers || [])].find(t => t?.id === row.triggerStepId)
                    : def.trigger;
                if (trigger?.kind === 'form') forms.push(row);
            }
            return { count: forms.length, owners: forms.map(ownerOf) };
        },
    },
    {
        // routes/datatables.js GET / → every table in the caller's scopes
        // (personal AND organisation), kept when the caller holds any grade.
        key: 'datatables',
        gate: async (req, d) => (await moduleActive(d, 'automation')) && (await licenceAllows(d, req, 'automations')),
        count: async (req, d) => {
            const { resolveDatatablePrincipal, datatableScopesFor, gradeForPrincipal } = d.datatableAccess;
            const principal = await resolveDatatablePrincipal(req);
            const scopes = datatableScopesFor(principal);
            const all = [];
            for (const scope of scopes) all.push(...await d.datatableStore.listDatatablesForScope(scope));
            const grants = await d.datatableStore.listGrantsForTables(all.map(t => t.id));
            const visible = all.filter(t => !!gradeForPrincipal(t, grants.get(t.id) || [], principal));
            return { count: visible.length, owners: visible.map(ownerOf) };
        },
    },
    {
        // routes/studioApps.js GET / → getAccessibleStudioApps(userId, groups,
        // orgIds): your own plus every app published into your org/groups —
        // the apps you can open, which is what "Apps 4" on an org rail means.
        // (/mine is the recents panel's list: what YOU build.)
        key: 'apps',
        gate: async (req, d) => (await moduleActive(d, 'apps')) && (await capability(d, req, 'app_studio')),
        count: async (req, d) => {
            const { userId, orgIds, userGroups } = await d.audience.resolveAudienceContext(req);
            const orgIdArr = orgIds instanceof Set ? [...orgIds] : (Array.isArray(orgIds) ? orgIds : []);
            const apps = await d.studioAppStore.getAccessibleStudioApps(userId, userGroups, orgIdArr);
            return { count: apps.length, owners: apps.map(ownerOf) };
        },
    },
    {
        // routes/playbooks.js GET / → listPlaybooksForUser(userId): owner-only,
        // gated like its mount (apps + automation modules, app_studio, automations).
        key: 'playbooks',
        gate: async (req, d) => (await moduleActive(d, 'apps')) && (await moduleActive(d, 'automation'))
            && (await capability(d, req, 'app_studio')) && (await licenceAllows(d, req, 'automations')),
        count: async (req, d) => {
            const uid = userIdOf(req);
            const rows = await d.playbookStore.listPlaybooksForUser(uid, { limit: 500 });
            return { count: rows.length, owners: rows.length ? [String(uid)] : [] };
        },
    },
    {
        // routes/webpages.js GET / → getAccessibleWebpages(userId, groups, orgIds).
        key: 'webpages',
        gate: async (req, d) => (await moduleActive(d, 'webpages')) && (await capability(d, req, 'webpages')),
        count: async (req, d) => {
            const { userId, orgIds, userGroups } = await d.audience.resolveAudienceContext(req);
            const orgIdArr = orgIds instanceof Set ? [...orgIds] : (Array.isArray(orgIds) ? orgIds : []);
            const pages = await d.webpageStore.getAccessibleWebpages(userId, userGroups, orgIdArr);
            return { count: pages.length, owners: pages.map(ownerOf) };
        },
    },
    {
        // routes/agents/published.js GET /all — requirePermission('manage_agents'),
        // then agentStore.getAllAgents() (`owner_id NOT IN ('system', 'swarm')`)
        // narrowed in JS to the caller's orgs (null = super admin). That list
        // loads every agent row in the database, config and tools included,
        // for every org — and the rail polls this every 30s for every
        // manage_agents user. A COUNT over the identical predicate, with the
        // org narrowing moved into the WHERE, on the same (core-DB) pool.
        key: 'agents',
        gate: (req, d) => permission(d, req, 'manage_agents'),
        count: async (req, d) => {
            const orgIds = await d.auth.resolveUserOrgIds(req);
            const base = `SELECT COUNT(*)::int AS n, array_remove(array_agg(DISTINCT owner_id), NULL) AS owners
                            FROM agents WHERE owner_id NOT IN ('system', 'swarm')`;
            let row;
            if (orgIds === null) {
                row = await d.db.getOne(base, []);
            } else {
                const ids = [...orgIds].filter(Boolean).map(String);
                // A member of no organisation sees no agent on /all either.
                if (ids.length === 0) return { count: 0, owners: [] };
                row = await d.db.getOne(`${base} AND organization_id = ANY($1::text[])`, [ids]);
            }
            return { count: Number(row?.n) || 0, owners: (row?.owners || []).map(String) };
        },
    },
    {
        // routes/skills.js GET / — requireCapability('skills') at the mount,
        // then getAvailableSkills(orgId, userId) with orgId re-read from the
        // user row (the route does the same).
        key: 'skills',
        gate: (req, d) => capability(d, req, 'skills'),
        count: async (req, d) => {
            const user = await d.userStore.getUser(userIdOf(req));
            const skills = await d.skillStore.getAvailableSkills(user?.organizationId || null, userIdOf(req));
            return { count: skills.length, owners: skills.map(ownerOf) };
        },
    },
    {
        // routes/knowledgeBases/list.js GET / — ungated at the mount (Knowledge
        // base is Community): listKBs + filterByGroupAccess with the route's
        // default query filter (manual sources only).
        key: 'knowledge',
        gate: async () => true,
        // De zichtbaarheidsketen zelf staat in ./shared.js — hij stond hier,
        // in search.js en in attentionChecks.js woordelijk hetzelfde, en dat is
        // de regel die stil uiteen gaat lopen.
        count: async (req, d) => {
            const visible = await visibleKnowledgeBasesFor(req, d);
            return { count: visible.length, owners: visible.map(ownerOf) };
        },
    },
    {
        // routes/transcriptions/notes.js GET / → getTranscriptions(userId,
        // { orgIds, userGroupIds, isSuperAdmin }) — capped at 100 per page, so
        // this is a COUNT(*) over the store's exact predicate (own rows, legacy
        // per-user shares, published-to-my-org rows filtered by group).
        key: 'meetingNotes',
        gate: async (req, d) => (await moduleActive(d, 'meetingNotes')) && (await capability(d, req, 'meeting_notes')),
        count: async (req, d) => {
            const userId = userIdOf(req);
            const { orgIds, userGroupIds, isSuperAdmin } = await d.transcriptionsShared.resolveAccessContext(req);
            let sql;
            let params;
            if (isSuperAdmin) {
                sql = `SELECT COUNT(*)::int AS n, array_remove(array_agg(DISTINCT user_id), NULL) AS owners FROM transcriptions`;
                params = [];
            } else {
                params = [userId, JSON.stringify([userId])];
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
                sql = `SELECT COUNT(*)::int AS n, array_remove(array_agg(DISTINCT user_id), NULL) AS owners
                         FROM transcriptions WHERE ${clauses.join(' OR ')}`;
            }
            const row = await d.db.getOne(sql, params);
            return { count: Number(row?.n) || 0, owners: (row?.owners || []).map(String) };
        },
    },
    {
        // routes/projects.js GET /?kind=solution → listUserProjects(userId,
        // groups, { kind: 'solution' }): Solutions plus the legacy projects
        // nobody has classified yet, never a collaborative project. The mount
        // is requireModule('projects') + requireCapability('projects') + the
        // operator kill switch (feature_projects_enabled).
        key: 'solutions',
        gate: async (req, d) => {
            if (!(await moduleActive(d, 'projects'))) return false;
            if (!(await capability(d, req, 'projects'))) return false;
            const enabled = await d.configStore.getConfig('feature_projects_enabled');
            return enabled !== false;
        },
        count: async (req, d) => {
            const userId = userIdOf(req);
            const projects = await d.projectStore.listUserProjects(
                userId, await d.auth.resolveUserGroups(userId), { kind: 'solution' },
            );
            return { count: projects.length, owners: projects.map(ownerOf) };
        },
    },
];

const KIND_KEYS = Object.freeze(KINDS.map(k => k.key));

/**
 * → { counts, makers, partial } — `partial` is true when any kind threw (its
 * key is then absent), which is the caller's cue not to cache the body.
 */
async function computeCounts(req, d) {
    const counts = {};
    const owners = new Set();
    let partial = false;
    await Promise.all(KINDS.map(async (kind) => {
        try {
            if (!(await kind.gate(req, d))) return;
            const { count, owners: kindOwners } = await kind.count(req, d);
            counts[kind.key] = Number.isFinite(count) ? count : 0;
            for (const o of kindOwners || []) if (o) owners.add(String(o));
        } catch (err) {
            // One store's bad day drops one number, never the response — but
            // it does mark the body partial so the drop lasts one poll, not
            // one cache window.
            partial = true;
            log.warn(`[StudioCounts] ${kind.key} failed:`, err?.message || err);
        }
    }));
    return { counts, makers: owners.size, partial };
}

function createCountsRouter(deps = null) {
    const d = deps || makeDefaultDeps();
    const router = express.Router();
    const cache = new Map();

    const now = () => (typeof d.now === 'function' ? d.now() : Date.now());
    const cacheGet = (key) => {
        const hit = cache.get(key);
        if (!hit) return null;
        if (now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
        return hit.body;
    };
    const cacheSet = (key, body) => {
        if (cache.size >= CACHE_MAX_ENTRIES) {
            // Oldest first — Map iterates in insertion order.
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(key, { at: now(), body });
    };

    router.get('/counts', requireSession, validate({ query: NoQuery }), async (req, res) => {
        const key = `${orgIdOf(req) || ''}:${userIdOf(req)}`;
        // The server cache is the only cache: no-store keeps the browser from
        // answering the visibilitychange catch-up fetch with a stale body.
        res.set('Cache-Control', 'private, no-store');
        const cached = cacheGet(key);
        if (cached) return res.json(cached);
        try {
            // `partial` never reaches the client: an absent key already means
            // "not for you", and the next poll (30s) recounts a partial body.
            const { partial, ...body } = await computeCounts(req, d);
            // …but `makers` is a SET SIZE, and a set built from kinds that
            // partly failed reports a smaller workplace rather than an unknown
            // one. Studio Home turns 0 into "Nothing built here yet", so a
            // single store having a bad day would become a statement about the
            // organisation. An ABSENT key is the answer this response already
            // has for "not known" (the counts use it), so makers uses it too.
            if (partial) delete body.makers;
            if (!partial) cacheSet(key, body);
            return res.json(body);
        } catch (err) {
            // computeCounts swallows per-kind failures; this is the "cannot
            // even start" case.
            log.error('[StudioCounts] failed:', err?.message || err);
            return res.status(500).json({ error: 'Could not count' });
        }
    });

    router.__clearCacheForTests = () => cache.clear();
    return router;
}

const router = createCountsRouter();

module.exports = router;
module.exports.createCountsRouter = createCountsRouter;
module.exports.KIND_KEYS = KIND_KEYS;
module.exports.CACHE_TTL_MS = CACHE_TTL_MS;
module.exports.ownerOf = ownerOf;
