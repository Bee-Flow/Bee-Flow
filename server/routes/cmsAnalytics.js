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
const cmsStore = require('../stores/cmsStore');
const umamiClient = require('../core/umamiClient');
const { perUserRateLimit } = require('../utils/perUserRateLimit');
const { SITE_ID_RE, getLiveSiteId } = require('./cmsShared');
const { requireSuperAdmin } = require('../auth/permissions');
const log = require('../telemetry/log');
const { validate } = require('../core/http/validate');
const { z, worded, bodyOf, closedObject, choice } = require('../core/http/schemaParts');

const router = express.Router();

const KEY_ANALYTICS_ENABLED      = 'cms_analytics_enabled';
const KEY_ANALYTICS_CONSENT_MODE = 'cms_analytics_consent_mode';
const KEY_ANALYTICS_SITE_MAP     = 'cms_analytics_site_map';
const KEY_ANALYTICS_RECORDER_MAP = 'cms_analytics_recorder_map';
const KEY_ANALYTICS_TRACKER_OPTS = 'cms_analytics_tracker_options';
const KEY_ANALYTICS_RECORDER_OPTS = 'cms_analytics_recorder_options';

/**
 * Tracker options mirrored onto the public <script> tag.
 *
 * `performance` is deliberately NOT in here: web vitals are cookieless browser
 * timings that ride along with a pageview already being sent under the same
 * consent decision, and making them optional is how they ended up switched off
 * and unnoticed for the whole life of the feature.
 */
const TRACKER_DEFAULTS = Object.freeze({
    tag: '',                 // free-text label → the `tag` dimension
    excludeSearch: false,    // strip ?query from recorded URLs
    excludeHash: true,       // #anchors otherwise fragment one page into many
    doNotTrack: false,       // honour the browser's DNT header
    domains: '',             // comma-separated allow-list of hostnames
});

const RECORDER_DEFAULTS = Object.freeze({
    sampleRate: 1,           // upstream default is 0.15 — useless at low traffic
    maskLevel: 'strict',
});
// Single source of truth lives at the Umami boundary — see umamiClient.
// Redefining a friendlier list here is exactly what produced a 400 on every
// value except 'strict'.
const MASK_LEVELS = umamiClient.MASK_LEVELS;

// ── Settings + site map ──────────────────────────────────────────────

async function getTrackerOptions() {
    const v = await configStore.getConfig(KEY_ANALYTICS_TRACKER_OPTS);
    const stored = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    return {
        tag: typeof stored.tag === 'string' ? stored.tag.slice(0, 60) : TRACKER_DEFAULTS.tag,
        excludeSearch: stored.excludeSearch === true,
        excludeHash: stored.excludeHash !== false,
        doNotTrack: stored.doNotTrack === true,
        domains: typeof stored.domains === 'string' ? stored.domains.slice(0, 300) : TRACKER_DEFAULTS.domains,
    };
}

async function getRecorderOptions() {
    const v = await configStore.getConfig(KEY_ANALYTICS_RECORDER_OPTS);
    const stored = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    const rate = Number(stored.sampleRate);
    return {
        sampleRate: Number.isFinite(rate) && rate > 0 && rate <= 1 ? rate : RECORDER_DEFAULTS.sampleRate,
        maskLevel: MASK_LEVELS.includes(stored.maskLevel) ? stored.maskLevel : RECORDER_DEFAULTS.maskLevel,
    };
}

async function getAnalyticsSettings() {
    const [enabled, consentMode, url] = await Promise.all([
        configStore.getConfig(KEY_ANALYTICS_ENABLED),
        configStore.getConfig(KEY_ANALYTICS_CONSENT_MODE),
        configStore.getConfig(umamiClient.KEY_URL),
    ]);
    return {
        enabled: enabled === true,
        consentMode: consentMode === 'cookies' ? 'cookies' : 'cookieless',
        // The PUBLIC script origin the browser loads /script.js from. Operator-
        // set value wins; UMAMI_PUBLIC_URL is the env fallback. Deliberately NOT
        // process.env.UMAMI_URL — that's the server's INTERNAL base (e.g.
        // http://umami:3000) which a visitor's browser can't reach.
        url: (typeof url === 'string' ? url : (process.env.UMAMI_PUBLIC_URL || '')) || '',
    };
}

async function readMap(key) {
    const v = await configStore.getConfig(key);
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
}

