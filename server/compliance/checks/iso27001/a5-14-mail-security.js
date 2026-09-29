/**
 * ISO 27001 A.5.14 — mail security (SPF/DMARC/DKIM) for the org's domain.
 * Reads the latest mail-security connector snapshot; not applicable until the
 * connector is enabled and has swept. DKIM absence alone never fails the check
 * (selectors are not discoverable — see the connector's honest caveat).
 */

const isoEvidenceStore = require('../../../stores/isoEvidenceStore');

module.exports = {
    id: 'ISO27001-A.5.14-mail-security',
    regulation: 'ISO27001',
    article: 'A.5.14',
    controls: ['A.5.14', 'A.8.26'],
    frameworks: [{ regulation: 'NIS2', ref: 'Art. 21(2)(j)' }],
    severity: 'medium',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.iso_mail_security.title',
    descriptionKey: 'compliance.checks.iso_mail_security.desc',
    remediationKey: 'compliance.checks.iso_mail_security.fix',
    remediationLink: 'admin/compliance/iso_connectors',

    async evaluate(orgId) {
        const config = await isoEvidenceStore.getConfig(orgId, 'mail-security').catch(() => null);
        if (!config?.enabled) {
            return {
                status: 'not_applicable',
                evidence: { connector: 'mail-security', enabled: false },
                details: 'Mail-security connector not enabled — enable it under ISO 27001 → Connectors and set your sending domain.',
            };
        }
        const snaps = await isoEvidenceStore.listLatestSnapshots(orgId, 'mail-security').catch(() => []);
        if (!snaps.length) {
            return {
                status: 'warn',
                evidence: { connector: 'mail-security', enabled: true, snapshots: 0 },
                details: 'Connector enabled but no snapshot yet — run a sweep or check the configured domain.',
            };
        }
        const p = snaps[0].payload || {};
        const spf = !!p.spf?.present;
        const dmarc = !!p.dmarc?.present;
        const dmarcEnforcing = dmarc && ['quarantine', 'reject'].includes(p.dmarc?.policy);
        const dkimFound = (p.dkim?.found_selectors || []).length > 0;
        const evidence = {
            domain: p.domain,
            spf_present: spf,
            dmarc_present: dmarc,
            dmarc_policy: p.dmarc?.policy || null,
            dkim_selectors_found: p.dkim?.found_selectors || [],
            fetched_at: snaps[0].fetched_at,
        };
        if (!spf && !dmarc) {
            return { status: 'fail', evidence, details: `Neither SPF nor DMARC found for ${p.domain} — anyone can spoof mail from this domain.` };
        }
        if (!spf || !dmarc || !dmarcEnforcing || !dkimFound) {
            const gaps = [
                !spf && 'SPF missing',
                !dmarc && 'DMARC missing',
                dmarc && !dmarcEnforcing && `DMARC policy is "${p.dmarc?.policy}" (not enforcing)`,
                !dkimFound && 'DKIM not found under probed selectors',
            ].filter(Boolean).join('; ');
            return { status: 'warn', evidence, details: `Mail authentication incomplete for ${p.domain}: ${gaps}.` };
        }
        return { status: 'pass', evidence, details: `SPF, enforcing DMARC (${p.dmarc.policy}) and DKIM present for ${p.domain}.` };
    },
};
