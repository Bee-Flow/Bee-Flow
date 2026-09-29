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
 */

const { getOne } = require('../../../db');
const configStore = require('../../../stores/configStore');

const WINDOW_DAYS = 30;
const MIN_TRAFFIC = 25; // below this, a silent guardrail log proves nothing

async function _guardrailStats(orgId) {
    try {
        const row = await getOne(`
            SELECT
                COUNT(*)::int AS total_events,
                COUNT(*) FILTER (WHERE action_taken = 'blocked')::int AS blocked_events,
                COUNT(*) FILTER (WHERE action_taken = 'redacted')::int AS redacted_events
            FROM guardrail_events
            WHERE timestamp >= NOW() - INTERVAL '${WINDOW_DAYS} days'
              ${orgId ? 'AND organization_id = $1' : ''}
        `, orgId ? [orgId] : []);
        return row || { total_events: 0, blocked_events: 0, redacted_events: 0 };
    } catch {
        return { total_events: 0, blocked_events: 0, redacted_events: 0, missing: true };
    }
}

async function _aiCallCount() {
    try {
        const row = await getOne(`SELECT COUNT(*)::int AS c FROM ai_usage_log WHERE timestamp >= NOW() - INTERVAL '${WINDOW_DAYS} days'`);
        return row?.c || 0;
    } catch {
        return 0;
    }
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

        const stats = await _guardrailStats(orgId);
        const traffic = await _aiCallCount();

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
