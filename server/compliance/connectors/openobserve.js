/** @typedef {import('url').URL} URL */
// @typecheck noImplicitAny
/**
 * OpenObserve monitoring connector — is the org's log platform actually
 * receiving data, retaining it, and wired to alert someone (A.8.16
 * monitoring, A.8.17). Config-state depth only: stream/alert counts and
 * retention numbers — never log lines, queries or dashboard contents.
 *
 * Credential (vault provider 'openobserve', kinds 'basic' | 'bearer'), read
 * defensively:
 *   { username, password }  -> Authorization: Basic base64(username:password)
 *                              (self-hosted OpenObserve authenticates with
 *                              the user's e-mail + password or service token
 *                              as the password)
 *   { token }               -> Authorization: Bearer <token>
 *                              (OpenObserve Cloud / proxy-issued tokens)
 * The account only needs read access to the target org (a Viewer role is
 * enough).
 *
 * Endpoints ({base_url} from settings, org from settings.org):
 *   GET {base}/api/{org}/streams        — stream list; per stream: stats
 *       (doc_num) and settings (data_retention, in days, 0/absent = the
 *       instance-wide default, recorded as unknown).
 *   GET {base}/api/v2/{org}/alerts      — alert rules (OpenObserve >= v0.14
 *       folder-aware API; verified against the upstream repo). Falls back to
 *       GET {base}/api/{org}/alerts on 404 for older versions. An alert
 *       failure never sinks the sweep — `alert_rules: null` plus
 *       `alerts_error` record the partial state honestly.
 *
 * One snapshot subject 'summary':
 *   { org, endpoint_host, streams, streams_with_data, alert_rules,
 *     alert_rules_enabled, retention_days_min, alerts_api }
 */

const ORG_RE = /^[A-Za-z0-9_-]+$/;

/** @param {Record<string, any> | null | undefined} secret */
function _authHeader(secret) {
    const username = secret?.username || secret?.user || secret?.email || null;
    const password = secret?.password || null;
    if (username && password) {
        return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    }
    const token = secret?.token || secret?.apiKey || secret?.api_key || null;
    if (token) return `Bearer ${token}`;
    throw new Error('OpenObserve connection needs { username, password } or { token }');
}

/**
 * @param {import('./index').SafeFetch} safeFetch
 * @param {string} url
 * @param {string} auth
 */
async function _get(safeFetch, url, auth) {
    return safeFetch(url, {
        headers: { 'Authorization': auth, 'User-Agent': 'BeeFlow-ISO-Evidence' },
        signal: AbortSignal.timeout(20000),
    });
}

module.exports = {
    id: 'openobserve',
    titleKey: 'compliance.connector.openobserve.title',
    descKey: 'compliance.connector.openobserve.desc',
    coveredControls: ['A.8.16', 'A.8.17'],
    checks: ['ISO27001-A.8.16-monitoring'],
    credential: { provider: 'openobserve', kinds: ['basic', 'bearer'] },
    settingsHint: 'base_url: "https://observe.example.com", org: "default"',

    /** @param {import('./index').CollectArgs} args */
    async collect({ secret, settings, safeFetch }) {
        const base = String(settings?.base_url || '').trim().replace(/\/+$/, '');
        if (!base) return [];
        /** @type {URL} */
        let parsed;
        try { parsed = new URL(base); } catch { return []; }
        if (!/^https?:$/.test(parsed.protocol)) return [];
        const org = String(settings?.org || 'default').trim();
        if (!ORG_RE.test(org)) throw new Error(`Invalid OpenObserve org "${org}"`);
        const auth = _authHeader(secret);

        const streamsRes = await _get(safeFetch, `${base}/api/${org}/streams`, auth);
        if (streamsRes.status === 401 || streamsRes.status === 403) {
            throw new Error(`OpenObserve credentials rejected (${streamsRes.status})`);
        }
        if (!streamsRes.ok) throw new Error(`OpenObserve streams list failed (${streamsRes.status})`);
        const streamsBody = /** @type {{ list?: Record<string, any>[] }} */ (await streamsRes.json().catch(() => ({})));
        /** @type {Record<string, any>[]} */
        const streams = Array.isArray(streamsBody?.list) ? streamsBody.list : [];

        const streamsWithData = streams.filter(s => Number(s?.stats?.doc_num) > 0).length;
        /** @type {number | null} */
        let retentionMin = null;
        for (const s of streams) {
            const days = Number(s?.settings?.data_retention);
            if (Number.isFinite(days) && days > 0 && (retentionMin === null || days < retentionMin)) {
                retentionMin = days;
            }
        }

        let alertRules = null;
        let alertRulesEnabled = null;
        /** @type {string | null} */
        let alertsApi = null;
        /** @type {string | null} */
        let alertsError = null;
        try {
            let api = 'v2';
            let res = await _get(safeFetch, `${base}/api/v2/${org}/alerts`, auth);
            if (res.status === 404) {
                api = 'v1';
                res = await _get(safeFetch, `${base}/api/${org}/alerts`, auth);
            }
            if (!res.ok) throw new Error(`alerts list failed (${res.status})`);
            const body = /** @type {Record<string, any>} */ (await res.json().catch(() => ({})));
            const list = Array.isArray(body?.list) ? body.list
                : (Array.isArray(body?.alerts) ? body.alerts
                    : (Array.isArray(body) ? body : []));
            alertRules = list.length;
            alertRulesEnabled = list.filter((/** @type {{ enabled: boolean; }} */ a) => a?.enabled !== false).length;
            alertsApi = api;
        } catch (e) {
            alertsError = String(/** @type {Error} */ (e)?.message || e).slice(0, 200);
        }

        return [{
            subject_id: 'summary',
            payload: {
                org,
                endpoint_host: parsed.hostname,
                streams: streams.length,
                streams_with_data: streamsWithData,
                retention_days_min: retentionMin,
                alert_rules: alertRules,
                alert_rules_enabled: alertRulesEnabled,
                alerts_api: alertsApi,
                ...(alertsError ? { alerts_error: alertsError } : {}),
            },
        }];
    },
};
