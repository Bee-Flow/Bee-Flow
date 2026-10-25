// @typecheck noImplicitAny
/**
 * Website analytics (Umami): the parts both the operator dashboard
 * (routes/cmsAnalytics.js) and the CMS MCP analytics tools (cms/mcp/analytics.js)
 * need, so neither carries its own copy:
 *
 *   - the config keys that say whether analytics is on and which site maps to
 *     which Umami website,
 *   - range token -> Umami time window,
 *   - which site to show (explicit, live, first tracked),
 *   - the enabled -> configured -> provisioned preflight,
 *   - the envelope Umami's report endpoints expect.
 *
 * Collaborators are injected: routes/ owns the live-site lookup and the id
 * pattern, and tests run this without a database or a live Umami.
 */

'use strict';

const KEY_ANALYTICS_ENABLED = 'cms_analytics_enabled';
const KEY_ANALYTICS_CONSENT_MODE = 'cms_analytics_consent_mode';
const KEY_ANALYTICS_SITE_MAP = 'cms_analytics_site_map';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Translate a range token into Umami's millisecond-epoch window + the natural
 * bucket size. Absolute ranges arrive as `start`/`end` epoch ms with range=custom.
 * @param {string} range  'today' | '24h' | '7d' | '30d' | '90d' | 'custom'
 * @param {{ start?: unknown, end?: unknown, now?: number }} [opts]
 * @returns {{ startAt: number, endAt: number, unit: 'hour'|'day' }}
 */
function rangeToWindow(range, { start, end, now } = {}) {
    if (range === 'custom') {
        const s = Number(start);
        const e = Number(end);
        if (Number.isFinite(s) && Number.isFinite(e) && e > s) {
            // Hourly buckets stay readable up to ~2 days; beyond that use days.
            const unit = (e - s) <= 2 * DAY_MS ? 'hour' : 'day';
            return { startAt: s, endAt: e, unit };
        }
    }
    const endAt = now ?? Date.now();
    if (range === 'today') {
        const startOfDay = Math.floor(endAt / DAY_MS) * DAY_MS; // UTC midnight
        return { startAt: startOfDay, endAt, unit: 'hour' };
    }
    const days = range === '24h' ? 1 : range === '30d' ? 30 : range === '90d' ? 90 : 7;
    return { startAt: endAt - days * DAY_MS, endAt, unit: range === '24h' ? 'hour' : 'day' };
}

/**
 * Umami 3.x report envelope, verified against a live 3.2 instance:
 *   type       - discriminator, must equal the endpoint
 *   filters    - REQUIRED, an object even when empty (omitting it 400s)
 *   parameters - report options AND a repeat of the window; the top-level
 *                dateRange alone is not enough
 * @param {{ type: string, websiteId: string, window: { startAt: number, endAt: number, unit: string }, timezone?: string, filters?: Record<string, unknown>, extra?: Record<string, unknown> }} opts
 */
function buildReportBody({ type, websiteId, window: w, timezone = 'UTC', filters = {}, extra = {} }) {
    const startDate = new Date(w.startAt).toISOString();
    const endDate = new Date(w.endAt).toISOString();
    return {
        type,
        websiteId,
        dateRange: { startDate, endDate, unit: w.unit, timezone },
        timezone,
        filters,
        parameters: { startDate, endDate, timezone, unit: w.unit, ...extra },
    };
}

/**
 * @param {object} deps
 * @param {{ getConfig: Function }} deps.configStore
 * @param {{ isConfigured: Function, KEY_URL: string }} deps.umamiClient
 * @param {() => Promise<string|null>} deps.getLiveSiteId
 * @param {RegExp} deps.siteIdRe
 */
function createAnalyticsQueries({ configStore, umamiClient, getLiveSiteId, siteIdRe }) {
    /** @param {string} key */
    async function readMap(key) {
        const v = await configStore.getConfig(key);
        return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    }

    const getSiteMap = () => readMap(KEY_ANALYTICS_SITE_MAP);

    async function getSettings() {
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
            // process.env.UMAMI_URL, the server's INTERNAL base.
            url: (typeof url === 'string' ? url : (process.env.UMAMI_PUBLIC_URL || '')) || '',
        };
    }

    // Pick the site to show: explicit siteId (must be tracked), else the live
    // site, else the first tracked site. Null when nothing is tracked.
    /** @param {string | null | undefined} wantedRaw */
    async function resolveTarget(wantedRaw) {
        const map = await getSiteMap();
        const wanted = (wantedRaw || '').toString();
        if (wanted && siteIdRe.test(wanted) && map[wanted]) return { siteId: wanted, websiteId: map[wanted] };
        const liveSiteId = await getLiveSiteId();
        if (liveSiteId && map[liveSiteId]) return { siteId: liveSiteId, websiteId: map[liveSiteId] };
        const firstSiteId = Object.keys(map)[0];
        if (firstSiteId) return { siteId: firstSiteId, websiteId: map[firstSiteId] };
        return null;
    }

    /**
     * enabled -> configured -> provisioned.
     * @returns {Promise<{ ok: true, target: { siteId: string, websiteId: string } }
     *   | { ok: false, state: 'disabled'|'unconfigured'|'unprovisioned' }>}
     * @param {string | null | undefined} siteId
     */
    async function preflight(siteId) {
        const settings = await getSettings();
        if (!settings.enabled) return { ok: false, state: 'disabled' };
        if (!(await umamiClient.isConfigured())) return { ok: false, state: 'unconfigured' };
        const target = await resolveTarget(siteId);
        if (!target) return { ok: false, state: 'unprovisioned' };
        return { ok: true, target };
    }

    return { readMap, getSiteMap, getSettings, resolveTarget, preflight };
}

module.exports = {
    KEY_ANALYTICS_ENABLED,
    KEY_ANALYTICS_CONSENT_MODE,
    KEY_ANALYTICS_SITE_MAP,
    rangeToWindow,
    buildReportBody,
    createAnalyticsQueries,
};
