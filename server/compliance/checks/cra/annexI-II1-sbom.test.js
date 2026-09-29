/**
 * CRA Annex I II(1) SBOM: relevance gate, nothing found → fail, licence list
 * only → warn, build-sha match → pass, fresh without sha → pass, stale /
 * mismatched / empty → warn, and evidence free of personal data.
 *
 * The locator and the build stamp are stubbed so the verdict never depends
 * on whether THIS checkout happens to carry a sbom/ folder.
 *
 * Run: cd server && node --test --test-force-exit compliance/checks/cra/annexI-II1-sbom.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const D = 86400e3;
const FULL_SHA = 'a3f9c2d1e4b5a6978877665544332211deadbeef';
const state = {
    settings: {},
    located: null,
    locateOpts: null,
};

const SEARCH_ORDER = ['/env/sbom.json', '/app/sbom/cyclonedx.json', '/repo/sbom/cyclonedx.json', '/repo/THIRD-PARTY-LICENSES.md'];

const fakeLocator = {
    async locate(opts) { state.locateOpts = opts; return state.located; },
    candidates() { return SEARCH_ORDER; },
};
const fakeComplianceStore = { async getSettings() { return state.settings; } };
const fakeBuildInfo = { APP_BUILD_SHA: FULL_SHA, buildKey: p => `${p}:b${FULL_SHA}` };
const fakeVersion = { APP_VERSION: '1.4.2', HOST_API_VERSION: 1 };

const restore = installResolveStub({
    '../../../stores/complianceStore': fakeComplianceStore,
    '../../lib/sbomLocator': fakeLocator,
    '../../../utils/buildInfo': fakeBuildInfo,
    '../../../version': fakeVersion,
});
const check = require('./annexI-II1-sbom');
test.after(() => restore());

function located(patch) {
    return {
        path: '/app/sbom/cyclonedx.json',
        format: 'cyclonedx',
        parsed: {
            component_count: 1049, generated_at: new Date(Date.now() - 2 * D).toISOString(),
            version: '1.0.0', name: 'server', build_sha: FULL_SHA, spec_version: '1.5', tool: 'npm cli 10.9.8',
        },
        size: 1234, mtime: new Date().toISOString(), sha256: 'ab'.repeat(32),
        tried: [{ path: '/env/sbom.json', reason: 'not found' }],
        ...patch,
    };
}
function nothing() {
    return { path: null, format: null, parsed: null, size: 0, mtime: null, tried: SEARCH_ORDER.map(p => ({ path: p, reason: 'not found' })) };
}
function noPersonalData(r) {
    const blob = JSON.stringify(r.evidence) + (r.details || '');
    assert.ok(!/@/.test(blob), `no e-mail address in evidence/details: ${blob}`);
}

test.beforeEach(() => {
    state.settings = { framework_relevance: { cra: 'relevant' }, cra_role: 'manufacturer' };
    state.located = located();
    state.locateOpts = null;
});

test('module shape: id, home regulation, PLD + ISO tags, high severity, operator task (no deep-link)', () => {
    assert.equal(check.id, 'CRA-AnnexI-II1-sbom');
    assert.equal(check.regulation, 'CRA');
    assert.equal(check.severity, 'high');
    assert.equal(check.scope, 'global');
    assert.equal(check.verification, 'automated');
    assert.deepEqual(check.frameworks.map(f => f.regulation), ['PLD', 'ISO27001']);
    assert.equal(check.frameworks[1].ref, 'A.5.9');
    assert.equal(check.remediationLink, null);
    assert.equal(check.titleKey, 'compliance.check_cra_sbom_title');
    assert.equal(check.remediationKey, 'compliance.check_cra_sbom_fix');
});

test('relevance gate: CRA marked not relevant → not_applicable, locator never consulted', async () => {
    state.settings = { framework_relevance: { cra: 'not_relevant' } };
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'not_applicable');
    assert.deepEqual(r.evidence, { relevance: 'not_relevant' });
    assert.equal(state.locateOpts, null);
});

test('settings without the new columns (undefined relevance) do not crash and the check runs', async () => {
    state.settings = {};
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'pass');
});

test('nothing found anywhere → fail; details name every searched location and SBOM_PATH', async () => {
    state.located = nothing();
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.found, false);
    assert.deepEqual(r.evidence.search_order, SEARCH_ORDER);
    assert.equal(r.evidence.tried.length, 4);
    assert.match(r.details, /SBOM_PATH/);
    assert.match(r.details, /\/app\/sbom\/cyclonedx\.json/);
    assert.equal(state.locateOpts.hash, true, 'the artefact hash is requested for the evidence row');
    noPersonalData(r);
});

test('only THIRD-PARTY-LICENSES.md (human-readable) → warn', async () => {
    state.located = located({
        path: '/repo/THIRD-PARTY-LICENSES.md', format: 'licenses-md',
        parsed: { component_count: 2210, generated_at: '2026-09-08T00:00:00.000Z', version: null, name: null, build_sha: null, spec_version: null, tool: 'scripts/generate-sbom.sh' },
    });
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.machine_readable, false);
    assert.equal(r.evidence.format, 'licenses-md');
    assert.match(r.details, /human-readable/);
    assert.match(r.details, /CycloneDX or SPDX/);
});

test('CycloneDX whose beeflow:build_sha matches APP_BUILD_SHA → pass (exact and short-prefix forms)', async () => {
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.matches_build, true);
    assert.equal(r.evidence.component_count, 1049);
    assert.equal(r.evidence.app_build_sha, FULL_SHA);
    assert.equal(r.evidence.app_version, '1.4.2');
    assert.equal(r.evidence.sbom_sha256, 'ab'.repeat(32));
    assert.match(r.details, /describes the running build/);
    noPersonalData(r);

    // A short sha in the artefact still matches the full one this process runs.
    state.located = located({ parsed: { ...located().parsed, build_sha: FULL_SHA.slice(0, 12), generated_at: new Date(Date.now() - 200 * D).toISOString() } });
    const r2 = await check.evaluate('org1');
    assert.equal(r2.status, 'pass', 'a stale timestamp does not matter when the sha matches');
    assert.equal(r2.evidence.matches_build, true);
});

test('CycloneDX for ANOTHER build → warn even when it is fresh', async () => {
    state.located = located({ parsed: { ...located().parsed, build_sha: 'f'.repeat(40) } });
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.matches_build, false);
    assert.equal(r.evidence.fresh, true);
    assert.match(r.details, /generated for build ffffffffffff/);
    assert.match(r.details, /runs build a3f9c2d1e4b5/);
});

test('no build-sha property: fresh (≤ 30 d) → pass, stale → warn, no timestamp at all → warn', async () => {
    state.located = located({ parsed: { ...located().parsed, build_sha: null, generated_at: new Date(Date.now() - 29 * D).toISOString() } });
    const fresh = await check.evaluate('org1');
    assert.equal(fresh.status, 'pass');
    assert.equal(fresh.evidence.fresh, true);
    assert.ok(fresh.evidence.age_days >= 28 && fresh.evidence.age_days <= 30);
    assert.match(fresh.details, /freshness is the only available proof/);

    state.located = located({ parsed: { ...located().parsed, build_sha: null, generated_at: new Date(Date.now() - 45 * D).toISOString() } });
    const stale = await check.evaluate('org1');
    assert.equal(stale.status, 'warn');
    assert.equal(stale.evidence.fresh, false);
    assert.match(stale.details, /45 days old/);

    state.located = located({ parsed: { ...located().parsed, build_sha: null, generated_at: null } });
    const undated = await check.evaluate('org1');
    assert.equal(undated.status, 'warn');
    assert.equal(undated.evidence.age_days, null);
    assert.match(undated.details, /neither a generation timestamp nor a build sha/);
});

test('a machine-readable SBOM without components → warn (generator ran on nothing)', async () => {
    state.located = located({ parsed: { ...located().parsed, component_count: 0 } });
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'warn');
    assert.match(r.details, /lists no components/);
});

test('SPDX is accepted as machine-readable too', async () => {
    state.located = located({ format: 'spdx', path: '/app/sbom/spdx.json', parsed: { ...located().parsed, build_sha: null, spec_version: 'SPDX-2.3' } });
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.machine_readable, true);
    assert.match(r.details, /^SPDX SBOM/);
});

test('_shaMatches: prefix either way from 7 chars, never for dev/empty', () => {
    const { _shaMatches } = check._test;
    assert.equal(_shaMatches(FULL_SHA, FULL_SHA), true);
    assert.equal(_shaMatches(FULL_SHA.slice(0, 7), FULL_SHA), true);
    assert.equal(_shaMatches(FULL_SHA, FULL_SHA.slice(0, 7).toUpperCase()), true);
    assert.equal(_shaMatches('abc', 'abcdef0'), false, 'below 7 chars only an exact match counts');
    assert.equal(_shaMatches('dev', 'dev'), false);
    assert.equal(_shaMatches(null, FULL_SHA), false);
    assert.equal(_shaMatches(FULL_SHA, ''), false);
});
