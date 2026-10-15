/**
 * Website-analytics admin API. All routes are super-admin gated server-side
 * and proxy a self-hosted Umami instance — the browser never holds Umami
 * credentials. Mirrors the cmsApi.js URL-builder style.
 *
 * `query`/`report` hit the server's allow-listed proxy (server/routes/
 * cmsAnalytics.js). The websiteId is resolved server-side from siteId, so
 * nothing here can address another install's data.
 */
import { API_BASE } from '../../../utils/helpers';
import type { SeriesPoint } from './analytics/window';
import type { StatField, XYRow } from './analytics/ui.types';

/** Range and filter params shared by every data call. */
export interface AnalyticsRequestOpts {
    siteId?: string;
    range?: string;
    timezone?: string;
    start?: number | string | null;
    end?: number | string | null;
    filters?: Record<string, unknown> | null;
    fresh?: boolean;
}

/** The range a data route answers for. */
export interface AnalyticsRange {
    startAt: number;
    endAt: number;
    unit?: string;
}

/** The scope every section is rendered for: the request options plus the Refresh counter. */
export interface AnalyticsScope extends AnalyticsRequestOpts {
    _token?: number;
}

/** One CMS site of `/sites` with its Umami tracking state. */
export interface AnalyticsSite {
    id: string;
    name?: string;
    live?: boolean;
    tracked?: boolean;
    websiteId?: string | null;
    recording?: boolean;
}

/** Umami `stats` totals; a field is `{ value, prev }` or a bare number depending on the version. */
export interface AnalyticsTotals {
    visits?: StatField;
    sessions?: StatField;
    pageviews?: StatField;
    visitors?: StatField;
    bounces?: StatField;
    totaltime?: StatField;
}

/** One dimension that failed to load; `/overview` reports it instead of throwing. */
export interface AnalyticsPartialError {
    key: string;
    message: string;
}

/**
 * The JSON body the analytics routes answer with (`null` for an empty body):
 * the union of the fields server/routes/cmsAnalytics.js sends. `/query` and
 * `/report` wrap Umami's answer in `data`; `/overview` adds the dimension
 * lists below.
 */
export type AnalyticsResponse = {
    error?: string;
    cached?: boolean;
    enabled?: boolean;
    configured?: boolean;
    provisioned?: boolean;
    siteId?: string;
    websiteId?: string;
    data?: unknown;
    /** `/settings`: the Umami base URL (public). */
    url?: string;
    range?: AnalyticsRange;
    stats?: (AnalyticsTotals & { comparison?: AnalyticsTotals }) | null;
    pageviews?: { pageviews?: SeriesPoint[]; sessions?: SeriesPoint[] } | null;
    pages?: XYRow[];
    referrers?: XYRow[];
    browsers?: XYRow[];
    os?: XYRow[];
    devices?: XYRow[];
    countries?: XYRow[];
    /** Visitors active right now; `null` when Umami could not say. */
    active?: number | null;
    partialErrors?: AnalyticsPartialError[];
} | null;

const root = `${API_BASE}/api/cms/admin/analytics`;

// Range/filter params shared by every data call.
function commonParams(p: URLSearchParams, { siteId, range, timezone, start, end, filters, fresh }: AnalyticsRequestOpts = {}): URLSearchParams {
    if (siteId) p.set('siteId', siteId);
    if (range) p.set('range', range);
    if (timezone) p.set('timezone', timezone);
    if (start != null) p.set('start', String(start));
    if (end != null) p.set('end', String(end));
    if (fresh) p.set('fresh', '1');
    // Filters ride as top-level params — the server reads them that way because
    // Express's default query parser does not decode filters[key] brackets.
    for (const [k, v] of Object.entries(filters || {})) {
        if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
    }
    return p;
}

export const analyticsApi = {
    settings: () => `${root}/settings`,
    sites:    () => `${root}/sites`,
    status:   () => `${root}/status`,
    diagnose: () => `${root}/diagnose`,
    recorder: () => `${root}/recorder`,
    overview: (opts: AnalyticsRequestOpts = {}) => {
        const qs = commonParams(new URLSearchParams(), opts).toString();
        return `${root}/overview${qs ? `?${qs}` : ''}`;
    },
    /** GET proxy: resource ∈ stats|pageviews|metrics|realtime|events|sessions|… */
    query: (resource: string, { params, ...opts }: AnalyticsRequestOpts & { params?: Record<string, unknown> | null } = {}) => {
        const p = new URLSearchParams();
        for (const [k, v] of Object.entries(params || {})) {
            if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
        }
        commonParams(p, opts);
        const qs = p.toString();
        return `${root}/query/${resource}${qs ? `?${qs}` : ''}`;
    },
    /** POST proxy: type ∈ funnel|retention|journey|performance|heatmap|utm|… */
    report: (type: string) => `${root}/report/${type}`,
};

/** Body builder for report POSTs — keeps range plumbing in one place. */
export function reportBody({ siteId, range, timezone, start, end, filters, fresh, ...rest }: AnalyticsRequestOpts & Record<string, unknown> = {}) {
    const body = { ...rest };
    if (siteId) body.siteId = siteId;
    if (range) body.range = range;
    if (timezone) body.timezone = timezone;
    if (start != null) body.start = start;
    if (end != null) body.end = end;
    if (filters && Object.keys(filters).length) body.filters = filters;
    if (fresh) body.fresh = true;
    return body;
}

// Thin fetch wrapper — always send the session cookie, parse JSON, throw on
// non-2xx so callers can surface a message.
export async function analyticsFetch(url: string, opts: RequestInit = {}): Promise<AnalyticsResponse> {
    const res = await fetch(url, { credentials: 'include', ...opts });
    const text = await res.text();
    let json: AnalyticsResponse = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (!res.ok) {
        const err: Error & { status?: number } = new Error(json?.error || `Request failed (${res.status})`);
        err.status = res.status;
        throw err;
    }
    return json;
}

/** POST helper for the report proxy. */
export function analyticsPost(url: string, body?: unknown, opts: RequestInit = {}) {
    return analyticsFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        ...opts,
    });
}
