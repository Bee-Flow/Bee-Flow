// @typecheck
/**
 * Website analytics (Umami) — admin routes.
 *
 * Extracted from routes/cms.js, which mounts this router at /admin/analytics
 * BEFORE its own `router.use('/admin', attachSiteId)` so that opening the
 * analytics dashboard never auto-provisions a default CMS project.
 *
 * Everything here is operator-only (requireSuperAdmin, stricter than the CMS
 * requireAdmin) and, apart from the settings writes and the recorder toggle,
 * strictly read-only against Umami. The browser never holds Umami credentials:
 * it talks to this router, this router talks to core/umamiClient.js.
 *
 * Storage (config table):
 *   cms_analytics_enabled       : boolean  master on/off for tracking
 *   cms_analytics_consent_mode  : 'cookieless' | 'cookies'
 *   cms_analytics_site_map      : { [siteId]: umamiWebsiteId }
 *   cms_analytics_recorder_map  : { [siteId]: true }  session recording opt-in
 *   cms_analytics_url           : Umami base URL (also the public script origin)
 *   cms_analytics_{username,password,api_token} : secrets (umamiClient reads)
 */

'use strict';

const express = require('express');
const configStore = require('../stores/configStore');
const umamiClient = require('../core/umamiClient');
const analyticsQueries = require('../core/cms/analyticsQueries');
const { perUserRateLimit } = require('../utils/perUserRateLimit');
const { SITE_ID_RE } = require('./cmsShared');
const { requireSuperAdmin } = require('../auth/permissions');
const log = require('../telemetry/log');
const { validate } = require('../core/http/validate');
const { z, worded, bodyOf, closedObject, choice, typeError } = require('../core/http/schemaParts');
const { HttpError } = require('../core/http/errors');
const { KEY_ANALYTICS_SITE_MAP, rangeToWindow, KEY_ANALYTICS_RECORDER_MAP, getTrackerOptions, readMap, getAnalyticsSettings, getAnalyticsSiteMap, resolveAnalyticsTarget, getRecorderMap, setAnalyticsWebsiteId, provisionAnalyticsForSite, windowFromReq, requireTarget, _cache, invalidateCache, metricTypes, pickFilters, getAnalyticsSettingsHandler, putAnalyticsSettingsHandler, getDiagnoseHandler, probeScript, getAnalyticsSitesHandler, getAnalyticsStatusHandler, putRecorderHandler, getAnalyticsOverviewHandler } = require('./cmsAnalyticsHandlers');

const router = express.Router();

// ── Settings + site map ──────────────────────────────────────────────

// Drop a site's mappings when it's deleted, so resolveAnalyticsTarget's
// fallback can't surface a deleted site's numbers.
async function forgetSite(siteId) {
    for (const key of [KEY_ANALYTICS_SITE_MAP, KEY_ANALYTICS_RECORDER_MAP]) {
        const map = await readMap(key);
        if (map[siteId] === undefined) continue;
        delete map[siteId];
        await configStore.setConfig(key, map);
    }
}

// ── Gate ─────────────────────────────────────────────────────────────
//
// Stricter than the CMS requireAdmin: analytics is an operator surface, so an
// org user holding the `all` permission via a group or custom role is NOT
// admitted. Imported from auth/permissions.js — was a local copy.

// One user hammering refresh fans out to many upstream Umami calls, so the
// limit sits in front of every analytics route rather than per-endpoint.
const analyticsLimiter = perUserRateLimit({ windowMs: 60_000, max: 240 });

// MUST be registered before any route below — Express runs middleware in
// registration order, so a `router.use` at the bottom of this file would leave
// every route defined above it ungated.
router.use(requireSuperAdmin, analyticsLimiter);

// ── Range + target resolution ────────────────────────────────────────

// ── Response cache ───────────────────────────────────────────────────
//
// Section switching and the realtime poll would otherwise stampede Umami. Short
// TTL so the dashboard still feels live; `fresh=1` (the refresh button) bypasses.
const CACHE_TTL_MS = 15_000;
const REALTIME_TTL_MS = 3_000;

function cacheGet(key) {
    const hit = _cache.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expires) { _cache.delete(key); return undefined; }
    return hit.value;
}

function cacheSet(key, value, ttl) {
    // Bounded so a long-lived process can't accumulate every filter combination.
    if (_cache.size > 500) _cache.clear();
    _cache.set(key, { value, expires: Date.now() + ttl });
}

