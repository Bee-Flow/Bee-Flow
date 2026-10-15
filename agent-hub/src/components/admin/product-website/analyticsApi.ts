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

/** The JSON envelope the server proxy answers with. */
export interface AnalyticsEnvelope {
    data?: unknown;
    cached?: boolean;
    error?: string;
}

/** The window and filters every analytics call shares. */
export interface AnalyticsScope {
    siteId?: string;
    range?: string;
    timezone?: string;
    start?: string | number | null;
    end?: string | number | null;
    filters?: Record<string, unknown>;
    fresh?: boolean;
    _token?: number;
}

export interface QueryOptions extends AnalyticsScope {
    params?: Record<string, unknown>;
}

const root = `${API_BASE}/api/cms/admin/analytics`;

// Range/filter params shared by every data call.
function commonParams(p: URLSearchParams, { siteId, range, timezone, start, end, filters, fresh }: AnalyticsScope = {}) {
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
    overview: (opts: AnalyticsScope = {}) => {
        const qs = commonParams(new URLSearchParams(), opts).toString();
        return `${root}/overview${qs ? `?${qs}` : ''}`;
    },
    /** GET proxy: resource ∈ stats|pageviews|metrics|realtime|events|sessions|… */
    query: (resource: string, { params, ...opts }: QueryOptions = {}) => {
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
export function reportBody({ siteId, range, timezone, start, end, filters, fresh, ...rest }: AnalyticsScope & Record<string, unknown> = {}) {
    const body: Record<string, unknown> = { ...rest };
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
export async function analyticsFetch<T = AnalyticsEnvelope>(url: string, opts: RequestInit = {}): Promise<T> {
    const res = await fetch(url, { credentials: 'include', ...opts });
    const text = await res.text();
    let json: { error?: string } | null = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (!res.ok) {
        const err: Error & { status?: number } = new Error(json?.error || `Request failed (${res.status})`);
        err.status = res.status;
        throw err;
    }
    return json as T;
}

/** POST helper for the report proxy. */
export function analyticsPost<T = AnalyticsEnvelope>(url: string, body: unknown, opts: RequestInit = {}): Promise<T> {
    return analyticsFetch<T>(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        ...opts,
    });
}