const getAnalyticsSiteMap = () => readMap(KEY_ANALYTICS_SITE_MAP);
const getRecorderMap      = () => readMap(KEY_ANALYTICS_RECORDER_MAP);

async function setAnalyticsWebsiteId(siteId, websiteId) {
    const map = await getAnalyticsSiteMap();
    map[siteId] = websiteId;
    await configStore.setConfig(KEY_ANALYTICS_SITE_MAP, map);
}

// Best-effort: ensure the live/published site has a Umami website provisioned
// and its id persisted. Never throws — analytics must not break publishing.
async function provisionAnalyticsForSite(siteId, { name, domain } = {}) {
    try {
        const settings = await getAnalyticsSettings();
        if (!settings.enabled) return null;
        if (!(await umamiClient.isConfigured())) return null;
        const map = await getAnalyticsSiteMap();
        if (map[siteId]) return map[siteId];
        const websiteId = await umamiClient.ensureWebsite({ name, domain });
        await setAnalyticsWebsiteId(siteId, websiteId);
        return websiteId;
    } catch (err) {
        log.warn('[CMS] analytics provisioning skipped:', err.message);
        return null;
    }
}

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

// Translate a range token into Umami's millisecond-epoch window + the natural
// bucket size. Absolute ranges arrive as `start`/`end` epoch ms with range=custom.
function rangeToWindow(range, { start, end } = {}) {
    if (range === 'custom') {
        const s = Number(start);
        const e = Number(end);
        if (Number.isFinite(s) && Number.isFinite(e) && e > s) {
            // Hourly buckets stay readable up to ~2 days; beyond that use days.
            const unit = (e - s) <= 2 * 24 * 60 * 60 * 1000 ? 'hour' : 'day';
            return { startAt: s, endAt: e, unit };
        }
    }
    const endAt = Date.now();
    const days = range === '24h' ? 1 : range === '30d' ? 30 : range === '90d' ? 90 : 7;
    return { startAt: endAt - days * 24 * 60 * 60 * 1000, endAt, unit: range === '24h' ? 'hour' : 'day' };
}

function windowFromReq(src) {
    return rangeToWindow((src.range || '7d').toString(), { start: src.start, end: src.end });
}

// Pick the site the dashboard should show: explicit siteId (must be tracked),
// else the live site, else the first tracked site. Null when nothing tracked.
async function resolveAnalyticsTarget(wantedRaw) {
    const map = await getAnalyticsSiteMap();
    const wanted = (wantedRaw || '').toString();
    if (wanted && SITE_ID_RE.test(wanted) && map[wanted]) return { siteId: wanted, websiteId: map[wanted] };
    const liveSiteId = await getLiveSiteId();
    if (liveSiteId && map[liveSiteId]) return { siteId: liveSiteId, websiteId: map[liveSiteId] };
    const firstSiteId = Object.keys(map)[0];
    if (firstSiteId) return { siteId: firstSiteId, websiteId: map[firstSiteId] };
    return null;
}

// Shared preflight for every data route: enabled → configured → provisioned.
// Returns the target, or null after having already sent the degenerate response.
async function requireTarget(req, res) {
    const settings = await getAnalyticsSettings();
    if (!settings.enabled) { res.json({ enabled: false }); return null; }
    if (!(await umamiClient.isConfigured())) { res.json({ enabled: true, configured: false }); return null; }
    const src = req.method === 'POST' ? (req.body || {}) : req.query;
    const target = await resolveAnalyticsTarget(src.siteId);
    if (!target) { res.json({ enabled: true, configured: true, provisioned: false }); return null; }
    return target;
}

// ── Response cache ───────────────────────────────────────────────────
//
// Section switching and the realtime poll would otherwise stampede Umami. Short
// TTL so the dashboard still feels live; `fresh=1` (the refresh button) bypasses.
const CACHE_TTL_MS = 15_000;
const REALTIME_TTL_MS = 3_000;
const _cache = new Map();

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

function invalidateCache() { _cache.clear(); }

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

// Dimensions a caller may filter on — mirrors Umami's own filter vocabulary.
// Resolved lazily rather than spread at module load: routes/cms.public.test.js
// stubs umamiClient with a partial object, and a load-time spread would make
// merely importing this router throw.
const metricTypes = () => umamiClient.METRIC_TYPES || [];

