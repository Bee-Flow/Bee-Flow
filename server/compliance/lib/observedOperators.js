/**
 * Observed operators — which third parties this organisation's workspace
 * actually talks to.
 *
 * Three sources, kept separate so each check can pick the signal it needs:
 *
 *   1. ACTIVITY LEDGER — `integration_activity_log`, last 30 days, one row per
 *      operator with an EU flag and a call count. This is the query
 *      gdpr/art28-subprocessors.js has always run; it lives here now so the
 *      DORA register (Art. 28(3)) reconciles against the same numbers. Local
 *      calls (a private address included) and dry runs are excluded: nothing
 *      left the building. A call via a global network (Cloudflare, …) stays,
 *      that network is a supplier; a row with neither an operator nor a
 *      location is dropped, it names nobody (SUPPLIER_ROW).
 *   2. CONNECTIONS — `integration_connections.provider`: a configured
 *      connection is an arrangement with a provider even before the first call.
 *   3. AI PROVIDERS — the platform's configured LLM providers (`config 'ai'`).
 *      Self-hosted runtimes (Ollama, vLLM, …) are NOT third parties and are
 *      dropped — the local runtime register in providers/localModels.js says
 *      which types those are.
 *
 * `collect()` unions the three into one register keyed on a canonical operator
 * name (lower-cased, corporate suffixes stripped, a few well-known aliases such
 * as claude → anthropic folded). Every row carries `sources` so the reader can
 * see WHY an operator is listed. Nothing here is personal data: operators are
 * companies, counts are counts.
 */

const { getAll } = require('../../db');
const configStore = require('../../stores/configStore');
const { SUPPLIER_ROW } = require('../../stores/integrationLocationSql');

const WINDOW_DAYS = 30;

// Provider types that run on the org's own infrastructure. Read from the local
// runtime register when it is available so a new runtime is excluded the day
// it is added there; the fallback list is only for a build without that file.
function _localRuntimeTypes() {
    try {
        const { LOCAL_RUNTIMES } = require('../../core/providers/localModels');
        if (LOCAL_RUNTIMES && typeof LOCAL_RUNTIMES === 'object') {
            return new Set(Object.keys(LOCAL_RUNTIMES).map(k => k.toLowerCase()).concat(['local']));
        }
    } catch { /* register not present in this build */ }
    return new Set(['ollama', 'vllm', 'llamacpp', 'lmstudio', 'sglang', 'localai', 'tgi', 'jan', 'koboldcpp', 'local']);
}

const ALIASES = {
    claude: 'anthropic',
    'google-vertex': 'google',
    googlevertex: 'google',
    'google vertex': 'google',
    azure: 'microsoft',
    'azure-openai': 'microsoft',
    'azure openai': 'microsoft',
    aws: 'amazon',
    'amazon aws': 'amazon',
};

/** Canonical key for an operator name: lower-case, no corporate suffix, aliases folded. */
function canonical(name) {
    let s = String(name || '').toLowerCase().trim();
    if (!s) return '';
    s = s.replace(/[,.]?\s+(llc|inc\.?|ltd\.?|b\.?v\.?|gmbh|corp\.?|s\.?a\.?)$/i, '').trim();
    return ALIASES[s] || s;
}

/**
 * Operators seen in the outbound ledger over the last 30 days.
 * @returns {Promise<Array<{operator:string,is_eu:boolean,calls:number,country_code?:string|null}>|null>}
 *   `null` when the ledger table is not available (fresh install) — callers
 *   distinguish "no ledger" from "ledger, but quiet".
 */
async function fromActivityLog(orgId, { withCountry = false } = {}) {
    const countryCol = withCountry ? `, MAX(country_code) AS country_code` : '';
    try {
        return await getAll(`
            SELECT COALESCE(operator, 'unknown') AS operator,
                   BOOL_OR(COALESCE(is_eu, false)) AS is_eu,
                   COUNT(*)::int AS calls${countryCol}
            FROM integration_activity_log
            WHERE organization_id = $1
              AND timestamp >= NOW() - INTERVAL '30 days'
              AND ${SUPPLIER_ROW}
              AND COALESCE(is_dry_run, false) = false
            GROUP BY COALESCE(operator, 'unknown')
        `, [orgId]);
    } catch {
        return null;
    }
}

/**
 * Providers with a configured (non-revoked) connection for this org.
 * @returns {Promise<Array<{provider:string,connections:number,any_active:boolean}>>}
 */
async function fromConnections(orgId) {
    try {
        return await getAll(`
            SELECT provider,
                   COUNT(*)::int AS connections,
                   BOOL_OR(status = 'active') AS any_active
            FROM integration_connections
            WHERE org_id = $1
              AND status <> 'revoked'
            GROUP BY provider
        `, [orgId]);
    } catch {
        return [];
    }
}

/**
 * Third-party LLM providers configured on the platform (self-hosted runtimes
 * excluded). Platform-level config: the same list applies to every org, which
 * is accurate — every org's AI calls go to these operators.
 * @returns {Promise<Array<{type:string,name:string|null}>>}
 */
async function fromAiProviders() {
    try {
        const ai = (await configStore.getConfig('ai')) || {};
        const providers = Array.isArray(ai.providers) ? ai.providers : [];
        const local = _localRuntimeTypes();
        const seen = new Map();
        for (const p of providers) {
            const type = String(p?.type || '').toLowerCase().trim();
            if (!type || local.has(type)) continue;
            if (!seen.has(type)) seen.set(type, { type, name: typeof p?.name === 'string' ? p.name : null });
        }
        return Array.from(seen.values());
    } catch {
        return [];
    }
}

/**
 * One register over all three sources.
 * @returns {Promise<{
 *   window_days:number, ledger_available:boolean,
 *   activity:Array, connections:Array, ai_providers:Array,
 *   operators:Array<{operator:string,key:string,sources:string[],is_eu:boolean|null,country_code:string|null,calls_30d:number,connections:number}>
 * }>}
 */
async function collect(orgId) {
    const [activity, connections, aiProviders] = await Promise.all([
        fromActivityLog(orgId, { withCountry: true }),
        fromConnections(orgId),
        fromAiProviders(),
    ]);
    const byKey = new Map();
    const upsert = (display, source) => {
        const key = canonical(display);
        if (!key) return null;
        let row = byKey.get(key);
        if (!row) {
            row = { operator: String(display), key, sources: [], is_eu: null, country_code: null, calls_30d: 0, connections: 0 };
            byKey.set(key, row);
        }
        if (!row.sources.includes(source)) row.sources.push(source);
        return row;
    };
    for (const a of activity || []) {
        const row = upsert(a.operator, 'activity_log');
        if (!row) continue;
        row.calls_30d += Number(a.calls) || 0;
        if (a.is_eu === true) row.is_eu = true;
        else if (a.is_eu === false && row.is_eu === null) row.is_eu = false;
        if (a.country_code && !row.country_code) row.country_code = String(a.country_code).toUpperCase();
    }
    for (const c of connections) {
        const row = upsert(c.provider, 'connection');
        if (row) row.connections += Number(c.connections) || 0;
    }
    for (const p of aiProviders) {
        upsert(p.type, 'ai_provider');
    }
    const operators = Array.from(byKey.values()).sort((a, b) => b.calls_30d - a.calls_30d || a.key.localeCompare(b.key));
    return {
        window_days: WINDOW_DAYS,
        ledger_available: activity !== null,
        activity: activity || [],
        connections,
        ai_providers: aiProviders,
        operators,
    };
}

module.exports = { WINDOW_DAYS, canonical, fromActivityLog, fromConnections, fromAiProviders, collect };
