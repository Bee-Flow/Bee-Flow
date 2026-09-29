/**
 * ISO 27001 A.8.20 — network security: no Scaleway security group may open
 * an admin port (22 SSH, 5432 PostgreSQL, 6379 Redis, 3306 MySQL) to the
 * whole internet. Web ports 80/443 open to 0.0.0.0/0 are normal and never
 * flagged. Groups whose default inbound policy is "accept" get a warn —
 * admin ports are then reachable unless a rule explicitly drops them.
 */

const isoEvidenceStore = require('../../../stores/isoEvidenceStore');

module.exports = {
    id: 'ISO27001-A.8.20-network-exposure',
    regulation: 'ISO27001',
    article: 'A.8.20',
    controls: ['A.8.20', 'A.8.22'],
    frameworks: [{ regulation: 'NIS2', ref: 'Art. 21(2)(e)' }, { regulation: 'CRA', ref: 'Annex I Part I' }],
    severity: 'high',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.iso_network_exposure.title',
    descriptionKey: 'compliance.checks.iso_network_exposure.desc',
    remediationKey: 'compliance.checks.iso_network_exposure.fix',
    remediationLink: 'admin/compliance/iso_connectors',

    async evaluate(orgId) {
        const config = await isoEvidenceStore.getConfig(orgId, 'scaleway').catch(() => null);
        if (!config?.enabled) {
            return {
                status: 'not_applicable',
                evidence: { connector: 'scaleway', enabled: false },
                details: 'Scaleway connector not enabled — link a read-only API key under ISO 27001 → Connectors to collect firewall evidence.',
            };
        }
        const snaps = await isoEvidenceStore.listLatestSnapshots(orgId, 'scaleway').catch(() => []);
        if (!snaps.length) {
            return {
                status: 'warn',
                evidence: { connector: 'scaleway', enabled: true, snapshots: 0 },
                details: 'Connector enabled but no snapshot yet — run a sweep or check the API key and region.',
            };
        }
        const summary = snaps.find(s => s.subject_id === 'summary');
        if (!summary) {
            return {
                status: 'warn',
                evidence: { connector: 'scaleway', enabled: true, summary: false },
                details: 'No summary snapshot found for the Scaleway connector — re-run the sweep.',
            };
        }
        const p = summary.payload || {};
        const groups = Number(p.security_groups) || 0;
        const open = Number(p.open_admin_ports) || 0;
        const samples = Array.isArray(p.open_admin_port_samples) ? p.open_admin_port_samples : [];
        const defaultAccept = Number(p.inbound_default_accept_groups) || 0;
        const evidence = {
            region: p.region || null,
            security_groups: groups,
            open_admin_ports: open,
            open_admin_port_samples: samples,
            inbound_default_accept_groups: defaultAccept,
            fetched_at: summary.fetched_at,
        };
        if (open > 0) {
            const ports = [...new Set(samples.map(s => s?.port).filter(Boolean))].join(', ');
            return {
                status: 'fail',
                evidence,
                details: `${open} firewall rule(s) expose admin ports${ports ? ` (${ports})` : ''} to the whole internet — restrict SSH and database ports to known addresses.`,
            };
        }
        if (defaultAccept > 0) {
            return {
                status: 'warn',
                evidence,
                details: `${defaultAccept} security group(s) accept all inbound traffic by default — admin ports are reachable unless a rule explicitly blocks them. Set the default inbound policy to drop.`,
            };
        }
        return {
            status: 'pass',
            evidence,
            details: groups === 0
                ? `No instance security groups exist in ${p.region || 'the configured region'} — nothing exposes an admin port.`
                : `No security group opens an admin port (22, 5432, 6379, 3306) to 0.0.0.0/0 across ${groups} group(s).`,
        };
    },
};
