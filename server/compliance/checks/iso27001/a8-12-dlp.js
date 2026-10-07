/**
 * ISO 27001 A.8.11 / A.8.12 — Data masking and data leakage prevention.
 *
 * Configuration signal re-implements gdpr/art32-dlp-enabled.js: regex
 * guardrails + PII detection from the per-org Privacy Shield (or the global
 * ai config fallback). 'redacted' guardrail events are the live masking
 * signal for A.8.11; blocked/total events evidence A.8.12.
 *
 * Efficacy signal mirrors gdpr/art32-dlp-efficacy.js: with both layers on
 * and real AI traffic, a silent guardrail log means the shield is not
 * actually in the request path. Helpers are re-implemented, not imported —
 * they are private to those checks.
 *
 * Both ledgers are counted over the SAME population, the one the efficacy
 * check uses: a row belongs to the org when its organization_id says so, or
 * when it names no organisation and its user belongs to the org. The
 * 'default' bucket also holds every row that resolves to no organisation at
 * all. Counting guardrail events per org against install-wide traffic let
 * another tenant's traffic make a quiet tenant warn, and hid the bucket's
 * NULL-org events behind traffic that covered the whole install.
 */

const { getOne } = require('../../../db');
const configStore = require('../../../stores/configStore');

const WINDOW_DAYS = 30;
const MIN_TRAFFIC = 25; // below this, a silent guardrail log proves nothing
// Not provisioned on this install (undefined table or column). Every other
// SQLSTATE is a count that FAILED, which is not zero.
const NOT_PROVISIONED = new Set(['42P01', '42703']);
// The bucket the platform files org-less rows under (routes/compliance/shared.js
// resolveOrgId); it is not a tenant.
const NO_ORG_ORG_ID = 'default';

// Bare column comparisons, so idx_*_org_timestamp stays usable.
const NO_ORG = "(t.organization_id IS NULL OR t.organization_id = '')";
const MEMBER_ORG = 'NULLIF(u."organizationId", \'\')';

/** SQL: the row `t` (joined to its user `u`) belongs to the org in $1. */
function _belongs(orgId) {
    const own = `(t.organization_id = $1 OR (${NO_ORG} AND ${MEMBER_ORG} = $1))`;
    return orgId === NO_ORG_ORG_ID ? `(${own} OR (${NO_ORG} AND ${MEMBER_ORG} IS NULL))` : own;
}

/** SQL: FROM and WHERE of one ledger's rows in the window that belong to the org. */
function _from(table, orgId) {
    return `FROM ${table} t
            LEFT JOIN users u ON u.id = t.user_id
            WHERE t.timestamp >= NOW() - INTERVAL '${WINDOW_DAYS} days'
              AND (t.organization_id = $1 OR ${NO_ORG})
              AND ${_belongs(orgId)}`;
}

/** One count query: its row, `missing` when not provisioned, `failed` (the SQLSTATE) otherwise. */
async function _read(sql, scope) {
    try {
        return { row: (await getOne(sql, [scope])) || null };
    } catch (e) {
        if (NOT_PROVISIONED.has(e?.code)) return { row: null, missing: true };
        return { row: null, failed: e?.code || 'unknown' };
    }
}

async function _guardrailStats(scope) {
    const r = await _read(`
        SELECT
            COUNT(*)::int AS total_events,
            COUNT(*) FILTER (WHERE t.action_taken = 'blocked')::int AS blocked_events,
            COUNT(*) FILTER (WHERE t.action_taken = 'redacted')::int AS redacted_events
        ${_from('guardrail_events', scope)}
    `, scope);
    return { total_events: 0, blocked_events: 0, redacted_events: 0, ...(r.row || {}), missing: !!r.missing, failed: r.failed || null };
}

async function _aiCallCount(scope) {
    const r = await _read(`SELECT COUNT(*)::int AS c ${_from('ai_usage_log', scope)}`, scope);
    // A ledger that does not exist has no traffic to judge, as before.
    return { count: r.row?.c || 0, failed: r.failed || null };
}