/**
 * Collect drill-down filters.
 *
 * Two shapes, because the two transports differ: JSON report bodies nest them
 * under `filters`, while GET requests pass them as top-level params the way
 * Umami's own API expects (?country=NL). Bracket syntax (?filters[country]=NL)
 * is NOT an option — Express 5's default query parser is 'simple' and would
 * hand us the literal key "filters[country]".
 */
function pickFilters(src) {
    const nested = src && typeof src.filters === 'object' && !Array.isArray(src.filters) ? src.filters : null;
    const out = {};
    for (const k of metricTypes()) {
        const v = nested ? nested[k] : src?.[k];
        if (v === undefined || v === null || v === '') continue;
        out[k] = String(v).slice(0, 500);
    }
    return out;
}

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
        return res.status(502).json({
            error: 'Failed to load analytics',
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
        // Umami 3.x report envelope, verified against a live 3.2 instance:
        //   type       – discriminator, must equal the endpoint
        //   filters    – REQUIRED, an object even when empty (omitting it 400s)
        //   parameters – report options AND a repeat of the window; the
        //                top-level dateRange alone is not enough
        const startDate = new Date(w.startAt).toISOString();
        const endDate = new Date(w.endAt).toISOString();
        const filters = pickFilters(src);
        const parameters = { startDate, endDate, timezone, unit: w.unit };
        for (const k of allowedKeys) {
            if (src[k] !== undefined) parameters[k] = src[k];
        }
        const body = {
            type: req.params.type,
            websiteId: target.websiteId,
            dateRange: { startDate, endDate, unit: w.unit, timezone },
            timezone,
            filters,
            parameters,
        };

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
        return res.status(502).json({ error: 'Failed to load report' });
    }
});

// ── Settings ─────────────────────────────────────────────────────────

async function getAnalyticsSettingsHandler(req, res) {
    const [settings, configured, tracker, recorder] = await Promise.all([
        getAnalyticsSettings(),
        umamiClient.isConfigured(),
        getTrackerOptions(),
        getRecorderOptions(),
    ]);
    res.json({
        enabled: settings.enabled,
        consentMode: settings.consentMode,
        url: settings.url,
        configured,
        tracker,
        recorder,
        maskLevels: MASK_LEVELS,
        // Booleans only. Which credentials exist is useful to show; their
        // values must never leave the server.
        storedCredentials: {
            username: !!(await configStore.getSecret(umamiClient.KEY_USERNAME)),
            password: !!(await configStore.getSecret(umamiClient.KEY_PASSWORD)),
            apiToken: !!(await configStore.getSecret(umamiClient.KEY_API_TOKEN)),
        },
    });
}

