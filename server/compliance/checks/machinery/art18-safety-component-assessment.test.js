// @typecheck
/**
 * MACHINERY-Art18-safety-component-assessment — per-source attestation. The
 * attestations are real rows (the boot ladder's schema on PGlite behind db.js's
 * pool), read by the real customFrameworkStore; the settings and the detector
 * are stubbed.
 * Run: cd server && node --test compliance/checks/machinery/art18-safety-component-assessment.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');
const { usePglitePool } = require('../../../testUtils/pglitePool');
const { ladderPglite } = require('../../../testUtils/pgliteTemplate');
const { insertRow } = require('../../../testUtils/pgliteSeed');
const { hideTable } = require('../../../testUtils/pgliteFaults');

const { pg, close } = usePglitePool(ladderPglite());
const customFrameworkStore = require('../../../stores/customFrameworkStore');
const realLatest = customFrameworkStore.latestAttestation;

const ORG = 'org-a';
const NOW = Date.parse('2026-09-14T12:00:00Z');
const fx = { settings: {}, matches: [] };

const restore = installResolveStub({
    '../../../stores/complianceStore': { getSettings: async (orgId) => ({ organization_id: orgId, ...fx.settings }) },
    '../../detectors/industrialIntegrations': { detect: async () => ({ scanned: {}, matches: fx.matches, skipped: [], heuristics_version: '1.0.0' }) },
});
const check = require('./art18-safety-component-assessment');
test.after(async () => { restore(); customFrameworkStore.latestAttestation = realLatest; await close(); });

test.beforeEach(async () => {
    fx.settings = {}; fx.matches = [];
    customFrameworkStore.latestAttestation = realLatest;
    await customFrameworkStore.initDB();
    await pg.exec('DELETE FROM compliance_attestations');
});

/** The one current attestation of the subject, as the table holds it. @param {Record<string, unknown>} row */
async function setAtt(row) {
    await pg.exec('DELETE FROM compliance_attestations');
    const { id: _id, ...cols } = row;
    await insertRow(pg, 'compliance_attestations', { organization_id: ORG, ...cols });
}

const PLC = { source: 'automation', id: 'a1', label: 'Line 3 PLC poll', confidence: 'high', signals: [{ kind: 'scheme', value: 'opc.tcp://plc.local:4840' }] };
const SUBJ = { id: 'automation:a1', label: 'Line 3 PLC poll', source: 'automation', confidence: 'high', signals: PLC.signals };
const att = (over = {}) => ({ check_id: check.id, subject_id: 'automation:a1', outcome: 'compliant', statement: '', evidence_refs: [], attested_by: 'user-7', attested_at: '2026-08-01T09:00:00Z', expires_at: null, superseded_at: null, ...over });

test('contract shape', () => {
    assert.equal(check.id, 'MACHINERY-Art18-safety-component-assessment');
    assert.equal(check.scope, 'per-source');
    assert.equal(check.verification, 'attestation');
    assert.equal(check.remediationLink, 'admin/compliance/machinery');
    assert.equal(typeof check.listSubjects, 'function');
});

test('relevance gate — no subjects, not_applicable', async () => {
    fx.settings = { framework_relevance: { machinery: 'not_relevant' } };
    fx.matches = [PLC];
    assert.deepEqual(await check.listSubjects(ORG), []);
    const r = await check.evaluate(ORG, SUBJ);
    assert.equal(r.status, 'not_applicable');
    assert.deepEqual(r.evidence, { relevance: 'not_relevant' });
});

test('listSubjects = detector matches ∪ manual subjects (strings and objects), deduped', async () => {
    fx.matches = [PLC, { source: 'connection', id: 'c1', label: 'mqtt broker', confidence: 'low', signals: [{ kind: 'keyword', value: 'mqtt' }] }];
    fx.settings = { machinery_manual_subjects: JSON.stringify(['Press brake bridge', { id: 'cnc-1', label: 'CNC gateway', note: 'via OPC' }, 'Press brake bridge']) };
    const subjects = await check.listSubjects(ORG);
    assert.deepEqual(subjects.map(s => s.id), ['automation:a1', 'connection:c1', 'manual:Press brake bridge', 'manual:cnc-1']);
    assert.equal(subjects[0].confidence, 'high');
    assert.equal(subjects[3].label, 'CNC gateway');
    assert.equal(subjects[3].source, 'manual');
    assert.ok(subjects.every(s => s.label && s.name));
});

test('nothing detected, nothing manual → empty subjects (runner reports not_applicable)', async () => {
    assert.deepEqual(await check.listSubjects(ORG), []);
});

