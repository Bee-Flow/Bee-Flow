/**
 * ISO 27001 A.8.16 — monitoring activities: the org's log platform
 * (OpenObserve) must actually receive data and have at least one enabled
 * alert rule so anomalies reach a human. Reads the openobserve connector's
 * summary snapshot; an unreadable alert configuration (alert_rules: null)
 * downgrades to warn, never guesses. Retention below 90 days warns —
 * investigations need history.
 */

const isoEvidenceStore = require('../../../stores/isoEvidenceStore');

const MIN_RETENTION_DAYS = 90;

module.exports = {
    id: 'ISO27001-A.8.16-monitoring',
    regulation: 'ISO27001',
    article: 'A.8.16',
    controls: ['A.8.16', 'A.8.17'],
    frameworks: [{ regulation: 'NIS2', ref: 'Art. 21(2)(b)' }],
    severity: 'medium',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.iso_monitoring.title',
    descriptionKey: 'compliance.checks.iso_monitoring.desc',
    remediationKey: 'compliance.checks.iso_monitoring.fix',
    remediationLink: 'admin/compliance/iso_connectors',

    async evaluate(orgId) {
        const config = await isoEvidenceStore.getConfig(orgId, 'openobserve').catch(() => null);
        if (!config?.enabled) {
            return {
                status: 'not_applicable',
                evidence: { connector: 'openobserve', enabled: false },
                details: 'OpenObserve connector not enabled — link your monitoring instance under ISO 27001 → Connectors.',
            };
        }
        const snaps = await isoEvidenceStore.listLatestSnapshots(orgId, 'openobserve').catch(() => []);
        if (!snaps.length) {
            return {
                status: 'warn',
                evidence: { connector: 'openobserve', enabled: true, snapshots: 0 },
                details: 'Connector enabled but no snapshot yet — run a sweep or check the base URL and credentials.',
            };
        }
        const summary = snaps.find(s => s.subject_id === 'summary') || snaps[0];
        const p = summary.payload || {};
        const streams = Number(p.streams) || 0;
        const withData = Number(p.streams_with_data) || 0;
        const alertRules = (p.alert_rules === null || p.alert_rules === undefined) ? null : Number(p.alert_rules);
        const enabledRules = (p.alert_rules_enabled === null || p.alert_rules_enabled === undefined)
            ? null
            : Number(p.alert_rules_enabled);
        const retention = (p.retention_days_min === null || p.retention_days_min === undefined)
            ? null
            : Number(p.retention_days_min);
        const evidence = {
            endpoint_host: p.endpoint_host || null,
            streams,
            streams_with_data: withData,
            alert_rules: alertRules,
            alert_rules_enabled: enabledRules,
            retention_days_min: retention,
            fetched_at: summary.fetched_at,
        };
        if (alertRules === 0 && withData === 0) {
            return {
                status: 'fail',
                evidence,
                details: 'The log platform receives no data and has no alert rules — security events would go completely unnoticed.',
            };
        }
        if (alertRules === null) {
            return {
                status: 'warn',
                evidence,
                details: `Alert configuration could not be read${p.alerts_error ? ` (${p.alerts_error})` : ''} — verify the account can list alerts.`,
            };
        }
        const gaps = [
            withData === 0 && `${streams} stream(s) are configured but none receives data`,
            alertRules === 0 && 'no alert rules exist — nobody is notified when something goes wrong',
            alertRules > 0 && enabledRules === 0 && `all ${alertRules} alert rule(s) are disabled`,
            retention !== null && retention < MIN_RETENTION_DAYS && `minimum stream retention is ${retention} days (recommended ≥ ${MIN_RETENTION_DAYS})`,
        ].filter(Boolean);
        if (gaps.length) {
            return { status: 'warn', evidence, details: `Monitoring needs attention — ${gaps.join('; ')}.` };
        }
        return {
            status: 'pass',
            evidence,
            details: `${withData} stream(s) receive data and ${enabledRules ?? alertRules} enabled alert rule(s) notify on anomalies${retention !== null ? `; minimum retention ${retention} days` : ''}.`,
        };
    },
};
