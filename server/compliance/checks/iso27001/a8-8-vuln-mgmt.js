/**
 * ISO 27001 A.8.8 — management of technical vulnerabilities: open Dependabot
 * alerts from the github connector snapshots. A critical/high finding left
 * open beyond 30 days, or vulnerability data that is invisible on every
 * monitored repository, fails the control; a fresh critical/high or a large
 * medium/low backlog is a warning. A pass needs the whole estate: alerts that
 * are not readable on some repositories, or a repository where only the first
 * page of 100 open alerts was read, make the result partial, so it warns.
 */

const isoEvidenceStore = require('../../../stores/isoEvidenceStore');

const STALE_DAYS = 30;
const BACKLOG_WARN = 20;

module.exports = {
    id: 'ISO27001-A.8.8-vuln-mgmt',
    regulation: 'ISO27001',
    article: 'A.8.8',
    controls: ['A.8.8'],
    frameworks: [{ regulation: 'NIS2', ref: 'Art. 21(2)(e)' }, { regulation: 'CRA', ref: 'Annex I Part II(2)' }],
    severity: 'high',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.iso_vuln_mgmt.title',
    descriptionKey: 'compliance.checks.iso_vuln_mgmt.desc',
    remediationKey: 'compliance.checks.iso_vuln_mgmt.fix',
    remediationLink: 'admin/compliance/iso_connectors',

    async evaluate(orgId) {
        const config = await isoEvidenceStore.getConfig(orgId, 'github').catch(() => null);
        if (!config?.enabled) {
            return {
                status: 'not_applicable',
                evidence: { connector: 'github', enabled: false },
                details: 'GitHub connector not enabled — link a token and list your repositories under ISO 27001 → Connectors.',
            };
        }
        const snaps = await isoEvidenceStore.listLatestSnapshots(orgId, 'github').catch(() => []);
        if (!snaps.length) {
            return {
                status: 'warn',
                evidence: { connector: 'github', enabled: true, snapshots: 0 },
                details: 'Connector enabled but no snapshot yet — run a sweep or check the configured repositories.',
            };
        }
        const repos = snaps.map(s => s.payload || {});
        const rows = repos.map(r => ({
            repo: r.repo,
            alerts_accessible: r.dependabot?.accessible === true,
            by_severity: r.dependabot?.by_severity || null,
            oldest_high_critical_days: r.dependabot?.oldest_high_critical_days ?? null,
            open_total: r.dependabot?.open_total ?? null,
        }));
        const visible = rows.filter(r => r.alerts_accessible);
        const evidence = {
            repos: rows,
            repos_monitored: rows.length,
            repos_with_alert_access: visible.length,
            fetched_at: snaps[0].fetched_at,
        };

        if (!visible.length) {
            return {
                status: 'fail',
                evidence,
                details: 'Dependabot alerts are not readable on any monitored repository — vulnerabilities in dependencies are invisible. Enable Dependabot alerts and grant the token access.',
            };
        }

        let critical = 0;
        let high = 0;
        let backlog = 0;
        let oldestHighCrit = null;
        for (const r of visible) {
            const b = r.by_severity || {};
            critical += b.critical || 0;
            high += b.high || 0;
            backlog += (b.medium || 0) + (b.low || 0);
            if (r.oldest_high_critical_days !== null
                && (oldestHighCrit === null || r.oldest_high_critical_days > oldestHighCrit)) {
                oldestHighCrit = r.oldest_high_critical_days;
            }
        }
        const critHigh = critical + high;
        evidence.open_critical = critical;
        evidence.open_high = high;
        evidence.open_medium_low = backlog;
        evidence.oldest_high_critical_days = oldestHighCrit;
        const hidden = rows.filter(r => !r.alerts_accessible).map(r => r.repo);
        const truncated = repos.filter(r => r.dependabot?.truncated).map(r => r.repo);
        evidence.repos_without_alert_access = hidden;
        evidence.alerts_truncated = truncated;

        if (critHigh > 0 && oldestHighCrit !== null && oldestHighCrit > STALE_DAYS) {
            return {
                status: 'fail',
                evidence,
                details: `${critHigh} open critical/high alert(s), the oldest open for ${oldestHighCrit} days — beyond the ${STALE_DAYS}-day remediation window.`,
            };
        }
        if (critHigh > 0) {
            return {
                status: 'warn',
                evidence,
                details: `${critHigh} open critical/high alert(s), all younger than ${STALE_DAYS} days — fix them before they age out of the window.`,
            };
        }
        if (backlog > BACKLOG_WARN) {
            return {
                status: 'warn',
                evidence,
                details: `No open critical/high alerts, but ${backlog} medium/low alerts are open (threshold ${BACKLOG_WARN}) — schedule a clean-up.`,
            };
        }
        if (hidden.length || truncated.length) {
            const gaps = [
                hidden.length && `Dependabot alerts are not readable on ${hidden.join(', ')}`,
                truncated.length && `only the first 100 open alerts were read on ${truncated.join(', ')}`,
            ].filter(Boolean).join('; ');
            return {
                status: 'warn',
                evidence,
                details: `${gaps} — no open critical/high alert among what could be read, but the result covers only part of the estate.`,
            };
        }
        return {
            status: 'pass',
            evidence,
            details: `No open critical/high Dependabot alerts across ${visible.length} repository(ies); ${backlog} medium/low open.`,
        };
    },
};
