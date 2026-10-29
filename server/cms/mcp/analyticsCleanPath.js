// @typecheck strict

const DAY_MS = 24 * 60 * 60 * 1000;

const MAX_CUSTOM_SPAN_MS = 366 * DAY_MS;

const RANGES = ['today', '24h', '7d', '30d', '90d'];

const MAX_METRIC_LIMIT = 50;

const MAX_SERIES_POINTS = 400;

const NAME_MAX = 120;

const EMAIL_RE = /[^\s/@?#&=]+@[^\s/@?#&=]+\.[^\s/@?#&=]+/g;

/**
 * Metric types a caller may ask for -> Umami's dimension name (null = derived).
 * @type {Readonly<Record<string, string | null>>}
 */
const METRIC_TYPES = Object.freeze({
    url: 'path',
    entry: null,
    referrer: 'referrer',
    channel: null,
    country: 'country',
    region: 'region',
    device: 'device',
    browser: 'browser',
    os: 'os',
    language: 'language',
    event: 'event',
    utm_source: 'utmSource',
    utm_medium: 'utmMedium',
    utm_campaign: 'utmCampaign',
});

const PATH_LIKE = new Set(['url', 'entry']);

const VITALS = ['lcp', 'inp', 'cls', 'fcp', 'ttfb'];

/** @type {Record<string, string>} */
const NOT_AVAILABLE = {
    disabled: 'Website analytics is switched off on this installation, so there is nothing to read. An operator turns it on in the CMS analytics settings.',
    unconfigured: 'Website analytics is switched on but the analytics service (Umami) has no credentials yet, so there is nothing to read. An operator sets them in the CMS analytics settings.',
    unprovisioned: 'No site is being tracked yet. Publish a site while analytics is on, then give it a few minutes and ask again.',
};

/** @param {unknown} v */
const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};

/**
 * @param {unknown} n
 * @param {number} [digits]
 */
const round = (n, digits = 1) => {
    const f = 10 ** digits;
    return Math.round(num(n) * f) / f;
};

/** @param {unknown} v */
const maybeNum = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * @param {string} error
 * @param {Record<string, unknown>} [extra]
 */
const err = (error, extra = {}) => ({ result: { error, ...extra } });

/** @param {unknown} s */
const scrub = (s) => String(s ?? '').replace(EMAIL_RE, '[removed]');

/**
 * A page path: no scheme or host, no ?query, no #hash.
 * @param {unknown} raw
 */
function cleanPath(raw) {
    let s = String(raw ?? '').trim();
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
        const rest = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '');
        s = rest;
    }
    s = s.split('#')[0].split('?')[0];
    if (!s) return '/';
    if (!s.startsWith('/')) s = `/${s}`;
    return scrub(s).slice(0, NAME_MAX);
}

/**
 * A referrer reduced to its domain ('' = direct).
 * @param {unknown} raw
 */
function cleanReferrer(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return '';
    const host = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0].replace(/^www\./i, '').toLowerCase();
    return scrub(host.split('@').pop()).slice(0, NAME_MAX);
}

/** @param {unknown} raw */
const cleanLabel = (raw) => scrub(String(raw ?? '').trim()).slice(0, NAME_MAX);

/**
 * {name, count} rows from Umami's [{x, y}], names cleaned and merged, biggest first.
 * @param {unknown} rows
 * @param {(raw: unknown) => string} clean
 */
function toNameCounts(rows, clean) {
    const merged = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
        const name = clean(row?.x);
        merged.set(name, (merged.get(name) || 0) + num(row?.y));
    }
    return [...merged.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);
}

const SEARCH = /(^|\.)(google|bing|duckduckgo|yahoo|yandex|ecosia|baidu|brave|startpage|qwant)\./i;

const SOCIAL = /(^|\.)(facebook|instagram|twitter|x|t|linkedin|reddit|youtube|pinterest|tiktok|mastodon|bsky|threads)\./i;

const EMAIL = /(^|\.)(mail|outlook|gmail|superhuman|hey)\./i;

const AI = /(^|\.)(chatgpt|openai|perplexity|claude|anthropic|copilot|gemini)\./i;

/** @param {string} host */
function channelOf(host) {
    if (!host) return 'Direct';
    if (SEARCH.test(host)) return 'Search';
    if (SOCIAL.test(host)) return 'Social';
    if (EMAIL.test(host)) return 'Email';
    if (AI.test(host)) return 'AI assistants';
    return 'Referral';
}

/**
 * A stats field as the analytics API answers it: a bare number, or `{ value, prev }`.
 * @typedef {{ value?: unknown, prev?: unknown } | number | string | null | undefined} StatField
 */

/** @param {StatField} s */
const statNow = (s) => (s && typeof s === 'object' ? num(s.value) : num(s));

/**
 * @param {any} stats
 * @param {string} key
 */
function statPrev(stats, key) {
    const s = stats?.[key];
    if (s && typeof s === 'object' && s.prev !== undefined) return maybeNum(s.prev);
    const cmp = stats?.comparison?.[key];
    if (cmp === undefined || cmp === null) return null;
    return maybeNum(cmp && typeof cmp === 'object' ? cmp.value : cmp);
}

/** @param {Array<{ x?: unknown }> | { visitors?: unknown, x?: unknown } | number | string | null | undefined} active */
function readActive(active) {
    if (Array.isArray(active)) return num(active[0]?.x ?? active.length);
    if (active && typeof active === 'object') return num(active.visitors ?? active.x);
    return num(active);
}

module.exports = { MAX_CUSTOM_SPAN_MS, RANGES, MAX_METRIC_LIMIT, MAX_SERIES_POINTS, METRIC_TYPES, PATH_LIKE, VITALS, NOT_AVAILABLE, num, round, maybeNum, err, cleanPath, cleanReferrer, cleanLabel, toNameCounts, channelOf, statNow, statPrev, readActive };
