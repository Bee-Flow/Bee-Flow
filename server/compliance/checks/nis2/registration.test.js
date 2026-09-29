/**
 * NIS2-Art3-registration — attestation of the registration with the authority.
 * Run: cd server && node --test --test-force-exit compliance/checks/nis2/registration.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const ORG = 'org-a';
const fx = { settings: {} };
const restore = installResolveStub({
    '../../../stores/complianceStore': { getSettings: async (orgId) => ({ organization_id: orgId, updated_at: '2026-09-01T10:00:00Z', ...fx.settings }) },
});
const check = require('./registration');
test.after(() => restore());

test.beforeEach(() => { fx.settings = {}; });

test('contract shape — attestation, no db module required', () => {
    assert.equal(check.id, 'NIS2-Art3-registration');
    assert.equal(check.verification, 'attestation');
    assert.equal(check.remediationLink, 'admin/compliance/settings');
    // The real module graph, not its require string: catches an indirect edge
    // to db.js just as well as a direct one, and survives a reformat that a
    // regex on the literal request string would not.
    const dbPath = require.resolve('../../../db');
    const children = require.cache[require.resolve('./registration')].children.map((c) => c.id);
    assert.ok(!children.includes(dbPath), 'settings-only check must not touch the db');
});

test('relevance gate', async () => {
    fx.settings = { framework_relevance: { nis2: 'not_relevant' } };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
    assert.deepEqual(r.evidence, { relevance: 'not_relevant' });
});

test('nothing set → warn "classify"', async () => {
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.entity_class, null);
    assert.match(r.details, /not been classified/);
});

test('not_in_scope / supplier_only → not_applicable with the self-classification recorded', async () => {
    fx.settings = { nis2_entity_class: 'not_in_scope' };
    let r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
    assert.equal(r.evidence.entity_class, 'not_in_scope');
    assert.equal(r.evidence.attested_at, '2026-09-01T10:00:00.000Z');
    fx.settings = { nis2_entity_class: 'supplier_only' };
    r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
    assert.match(r.details, /questionnaire pack/);
});

test('essential + reference + date → pass', async () => {
    fx.settings = { nis2_entity_class: 'essential', nis2_registration_reference: 'RDI-2026-00123', nis2_registered_at: '2026-08-20' };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.registration_reference, 'RDI-2026-00123');
    assert.equal(r.evidence.registered_at.slice(0, 10), '2026-08-20');
});

test('important without a reference → fail; with reference but no date → fail', async () => {
    fx.settings = { nis2_entity_class: 'important' };
    let r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.match(r.details, /no registration reference/);
    fx.settings = { nis2_entity_class: 'important', nis2_registration_reference: 'X' };
    r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.match(r.details, /no registration date/);
});

test('unknown class value → warn naming the options', async () => {
    fx.settings = { nis2_entity_class: 'huge' };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.match(r.details, /essential, important, supplier_only or not_in_scope/);
});

test('evidence carries no personal data', async () => {
    fx.settings = { nis2_entity_class: 'essential', nis2_registration_reference: 'REF', nis2_registered_at: '2026-08-20', dpo_email: 'dpo@example.org', dpo_name: 'Jane Doe' };
    const r = await check.evaluate(ORG);
    assert.doesNotMatch(JSON.stringify(r.evidence) + r.details, /@|Jane/);
});
