// @typecheck
const configStore = require('../stores/configStore');
const cmsStore = require('../stores/cmsStore');
const umamiClient = require('../core/umamiClient');
const analyticsQueries = require('../core/cms/analyticsQueries');
const { SITE_ID_RE, getLiveSiteId } = require('./cmsShared');
const log = require('../telemetry/log');
const { HttpError } = require('../core/http/errors');
const { rangeToWindow, KEY_ANALYTICS_RECORDER_MAP, readMap, getAnalyticsSettings, getAnalyticsSiteMap, resolveAnalyticsTarget, getRecorderMap, windowFromReq, requireTarget, metricTypes, pickFilters, getDiagnoseHandler, probeScript, getAnalyticsSitesHandler, getAnalyticsStatusHandler, getAnalyticsOverviewHandler } = require('./cmsAnalyticsOverview');
const { fallback, bestEffort } = require('../utils/bestEffort');

const KEY_ANALYTICS_ENABLED = analyticsQueries.KEY_ANALYTICS_ENABLED;

const KEY_ANALYTICS_CONSENT_MODE = analyticsQueries.KEY_ANALYTICS_CONSENT_MODE;

const KEY_ANALYTICS_SITE_MAP = analyticsQueries.KEY_ANALYTICS_SITE_MAP;

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

async function setAnalyticsWebsiteId(siteId, websiteId) {
    const map = await getAnalyticsSiteMap();
    map[siteId] = websiteId;
    await configStore.setConfig(KEY_ANALYTICS_SITE_MAP, map);
}

// Best-effort: ensure the live/published site has a Umami website provisioned
// and its id persisted. Never throws — analytics must not break publishing.
/**
 * @param {string} siteId
 * @param {{ name?: string, domain?: string }} [site]
 */
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

const _cache = new Map();

function invalidateCache() { _cache.clear(); }

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
    if (password !== undefined) await configStore.setSecret(umamiClient.KEY_PASSWORD, String(password || '')); // nosemgrep: ajinabraham.njsscan.crypto.timing_attack_node.node_timing_attack -- checks whether the field was sent at all, not a comparison against a stored secret
    if (apiToken !== undefined) await configStore.setSecret(umamiClient.KEY_API_TOKEN, String(apiToken || ''));
    umamiClient.invalidateEndpointCache();
    invalidateCache();

    const settings = await getAnalyticsSettings();
    const configured = await umamiClient.isConfigured();
    // Turning analytics on (or saving fresh creds) provisions the live site
    // immediately so its public pages start tracking without waiting for the
    // next publish. Best-effort, fire-and-forget.
    if (settings.enabled && configured) {
        const liveSiteId = await getLiveSiteId().catch((e) => fallback('routes/cmsAnalyticsHandlers:putAnalyticsSettingsHandler', e, null));
        if (liveSiteId) {
            const project = await cmsStore.getProject(liveSiteId).catch((e) => fallback('routes/cmsAnalyticsHandlers:putAnalyticsSettingsHandler#2', e, null));
            provisionAnalyticsForSite(liveSiteId, {
                name: project?.name || 'CMS site',
                domain: req.get('host'),
            }).catch((e) => bestEffort('routes/cmsAnalyticsHandlers:putAnalyticsSettingsHandler#3', e));
        }
    }
    res.json({
        success: true, enabled: settings.enabled, consentMode: settings.consentMode,
        url: settings.url, configured,
        tracker: await getTrackerOptions(),
        recorder: await getRecorderOptions(),
    });
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
        throw new HttpError(502, 'recorder_not_applied', `Umami rejected the recorder change: ${upstream}`, {
            success: false, siteId, recording,
        });
    }

    const recorderMap = await getRecorderMap();
    if (on) recorderMap[siteId] = true; else delete recorderMap[siteId];
    await configStore.setConfig(KEY_ANALYTICS_RECORDER_MAP, recorderMap);

    res.json({ success: true, siteId, recording: on, upstreamWarning: null });
}

module.exports = { KEY_ANALYTICS_SITE_MAP, rangeToWindow, KEY_ANALYTICS_RECORDER_MAP, getTrackerOptions, readMap, getAnalyticsSettings, getAnalyticsSiteMap, resolveAnalyticsTarget, getRecorderMap, setAnalyticsWebsiteId, provisionAnalyticsForSite, windowFromReq, requireTarget, _cache, invalidateCache, metricTypes, pickFilters, getAnalyticsSettingsHandler, putAnalyticsSettingsHandler, getDiagnoseHandler, probeScript, getAnalyticsSitesHandler, getAnalyticsStatusHandler, putRecorderHandler, getAnalyticsOverviewHandler };
