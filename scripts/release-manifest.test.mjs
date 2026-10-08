import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCandidate, validateCandidate, verifyStaging, STAGING_CHECKS } from './release-manifest.mjs';
import { inspectContainer } from './container-release-gate.mjs';
const digest = `sha256:${'a'.repeat(64)}`;
const candidate = { ...makeCandidate({ server: { outputs: { digest } } }, { GITHUB_SHA: 'b'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' }), security: { dependencies: 'passed', secrets: 'passed', containers: 'passed' } };
const staging = { schema: 1, candidateRunId: '123', candidateRunAttempt: '1', commit: candidate.commit, images: candidate.images, checkedBy: 'release reviewer', checkedAt: new Date().toISOString(),
    evidenceUrl: 'https://github.com/Bee-Flow/Bee-Flow/actions/runs/456', checks: Object.fromEntries(STAGING_CHECKS.map(key => [key,true])) };
test('release requires immutable images and all security checks', () => {
    validateCandidate(candidate);
    assert.throws(() => validateCandidate({ ...candidate, security: { ...candidate.security, containers: 'pending' } }));
    assert.throws(() => validateCandidate({ ...candidate, images: { server: { image: 'ghcr.io/bee-flow/server', digest: 'prod' } } }));
});
test('staging evidence must cover the exact candidate and every acceptance criterion', () => {
    verifyStaging(candidate, staging);
    for (const bad of [{ ...staging, candidateRunAttempt: '2' }, { ...staging, commit: 'c'.repeat(40) }, { ...staging, checkedAt: '2000-01-01' }, { ...staging, images: {} }, { ...staging, checks: { ...staging.checks, microsoftLogin: false } }]) assert.throws(() => verifyStaging(candidate, bad));
    for (const check of STAGING_CHECKS) assert.throws(() => verifyStaging(candidate, { ...staging, checks: { ...staging.checks, [check]: false } }));
});
test('a failed scan, mutable image, unreviewed, expired or differently scoped CVE blocks promotion', () => {
    const image = `ghcr.io/bee-flow/server@${digest}`;
    const report = { SchemaVersion: 2, ArtifactName: image, Results: [{ Vulnerabilities: [{ Severity: 'HIGH', VulnerabilityID: 'CVE-example' }] }] };
    assert.equal(inspectContainer(report,image).unreviewed, 1);
    const entry = { id: 'CVE-example', images: ['server'], expires: '2099-01-01', reviewedAt: '2026-10-08', reason: 'Reviewed exception', reachability: 'Unreachable parser; regression verifies input restriction' };
    assert.equal(inspectContainer(report,image,[entry]).unreviewed, 0);
    assert.equal(inspectContainer(report,image,[{ ...entry, expires: '2000-01-01' }]).unreviewed, 1);
    assert.equal(inspectContainer(report,image,[{ ...entry, images: ['other'] }]).unreviewed, 1);
    assert.throws(() => inspectContainer({},image));
    assert.throws(() => inspectContainer(report,'ghcr.io/bee-flow/server:prod'));
});
test('container reviews require the measured runtime, package, version and code path', () => {
    const image = `ghcr.io/bee-flow/server@${digest}`;
    const finding = { Severity: 'HIGH', VulnerabilityID: 'CVE-example', PkgName: 'library', InstalledVersion: '1.0', PkgPath: 'global-npm/library/package.json' };
    const report = { SchemaVersion: 2, ArtifactName: image, Metadata: { ImageConfig: { config: { User: 'node' } } },
        Results: [{ Target: 'global-npm', Vulnerabilities: [finding] }] };
    const entry = { id: finding.VulnerabilityID, images: ['server'], package: 'library', versions: ['1.0'],
        requiredUser: 'node', runtimeCheck: 'actual-image-check', pathPrefix: 'global-npm/', scanTarget: 'global-npm',
        reviewedAt: '2026-10-08', expires: '2026-11-08', reason: 'Absent entry point', reachability: 'Checked on the image' };
    const check = (r, e, verified = true) => inspectContainer(r, image, [e], '2026-10-08', { runtimeVerified: verified });
    assert.equal(check(report, entry).unreviewed, 0);
    assert.equal(check(report, entry, false).unreviewed, 1);
    for (const patch of [{ package: 'other' }, { versions: ['2.0'] }, { pathPrefix: 'application/' },
        { scanTarget: 'daemon' }, { requiredUser: 'root' }, { expires: '2026-10-07' },
        { expires: '2026-11-31' }, { reviewedAt: '2026-10-09' }]) {
        assert.equal(check(report, { ...entry, ...patch }).unreviewed, 1);
    }
    const root = { ...report, Metadata: { ImageConfig: { config: { User: 'root' } } } };
    assert.equal(check(root, entry).unreviewed, 1);
    assert.equal(check({ ...report, Results: [{ Target: 'global-npm', Vulnerabilities: [{ ...finding, PkgPath: 'app/library/package.json' }] }] }, entry).unreviewed, 1);
});
