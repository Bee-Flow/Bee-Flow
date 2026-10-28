import fs from 'node:fs';
import { isEntryPoint } from './entry-point.mjs';
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

// An exception with `debianTracker: { source, release }` holds only while the Debian security
// tracker (https://security-tracker.debian.org/tracker/data/json) still lists the CVE as open in
// that release without a fix and without a DSA (no-dsa, postponed or ignored). The moment Debian
// ships a fix the exception stops counting, so the gate turns red and the image gets rebuilt
// instead of waiting for the expiry date. No tracker data means the exception does not hold.
export function debianStillUnfixed(tracker, entry) {
    const { source, release } = entry.debianTracker || {};
    const status = typeof source === 'string' && typeof release === 'string' ? tracker?.[source]?.[entry.id]?.releases?.[release] : undefined;
    return status?.status === 'open' && !status.fixed_version
        && (Boolean(status.nodsa) || ['postponed', 'ignored'].includes(status.nodsa_reason));
}

export function inspectContainer(report, image, exceptions = [], today = new Date().toISOString().slice(0, 10), { runtimeVerified = false, debianTracker = null } = {}) {
    if (report?.SchemaVersion !== 2 || !Array.isArray(report.Results) || report.ArtifactName !== image || !/@sha256:[0-9a-f]{64}$/.test(image)) throw new Error('Invalid or incomplete immutable container scan');
    const findings = report.Results.flatMap(result => (result.Vulnerabilities || []).filter(v => ['HIGH','CRITICAL'].includes(v.Severity)).map(v => ({ ...v, scanTarget: result.Target })));
    const service = image.split('@')[0].split('/').at(-1);
    const unreviewed = findings.filter(finding => !exceptions.some(entry => entry.id === finding.VulnerabilityID
        && entry.images?.includes(service) && (!entry.package || entry.package === finding.PkgName)
        && (!entry.packages || entry.packages.includes(finding.PkgName))
        && (!entry.versions || entry.versions.includes(finding.InstalledVersion))
        && (!entry.pathPrefix || finding.PkgPath?.startsWith(entry.pathPrefix))
        && (!entry.scanTarget || finding.scanTarget === entry.scanTarget)
        && (!entry.requiredUser || report.Metadata?.ImageConfig?.config?.User === entry.requiredUser)
        && (!entry.runtimeCheck || runtimeVerified)
        && (!entry.debianTracker || debianStillUnfixed(debianTracker, entry))
        && validDate(entry.expires) && entry.expires >= today
        && validDate(entry.reviewedAt) && entry.reviewedAt <= today
        && typeof entry.reason === 'string' && entry.reason.trim() && typeof entry.reachability === 'string' && entry.reachability.trim()));
    // Exception ids are public (they are in this repo), so naming the ones Debian has fixed leaks nothing.
    const fixedUpstream = [...new Set(exceptions.filter(entry => entry.debianTracker && entry.images?.includes(service)
        && findings.some(f => f.VulnerabilityID === entry.id) && !debianStillUnfixed(debianTracker, entry)).map(entry => entry.id))];
    return { total: findings.length, unreviewed: unreviewed.length, fixedUpstream };
}
function main() {
    const [file, image] = process.argv.slice(2);
    const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
    const exceptions = [...read('.github/security/container-exceptions.json').accepted, ...(read('.github/security/audit-baseline.json').accepted || [])];
    const trackerFile = process.env.DEBIAN_TRACKER_JSON;
    const debianTracker = trackerFile && fs.existsSync(trackerFile) ? read(trackerFile) : null;
    if (!debianTracker) console.log('Debian security tracker data unavailable: Debian-tracked exceptions do not hold');
    const result = inspectContainer(read(file), image, exceptions, undefined, { runtimeVerified: process.env.CONTAINER_RUNTIME_VERIFIED === 'true', debianTracker });
    if (debianTracker && result.fixedUpstream.length) console.log(`Debian now lists a fix or a DSA for: ${result.fixedUpstream.join(', ')}; rebuild on the fixed packages and drop the exception`);
    console.log(`Container release gate: ${result.total} high/critical findings, ${result.unreviewed} without a valid reachability review`);
    if (result.unreviewed) process.exitCode = 1;
}
if (isEntryPoint(import.meta.url)) main();
