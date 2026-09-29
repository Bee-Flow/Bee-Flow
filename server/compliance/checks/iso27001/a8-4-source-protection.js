/**
 * ISO 27001 A.8.4 — access to source code: default-branch protection from the
 * github connector snapshots. An unprotected default branch on any monitored
 * repository fails the control; protection without required reviews, with
 * force pushes allowed, or a repository the token cannot see is a warning.
 * Note the connector's honest caveat: GitHub answers 404 on the protection
 * endpoint both for "not protected" and "no admin read" — either way the
 * control cannot be shown effective, so protected:false fails.
 */

const isoEvidenceStore = require('../../../stores/isoEvidenceStore');

module.exports = {
    id: 'ISO27001-A.8.4-source-protection',
    regulation: 'ISO27001',
    article: 'A.8.4',
    controls: ['A.8.4', 'A.8.31'],
    frameworks: [{ regulation: 'NIS2', ref: 'Art. 21(2)(e)' }, { regulation: 'CRA', ref: 'Annex I Part I' }],
    severity: 'high',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.iso_source_protection.title',
    descriptionKey: 'compliance.checks.iso_source_protection.desc',
    remediationKey: 'compliance.checks.iso_source_protection.fix',
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
            default_branch: r.default_branch || null,
            protected: r.branch_protection?.protected === true,
            required_reviews: r.branch_protection?.required_reviews ?? null,
            enforce_admins: r.branch_protection?.enforce_admins ?? null,
            allow_force_pushes: r.branch_protection?.allow_force_pushes ?? null,
        }));
        const unreadable = rows.filter(r => !r.accessible);
        const readable = rows.filter(r => r.accessible);
        const unprotected = readable.filter(r => !r.protected);
        const weak = readable.filter(r => r.protected
            && ((r.required_reviews || 0) < 1 || r.allow_force_pushes === true));
        const evidence = {
            repos: rows,
            repos_monitored: rows.length,
            unprotected: unprotected.map(r => r.repo),
            weak_protection: weak.map(r => r.repo),
            unreadable: unreadable.map(r => r.repo),
            fetched_at: snaps[0].fetched_at,
        };

        if (unprotected.length) {
            return {
                status: 'fail',
                evidence,
                details: `Default branch unprotected (or protection not verifiable) on: ${unprotected.map(r => r.repo).join(', ')}.`,
            };
        }
        if (weak.length || unreadable.length) {
            const parts = [
                weak.length && `protection without required reviews or with force pushes allowed on ${weak.map(r => r.repo).join(', ')}`,
                unreadable.length && `repository not readable with the linked token: ${unreadable.map(r => r.repo).join(', ')}`,
            ].filter(Boolean).join('; ');
            return { status: 'warn', evidence, details: `Branch protection incomplete — ${parts}.` };
        }
        return {
            status: 'pass',
            evidence,
            details: `Default branch protected with required reviews and no force pushes on all ${readable.length} repository(ies).`,
        };
    },
};
