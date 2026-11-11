// @typecheck strict
/**
 * /api/usage/adoption — the organisation's Adoption report (Settings →
 * Organisation → Usage & Monitoring → Adoption): who uses Bee Flow and how,
 * what has been built and by whom, where the AI spend goes.
 *
 *   GET /summary        members, makers, spend, seats, the period before
 *   GET /areas          spend per area of shared/usageAreas.js, and per ISO week
 *   GET /studio         the Studio inventory per kind, with usage evidence
 *   GET /studio/items   the objects of one kind (?kind=), top users pseudonymous
 *   GET /groups         adoption per group, groups under five members folded
 *   GET /people         adoption per member, PSEUDONYMOUS; ?reveal=true shows
 *                       names after writing an access-audit row (fail-closed)
 *
 * An organisation report: the chain is session → query → admin_monitoring
 * (org admins hold it through `all`, the DPO role holds it) → the
 * organisation from the session (a super admin: the one on their record) →
 * admin_monitoring held IN that organisation (routes/usageAdoptionAccess.js).
 * A caller without an organisation is refused; the organisation never comes
 * from the query, and `?group=` only narrows within it. Parameter-free paths, so isolation is proven by the tests next to
 * this file, not by the tenant matrix.
 *
 * Privacy: people are pseudonymous by default (core/privacy/pseudonym.js); a
 * reveal is one audited request, the record written BEFORE the answer is
 * built (routes/dsr.js dsr.subject_viewed). The people who use a Studio kind
 * most are always pseudonymous, under a pseudonym key of their own that the
 * people reveal does not unlock. Owners are named: building something is
 * organisational metadata, using it is behaviour. Cost figures go through the
 * same customer view as the Overview tab (routes/usageRedact.js): on cloud a
 * customer sees marked-up cost and no call counts.
 *
 * Mounted in index.js behind the advanced_usage_monitoring capability, before
 * /api/usage. Cached 60 s in memory per organisation and query (the limit as
 * clamped; people pages as the fields they show, bounded by their row count),
 * never a partial answer, and `Cache-Control: private, no-store` (the server cache is
 * the only cache), like routes/studio/counts.js.
 *
 * Dependencies are injectable (`createAdoptionRouter(deps)`) so the
 * authorisation test runs the real chain with its own store and gates.
 */

'use strict';

const express = require('express');
const { validate } = require('../core/http/validate');
const { worded, queryOf, choice, wholeNumber } = require('../core/http/schemaParts');
const { HttpError } = require('../core/http/errors');
const log = require('../telemetry/log');
const { makeLazyDeps } = require('./studio/shared');
const {
    shapeSummary, shapeAreas, shapeStudio, shapeItems, shapeGroups, shapePerson, compactPeople,
} = require('./usageAdoptionShape');
const access = require('./usageAdoptionAccess');

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 2000;
/** The people rows the cache may hold over all its entries (an entry of any other route weighs 1). */
const CACHE_MAX_ROWS = 20_000;
const ITEMS_DEFAULT = 50;
const ITEMS_MAX = 200;
const PEOPLE_DEFAULT = 50;
const PEOPLE_MAX = 500;

const DEFAULT_LOADERS = {
    store: () => require('../stores/adoptionStore'),
    userStore: () => require('../stores/userStore'),
    permissions: () => require('../auth/permissions'),
    scope: () => require('./usageScope'),
    redact: () => require('./usageRedact'),
    pseudonym: () => require('../core/privacy/pseudonym'),
    orgRoles: () => require('../auth/orgRolePolicy'),
    catalog: () => require('../auth/permissionsCatalog'),
    now: () => Date.now,
};

/** @typedef {ReturnType<typeof makeDefaultDeps>} AdoptionRouteDeps */
const makeDefaultDeps = () => makeLazyDeps(DEFAULT_LOADERS);

/** The Studio kinds, in report order (stores/adoption/kinds.js, which loads no store). */
const KIND_KEYS = /** @type {[string, ...string[]]} */ ([...require('../stores/adoption/kinds').KIND_KEYS]);

const DATE_TEXT = 'startDate and endDate are dates, like 2026-09-01T00:00:00Z.';
const aDate = worded(DATE_TEXT).max(64, DATE_TEXT).refine((v) => !Number.isNaN(new Date(v).getTime()), DATE_TEXT);