async function putAnalyticsSettingsHandler(req, res) {
    const { enabled, consentMode, url, username, password, apiToken, tracker, recorder } = req.body || {};
    if (tracker && typeof tracker === 'object') {
        const cur = await getTrackerOptions();
        await configStore.setConfig(KEY_ANALYTICS_TRACKER_OPTS, {
            tag: typeof tracker.tag === 'string' ? tracker.tag.trim().slice(0, 60) : cur.tag,
            excludeSearch: tracker.excludeSearch !== undefined ? tracker.excludeSearch === true : cur.excludeSearch,
            excludeHash: tracker.excludeHash !== undefined ? tracker.excludeHash === true : cur.excludeHash,
            doNotTrack: tracker.doNotTrack !== undefined ? tracker.doNotTrack === true : cur.doNotTrack,
            domains: typeof tracker.domains === 'string' ? tracker.domains.trim().slice(0, 300) : cur.domains,
        });
    }
    if (recorder && typeof recorder === 'object') {
        const cur = await getRecorderOptions();
        const rate = Number(recorder.sampleRate);
        await configStore.setConfig(KEY_ANALYTICS_RECORDER_OPTS, {
            sampleRate: Number.isFinite(rate) && rate > 0 && rate <= 1 ? rate : cur.sampleRate,
            maskLevel: MASK_LEVELS.includes(recorder.maskLevel) ? recorder.maskLevel : cur.maskLevel,
        });
    }
    if (enabled !== undefined) {
        await configStore.setConfig(KEY_ANALYTICS_ENABLED, enabled === true);
    }
    if (consentMode !== undefined) {
        await configStore.setConfig(KEY_ANALYTICS_CONSENT_MODE,
            consentMode === 'cookies' ? 'cookies' : 'cookieless');
    }
    if (url !== undefined) {
        await configStore.setConfig(umamiClient.KEY_URL, String(url || '').trim().replace(/\/+$/, ''));
    }
    // Secrets — the panel only sends a credential field when the operator
    // actually typed into it, so a save that leaves a field untouched never
    // clears the stored secret. Sending an explicit empty string clears it.
    if (username !== undefined) await configStore.setSecret(umamiClient.KEY_USERNAME, String(username || ''));
    if (password !== undefined) await configStore.setSecret(umamiClient.KEY_PASSWORD, String(password || ''));
    if (apiToken !== undefined) await configStore.setSecret(umamiClient.KEY_API_TOKEN, String(apiToken || ''));
    umamiClient.invalidateEndpointCache();
    invalidateCache();

    const settings = await getAnalyticsSettings();
    const configured = await umamiClient.isConfigured();
    // Turning analytics on (or saving fresh creds) provisions the live site
    // immediately so its public pages start tracking without waiting for the
    // next publish. Best-effort, fire-and-forget.
    if (settings.enabled && configured) {
        const liveSiteId = await getLiveSiteId().catch(() => null);
        if (liveSiteId) {
            const project = await cmsStore.getProject(liveSiteId).catch(() => null);
            provisionAnalyticsForSite(liveSiteId, {
                name: project?.name || 'CMS site',
                domain: req.get('host'),
            }).catch(() => {});
        }
    }
    res.json({
        success: true, enabled: settings.enabled, consentMode: settings.consentMode,
        url: settings.url, configured,
        tracker: await getTrackerOptions(),
        recorder: await getRecorderOptions(),
    });
}

/**
 * Diagnose the whole chain, in causal order, and stop at the first break.
 *
 * This exists because the failure modes here are all silent: a tracker that
 * never loads, a consent mode nobody satisfies, an internal URL the browser
 * cannot reach — every one of them presents as "the dashboard is empty", and
 * telling them apart used to mean reading source.
 */
async function getDiagnoseHandler(req, res) {
    const checks = [];
    const add = (id, label, status, detail) => checks.push({ id, label, status, detail });

    const settings = await getAnalyticsSettings();
    const configured = await umamiClient.isConfigured();

    add('enabled', 'Analytics is switched on',
        settings.enabled ? 'pass' : 'fail',
        settings.enabled ? null : 'Nothing is tracked while the master switch is off.');

    add('configured', 'Umami credentials are set',
        configured ? 'pass' : 'fail',
        configured ? null : 'Set the Umami URL plus either an API token or a username and password.');

    const internalUrl = process.env.UMAMI_URL || settings.url || '';
    add('urls', 'Server and browser URLs make sense',
        settings.url ? 'pass' : 'fail',
        settings.url
            ? (process.env.UMAMI_URL && process.env.UMAMI_URL !== settings.url
                ? `The server calls ${internalUrl}; visitors load the script from ${settings.url}. That split is normal in Docker.`
                : null)
            : 'Without a public URL the browser has nowhere to load the tracker from.');

    if (!configured) {
        add('reachable', 'Umami answers', 'skip', 'Needs credentials first.');
        add('script', 'The tracker script is reachable', 'skip', 'Needs a public URL first.');
    } else {
        try {
            const sites = await umamiClient.listWebsites();
            add('reachable', 'Umami answers', 'pass', `${sites.length} website${sites.length === 1 ? '' : 's'} registered.`);
        } catch (err) {
            add('reachable', 'Umami answers', 'fail', `The server could not reach ${internalUrl}: ${err.message}`);
        }

        // The check nothing performed before: is the URL the BROWSER uses
        // actually serving a script? A wrong public URL is invisible
        // server-side, because the server never loads it.
        if (settings.url) {
            add('script', 'The tracker script is reachable', ...await probeScript(settings.url));
        }
    }

    const map = await getAnalyticsSiteMap();
    const tracked = Object.keys(map).length;
    add('provisioned', 'A site is registered for tracking',
        tracked > 0 ? 'pass' : 'fail',
        tracked > 0 ? `${tracked} site${tracked === 1 ? '' : 's'} mapped.` : 'Publish a CMS site to register it with Umami.');

    add('consent', 'Visitors can be counted',
        settings.consentMode === 'cookieless' ? 'pass' : 'warn',
        settings.consentMode === 'cookieless'
            ? 'Cookieless mode counts every visitor immediately — no banner interaction needed.'
            : 'In cookie mode NOTHING is counted until a visitor clicks Accept, including your own testing.');

    const recorderMap = await getRecorderMap();
    const recording = Object.keys(recorderMap).length;
    add('recorder', 'Session recording', recording > 0 ? 'pass' : 'info',
        recording > 0
            ? 'On. Recording is consent-gated in every mode, so recorded sessions will always be fewer than total sessions.'
            : 'Off. Heatmaps and replays need it; pageviews and events do not.');

    res.json({ checks });
}

