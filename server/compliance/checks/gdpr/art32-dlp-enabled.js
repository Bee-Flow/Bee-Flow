/**
 * GDPR Art. 32 — DLP (Data Loss Prevention) active and working.
 *
 * Three signals, evaluated in order:
 *   1. CONFIG  — regex guardrails + PII detection enabled (per-org Privacy
 *               Shield or global ai config). Content moderation was the third
 *               layer until the Azure Content Safety backend was dropped.
 *   2. ACTIVITY — at least one guardrail_events row in the last 30 days
 *               when AI traffic is observed. "Configured but silent" is
 *               degraded to warn — strongly suggests it isn't wired up.
 *   3. OVER-BLOCK — if 50%+ of recent events are blocks, warn the admin to
 *               check that legitimate traffic isn't being suppressed.
 */

const { getOne } = require('../../../db');
const configStore = require('../../../stores/configStore');

/** The layers a fully configured DLP has: regex guardrails and PII detection. */
const DLP_LAYERS = 2;

async function _guardrailStats(orgId) {
    try {
        const row = await getOne(`
            SELECT
                COUNT(*)::int AS total_events,
                COUNT(*) FILTER (WHERE action_taken = 'blocked')::int AS blocked_events,
                COUNT(*) FILTER (WHERE action_taken = 'redacted')::int AS redacted_events
            FROM guardrail_events
            WHERE timestamp >= NOW() - INTERVAL '30 days'
              ${orgId ? 'AND organization_id = $1' : ''}
        `, orgId ? [orgId] : []);
        return row || { total_events: 0, blocked_events: 0, redacted_events: 0 };
    } catch {
        return { total_events: 0, blocked_events: 0, redacted_events: 0, missing: true };
    }
}

async function _aiCallCount(orgId) {
    try {
        const row = await getOne(`
            SELECT COUNT(*)::int AS c FROM ai_usage_log
            WHERE timestamp >= NOW() - INTERVAL '30 days'
              ${orgId ? 'AND organization_id = $1' : ''}
        `, orgId ? [orgId] : []);
        return row?.c || 0;
    } catch {
        return 0;
    }
}

module.exports = {
    id: 'GDPR-Art32-dlp-enabled',
    regulation: 'GDPR',
    article: '32',
    // Also ISO 27001 evidence (control A.8.12) — counts once per framework.
    frameworks: [{ regulation: 'ISO27001', ref: 'A.8.12' }],
    severity: 'high',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.gdpr_art32_dlp.title',
    descriptionKey: 'compliance.checks.gdpr_art32_dlp.desc',
    remediationKey: 'compliance.checks.gdpr_art32_dlp.fix',
    remediationLink: 'admin/security/guardrails',
    async evaluate(orgId) {
        const orgKey = `org_privacy_shield_${orgId || 'default'}`;
        const shield = (await configStore.getConfig(orgKey)) || {};
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

        // Content moderation was removed when the Azure Content Safety
        // backend was dropped; only regex + PII signals remain.
        const configCoverage = [regexEnabled, piiEnabled].filter(Boolean).length;

        let status;
        if (configCoverage === DLP_LAYERS) status = 'pass';
        else if (configCoverage === 1) status = 'warn';
        else status = 'fail';

        // ── Activity signals (only meaningful if DLP is configured) ──
        const stats = await _guardrailStats(orgId);
        let overBlockWarning = null;
        let silentWarning = null;
        if (status === 'pass') {
            if ((stats.total_events || 0) === 0 && !stats.missing) {
                const aiCalls = await _aiCallCount(orgId);
                if (aiCalls > 0) {
                    status = 'warn';
                    silentWarning = `DLP is configured but no guardrail events fired in 30 days despite ${aiCalls} AI calls — verify it's wired up.`;
                }
            }
            const blockRatio = (stats.total_events || 0) > 0
                ? (stats.blocked_events || 0) / stats.total_events
                : 0;
            if (blockRatio >= 0.5) {
                status = 'warn';
                overBlockWarning = `${Math.round(blockRatio * 100)}% of guardrail decisions in the last 30 days were blocks — review rules to avoid suppressing legitimate traffic.`;
            }
        }

        // Compare against the number of layers that exist, never a literal: the
        // literal stayed at 3 after moderation was removed, so a fully
        // configured PASS read "DLP is partially enabled".
        const baseDetails =
            configCoverage === DLP_LAYERS
                ? 'Regex guardrails and PII detection are both enabled.'
                : configCoverage >= 1
                    ? `DLP is partially enabled. Open Security → Guardrails and turn on ${regexEnabled ? 'PII detection' : 'a regex collection'}.`
                    : 'No DLP protection active. Sensitive data can leave the system unchecked.';

        return {
            status,
            evidence: {
                regex_guardrails: regexEnabled,
                pii_detection: piiEnabled,
                source: shield.enabled ? 'org_privacy_shield' : 'global_ai_config',
                window_days: 30,
                total_events: stats.total_events || 0,
                blocked_events: stats.blocked_events || 0,
                redacted_events: stats.redacted_events || 0,
                guardrail_table_missing: !!stats.missing || undefined,
            },
            details: [baseDetails, silentWarning, overBlockWarning].filter(Boolean).join(' '),
        };
    },
};