const AdoptionQuery = queryOf({
    days: wholeNumber('days is a whole number of days, 1 or more.', { min: 1, max: 36_500 }).optional(),
    startDate: aDate.optional(),
    endDate: aDate.optional(),
    group: worded('group is the id of a group.').max(200, 'group is at most 200 characters.').optional(),
    // A platform admin's choice of organisation (routes/usageScope.js getOrgFilter); anyone else may only name their own.
    orgId: worded('orgId is the id of an organisation.').max(200, 'orgId is at most 200 characters.').optional(),
    kind: choice(KIND_KEYS, `kind is one of ${KIND_KEYS.join(', ')}.`).optional(),
    reveal: choice(['true', 'false'], 'reveal is true or false.').optional(),
    // Each route clamps its own page size.
    limit: wholeNumber('limit is a whole number, 1 or more.', { min: 1 }).optional(),
    cursor: wholeNumber('cursor is the position the previous page ended at.', { min: 0 }).optional(),
}, 'The adoption report').refine((q) => !q.startDate === !q.endDate, {
    message: 'Send startDate and endDate together, or neither.', path: ['startDate'],
});

/**
 * The session check, ahead of the schema: a caller without one hears 401, not 400.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
const requireSession = (req, res, next) => (req.session?.isAuthenticated && req.session.user
    ? next()
    : res.status(401).json({ error: 'Not authenticated' }));

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} max
 */
function clamp(value, fallback, max) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), max) : fallback;
}

/** @param {unknown} body The rows an answer holds: a people page its rows, anything else 1. */
function weightOf(body) {
    const rows = /** @type {{ people?: unknown }} */ (body).people;
    return Array.isArray(rows) ? Math.max(1, rows.length) : 1;
}

/**
 * The 60 s answer cache, bounded by its entries and by the people rows they
 * hold. Entries are kept in the order they were written, so the oldest go
 * first: the expired ones on every write, then as many as a new one needs.
 * @param {() => number} now
 * @param {{ maxEntries?: number, maxRows?: number }} [limits]
 */
function createCache(now, { maxEntries = CACHE_MAX_ENTRIES, maxRows = CACHE_MAX_ROWS } = {}) {
    /** @type {Map<string, { at: number, body: unknown, weight: number }>} */
    const cache = new Map();
    let rows = 0;
    /** @param {string} key */
    const drop = (key) => {
        const e = cache.get(key);
        if (e) { rows -= e.weight; cache.delete(key); }
    };
    /** @param {number} weight */
    const makeRoom = (weight) => {
        const t = now();
        for (const [key, e] of cache) {
            if (cache.size < maxEntries && rows + weight <= maxRows && t - e.at <= CACHE_TTL_MS) break;
            drop(key);
        }
    };
    return {
        clear: () => { cache.clear(); rows = 0; },
        stats: () => ({ entries: cache.size, rows }),
        /**
         * The answer for this organisation and query, from the cache when
         * fresh. A partial answer is never kept.
         * @template T
         * @param {string} key
         * @param {() => Promise<T>} load
         * @returns {Promise<T>}
         */
        async get(key, load) {
            const hit = cache.get(key);
            if (hit && now() - hit.at <= CACHE_TTL_MS) return /** @type {T} */ (hit.body);
            drop(key);
            const body = await load();
            if (!body || (/** @type {{ partial?: boolean }} */ (body)).partial) return body;
            const weight = weightOf(body);
            if (weight > maxRows) return body;
            drop(key);
            makeRoom(weight);
            cache.set(key, { at: now(), body, weight });
            rows += weight;
            return body;
        },
    };
}

/**
 * The cache key: organisation, route, the period as sent (a relative period
 * keys on `days`, not on the instants it resolves to, or it would never hit),
 * the group and kind, and the page as the route clamped it. `reveal` is not
 * in it: the store's answer is the same, and the reveal is shaped after.
 * @param {import('express').Request} req
 * @param {string} route
 * @param {{ limit?: number, cursor?: number }} [page]
 */
function cacheKey(req, route, page = {}) {
    const q = /** @type {Record<string, unknown>} */ (req.query || {});
    const period = q.startDate && q.endDate ? [null, q.startDate, q.endDate] : [Number(q.days ?? 30), null, null];
    return JSON.stringify([req.usageFilters?.organizationId, route, ...period,
        q.group ?? null, q.kind ?? null, page.limit ?? null, page.cursor ?? null]);
}

/**
 * The scope every store read runs under.
 * @param {import('express').Request} req
 * @param {AdoptionRouteDeps} d
 * @returns {import('../stores/adoption/shared').Scope}
 */
