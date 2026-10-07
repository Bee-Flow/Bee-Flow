/**
 * ISO 27001 A.8.13 — information backup: every Scaleway server must have a
 * recent snapshot. Reads the scaleway connector's summary snapshot;
 * `newest_backup_age_days` is the WORST per-server freshness (the stalest
 * "newest snapshot" among servers that have one), coverage gaps are
 * servers_with_backup vs servers. Honest warn when the org runs no compute
 * instances — the connector is then evidence-only, not proof of backups.
 */

const isoEvidenceStore = require('../../../stores/isoEvidenceStore');

const FAIL_AGE_DAYS = 7;
const PASS_AGE_DAYS = 3;

module.exports = {
    id: 'ISO27001-A.8.13-backups',
    regulation: 'ISO27001',
    article: 'A.8.13',
    controls: ['A.8.13', 'A.8.14'],
    frameworks: [{ regulation: 'NIS2', ref: 'Art. 21(2)(c)' }],
    severity: 'high',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.iso_backups.title',
    descriptionKey: 'compliance.checks.iso_backups.desc',
    remediationKey: 'compliance.checks.iso_backups.fix',
    remediationLink: 'admin/compliance/iso_connectors',

    async evaluate(orgId) {
        const config = await isoEvidenceStore.getConfig(orgId, 'scaleway').catch(() => null);
        if (!config?.enabled) {
            return {
                status: 'not_applicable',
                evidence: { connector: 'scaleway', enabled: false },
                details: 'Scaleway connector not enabled — link a read-only API key under ISO 27001 → Connectors to collect backup evidence.',
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
        const servers = Number(p.servers) || 0;
        const clusters = (p.clusters === null || p.clusters === undefined) ? null : Number(p.clusters);
        const withBackup = Number(p.servers_with_backup) || 0;
        const age = (p.newest_backup_age_days === null || p.newest_backup_age_days === undefined)
            ? null
            : Number(p.newest_backup_age_days);
        const evidence = {
            region: p.region || null,
            servers,
            clusters,
            servers_with_backup: withBackup,
            newest_backup_age_days: age,
            snapshots: Number(p.snapshots) || 0,
            // The connector reads at most 300 servers or snapshots per zone.
            truncated: !!p.truncated,
            fetched_at: summary.fetched_at,
        };
        if (servers === 0) {
            const clusterNote = clusters ? ` (${clusters} Kubernetes cluster(s) present)` : '';
            return {
                status: 'warn',
                evidence,
                details: `No compute instances found in ${p.region || 'the configured region'}${clusterNote} — instance backup evidence is not assessable. If all workloads run on managed services, document their backup arrangements instead.`,
            };
        }
        if (withBackup === 0) {
            return {
                status: 'fail',
                evidence,
                details: `${servers} server(s) run in ${p.region} but no snapshots exist — a disk failure means data loss.`,
            };
        }
        if (age === null) {
            return {
                status: 'warn',
                evidence,
                details: 'Snapshot ages could not be determined from the latest sweep — re-run the sweep.',
            };
        }
        if (age > FAIL_AGE_DAYS) {
            return {
                status: 'fail',
                evidence,
                details: `The stalest server backup is ${age} days old (limit ${FAIL_AGE_DAYS}) — snapshot schedules are not keeping up.`,
            };
        }
        const partial = withBackup < servers;
        if (partial || age > PASS_AGE_DAYS) {
            const parts = [
                partial && `${servers - withBackup} of ${servers} server(s) have no snapshot at all`,
                age > PASS_AGE_DAYS && `the stalest server backup is ${age} days old`,
            ].filter(Boolean).join('; ');
            return { status: 'warn', evidence, details: `Backup coverage needs attention — ${parts}.` };
        }
        // Servers or snapshots the sweep never saw could change the verdict.
        if (p.truncated) {
            return {
                status: 'warn',
                evidence,
                details: 'More than 300 servers or snapshots in a zone: only the first 300 were read, so backup coverage is partial.',
            };
        }
        return {
            status: 'pass',
            evidence,
            details: `All ${servers} server(s) in ${p.region} have a snapshot at most ${age} day(s) old.`,
        };
    },
};
