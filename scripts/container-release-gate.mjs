import fs from 'node:fs';
import { isEntryPoint } from './entry-point.mjs';
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function inspectContainer(report, image, exceptions = [], today = new Date().toISOString().slice(0, 10), { runtimeVerified = false } = {}) {
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
        && validDate(entry.expires) && entry.expires >= today
        && validDate(entry.reviewedAt) && entry.reviewedAt <= today
        && typeof entry.reason === 'string' && entry.reason.trim() && typeof entry.reachability === 'string' && entry.reachability.trim()));
    return { total: findings.length, unreviewed: unreviewed.length };
}
function main() {
    const [file, image] = process.argv.slice(2);
    const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
    const exceptions = [...read('.github/security/container-exceptions.json').accepted, ...(read('.github/security/audit-baseline.json').accepted || [])];
    const result = inspectContainer(read(file), image, exceptions, undefined, { runtimeVerified: process.env.CONTAINER_RUNTIME_VERIFIED === 'true' });
    console.log(`Container release gate: ${result.total} high/critical findings, ${result.unreviewed} without a valid reachability review`);
    if (result.unreviewed) process.exitCode = 1;
}
if (isEntryPoint(import.meta.url)) main();