module.exports = {
    id: 'ISO27001-A.8.12-dlp',
    regulation: 'ISO27001',
    article: 'A.8.12',
    controls: ['A.8.11', 'A.8.12'],
    severity: 'high',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.iso_dlp.title',
    descriptionKey: 'compliance.checks.iso_dlp.desc',
    remediationKey: 'compliance.checks.iso_dlp.fix',
    remediationLink: 'admin/security/guardrails',
    async evaluate(orgId) {
        const shield = (await configStore.getConfig(`org_privacy_shield_${orgId || 'default'}`)) || {};
        const ai = (await configStore.getConfig('ai')) || {};

        const regexEnabled =
            (!!shield.enabled && Array.isArray(shield.collectionIds) && shield.collectionIds.length > 0) ||
            (!!ai.regexGuardrails && (Array.isArray(ai.regexGuardrails)
                ? ai.regexGuardrails.length > 0
                : Object.keys(ai.regexGuardrails).length > 0));

        const piiEnabled =
            !!shield.enabled ||
            (Array.isArray(shield.piiDetectionCategories) && shield.piiDetectionCategories.length > 0) ||
            (Array.isArray(ai.piiDetectionCategories) && ai.piiDetectionCategories.length > 0);

        const layersOn = [regexEnabled, piiEnabled].filter(Boolean).length;

        const scope = orgId || NO_ORG_ORG_ID;
        const stats = await _guardrailStats(scope);
        const trafficRead = await _aiCallCount(scope);
        const traffic = trafficRead.count;

        const evidence = {
            window_days: WINDOW_DAYS,
            regex_guardrails: regexEnabled,
            pii_detection: piiEnabled,
            source: shield.enabled ? 'org_privacy_shield' : 'global_ai_config',
            ai_requests: traffic,
            total_events: stats.total_events || 0,
            blocked_events: stats.blocked_events || 0,
            redacted_events: stats.redacted_events || 0,
            guardrail_table_missing: !!stats.missing || undefined,
        };
        const failedReads = [
            stats.failed && `guardrail_events (SQL state ${stats.failed})`,
            trafficRead.failed && `ai_usage_log (SQL state ${trafficRead.failed})`,
        ].filter(Boolean);
        if (failedReads.length) evidence.unreadable = failedReads;

        if (layersOn === 0) {
            return {
                status: 'fail',
                evidence,
                details: 'No leak-prevention layers are active — sensitive data can leave the workspace unmasked and unblocked.',
            };
        }
        if (layersOn === 1) {
            return {
                status: 'warn',
                evidence,
                details: `Only one of two leak-prevention layers is on (${regexEnabled ? 'regex guardrails' : 'PII detection'}). Open Security → Guardrails and enable the missing layer.`,
            };
        }
        if (failedReads.length) {
            return {
                status: 'warn',
                evidence,
                details: `Guardrail or AI-usage counts could not be read (${failedReads.join(', ')}), so whether the configured shield fires on real traffic was not verified this run.`,
            };
        }
        if (traffic < MIN_TRAFFIC) {
            return {
                status: 'warn',
                evidence,
                details: `Masking and leak prevention are configured, but with only ${traffic} AI request(s) in ${WINDOW_DAYS} days there is no traffic yet to demonstrate they work.`,
            };
        }
        if (stats.missing) {
            return {
                status: 'warn',
                evidence,
                details: 'Leak prevention is configured, but the guardrail event log is not available — whether the shield actually fires cannot be verified.',
            };
        }
        if ((stats.total_events || 0) === 0) {
            return {
                status: 'warn',
                evidence,
                details: `Leak prevention is configured and ${traffic} AI request(s) flowed in ${WINDOW_DAYS} days, yet the guardrail log recorded zero events — verify the shield is actually in the request path.`,
            };
        }
        return {
            status: 'pass',
            evidence,
            details: `Masking and leak prevention are demonstrably active: ${stats.total_events} guardrail event(s) (${stats.redacted_events} redacted, ${stats.blocked_events} blocked) across ${traffic} AI request(s) in the last ${WINDOW_DAYS} days.`,
        };
    },
};