// ── Umami read surface (closed allow-list) ───────────────────────────
//
// SECURITY: `:resource` and `:type` are looked up in these literal tables and
// the upstream path comes from the table, never from the request. Mutating and
// operator endpoints (reset, transfer, shares, POST /api/reports which SAVES a
// report, and everything under /api/admin|users|teams) are unreachable by
// construction rather than by filtering.
//
// `params` is the per-resource allow-list of caller-supplied query keys, on top
// of the window (startAt/endAt/unit/timezone) which we always compute ourselves.

const RESOURCES = Object.freeze({
    stats:            { path: (w) => `/api/websites/${w}/stats`,            params: [] },
    pageviews:        { path: (w) => `/api/websites/${w}/pageviews`,        params: [] },
    metrics:          { path: (w) => `/api/websites/${w}/metrics`,          params: ['type', 'limit'] },
    values:           { path: (w) => `/api/websites/${w}/values`,           params: ['type', 'search'] },
    active:           { path: (w) => `/api/websites/${w}/active`,           params: [], window: false },
    realtime:         { path: (w) => `/api/realtime/${w}`,                  params: [], window: false, ttl: REALTIME_TTL_MS },
    events:           { path: (w) => `/api/websites/${w}/events`,           params: ['query', 'page', 'pageSize'] },
    // page/pageSize matter here: without them the proxy can only ever return
    // Umami's first page, so per-block event aggregation silently under-counts.
    'event-data':     { path: (w) => `/api/websites/${w}/event-data`,       params: ['event', 'propertyName', 'page', 'pageSize'] },
    sessions:         { path: (w) => `/api/websites/${w}/sessions`,         params: ['query', 'page', 'pageSize'] },
    'session-data':   { path: (w) => `/api/websites/${w}/session-data`,     params: ['propertyName'] },
    daterange:        { path: (w) => `/api/websites/${w}/daterange`,        params: [], window: false },
    segments:         { path: (w) => `/api/websites/${w}/segments`,         params: ['type', 'page', 'pageSize'], window: false },
    replays:          { path: (w) => `/api/websites/${w}/replays`,          params: ['page', 'pageSize'] },
    'revenue-chart':  { path: (w) => `/api/websites/${w}/revenue/chart`,    params: ['currency'] },
    'revenue-stats':  { path: (w) => `/api/websites/${w}/revenue/stats`,    params: ['currency', 'compare'] },
    'revenue-metrics':{ path: (w) => `/api/websites/${w}/revenue/metrics`,  params: ['currency', 'type'] },
});

// Report endpoints are POST-with-a-body and compute on the fly — they do not
// persist anything. Each entry lists the body keys the caller may set.
const REPORTS = Object.freeze({
    funnel:      ['steps', 'window'],
    retention:   [],
    journey:     ['steps', 'startStep', 'endStep'],
    goal:        ['type', 'value'],
    // `unit` is deliberately absent: `parameters` is seeded with the window we
    // derived, and an allow-listed key of the same name would overwrite it.
    performance: ['metric'],
    utm:         [],
    attribution: ['model', 'type', 'step'],
    breakdown:   ['fields'],
    revenue:     ['currency', 'compare'],
    // Umami reads `mode` ('click' | 'scroll'); `type` is ignored, which is why
    // scroll heatmaps were unreachable. `type` stays for one release so an
    // older client keeps working — but it also keeps click and scroll requests
    // for the same page from colliding on one cache entry.
    heatmap:     ['mode', 'type', 'urlPath'],
});

// The only resources whose `type` param is a METRIC_TYPES dimension.
const DIMENSION_RESOURCES = new Set(['metrics', 'values']);

const MAX_PAGE_SIZE = 500;

/**
 * Paging params reach Umami verbatim, so an edited URL could otherwise ask for
 * a million rows and park a 12 s upstream call behind the shared cache.
 */
function clampPaging(query) {
    if (query.page !== undefined) {
        const n = Math.floor(Number(query.page));
        query.page = String(Number.isFinite(n) && n > 0 ? n : 1);
    }
    if (query.pageSize !== undefined) {
        const n = Math.floor(Number(query.pageSize));
        query.pageSize = String(Number.isFinite(n) && n > 0 ? Math.min(n, MAX_PAGE_SIZE) : 50);
    }
    if (query.limit !== undefined) {
        const n = Math.floor(Number(query.limit));
        query.limit = String(Number.isFinite(n) && n > 0 ? Math.min(n, MAX_PAGE_SIZE) : 10);
    }
    return query;
}

