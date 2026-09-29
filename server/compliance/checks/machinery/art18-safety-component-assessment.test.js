/**
 * MACHINERY-Art18-safety-component-assessment — per-source attestation.
 * Run: cd server && node --test --test-force-exit compliance/checks/machinery/art18-safety-component-assessment.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const ORG = 'org-a';
const NOW = Date.parse('2026-09-14T12:00:00Z');
const fx = { settings: {}, matches: [], attestations: {}, lookups: [], storeThrows: null, useStore: true, dbQueries: [] };

const storeStub = {
    get latestAttestation() {
        if (!fx.useStore) return undefined;
        return async (orgId, checkId, subjectId) => {
            fx.lookups.push({ orgId, checkId, subjectId });
            if (fx.storeThrows) { const e = new Error('nope'); e.code = fx.storeThrows; throw e; }
            return fx.attestations[subjectId] || null;
        };
    },
};

const restore = installResolveStub({
    '../../../stores/complianceStore': { getSettings: async (orgId) => ({ organization_id: orgId, ...fx.settings }) },
    '../../detectors/industrialIntegrations': { detect: async () => ({ scanned: {}, matches: fx.matches, skipped: [], heuristics_version: '1.0.0' }) },
    '../../../stores/customFrameworkStore': storeStub,
    '../../../db': {
        getOne: async (sql, params) => { fx.dbQueries.push({ sql, params }); return fx.attestations[params[2]] || null; },
    },
});
const check = require('./art18-safety-component-assessment');
test.after(() => restore());

test.beforeEach(() => {
    fx.settings = {}; fx.matches = []; fx.attestations = {}; fx.lookups = []; fx.storeThrows = null; fx.useStore = true; fx.dbQueries = [];
});

const PLC = { source: 'automation', id: 'a1', label: 'Line 3 PLC poll', confidence: 'high', signals: [{ kind: 'scheme', value: 'opc.tcp://plc.local:4840' }] };
const SUBJ = { id: 'automation:a1', label: 'Line 3 PLC poll', source: 'automation', confidence: 'high', signals: PLC.signals };
const att = (over = {}) => ({ id: 'att-1', check_id: check.id, subject_id: 'automation:a1', outcome: 'compliant', statement: '', evidence_refs: [], attested_by: 'user-7', attested_at: '2026-08-01T09:00:00Z', expires_at: null, superseded_at: null, ...over });

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
    const r = await check.evaluate(ORG, SUBJ, { now: NOW });
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.attested, false);
    assert.deepEqual(fx.lookups, [{ orgId: ORG, checkId: check.id, subjectId: 'automation:a1' }]);
    assert.match(r.details, /No safety-component assessment/);
});

test('classification marker [safety_component] → pass with requires_conformity_assessment', async () => {
    fx.attestations['automation:a1'] = att({ outcome: 'compliant', statement: '[safety_component] Drives the light curtain reset.', evidence_refs: [{ evidence_id: 'e1' }] });
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
    fx.attestations['automation:a1'] = att({ statement: '[monitoring_only] read-only OEE dashboard' });
    let r = await check.evaluate(ORG, SUBJ, { now: NOW });
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.requires_conformity_assessment, false);
    fx.attestations['automation:a1'] = att({ classification: 'not_safety_component' });
    r = await check.evaluate(ORG, SUBJ, { now: NOW });
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.classification, 'not_safety_component');
});

test('older than 365 days → warn; expires_at in the past → warn', async () => {
    fx.attestations['automation:a1'] = att({ attested_at: '2025-06-01T00:00:00Z', statement: '[safety_component] x' });
    let r = await check.evaluate(ORG, SUBJ, { now: NOW });
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.expired, true);
    assert.match(r.details, /days old/);
    fx.attestations['automation:a1'] = att({ attested_at: '2026-08-01T00:00:00Z', expires_at: '2026-09-01T00:00:00Z' });
    r = await check.evaluate(ORG, SUBJ, { now: NOW });
    assert.equal(r.status, 'warn');
    assert.match(r.details, /past its expiry/);
});

test('generic outcomes map: partial → warn, non_compliant → fail, not_applicable → not_applicable', async () => {
    fx.attestations['automation:a1'] = att({ outcome: 'partial' });
    assert.equal((await check.evaluate(ORG, SUBJ, { now: NOW })).status, 'warn');
    fx.attestations['automation:a1'] = att({ outcome: 'non_compliant' });
    assert.equal((await check.evaluate(ORG, SUBJ, { now: NOW })).status, 'fail');
    fx.attestations['automation:a1'] = att({ outcome: 'not_applicable' });
    assert.equal((await check.evaluate(ORG, SUBJ, { now: NOW })).status, 'not_applicable');
});

test('table not provisioned → warn "not provisioned yet"', async () => {
    fx.storeThrows = '42P01';
    const r = await check.evaluate(ORG, SUBJ, { now: NOW });
    assert.equal(r.status, 'warn');
    assert.equal(r.details, 'not provisioned yet');
});

test('without the store helper the check falls back to its own org-scoped SELECT', async () => {
    fx.useStore = false;
    fx.attestations['automation:a1'] = att({ statement: '[safety_component] y' });
    const r = await check.evaluate(ORG, SUBJ, { now: NOW });
    assert.equal(r.status, 'pass');
    assert.equal(fx.dbQueries.length, 1);
    assert.match(fx.dbQueries[0].sql, /organization_id = \$1/);
    assert.equal(fx.dbQueries[0].params[0], ORG);
});

test('evidence carries no personal data — attested_by never copied', async () => {
    fx.settings = { dpo_email: 'dpo@example.org' };
    fx.attestations['automation:a1'] = att({ attested_by: 'jane.doe@example.org', statement: '[safety_component] contact jane.doe@example.org' });
    const r = await check.evaluate(ORG, SUBJ, { now: NOW });
    const json = JSON.stringify(r.evidence);
    assert.ok(!/[\w.+-]+@[\w-]+\.[\w.-]+/.test(json), json);
    assert.ok(!('attested_by' in r.evidence));
    assert.ok(!('statement' in r.evidence));
});
