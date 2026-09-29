/**
 * ISO 27001 A.8.28 — secure coding: secret scanning and push protection from
 * the github connector snapshots. This check never fails outright — GitHub
 * only exposes security_and_analysis to sufficiently privileged tokens, so
 * "off" and "unknown" both downgrade to warn rather than pretending certainty.
 * Pass requires both features enabled on every monitored repository.
 */

const isoEvidenceStore = require('../../../stores/isoEvidenceStore');

module.exports = {
    id: 'ISO27001-A.8.28-secure-coding',
    regulation: 'ISO27001',
    article: 'A.8.28',
    controls: ['A.8.28'],
    frameworks: [{ regulation: 'NIS2', ref: 'Art. 21(2)(e)' }, { regulation: 'CRA', ref: 'Annex I Part I' }],
    severity: 'medium',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.iso_secure_coding.title',
    descriptionKey: 'compliance.checks.iso_secure_coding.desc',
    remediationKey: 'compliance.checks.iso_secure_coding.fix',
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
            accessible: r.accessible !== false,
            known: r.security_and_analysis?.known === true,
            secret_scanning: r.security_and_analysis?.secret_scanning || null,
            push_protection: r.security_and_analysis?.push_protection || null,
        }));
        const gaps = rows.filter(r => !r.accessible || !r.known
            || r.secret_scanning !== 'enabled' || r.push_protection !== 'enabled');
        const evidence = {
            repos: rows,
            repos_monitored: rows.length,
            repos_with_gaps: gaps.map(r => r.repo),
            fetched_at: snaps[0].fetched_at,
        };

        if (gaps.length) {
            const named = gaps.map(r => {
                if (!r.accessible) return `${r.repo} (not readable)`;
                if (!r.known) return `${r.repo} (status not visible to the token)`;
                const off = [
                    r.secret_scanning !== 'enabled' && 'secret scanning',
                    r.push_protection !== 'enabled' && 'push protection',
                ].filter(Boolean).join(' + ');
                return `${r.repo} (${off} off)`;
            }).join(', ');
            return {
                status: 'warn',
                evidence,
                details: `Secret scanning or push protection not confirmed on: ${named}.`,
            };
        }
        return {
            status: 'pass',
            evidence,
            details: `Secret scanning and push protection enabled on all ${rows.length} monitored repository(ies).`,
        };
    },
};
