// @typecheck noImplicitAny
/**
 * The website-analytics tools of the CMS MCP server (read-only, super admin).
 *
 * PRIVACY. Whatever these tools return goes to an external LLM, and the CLAUDE.md
 * rule applies: personal data does not leave Bee Flow. So every result here is
 * BUILT from an explicit allow-list of fields (a count, a rate, a duration, a
 * sanitised name), never produced by deleting keys from what Umami sent. A field
 * Umami adds next year therefore cannot leak along.
 *
 *   returned    counts, rates, durations, time-series buckets, page PATHS without
 *               ?query or #hash, referrer DOMAINS, country/region/device/browser/
 *               os/language names, event NAMES, web-vitals percentiles
 *   never       sessions, session or visitor ids, replays, heatmap coordinates,
 *               IP addresses, user-agent strings, full URLs, event properties,
 *               cities
 *
 * Text that comes from visitors (a path, a campaign name) is additionally
 * stripped of anything that looks like an e-mail address, because a link such
 * as /unsubscribe/jane@example.org is still a path.
 *
 * The Umami calls go through the same client and the same helpers as the
 * dashboard (core/cms/analyticsQueries.js); nothing here talks HTTP itself.
 */

'use strict';

const log = require('../../telemetry/log');
const { rangeToWindow, buildReportBody } = require('../../core/cms/analyticsQueries');
const { MAX_CUSTOM_SPAN_MS, RANGES, MAX_METRIC_LIMIT, MAX_SERIES_POINTS, METRIC_TYPES, PATH_LIKE, VITALS, NOT_AVAILABLE, num, round, maybeNum, err, cleanPath, cleanReferrer, cleanLabel, toNameCounts, channelOf, statNow, statPrev, readActive } = require('./analyticsCleanPath');

// ── allow-listed value sanitisers ───────────────────────────────────────

// ── channels (same table as the dashboard's model.js) ───────────────────

// ── Umami response readers ──────────────────────────────────────────────

// ── the handlers ────────────────────────────────────────────────────────

/**
 * `analytics` is core/cms/analyticsQueries.
 * @typedef {{ siteIdRe: RegExp, analytics: { preflight: Function, resolveTarget: Function, getSettings: Function },
 *   umami: { isConfigured: Function, getStats: Function, getPageviews: Function, getMetrics: Function,
 *     getActive: Function, get: Function, post: Function }, now?: () => number }} AnalyticsDeps
 * @typedef {ReturnType<typeof createAnalyticsKit>} AnalyticsKit  the window, preflight and error guard every data tool shares
 */

/**
 * The clean name/count rows of one metric type: the entry-page breakdown, the
 * channel totals built from referrers, or one of Umami's own metric lists.
 * @param {AnalyticsDeps['umami']} umami
 * @param {string} type  a key of METRIC_TYPES
 * @param {string} websiteId
 * @param {{ startAt: number, endAt: number, unit: string }} window
 * @returns {Promise<Array<{ name: string, count: number }>>}
 */