function scopeOf(req, d) {
    const now = d.now();
    const q = /** @type {Record<string, unknown>} */ (req.query || {});
    return {
        orgId: String(req.usageFilters?.organizationId),
        // attachOrgFilter always sets the window (routes/usageScope.js buildRequestFilters).
        period: d.store.periodOf(/** @type {{ startDate?: string, endDate?: string }} */ (req.usageFilters || {}), q, now),
        groupId: typeof q.group === 'string' && q.group ? q.group : null,
        now,
    };
}

// ── The handlers ──────────────────────────────────────────────────────────

/**
 * The pseudonym of a person in the caller's organisation: an opaque row id
 * and the label, both from the people table's key domain.
 * @param {AdoptionRouteDeps} d
 * @param {string} orgId
 */
function pseudonymizer(d, orgId) {
    const secret = d.pseudonym.pseudonymSecret();
    return (/** @type {string} */ userId) => ({
        id: d.pseudonym.pseudonymId(userId, orgId, secret),
        name: d.pseudonym.pseudonymFor(userId, orgId, secret),
    });
}

/**
 * The label of a top user of a Studio kind: a key domain of its own, so it
 * never equals the people-table label a reveal names.
 * @param {AdoptionRouteDeps} d
 * @param {string} orgId
 */
function topPeopleLabel(d, orgId) {
    const secret = d.pseudonym.pseudonymSecret();
    return (/** @type {string} */ userId) => d.pseudonym.pseudonymFor(userId, orgId, secret, { domain: 'top-people' });
}

/**
 * The avatars of revealed people, by id.
 * @param {AdoptionRouteDeps} d
 * @param {string[]} ids
 * @returns {Promise<Map<string, import('./usageAdoptionShape').AvatarRow>>}
 */
async function avatarsOf(d, ids) {
    /** @type {import('./usageAdoptionShape').AvatarRow[]} */
    const rows = (await d.userStore.getUserAvatarsByIds(ids)) || [];
    return new Map(rows.map((u) => [String(u.id), u]));
}

/**
 * Write the reveal's access-audit row before anything is built. A failure, or
 * a store that cannot write it, refuses the answer: names are shown only when
 * the record of showing them exists.
 * @param {import('express').Request} req
 * @param {AdoptionRouteDeps} d
 * @param {import('../stores/adoption/shared').Scope} scope
 * @param {number} limit
 */
async function recordReveal(req, d, scope, limit) {
    try {
        if (typeof d.store.recordReveal !== 'function') throw new Error('no audit writer');
        await d.store.recordReveal({
            orgId: scope.orgId,
            actorId: String(req.session?.user?.id),
            details: { startDate: scope.period.startDate, endDate: scope.period.endDate, group: scope.groupId || null, limit },
        });
    } catch (err) {
        // The reason only: no names, no ids of the people asked for.
        log.error('[Adoption] reveal audit failed; names withheld:', /** @type {Error} */ (err)?.message || err);
        throw new HttpError(503, 'audit_unavailable', 'The reveal could not be recorded, so names cannot be shown. Try again later.');
    }
}

/**
 * @param {AdoptionRouteDeps} d
 * @param {ReturnType<typeof createCache>} cache
 */