router.get('/query/:resource', async (req, res) => {
    const spec = Object.prototype.hasOwnProperty.call(RESOURCES, req.params.resource)
        ? RESOURCES[req.params.resource] : null;
    if (!spec) return res.status(400).json({ error: 'Unknown analytics resource' });

    try {
        const target = await requireTarget(req, res);
        if (!target) return undefined;

        const query = {};
        if (spec.window !== false) {
            const w = windowFromReq(req.query);
            query.startAt = w.startAt;
            query.endAt = w.endAt;
            if (req.query.unit || w.unit) query.unit = (req.query.unit || w.unit).toString();
            query.timezone = (req.query.timezone || 'UTC').toString();
        }
        for (const k of spec.params) {
            if (req.query[k] !== undefined) query[k] = req.query[k];
        }
        // Only /metrics and /values speak the METRIC_TYPES vocabulary. `segments`
        // and `revenue-metrics` declare their own `type` values, so validating
        // theirs against dimensions makes them permanently unreachable.
        if (DIMENSION_RESOURCES.has(req.params.resource)
            && query.type !== undefined
            && !metricTypes().includes(String(query.type))) {
            return res.status(400).json({ error: 'Unknown dimension' });
        }
        clampPaging(query);

        // Filters describe a window of traffic, so they are meaningless for the
        // window-less resources (realtime/active/daterange) — forwarding them
        // there would only fragment the cache for a byte-identical payload.
        const filters = spec.window !== false ? pickFilters(req.query) : {};
        Object.assign(query, filters);

        // Key on the REQUEST identity (range token + params), never on the
        // resolved window: a relative range recomputes endAt=Date.now() on every
        // call, so a window-derived key would change every millisecond and the
        // cache would never hit.
        const keyParts = { tz: query.timezone };
        if (spec.window !== false) {
            keyParts.range = req.query.range || '7d';
            for (const k of ['unit', 'start', 'end']) {
                if (req.query[k] !== undefined) keyParts[k] = req.query[k];
            }
            Object.assign(keyParts, filters);
        }
        for (const k of spec.params) {
            if (query[k] !== undefined) keyParts[k] = query[k];
        }
        const cacheKey = `${target.websiteId}|${req.params.resource}|${JSON.stringify(keyParts)}`;
        if (req.query.fresh !== '1') {
            const hit = cacheGet(cacheKey);
            if (hit !== undefined) return res.json({ ...hit, cached: true });
        }

        // metrics goes through getMetrics so it inherits the v2/v3 dimension-name
        // fallback; everything else is a straight passthrough. Filters must be
        // handed over explicitly — dropping them here is what made every
        // drill-down chip return unfiltered rows under a filtered cache key.
        const data = req.params.resource === 'metrics'
            ? await umamiClient.getMetrics(target.websiteId, {
                type: query.type, startAt: query.startAt, endAt: query.endAt,
                limit: query.limit || 10, filters,
            })
            : await umamiClient.get(spec.path(target.websiteId), query);

        const payload = {
            enabled: true, configured: true, provisioned: true,
            siteId: target.siteId, data,
        };
        cacheSet(cacheKey, payload, spec.ttl || CACHE_TTL_MS);
        return res.json(payload);
    } catch (err) {
        log.error(`[CMS] analytics query ${req.params.resource} failed:`, err.message);
        // Pass the upstream reason through. This route is requireSuperAdmin and
        // Umami's failures are schema/validation text, not secrets — collapsing
        // them into a bare "Failed to load analytics" turned a self-describing
        // 400 ("expected one of …") into a guessing game.
        throw new HttpError(502, 'analytics_unavailable', 'Failed to load analytics', {
            upstreamStatus: err.status || null,
            reason: String(err.message || '').slice(0, 600),
        });
    }
});

router.post('/report/:type', async (req, res) => {
    const allowedKeys = Object.prototype.hasOwnProperty.call(REPORTS, req.params.type)
        ? REPORTS[req.params.type] : null;
    if (!allowedKeys) return res.status(400).json({ error: 'Unknown report type' });

    try {
        const target = await requireTarget(req, res);
        if (!target) return undefined;

        const src = req.body || {};
        const w = windowFromReq(src);
        const timezone = (src.timezone || 'UTC').toString();
        const filters = pickFilters(src);
        const extra = {};
        for (const k of allowedKeys) {
            if (src[k] !== undefined) extra[k] = src[k];
        }
        const body = analyticsQueries.buildReportBody({
            type: req.params.type, websiteId: target.websiteId, window: w, timezone, filters, extra,
        });

        // Request identity, not the resolved dateRange — see the note in
        // /query/:resource: a relative range would bust the key every call.
        const keyParts = { range: src.range || '7d', tz: timezone, start: src.start, end: src.end };
        for (const k of allowedKeys) {
            if (src[k] !== undefined) keyParts[k] = src[k];
        }
        Object.assign(keyParts, filters);
        const cacheKey = `${target.websiteId}|report:${req.params.type}|${JSON.stringify(keyParts)}`;
        if (src.fresh !== true) {
            const hit = cacheGet(cacheKey);
            if (hit !== undefined) return res.json({ ...hit, cached: true });
        }

        const data = await umamiClient.post(`/api/reports/${req.params.type}`, body);
        const payload = {
            enabled: true, configured: true, provisioned: true,
            siteId: target.siteId, data,
        };
        cacheSet(cacheKey, payload, CACHE_TTL_MS);
        return res.json(payload);
    } catch (err) {
        log.error(`[CMS] analytics report ${req.params.type} failed:`, err.message);
        throw new HttpError(502, 'analytics_unavailable', 'Failed to load report');
    }
});

