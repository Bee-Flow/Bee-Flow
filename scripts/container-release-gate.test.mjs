import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectContainer, debianStillUnfixed } from './container-release-gate.mjs';
const image = `ghcr.io/bee-flow/guard@sha256:${'a'.repeat(64)}`;
const report = { SchemaVersion: 2, ArtifactName: image, Results: [{ Vulnerabilities: [{ Severity: 'HIGH', VulnerabilityID: 'CVE-2026-1', PkgName: 'mount' }] }] };
const entry = { id: 'CVE-2026-1', images: ['guard'], packages: ['mount'], debianTracker: { source: 'util-linux', release: 'trixie' },
    expires: '2099-01-01', reviewedAt: '2026-10-28', reason: 'No fixed trixie build', reachability: 'mount is removed from the image' };
const tracker = trixie => ({ 'util-linux': { 'CVE-2026-1': { releases: { trixie } } } });
const noDsa = { status: 'open', urgency: 'not yet assigned', nodsa: 'Minor issue', nodsa_reason: '' };

test('a Debian-tracked exception holds while trixie has no fix and no DSA', () => {
    for (const trixie of [noDsa, { status: 'open', nodsa: 'Minor issue; wait for upstream', nodsa_reason: 'postponed' }, { status: 'open', nodsa_reason: 'ignored' }]) {
        assert.equal(debianStillUnfixed(tracker(trixie), entry), true);
        assert.deepEqual(inspectContainer(report, image, [entry], undefined, { debianTracker: tracker(trixie) }), { total: 1, unreviewed: 0, fixedUpstream: [] });
    }
});
test('a Debian fix or a planned DSA ends the exception before its expiry date', () => {
    for (const trixie of [{ status: 'resolved', fixed_version: '2.41.6-0+deb13u1' }, { ...noDsa, fixed_version: '2.41.6-0+deb13u1' }, { status: 'open', urgency: 'high' }]) {
        assert.deepEqual(inspectContainer(report, image, [entry], undefined, { debianTracker: tracker(trixie) }), { total: 1, unreviewed: 1, fixedUpstream: ['CVE-2026-1'] });
    }
});
test('without tracker data, or for a CVE the tracker does not know, a tracked exception does not hold', () => {
    assert.equal(inspectContainer(report, image, [entry]).unreviewed, 1);
    assert.equal(inspectContainer(report, image, [entry], undefined, { debianTracker: {} }).unreviewed, 1);
    assert.equal(inspectContainer(report, image, [{ ...entry, debianTracker: { source: 'util-linux' } }], undefined, { debianTracker: tracker(noDsa) }).unreviewed, 1);
});
test('the tracker never extends an exception past its expiry or outside its scope', () => {
    const debianTracker = tracker(noDsa);
    assert.equal(inspectContainer(report, image, [{ ...entry, expires: '2000-01-01' }], undefined, { debianTracker }).unreviewed, 1);
    assert.equal(inspectContainer(report, image, [{ ...entry, images: ['server'] }], undefined, { debianTracker }).unreviewed, 1);
    assert.equal(inspectContainer(report, image, [{ ...entry, packages: ['login'] }], undefined, { debianTracker }).unreviewed, 1);
});
test('an exception without debianTracker ignores the tracker', () => {
    const { debianTracker: _unused, ...plain } = entry;
    assert.equal(inspectContainer(report, image, [plain]).unreviewed, 0);
    assert.deepEqual(inspectContainer(report, image, [plain], undefined, { debianTracker: tracker({ status: 'resolved', fixed_version: '1' }) }).fixedUpstream, []);
});
