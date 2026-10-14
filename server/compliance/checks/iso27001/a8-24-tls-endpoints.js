/**
 * ISO 27001 A.8.24 — TLS on public endpoints: certificate validity/expiry and
 * protocol version from the tls-endpoints connector snapshots. Complements the
 * architecture-level cryptography check (a8-24-cryptography) with the
 * operating-effectiveness side an auditor can verify from outside.
 */

const { readConnectorSnapshots, noSnapshotYet } = require('../lib/connectorSnapshots');

const MIN_DAYS_WARN = 30;

module.exports = {
    id: 'ISO27001-A.8.24-tls-endpoints',
    regulation: 'ISO27001',
    article: 'A.8.24',
    controls: ['A.8.24'],
    frameworks: [{ regulation: 'NIS2', ref: 'Art. 21(2)(h)' }],
    severity: 'high',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.iso_tls_endpoints.title',
    descriptionKey: 'compliance.checks.iso_tls_endpoints.desc',
    remediationKey: 'compliance.checks.iso_tls_endpoints.fix',
    remediationLink: 'admin/compliance/iso_connectors',

    async evaluate(orgId) {
        const read = await readConnectorSnapshots(orgId, 'tls-endpoints', 'TLS-endpoint connector not enabled — list your public endpoints under ISO 27001 → Connectors.');
        if (read.result) return read.result;
        const { snaps } = read;
        const probed = snaps.filter(s => !s.payload?.skipped);
        if (!probed.length) return noSnapshotYet('tls-endpoints', 'Connector enabled but no endpoints probed yet — add endpoints or run a sweep.', { endpoints: 0 });
        const rows = probed.map(s => ({
            host: s.payload.host,
            reachable: !!s.payload.reachable,
            protocol: s.payload.protocol || null,
            days_remaining: s.payload.days_remaining ?? null,
            authorized: s.payload.authorized ?? null,
        }));
        const expired = rows.filter(r => r.reachable && r.days_remaining !== null && r.days_remaining < 0);
        const unreachable = rows.filter(r => !r.reachable);
        const expiring = rows.filter(r => r.reachable && r.days_remaining !== null && r.days_remaining >= 0 && r.days_remaining < MIN_DAYS_WARN);
        const oldProtocol = rows.filter(r => r.reachable && r.protocol && !/TLSv1\.[23]/.test(r.protocol));
        const untrusted = rows.filter(r => r.reachable && r.authorized === false);
        const evidence = { endpoints: rows, expired: expired.length, expiring_soon: expiring.length, unreachable: unreachable.length };

        if (expired.length || unreachable.length) {
            const parts = [
                expired.length && `expired certificate on ${expired.map(r => r.host).join(', ')}`,
                unreachable.length && `unreachable: ${unreachable.map(r => r.host).join(', ')}`,
            ].filter(Boolean).join('; ');
            return { status: 'fail', evidence, details: `TLS problems — ${parts}.` };
        }
        if (expiring.length || oldProtocol.length || untrusted.length) {
            const parts = [
                expiring.length && `certificate expiring within ${MIN_DAYS_WARN} days on ${expiring.map(r => r.host).join(', ')}`,
                oldProtocol.length && `legacy protocol on ${oldProtocol.map(r => `${r.host} (${r.protocol})`).join(', ')}`,
                untrusted.length && `untrusted chain on ${untrusted.map(r => r.host).join(', ')}`,
            ].filter(Boolean).join('; ');
            return { status: 'warn', evidence, details: `TLS attention needed — ${parts}.` };
        }
        return {
            status: 'pass',
            evidence,
            details: `${rows.length} endpoint(s) serve valid TLS ≥1.2 certificates with ≥${MIN_DAYS_WARN} days validity.`,
        };
    },
};