async function fetchMetricRows(umami, type, websiteId, window) {
    const { startAt, endAt } = window;
    // Ask for more than `limit`: several raw values can collapse into one
    // clean name (a path with different query strings), and the top list
    // is cut only after that.
    const fetchLimit = 200;
    let rows;
    if (type === 'entry') {
        const report = await umami.post('/api/reports/breakdown', buildReportBody({
            type: 'breakdown', websiteId, window, extra: { fields: ['path'] },
        }));
        const list = Array.isArray(report) ? report : (Array.isArray(report?.data) ? report.data : []);
        rows = toNameCounts(list.map((/** @type {Record<string, any>} */ r) => ({ x: r?.path, y: r?.visits })), cleanPath);
    } else if (type === 'channel') {
        const [referrers, stats] = await Promise.all([
            umami.getMetrics(websiteId, { type: 'referrer', startAt, endAt, limit: 500 }),
            umami.getStats(websiteId, { startAt, endAt }),
        ]);
        const named = toNameCounts(referrers, cleanReferrer);
        const referred = named.filter((r) => r.name).reduce((a, r) => a + r.count, 0);
        const blank = named.filter((r) => !r.name).reduce((a, r) => a + r.count, 0);
        const totals = new Map();
        const direct = Math.max(blank, (statNow(stats?.visits) || statNow(stats?.sessions)) - referred);
        if (direct > 0) totals.set('Direct', direct);
        for (const r of named.filter((x) => x.name)) {
            const ch = channelOf(r.name);
            totals.set(ch, (totals.get(ch) || 0) + r.count);
        }
        rows = [...totals.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    } else {
        const raw = await umami.getMetrics(websiteId, { type: METRIC_TYPES[type], startAt, endAt, limit: fetchLimit });
        const clean = PATH_LIKE.has(type) ? cleanPath : type === 'referrer' ? cleanReferrer : cleanLabel;
        rows = toNameCounts(raw, clean);
        if (type === 'referrer') rows = rows.map((r) => ({ ...r, name: r.name || '(direct)' }));
    }
    return rows;
}

/**
 * The window parser, the preflight and the upstream-failure guard the handlers share.
 * @param {AnalyticsDeps} deps
 */
function createAnalyticsKit(deps) {
    const { analytics, umami, siteIdRe } = deps;
    const now = deps.now || Date.now;

    /**
     * Window from `range` or `startAt`/`endAt`, or an error result.
     * @param {Record<string, any>} args
     */
    function windowOf(args) {
        const hasAbs = args.startAt !== undefined || args.endAt !== undefined;
        if (hasAbs) {
            const s = Date.parse(String(args.startAt ?? ''));
            const e = Date.parse(String(args.endAt ?? ''));
            if (!Number.isFinite(s) || !Number.isFinite(e)) return { error: 'startAt and endAt must both be ISO dates, like 2026-09-01 or 2026-09-01T00:00:00Z.' };
            if (e <= s) return { error: 'endAt must be after startAt.' };
            if (e - s > MAX_CUSTOM_SPAN_MS) return { error: 'The window can be at most 366 days.' };
            if (s > now()) return { error: 'startAt is in the future.' };
            return { window: rangeToWindow('custom', { start: s, end: e }), range: 'custom' };
        }
        const range = args.range === undefined ? '7d' : args.range;
        if (!RANGES.includes(range)) return { error: `range must be one of ${RANGES.join(', ')}.` };
        return { window: rangeToWindow(range, { now: now() }), range };
    }

    /**
     * @param {{ startAt: number, endAt: number, unit?: string }} w
     * @param {string} range
     */
    const rangeInfo = (w, range) => ({
        range,
        from: new Date(w.startAt).toISOString(),
        to: new Date(w.endAt).toISOString(),
        unit: w.unit,
    });

    /**
     * Preflight + window shared by every data tool.
     * @param {Record<string, any>} args
     * @returns {Promise<{ stop?: object, target?: { websiteId: string, siteId: string, [k: string]: unknown }, window?: { startAt: number, endAt: number, unit: string, [k: string]: unknown }, range?: string }>}
     */
    async function prepare(args) {
        if (args.siteId !== undefined && args.siteId !== null && args.siteId !== ''
            && (typeof args.siteId !== 'string' || !siteIdRe.test(args.siteId))) {
            return { stop: err('siteId must be a site id (pj_…). cms_list_sites lists them.') };
        }
        const win = windowOf(args);
        if (win.error) return { stop: err(win.error) };
        const pre = await analytics.preflight(args.siteId);
        if (!pre.ok) {
            const message = NOT_AVAILABLE[pre.state];
            return { stop: { result: { available: false, state: pre.state, message }, text: message } };
        }
        return { target: pre.target, window: win.window, range: win.range };
    }

    /**
     * Run a handler body; an upstream failure becomes a plain sentence, never Umami's text.
     * @param {string} tool
     * @param {() => Promise<any>} fn
     */
    async function guarded(tool, fn) {
        try {
            return await fn();
        } catch (e) {
            log.warn(`[CmsMcp] analytics ${tool} failed: ${e.message}`);
            return err('The analytics service did not answer. Try again in a moment; an operator can check it in the CMS analytics settings.');
        }
    }

    return { analytics, umami, siteIdRe, rangeInfo, prepare, guarded };
}

/**
 * cms_analytics_status and cms_analytics_overview.
 * @param {AnalyticsKit} kit
 */
function createSummaryHandlers(kit) {
    const { analytics, umami, siteIdRe, rangeInfo, prepare, guarded } = kit;

    /** @param {Record<string, any>} args */
    async function status(args) {
        if (args.siteId !== undefined && args.siteId !== null && args.siteId !== ''
            && (typeof args.siteId !== 'string' || !siteIdRe.test(args.siteId))) {
            return err('siteId must be a site id (pj_…). cms_list_sites lists them.');
        }
        return guarded('status', async () => {
            const settings = await analytics.getSettings();
            const configured = settings.enabled ? await umami.isConfigured() : false;
            const target = settings.enabled && configured ? await analytics.resolveTarget(args.siteId) : null;
            const wanted = typeof args.siteId === 'string' && args.siteId ? args.siteId : null;
            const state = !settings.enabled ? 'disabled' : !configured ? 'unconfigured' : !target ? 'unprovisioned' : 'ready';
            const message = state === 'ready'
                ? `Analytics is on and tracking site ${target.siteId}.${wanted && wanted !== target.siteId ? ` (${wanted} itself is not tracked, so this is the site that is.)` : ''}`
                : NOT_AVAILABLE[state];
            return {
                result: {
                    state,
                    enabled: settings.enabled,
                    configured,
                    tracked: !!target,
                    siteId: target ? target.siteId : null,
                    consentMode: settings.consentMode,
                    message,
                },
                text: state === 'ready' ? undefined : message,
            };
        });
    }

    /** @param {Record<string, any>} args */
    async function overview(args) {
        const p = await prepare(args);
        if (p.stop) return p.stop;
        return guarded('overview', async () => {
            const { startAt, endAt } = p.window;
            const stats = await umami.getStats(p.target.websiteId, { startAt, endAt });
            const visits = statNow(stats?.visits) || statNow(stats?.sessions);
            const prevVisits = statPrev(stats, 'visits') ?? statPrev(stats, 'sessions');
            const bounceRate = visits > 0 ? (statNow(stats?.bounces) / visits) * 100 : null;
            const avgVisit = visits > 0 ? statNow(stats?.totaltime) / visits : null;
            const prevBounces = statPrev(stats, 'bounces');
            const prevTime = statPrev(stats, 'totaltime');
            const prevBounceRate = prevVisits > 0 && prevBounces !== null ? (prevBounces / prevVisits) * 100 : null;
            const prevAvgVisit = prevVisits > 0 && prevTime !== null ? prevTime / prevVisits : null;
            const pair = (/** @type {number | null} */ current, /** @type {number | null} */ previous, digits = 0) => ({
                value: current === null ? null : round(current, digits),
                previous: previous === null ? null : round(previous, digits),
            });
            return {
                result: {
                    siteId: p.target.siteId,
                    ...rangeInfo(p.window, p.range),
                    visitors: pair(statNow(stats?.visitors), statPrev(stats, 'visitors')),
                    pageviews: pair(statNow(stats?.pageviews), statPrev(stats, 'pageviews')),
                    visits: pair(visits, prevVisits),
                    bounceRatePercent: pair(bounceRate, prevBounceRate, 1),
                    avgVisitSeconds: pair(avgVisit, prevAvgVisit, 0),
                    note: 'previous = the period of equal length just before this one (null when Umami gave no comparison).',
                },
            };
        });
    }

    return { status, overview };
}

/**
 * cms_analytics_pageviews and cms_analytics_metrics.
 * @param {AnalyticsKit} kit
 */
function createTrafficHandlers(kit) {
    const { umami, rangeInfo, prepare, guarded } = kit;

    /** @param {Record<string, any>} args */
    async function pageviews(args) {
        const p = await prepare(args);
        if (p.stop) return p.stop;
        return guarded('pageviews', async () => {
            const { startAt, endAt, unit } = p.window;
            const raw = await umami.getPageviews(p.target.websiteId, { startAt, endAt, unit, timezone: 'UTC' });
            const byTime = new Map();
            const put = (/** @type {unknown} */ rows, /** @type {string} */ key) => {
                for (const row of Array.isArray(rows) ? rows : []) {
                    const t = String(row?.x ?? '').slice(0, 25);
                    if (!t) continue;
                    byTime.set(t, { ...(byTime.get(t) || { time: t, pageviews: 0, sessions: 0 }), [key]: num(row?.y) });
                }
            };
            put(raw?.pageviews, 'pageviews');
            put(raw?.sessions, 'sessions');
            const series = [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time)).slice(-MAX_SERIES_POINTS);
            return { result: { siteId: p.target.siteId, ...rangeInfo(p.window, p.range), series } };
        });
    }

    /** @param {Record<string, any>} args */
    async function metrics(args) {
        const type = String(args.type ?? '');
        if (!Object.prototype.hasOwnProperty.call(METRIC_TYPES, type)) {
            return err(`type must be one of ${Object.keys(METRIC_TYPES).join(', ')}.`);
        }
        const limit = args.limit === undefined ? 10 : args.limit;
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_METRIC_LIMIT) return err(`limit must be a whole number from 1 to ${MAX_METRIC_LIMIT}.`);
        const p = await prepare(args);
        if (p.stop) return p.stop;
        return guarded('metrics', async () => {
            const rows = await fetchMetricRows(umami, type, p.target.websiteId, p.window);
            const countLabel = type === 'entry' ? 'visits' : type === 'channel' ? 'visits' : type === 'event' ? 'times fired' : 'pageviews or visitors, as Umami counts this dimension';
            return {
                result: {
                    siteId: p.target.siteId,
                    ...rangeInfo(p.window, p.range),
                    type,
                    countMeans: countLabel,
                    rows: rows.slice(0, limit).map((r) => ({ name: r.name, count: r.count })),
                },
            };
        });
    }

    return { pageviews, metrics };
}

