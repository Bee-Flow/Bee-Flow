/**
 * EU AI Act Art. 12 / 26(6) — automatically generated logs of high-risk AI
 * systems must be kept for at least six months.
 *
 * Automated signal: the age span of the activity ledgers
 * (integration_activity_log + guardrail_events). A span ≥ 180 days proves the
 * retention window is honoured; a shorter span cannot distinguish "young
 * install" from "purged logs", so it warns (never fails) with the observed
 * span.
 */

const { getOne } = require('../../../db');

const REQUIRED_DAYS = 180;

async function _oldestAgeDays(table, orgScoped, orgId) {
    try {
        const row = orgScoped
            ? await getOne(`SELECT EXTRACT(EPOCH FROM (NOW() - MIN(timestamp))) / 86400 AS age FROM ${table} WHERE organization_id = $1`, [orgId])
            : await getOne(`SELECT EXTRACT(EPOCH FROM (NOW() - MIN(timestamp))) / 86400 AS age FROM ${table}`);
        return row?.age == null ? null : Math.floor(Number(row.age));
    } catch {
        return null; // table absent on fresh installs
    }
}

module.exports = {
    id: 'AIA-Art26-6-log-retention',
    regulation: 'AIA',
    article: '26(6)',
    severity: 'medium',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.aia_art26_6.title',
    descriptionKey: 'compliance.checks.aia_art26_6.desc',
    remediationKey: 'compliance.checks.aia_art26_6.fix',
    remediationLink: 'admin/monitoring/activity',
    async evaluate(orgId) {
        const integrationAge = await _oldestAgeDays('integration_activity_log', true, orgId);
        const guardrailAge = await _oldestAgeDays('guardrail_events', false, orgId);
        const spans = [integrationAge, guardrailAge].filter(v => v != null);
        const evidence = {
            required_days: REQUIRED_DAYS,
            integration_log_span_days: integrationAge,
            guardrail_log_span_days: guardrailAge,
        };
        if (!spans.length) {
            return {
                status: 'not_applicable',
                evidence,
                details: 'No activity logs recorded yet — nothing to retain.',
            };
        }
        const maxSpan = Math.max(...spans);
        if (maxSpan >= REQUIRED_DAYS) {
            return {
                status: 'pass',
                evidence: { ...evidence, observed_span_days: maxSpan },
                details: `Activity logs span ${maxSpan} days — the six-month Art. 26(6) retention window is demonstrated.`,
            };
        }
        return {
            status: 'warn',
            evidence: { ...evidence, observed_span_days: maxSpan },
            details: `Activity logs span only ${maxSpan} days. If this install is older than that, logs are being purged early — Art. 12/26(6) requires keeping them at least six months.`,
        };
    },
};