test('no attestation → fail, looked up by (org, check id, subject id)', async () => {
    // Someone else's, another check's, another subject's and a superseded one do not count.
    await insertRow(pg, 'compliance_attestations', { ...att(), organization_id: 'org-b' });
    await insertRow(pg, 'compliance_attestations', { ...att(), organization_id: ORG, check_id: 'OTHER-check' });
    await insertRow(pg, 'compliance_attestations', { ...att(), organization_id: ORG, subject_id: 'automation:a2' });
    await insertRow(pg, 'compliance_attestations', { ...att(), organization_id: ORG, superseded_at: '2026-08-02T00:00:00Z' });
    const r = await check.evaluate(ORG, SUBJ, { now: NOW });
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.attested, false);
    assert.match(r.details, /No safety-component assessment/);
});

test('classification marker [safety_component] → pass with requires_conformity_assessment', async () => {
    await setAtt(att({ outcome: 'compliant', statement: '[safety_component] Drives the light curtain reset.', evidence_refs: [{ evidence_id: 'e1' }] }));
    const r = await check.evaluate(ORG, SUBJ, { now: NOW });
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.classification, 'safety_component');
    assert.equal(r.evidence.requires_conformity_assessment, true);
    assert.equal(r.evidence.evidence_refs, 1);
    assert.equal(r.evidence.age_days, 44);
    assert.match(r.details, /SAFETY COMPONENT/);
    assert.match(r.details, /CE-marking/);
});

test('monitoring_only / not_safety_component → pass without the conformity flag', async () => {
    await setAtt(att({ statement: '[monitoring_only] read-only OEE dashboard' }));
    let r = await check.evaluate(ORG, SUBJ, { now: NOW });
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.requires_conformity_assessment, false);
    await setAtt(att({ statement: '[not_safety_component] reads counters only' }));
    r = await check.evaluate(ORG, SUBJ, { now: NOW });
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.classification, 'not_safety_component');
});

test('older than 365 days → warn; expires_at in the past → warn', async () => {
    await setAtt(att({ attested_at: '2025-06-01T00:00:00Z', statement: '[safety_component] x' }));
    let r = await check.evaluate(ORG, SUBJ, { now: NOW });
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.expired, true);
    assert.match(r.details, /days old/);
    await setAtt(att({ attested_at: '2026-08-01T00:00:00Z', expires_at: '2026-09-01T00:00:00Z' }));
    r = await check.evaluate(ORG, SUBJ, { now: NOW });
    assert.equal(r.status, 'warn');
    assert.match(r.details, /past its expiry/);
});

test('generic outcomes map: partial → warn, non_compliant → fail, not_applicable → not_applicable', async () => {
    await setAtt(att({ outcome: 'partial' }));
    assert.equal((await check.evaluate(ORG, SUBJ, { now: NOW })).status, 'warn');
    await setAtt(att({ outcome: 'non_compliant' }));
    assert.equal((await check.evaluate(ORG, SUBJ, { now: NOW })).status, 'fail');
    await setAtt(att({ outcome: 'not_applicable' }));
    assert.equal((await check.evaluate(ORG, SUBJ, { now: NOW })).status, 'not_applicable');
});

test('table not provisioned → warn "not provisioned yet"', async () => {
    const show = await hideTable(pg, 'compliance_attestations');
    let r;
    try { r = await check.evaluate(ORG, SUBJ, { now: NOW }); } finally { await show(); }
    assert.equal(r.status, 'warn');
    assert.equal(r.details, 'not provisioned yet');
});

test('without the store helper the check falls back to its own org-scoped SELECT', async () => {
    customFrameworkStore.latestAttestation = /** @type {any} */ (undefined);
    await setAtt(att({ statement: '[safety_component] y' }));
    await insertRow(pg, 'compliance_attestations', { ...att({ statement: '[monitoring_only] newer, other org', attested_at: '2026-09-01T00:00:00Z' }), organization_id: 'org-b' });
    const r = await check.evaluate(ORG, SUBJ, { now: NOW });
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.classification, 'safety_component', 'the other org\'s newer row is not read');
});

test('evidence carries no personal data — attested_by never copied', async () => {
    fx.settings = { dpo_email: 'dpo@example.org' };
    await setAtt(att({ attested_by: 'jane.doe@example.org', statement: '[safety_component] contact jane.doe@example.org' }));
    const r = await check.evaluate(ORG, SUBJ, { now: NOW });
    const json = JSON.stringify(r.evidence);
    assert.ok(!/[\w.+-]+@[\w-]+\.[\w.-]+/.test(json), json);
    assert.ok(!('attested_by' in r.evidence));
    assert.ok(!('statement' in r.evidence));
});
