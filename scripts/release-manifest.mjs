import fs from 'node:fs';
import { isEntryPoint } from './entry-point.mjs';

export const SERVICE_IMAGES = Object.freeze({ server: 'server', 'agent-hub': 'agent-hub', 'search-api': 'search-api', 'search-gpu': 'search-inference-gpu',
    guard: 'guard', pii: 'pii', classify: 'classify', whisperx: 'whisperx', wizard: 'install-wizard', reranker: 'reranker', 'pwt-runner': 'pwt-runner', connector: 'connector' });
export const STAGING_CHECKS = Object.freeze(['existingInstallationUpgrade','cleanInstallation','microsoftLogin','administratorLink','unauthorizedLinkRefused',
    'organizationSyncIsolation','explicitMultiOrganizationMembership','secretRotation','migrationRepeatability','backupRestore','dockerHostPatched','nextcloudHarpCompatibility','applicationAzureModelCalls','azureLiveRequests']);
// Character checks rather than regexes: these read workflow input, and a loop has nothing to backtrack.
const HEX = new Set('0123456789abcdef');
const isHex = (s, len) => typeof s === 'string' && s.length === len && [...s].every((c) => HEX.has(c));
const isDigest = (s) => typeof s === 'string' && s.startsWith('sha256:') && isHex(s.slice(7), 64);
const isRunNumber = (v) => { const s = String(v); return s.length > 0 && s[0] !== '0' && [...s].every((c) => c >= '0' && c <= '9'); };
export function validateCandidate(candidate, { security = true } = {}) {
    if (candidate?.schema !== 1 || !isRunNumber(candidate.runId) || !isRunNumber(candidate.runAttempt) || !isHex(candidate.commit || '', 40)) throw new Error('Invalid release candidate provenance');
    if (!Number.isFinite(Date.parse(candidate.createdAt)) || !candidate.images || !Object.keys(candidate.images).length) throw new Error('Empty or invalid release candidate');
    for (const [service, entry] of Object.entries(candidate.images)) {
        if (!Object.hasOwn(SERVICE_IMAGES, service) || entry.image !== `ghcr.io/bee-flow/${SERVICE_IMAGES[service]}` || !isDigest(entry.digest || '')) throw new Error(`Invalid immutable image for ${service}`);
    }
    if (security && ['dependencies','secrets','containers'].some(check => candidate.security?.[check] !== 'passed')) throw new Error('Mandatory release security checks have not passed');
    return candidate;
}
export function verifyStaging(candidate, report, now = Date.now()) {
    validateCandidate(candidate);
    if (report?.schema !== 1 || String(report.candidateRunId) !== String(candidate.runId)
        || String(report.candidateRunAttempt) !== String(candidate.runAttempt) || report.commit !== candidate.commit) throw new Error('Staging report belongs to a different candidate');
    const checkedAt = Date.parse(report.checkedAt);
    if (!Number.isFinite(checkedAt) || checkedAt < Date.parse(candidate.createdAt) || checkedAt > now || now - checkedAt > 7 * 86400000) throw new Error('Staging report is expired or predates the candidate');
    if (typeof report.checkedBy !== 'string' || !report.checkedBy.trim() || !/^https:\/\//.test(report.evidenceUrl || '')) throw new Error('Staging acceptance needs a reviewer and evidence URL');
    if (STAGING_CHECKS.some(check => report.checks?.[check] !== true)) throw new Error('Staging acceptance is incomplete');
    if (JSON.stringify(Object.entries(report.images || {}).sort()) !== JSON.stringify(Object.entries(candidate.images).sort())) throw new Error('Staging did not validate these exact image digests');
    return report;
}
export function makeCandidate(results, env) {
    const images = {};
    for (const [service, image] of Object.entries(SERVICE_IMAGES)) {
        const digest = results[service]?.outputs?.digest;
        if (digest) images[service] = { image: `ghcr.io/bee-flow/${image}`, digest };
    }
    return validateCandidate({ schema: 1, runId: String(env.GITHUB_RUN_ID), runAttempt: String(env.GITHUB_RUN_ATTEMPT),
        commit: env.GITHUB_SHA, createdAt: new Date().toISOString(), images }, { security: false });
}
function main() {
    const [command, input, output, third] = process.argv.slice(2);
    const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
    const write = (file, data) => fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
    if (command === 'build') {
        const candidate = makeCandidate(JSON.parse(process.env.BUILD_RESULTS), process.env);
        write(input, candidate);
        if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(Object.entries(candidate.images).map(([service, entry]) => ({ service, ref: `${entry.image}@${entry.digest}` })))}\n`);
    } else if (command === 'finalize') {
        const candidate = read(input);
        validateCandidate(candidate, { security: false });
        candidate.security = { dependencies: 'passed', secrets: 'passed', containers: 'passed' };
        write(output, validateCandidate(candidate));
    } else if (command === 'staging') {
        const candidate = validateCandidate(read(input));
        const manual = read(output);
        if (manual.checks?.azureLiveRequests !== true) throw new Error('Azure live smoke test must pass before staging acceptance');
        if (JSON.stringify(Object.entries(manual.images || {}).sort()) !== JSON.stringify(Object.entries(candidate.images).sort())) throw new Error('Manual staging acceptance must record the deployed image digests');
        const report = { ...manual, schema: 1, candidateRunId: candidate.runId, candidateRunAttempt: candidate.runAttempt, commit: candidate.commit, images: candidate.images };
        verifyStaging(candidate, report); write(third, report);
    } else if (command === 'verify') {
        const candidate = validateCandidate(read(input));
        verifyStaging(candidate, read(output));
        if (third) write(third, candidate);
        for (const { image, digest } of Object.values(candidate.images)) console.log(`${image}@${digest}`);
    } else if (command === 'validate') validateCandidate(read(input));
    else throw new Error('Usage: release-manifest.mjs build|finalize|staging|verify|validate <files>');
}
if (isEntryPoint(import.meta.url)) main();