/**
 * cms_analytics_realtime and cms_analytics_vitals.
 * @param {AnalyticsKit} kit
 */
function createLiveHandlers(kit) {
    const { umami, rangeInfo, prepare, guarded } = kit;

    /** @param {Record<string, any>} args */
    async function realtime(args) {
        // Realtime has no window; skip the range validation but keep the rest.
        const p = await prepare({ siteId: args.siteId });
        if (p.stop) return p.stop;
        return guarded('realtime', async () => {
            const websiteId = p.target.websiteId;
            const [live, active] = await Promise.all([
                umami.get(`/api/realtime/${websiteId}`),
                umami.getActive(websiteId),
            ]);
            const urlRows = live && typeof live.urls === 'object' && !Array.isArray(live.urls)
                ? Object.entries(live.urls).map(([x, y]) => ({ x, y })) : [];
            const totals = live?.totals || {};
            return {
                result: {
                    siteId: p.target.siteId,
                    activeVisitors: readActive(active),
                    activePages: toNameCounts(urlRows, cleanPath).slice(0, 10),
                    last30Minutes: { pageviews: num(totals.views), visitors: num(totals.visitors), events: num(totals.events) },
                },
            };
        });
    }

    /** @param {Record<string, any>} args */
    async function vitals(args) {
        const p = await prepare(args);
        if (p.stop) return p.stop;
        return guarded('vitals', async () => {
            const report = await umami.post('/api/reports/performance', buildReportBody({
                type: 'performance', websiteId: p.target.websiteId, window: p.window,
            }));
            const samples = num(report?.summary?.count);
            const base = { siteId: p.target.siteId, ...rangeInfo(p.window, p.range), samples };
            if (samples === 0) {
                const message = 'No web-vitals samples in this period. Vitals arrive when a visitor leaves a page or after ten seconds on it, so a quiet period can have none.';
                return { result: { ...base, available: false, message }, text: message };
            }
            /** @type {Record<string, any>} */
            const metricsOut = {};
            for (const id of VITALS) {
                const v = report.summary[id];
                if (v && typeof v === 'object') metricsOut[id] = { p50: maybeNum(v.p50), p75: maybeNum(v.p75), p95: maybeNum(v.p95) };
                else if (typeof v === 'number') metricsOut[id] = { p50: null, p75: v, p95: null };
            }
            const pages = (Array.isArray(report.pages) ? report.pages : [])
                .map((/** @type {Record<string, any>} */ pg) => ({ path: cleanPath(pg?.name), lcpP75Ms: maybeNum(pg?.p75), samples: num(pg?.count) }))
                .sort((/** @type {{ lcpP75Ms: number | null }} */ a, /** @type {{ lcpP75Ms: number | null }} */ b) => num(b.lcpP75Ms) - num(a.lcpP75Ms))
                .slice(0, 10);
            return {
                result: {
                    ...base,
                    vitals: metricsOut,
                    units: 'lcp, inp, fcp, ttfb in milliseconds; cls is unitless. Good (p75): lcp <= 2500, inp <= 200, cls <= 0.1, fcp <= 1800, ttfb <= 800.',
                    slowestPages: pages,
                },
            };
        });
    }

    return { realtime, vitals };
}

/**
 * @param {AnalyticsDeps} deps
 */
function createAnalyticsHandlers(deps) {
    const kit = createAnalyticsKit(deps);
    const { status, overview } = createSummaryHandlers(kit);
    const { pageviews, metrics } = createTrafficHandlers(kit);
    const { realtime, vitals } = createLiveHandlers(kit);

    return {
        handlers: {
            cms_analytics_status: status,
            cms_analytics_overview: overview,
            cms_analytics_pageviews: pageviews,
            cms_analytics_metrics: metrics,
            cms_analytics_realtime: realtime,
            cms_analytics_vitals: vitals,
        },
    };
}

module.exports = { createAnalyticsHandlers, METRIC_TYPES, RANGES, cleanPath, cleanReferrer };