// ── Settings ─────────────────────────────────────────────────────────

// ── Overview ─────────────────────────────────────────────────────────

// ── Registration ─────────────────────────────────────────────────────
// (the requireSuperAdmin + limiter gate is installed near the top of the file,
// ahead of the /query and /report routes)

// ── What the two writes accept ───────────────────────────────────────
// Closed bodies, booleans as booleans. The handler compared with `=== true`,
// so the text "true" read as false: `enabled: "true"` switched tracking OFF,
// `tracker.doNotTrack: "true"` stopped honouring Do Not Track, and on
// PUT /recorder it switched session recording off. A misspelled mask level
// or an out-of-range sample rate kept the old value under a 200.
//
// The reads (GET /query/:resource, POST /report/:type, /overview) keep no
// schema: their accepted keys are the per-resource allow-lists above
// (RESOURCES, REPORTS, metricTypes()), which vary by resource and by the
// Umami version, and every value is clamped before it leaves. Nothing they
// take is written anywhere.
const flagOf = (name) => z.boolean({ error: typeError({ invalid: `${name} is true or false.` }) });
const aText = (message, max) => worded(message).max(max, message);
const SettingsBody = bodyOf({
    enabled: flagOf('enabled').optional(),
    consentMode: choice(['cookieless', 'cookies'], 'consentMode is cookieless or cookies.').optional(),
    url: aText('url is the address of your Umami, like https://umami.example.com.', 500).nullish(),
    username: aText('username is text.', 500).nullish(),
    password: aText('password is text.', 500).nullish(),
    apiToken: aText('apiToken is text.', 2000).nullish(),
    tracker: closedObject({
        tag: aText('tracker.tag is text of at most 60 characters.', 60).optional(),
        excludeSearch: flagOf('tracker.excludeSearch').optional(),
        excludeHash: flagOf('tracker.excludeHash').optional(),
        doNotTrack: flagOf('tracker.doNotTrack').optional(),
        domains: aText('tracker.domains is a comma-separated list of at most 300 characters.', 300).optional(),
    }, 'tracker').optional(),
    recorder: closedObject({
        sampleRate: z.number({ error: typeError({ invalid: 'recorder.sampleRate is a number above 0, at most 1.' }) })
            .gt(0, 'recorder.sampleRate is a number above 0, at most 1.').lte(1, 'recorder.sampleRate is a number above 0, at most 1.').optional(),
        // Read when a request arrives: routes/cmsPublicSite.test.js stubs
        // umamiClient with a partial object (see metricTypes below).
        maskLevel: aText('recorder.maskLevel is a mask level, like strict.', 40)
            .refine((v) => (umamiClient.MASK_LEVELS || []).includes(v), 'recorder.maskLevel is strict or moderate.').optional(),
    }, 'recorder').optional(),
}, 'Analytics settings');
const RecorderBody = bodyOf({
    siteId: aText('Invalid siteId', 200).regex(SITE_ID_RE, 'Invalid siteId'),
    enabled: flagOf('enabled'),
}, 'Session recording');

router.get('/settings',  getAnalyticsSettingsHandler);
router.put('/settings',  validate({ body: SettingsBody }), putAnalyticsSettingsHandler);
router.get('/sites',     getAnalyticsSitesHandler);
router.get('/status',    getAnalyticsStatusHandler);
router.get('/diagnose',  getDiagnoseHandler);
router.get('/overview',  getAnalyticsOverviewHandler);
router.put('/recorder',  validate({ body: RecorderBody }), putRecorderHandler);

module.exports = {
    router,
    // Consumed by routes/cms.js (publish / delete / public envelope).
    getAnalyticsSettings,
    getAnalyticsSiteMap,
    getRecorderMap,
    getTrackerOptions,
    setAnalyticsWebsiteId,
    provisionAnalyticsForSite,
    forgetSite,
    // Exported for tests.
    _test: { rangeToWindow, resolveAnalyticsTarget, RESOURCES, REPORTS, invalidateCache, probeScript },
};
