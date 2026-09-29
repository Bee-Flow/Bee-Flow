/**
 * EAA-Art4-product-surfaces-conformance — verdicts over the CI axe artefact.
 * Run: cd server && node --test --test-force-exit compliance/checks/eaa/art4-product-surfaces-conformance.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const ORG = 'org-a';
const fx = { settings: {}, sha: 'abcdef1234567' };
const restore = installResolveStub({
    '../../../stores/complianceStore': { getSettings: async (orgId) => ({ organization_id: orgId, ...fx.settings }) },
    '../../../utils/buildInfo': { get APP_BUILD_SHA() { return fx.sha; } },
});
const check = require('./art4-product-surfaces-conformance');
test.after(() => restore());

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-conf-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const NOW = Date.parse('2026-09-14T12:00:00Z');
let n = 0;
function artefact(overrides = {}, surfacesOverride) {
    const surfaces = surfacesOverride || ['public_form', 'public_app', 'dsr', 'webpage_viewer'].map(id => ({
        id, status: 'tested', url_path: `/${id}`, violations: { critical: 0, serious: 0, moderate: 0, minor: 0 }, rules: [],
    }));
    const doc = { schema_version: 1, build_sha: 'abcdef1234567', generated_at: '2026-09-13T10:00:00Z', axe_version: '4.10.0', surfaces, ...overrides };
    const p = path.join(dir, `c${n++}.json`);
    fs.writeFileSync(p, JSON.stringify(doc));
    return p;
}

test.beforeEach(() => { fx.settings = {}; fx.sha = 'abcdef1234567'; });

test('contract shape', () => {
    assert.equal(check.id, 'EAA-Art4-product-surfaces-conformance');
    assert.equal(check.verification, 'hybrid');
    assert.equal(check.scope, 'global');
    assert.equal(check.remediationLink, null);
});

test('relevance gate', async () => {
    fx.settings = { framework_relevance: { eaa: 'not_relevant' } };
    const r = await check.evaluate(ORG, null, { path: artefact(), now: NOW });
    assert.equal(r.status, 'not_applicable');
    assert.deepEqual(r.evidence, { relevance: 'not_relevant' });
});

test('artefact absent → fail', async () => {
    const r = await check.evaluate(ORG, null, { path: path.join(dir, 'nope.json'), now: NOW });
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.artefact_found, false);
    assert.match(r.details, /No accessibility conformance artefact/);
});

test('artefact unusable (bad shape) → fail naming the problem', async () => {
    const p = path.join(dir, 'bad.json');
    fs.writeFileSync(p, JSON.stringify({ schema_version: 1, build_sha: 'abcdef1234567', generated_at: 'x', surfaces: [] }));
    const r = await check.evaluate(ORG, null, { path: p, now: NOW });
    assert.equal(r.status, 'fail');
    assert.ok(r.evidence.artefact_problems.length >= 1);
});

test('clean, current artefact → pass with the declared level in evidence', async () => {
    fx.settings = { accessibility_conformance_level: 'WCAG 2.1 AA', accessibility_conformance_at: '2026-09-01' };
    const r = await check.evaluate(ORG, null, { path: artefact(), now: NOW });
    assert.equal(r.status, 'pass', r.details);
    assert.equal(r.evidence.build_sha_matches, true);
    assert.equal(r.evidence.stale, false);
    assert.equal(r.evidence.attestation.declared_level, 'WCAG 2.1 AA');
    assert.equal(r.evidence.attestation.declared_at.slice(0, 10), '2026-09-01');
    assert.deepEqual(r.evidence.tested_surfaces, ['public_form', 'public_app', 'dsr', 'webpage_viewer']);
});

test('sha mismatch → warn stale', async () => {
    fx.sha = 'ffffff9999999';
    const r = await check.evaluate(ORG, null, { path: artefact(), now: NOW });
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.build_sha_matches, false);
    assert.match(r.details, /stale/);
});

test('older than 60 days → warn stale; a short sha prefix still matches', async () => {
    fx.sha = 'abcdef1';
    const r = await check.evaluate(ORG, null, { path: artefact({ generated_at: '2026-06-01T00:00:00Z' }), now: NOW });
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.build_sha_matches, true);
    assert.ok(r.evidence.age_days > 60);
});

test('serious/critical violations → fail (even when also stale)', async () => {
    const surfaces = [
        { id: 'public_form', status: 'tested', violations: { critical: 1, serious: 2, moderate: 0, minor: 0 }, rules: [{ id: 'label', impact: 'critical', nodes: 1, targets: ['#f > input'] }] },
        { id: 'dsr', status: 'tested', violations: { critical: 0, serious: 0, moderate: 0, minor: 0 }, rules: [] },
    ];
    const r = await check.evaluate(ORG, null, { path: artefact({ build_sha: '1234567abc' }, surfaces), now: NOW });
    assert.equal(r.status, 'fail');
    assert.deepEqual(r.evidence.totals, { critical: 1, serious: 2, moderate: 0, minor: 0 });
    assert.equal(r.evidence.surfaces[0].rules[0].id, 'label');
    assert.match(r.details, /3 serious\/critical/);
});

test('moderate/minor only → warn', async () => {
    const surfaces = ['public_form', 'public_app', 'dsr', 'webpage_viewer'].map(id => ({
        id, status: 'tested', violations: { critical: 0, serious: 0, moderate: 1, minor: 2 }, rules: [{ id: 'region', impact: 'moderate', nodes: 1 }],
    }));
    const r = await check.evaluate(ORG, null, { path: artefact({}, surfaces), now: NOW });
    assert.equal(r.status, 'warn');
    assert.match(r.details, /moderate\/minor/);
});

test('a skipped surface is never a pass → warn', async () => {
    const surfaces = [
        { id: 'public_form', status: 'tested', violations: { critical: 0, serious: 0, moderate: 0, minor: 0 }, rules: [] },
        { id: 'public_app', status: 'skipped', skip_reason: 'no fixture token' },
    ];
    const r = await check.evaluate(ORG, null, { path: artefact({}, surfaces), now: NOW });
    assert.equal(r.status, 'warn');
    assert.deepEqual(r.evidence.skipped_surfaces, ['public_app']);
    assert.equal(r.evidence.surfaces[1].skip_reason, 'no fixture token');
});

test('evidence contains no personal data', async () => {
    fx.settings = { dpo_email: 'dpo@example.org', accessibility_conformance_level: 'AA' };
    const r = await check.evaluate(ORG, null, { path: artefact(), now: NOW });
    assert.ok(!/[\w.+-]+@[\w-]+\.[\w.-]+/.test(JSON.stringify(r.evidence)));
});