/**
 * Fetch the public /script.js.
 *
 * Outbound HTTP driven by an operator-supplied URL, so: super-admin only (the
 * router gate), no redirects followed, a hard timeout, and only the status and
 * content-type are echoed — never the body.
 */
async function probeScript(publicUrl) {
    const url = `${publicUrl.replace(/\/+$/, '')}/script.js`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
        const r = await fetch(url, { redirect: 'manual', signal: controller.signal });
        const type = r.headers.get('content-type') || '';
        if (r.status >= 300 && r.status < 400) {
            return ['warn', `${url} redirects (${r.status}). Point the URL at the final origin.`];
        }
        if (!r.ok) return ['fail', `${url} returned ${r.status}. Visitors' browsers will get the same.`];
        if (!/javascript|ecmascript/i.test(type)) {
            return ['warn', `${url} answered ${r.status} but as "${type || 'no content-type'}" — probably not the tracker.`];
        }
        return ['pass', `${url} serves the tracker.`];
    } catch (err) {
        return ['fail', `Could not load ${url}: ${err.name === 'AbortError' ? 'timed out' : err.message}`];
    } finally {
        clearTimeout(timer);
    }
}

async function getAnalyticsSitesHandler(req, res) {
    const [projects, map, recorderMap, liveSiteId] = await Promise.all([
        cmsStore.listProjects(),
        getAnalyticsSiteMap(),
        getRecorderMap(),
        getLiveSiteId(),
    ]);
    const sites = projects.map(p => ({
        id: p.id,
        name: p.name,
        live: p.id === liveSiteId,
        tracked: !!map[p.id],
        websiteId: map[p.id] || null,
        recording: !!recorderMap[p.id],
    }));
    res.json({ sites, liveSiteId });
}

// Connection diagnostic. Surfaces the internal-vs-public URL split, which is
// the standard way this integration silently half-works: the browser loads
// /script.js fine from the public origin while every server→Umami call fails.
async function getAnalyticsStatusHandler(req, res) {
    const settings = await getAnalyticsSettings();
    const configured = await umamiClient.isConfigured();
    const out = {
        enabled: settings.enabled,
        configured,
        publicUrl: settings.url,
        internalUrl: process.env.UMAMI_URL || settings.url || '',
        usingInternalOverride: !!process.env.UMAMI_URL,
        reachable: false,
        websiteCount: null,
        error: null,
    };
    if (configured) {
        try {
            const sites = await umamiClient.listWebsites();
            out.reachable = true;
            out.websiteCount = sites.length;
        } catch (err) {
            out.error = err.message;
        }
    }
    res.json(out);
}