function makeHandlers(d, cache) {
    return {
        /** @param {import('express').Request} req @param {import('express').Response} res */
        summary: async (req, res) => {
            const scope = scopeOf(req, d);
            const body = await cache.get(cacheKey(req, 'summary'), () => d.store.summary(scope));
            res.json(shapeSummary(body, await d.redact.costLens(req)));
        },
        /** @param {import('express').Request} req @param {import('express').Response} res */
        areas: async (req, res) => {
            const scope = scopeOf(req, d);
            const body = await cache.get(cacheKey(req, 'areas'), () => d.store.areas(scope));
            res.json(shapeAreas(body, await d.redact.costLens(req)));
        },
        /** @param {import('express').Request} req @param {import('express').Response} res */
        studio: async (req, res) => {
            const scope = scopeOf(req, d);
            const body = await cache.get(cacheKey(req, 'studio'), () => d.store.studio(scope));
            res.json(shapeStudio(body, await d.redact.costLens(req)));
        },
        /** @param {import('express').Request} req @param {import('express').Response} res */
        studioItems: async (req, res) => {
            const kind = typeof req.query.kind === 'string' ? req.query.kind : '';
            if (!kind) throw new HttpError(400, 'invalid_request', `The drill-down needs a kind: one of ${KIND_KEYS.join(', ')}.`);
            const scope = scopeOf(req, d);
            const limit = clamp(req.query.limit, ITEMS_DEFAULT, ITEMS_MAX);
            const body = await cache.get(cacheKey(req, 'studio/items', { limit }), () => d.store.studioItems(scope, kind, limit));
            if (!body) throw new HttpError(400, 'invalid_request', `kind is one of ${KIND_KEYS.join(', ')}.`);
            res.json(shapeItems(body, await d.redact.costLens(req), topPeopleLabel(d, scope.orgId)));
        },
        /** @param {import('express').Request} req @param {import('express').Response} res */
        groups: async (req, res) => {
            const scope = scopeOf(req, d);
            const body = await cache.get(cacheKey(req, 'groups'), () => d.store.groups(scope));
            res.json(shapeGroups(body, await d.redact.costLens(req)));
        },
        /** @param {import('express').Request} req @param {import('express').Response} res */
        people: async (req, res) => {
            const scope = scopeOf(req, d);
            const reveal = req.query.reveal === 'true';
            const limit = clamp(req.query.limit, PEOPLE_DEFAULT, PEOPLE_MAX);
            const cursor = Math.max(0, Number(req.query.cursor) || 0);
            if (reveal) await recordReveal(req, d, scope, limit);
            const out = await cache.get(cacheKey(req, 'people', { limit, cursor }),
                async () => compactPeople(await d.store.people(scope, { limit, cursor })));
            const ctx = {
                lens: await d.redact.costLens(req), reveal,
                avatars: reveal ? await avatarsOf(d, out.people.map((p) => p.id)) : new Map(),
                pseudonym: pseudonymizer(d, scope.orgId),
                groupNames: new Map(out.groupNames),
            };
            res.json({
                reveal, auditRecorded: reveal,
                people: out.people.map((row) => shapePerson(row, ctx)),
                total: out.total, nextCursor: out.nextCursor,
            });
        },
    };
}

/** @param {AdoptionRouteDeps | null} [deps] */
function createAdoptionRouter(deps = null) {
    const d = deps || makeDefaultDeps();
    const router = express.Router();
    const cache = createCache(() => d.now());
    const h = makeHandlers(d, cache);

    router.use(requireSession);
    router.use(validate({ query: AdoptionQuery }));
    router.use(d.permissions.requirePermission('admin_monitoring'));
    router.use(d.scope.attachOrgFilter);
    router.use(access.requireOrganisation(d));
    router.use(access.requireMonitoringInOrg(d));
    // The server cache is the only cache.
    router.use((/** @type {import('express').Request} */ _req, /** @type {import('express').Response} */ res, /** @type {import('express').NextFunction} */ next) => {
        res.set('Cache-Control', 'private, no-store');
        next();
    });

    router.get('/summary', h.summary);
    router.get('/areas', h.areas);
    router.get('/studio', h.studio);
    router.get('/studio/items', h.studioItems);
    router.get('/groups', h.groups);
    router.get('/people', h.people);

    const testable = /** @type {import('express').Router & { __clearCacheForTests?: () => void, __cacheStatsForTests?: () => { entries: number, rows: number } }} */ (router);
    testable.__clearCacheForTests = () => cache.clear();
    testable.__cacheStatsForTests = () => cache.stats();
    return router;
}

/** @typedef {ReturnType<typeof createAdoptionRouter> & { createAdoptionRouter: typeof createAdoptionRouter, createCache: typeof createCache, KIND_KEYS: typeof KIND_KEYS, CACHE_TTL_MS: typeof CACHE_TTL_MS, AdoptionQuery: typeof AdoptionQuery }} AdoptionRouter */
const router = createAdoptionRouter();

module.exports = /** @type {AdoptionRouter} */ (router);
/** @type {AdoptionRouter} */ (module.exports).createAdoptionRouter = createAdoptionRouter;
/** @type {AdoptionRouter} */ (module.exports).createCache = createCache;
/** @type {AdoptionRouter} */ (module.exports).KIND_KEYS = KIND_KEYS;
/** @type {AdoptionRouter} */ (module.exports).CACHE_TTL_MS = CACHE_TTL_MS;
/** @type {AdoptionRouter} */ (module.exports).AdoptionQuery = AdoptionQuery;
