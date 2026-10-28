// @typecheck
const { fetchConfiguredEndpoint } = require('../core/http/configuredEndpointFetch');
const configStore = require('../stores/configStore');
const cmsStore = require('../stores/cmsStore');
const umamiClient = require('../core/umamiClient');
const analyticsQueries = require('../core/cms/analyticsQueries');
const { SITE_ID_RE, getLiveSiteId } = require('./cmsShared');
const log = require('../telemetry/log');
const { HttpError } = require('../core/http/errors');

const rangeToWindow = analyticsQueries.rangeToWindow;

const KEY_ANALYTICS_RECORDER_MAP = 'cms_analytics_recorder_map';

// Settings, site map and target resolution are shared with the CMS MCP
// analytics tools (core/cms/analyticsQueries.js).
const queries = analyticsQueries.createAnalyticsQueries({
    configStore, umamiClient, getLiveSiteId, siteIdRe: SITE_ID_RE,
});

const readMap = queries.readMap;

const getAnalyticsSettings = queries.getSettings;

const getAnalyticsSiteMap = queries.getSiteMap;

const resolveAnalyticsTarget = queries.resolveTarget;

const getRecorderMap      = () => readMap(KEY_ANALYTICS_RECORDER_MAP);

function windowFromReq(src) {
    return rangeToWindow((src.range || '7d').toString(), { start: src.start, end: src.end });
}

// Shared preflight for every data route: enabled → configured → provisioned.
// Returns the target, or null after having already sent the degenerate response.
async function requireTarget(/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) {
    const settings = await getAnalyticsSettings();
    if (!settings.enabled) { res.json({ enabled: false }); return null; }
    if (!(await umamiClient.isConfigured())) { res.json({ enabled: true, configured: false }); return null; }
    const src = req.method === 'POST' ? (req.body || {}) : req.query;
    const target = await resolveAnalyticsTarget(src.siteId);
    if (!target) { res.json({ enabled: true, configured: true, provisioned: false }); return null; }
    return target;
}

// Dimensions a caller may filter on — mirrors Umami's own filter vocabulary.
// Resolved lazily rather than spread at module load: routes/cmsPublicSite.test.js
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
    /** @type {Record<string, string>} */
    const out = {};
    for (const k of metricTypes()) {
        const v = nested ? nested[k] : src?.[k];
        if (v === undefined || v === null || v === '') continue;
        out[k] = String(v).slice(0, 500);
    }
    return out;
}

/**
 * Diagnose the whole chain, in causal order, and stop at the first break.
 *
 * This exists because the failure modes here are all silent: a tracker that
 * never loads, a consent mode nobody satisfies, an internal URL the browser
 * cannot reach — every one of them presents as "the dashboard is empty", and
 * telling them apart would mean reading source.
 */
async function getDiagnoseHandler(/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) {
    /** @type {({ id: string; label: string; status: string | undefined; detail: string | null | undefined; })[]} */
    const checks = [];
    /**
     * @param {string} id
     * @param {string} label
     * @param {string} [status]
     * @param {string | null} [detail]
     */
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
            add('reachable', 'Umami answers', 'fail', `The server could not reach ${internalUrl}: ${/** @type {Error} */ (err).message}`);
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
 * @param {string} publicUrl
 */
async function probeScript(publicUrl) {
    const url = `${publicUrl.replace(/\/+$/, '')}/script.js`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
        const r = await fetchConfiguredEndpoint(url, { redirect: 'manual', signal: controller.signal });
        const type = r.headers.get('content-type') || '';
        if (r.status >= 300 && r.status < 400) return ['warn', `${url} redirects (${r.status}). Point the URL at the final origin.`];
        if (!r.ok) return ['fail', `${url} returned ${r.status}. Visitors' browsers will get the same.`];
        if (!/javascript|ecmascript/i.test(type)) {
            return ['warn', `${url} answered ${r.status} but as "${type || 'no content-type'}" — probably not the tracker.`];
        }
        return ['pass', `${url} serves the tracker.`];
    } catch (err) {
        return ['fail', `Could not load ${url}: ${/** @type {Error} */ (err).name === 'AbortError' ? 'timed out' : /** @type {Error} */ (err).message}`];
    } finally {
        clearTimeout(timer);
    }
}

async function getAnalyticsSitesHandler(/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) {
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
async function getAnalyticsStatusHandler(/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) {
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
            out.error = /** @type {Error} */ (err).message;
        }
    }
    res.json(out);
}

// Every dimension is fetched in parallel and failures are captured per key
// rather than thrown, so one broken dimension degrades instead of blanking the
// page — but the failure is REPORTED in partialErrors. A silently swallowed
// error here is what hid the `type: 'url'` 400 on Umami 3.x for so long.
async function settle(partialErrors, key, promise, fallback) {
    try {
        return await promise;
    } catch (err) {
        partialErrors.push({ key, message: /** @type {Error} */ (err).message });
        return fallback;
    }
}

async function getAnalyticsOverviewHandler(/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) {
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
        /**
         * @param {string} key
         * @param {string} type
         * @param {number} limit
         */
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
        /** @type {number | null} */
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
        log.error('[CMS] analytics overview error:', /** @type {Error} */ (err).message);
        throw new HttpError(502, 'analytics_unavailable', 'Failed to load analytics');
    }
}

module.exports = { rangeToWindow, KEY_ANALYTICS_RECORDER_MAP, readMap, getAnalyticsSettings, getAnalyticsSiteMap, resolveAnalyticsTarget, getRecorderMap, windowFromReq, requireTarget, metricTypes, pickFilters, getDiagnoseHandler, probeScript, getAnalyticsSitesHandler, getAnalyticsStatusHandler, getAnalyticsOverviewHandler };