// ── Session recording opt-in (heatmaps + replays) ────────────────────
//
// Stored in config rather than on the site doc so the toggle takes effect
// immediately, like every other setting on this dashboard — a site-doc flag
// would only apply on the next publish.
async function putRecorderHandler(req, res) {
    const { siteId, enabled } = req.body || {};
    if (!siteId || !SITE_ID_RE.test(String(siteId))) {
        return res.status(400).json({ error: 'Invalid siteId' });
    }
    const map = await getAnalyticsSiteMap();
    const websiteId = map[siteId];
    if (!websiteId) return res.status(409).json({ error: 'Site is not tracked yet — publish it first' });

    const on = enabled === true;

    // Umami gates recording per website and returns
    // {ok:false, reason:'recorder_disabled'} on /api/record until it is set,
    // so this MUST stick or heatmaps/replays stay silently empty. The flag
    // is derived from replayConfig upstream — sending recorderEnabled
    // directly returns 200 and changes nothing, hence the read-back.
    //
    // Upstream FIRST, then persist. The other order stores an opt-in Umami
    // rejected: the public site would then load recorder.js, every
    // /api/record would be discarded, and this dashboard would confidently
    // report "Recording on" while capturing nothing.
    let upstream = null;
    try {
        const opts = await getRecorderOptions();
        const site = await umamiClient.updateWebsite(websiteId, {
            replayConfig: umamiClient.buildReplayConfig({ enabled: on, ...opts }),
        });
        if (!!site?.recorderEnabled !== on) {
            upstream = `Umami did not apply the recorder setting (recorderEnabled=${site?.recorderEnabled}).`;
        }
    } catch (err) {
        upstream = err.message;
    }

    if (upstream) {
        log.warn('[CMS] recorder flag not applied upstream:', upstream);
        const recording = !!(await getRecorderMap())[siteId];
        return res.status(502).json({
            success: false, siteId, recording,
            error: `Umami rejected the recorder change: ${upstream}`,
        });
    }

    const recorderMap = await getRecorderMap();
    if (on) recorderMap[siteId] = true; else delete recorderMap[siteId];
    await configStore.setConfig(KEY_ANALYTICS_RECORDER_MAP, recorderMap);

    res.json({ success: true, siteId, recording: on, upstreamWarning: null });
}

// ── Overview ─────────────────────────────────────────────────────────

// Every dimension is fetched in parallel and failures are captured per key
// rather than thrown, so one broken dimension degrades instead of blanking the
// page — but the failure is REPORTED in partialErrors. A silently swallowed
// error here is what hid the `type: 'url'` 400 on Umami 3.x for so long.
async function settle(partialErrors, key, promise, fallback) {
    try {
        return await promise;
    } catch (err) {
        partialErrors.push({ key, message: err.message });
        return fallback;
    }
}

async function getAnalyticsOverviewHandler(req, res) {
    try {
        const target = await requireTarget(req, res);
        if (!target) return undefined;

        const { websiteId, siteId } = target;
        const { startAt, endAt, unit } = windowFromReq(req.query);
        const tz = (req.query.timezone || 'UTC').toString();
        // The shell renders a filter chip over these totals, so they have to
        // honour it — until now /overview was the one data route that ignored
        // filters entirely and showed site-wide numbers under a filtered chip.
        const filters = pickFilters(req.query);
        const errs = [];
        const metric = (key, type, limit) => settle(errs, key,
            umamiClient.getMetrics(websiteId, { type, startAt, endAt, limit, filters }), []);

        const [stats, pageviews, pages, referrers, browsers, os, devices, countries, active] = await Promise.all([
            settle(errs, 'stats', umamiClient.getStats(websiteId, { startAt, endAt, ...filters }), null),
            settle(errs, 'pageviews', umamiClient.getPageviews(websiteId, { startAt, endAt, unit, timezone: tz, ...filters }), null),
            metric('pages', 'path', 25),
            metric('referrers', 'referrer', 25),
            metric('browsers', 'browser', 10),
            metric('os', 'os', 10),
            metric('devices', 'device', 10),
            metric('countries', 'country', 25),
            settle(errs, 'active', umamiClient.getActive(websiteId), null),
        ]);

        // `active` shape varies by Umami version: [{x:N}] or {visitors:N} or N.
        let activeCount = null;
        if (Array.isArray(active)) activeCount = active[0]?.x ?? active.length ?? null;
        else if (active && typeof active === 'object') activeCount = active.x ?? active.visitors ?? null;
        else if (typeof active === 'number') activeCount = active;

        res.json({
            enabled: true, configured: true, provisioned: true,
            siteId, websiteId, range: { startAt, endAt, unit },
            stats, pageviews, pages, referrers, browsers, os, devices, countries,
            active: activeCount,
            partialErrors: errs,
        });
    } catch (err) {
        log.error('[CMS] analytics overview error:', err.message);
        res.status(502).json({ error: 'Failed to load analytics' });
    }
}

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
const flagOf = (name) => z.boolean({ invalid_type_error: `${name} is true or false.` });
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
        sampleRate: z.number({ invalid_type_error: 'recorder.sampleRate is a number above 0, at most 1.' })
            .gt(0, 'recorder.sampleRate is a number above 0, at most 1.').lte(1, 'recorder.sampleRate is a number above 0, at most 1.').optional(),
        // Read when a request arrives: routes/cms.public.test.js stubs
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
