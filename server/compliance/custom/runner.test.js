/**
 * compliance/custom/runner — status mapping, grace, expiry, the evidence cap
 * and the mapped-check passthrough; plus the persisted row shape and org
 * scoping of every store call.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

const ORG = 'org_a';
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-14T12:00:00Z');

const fx = {
    frameworks: [],
    checks: {},          // frameworkId → rows
    attestations: [],    // rows returned by listLatestByPrefix
    latestBuiltin: [],   // rows returned by complianceStore.getLatestPerCheck
    recorded: [],
    calls: [],
};

const complianceStoreStub = {
    getLatestPerCheck: async (orgId) => { fx.calls.push(['getLatestPerCheck', orgId]); return fx.latestBuiltin; },
    recordCheckResult: async (row) => { fx.recorded.push(row); },
};

// The real store for its pure helpers (customCheckId / isCurrent); its db is a no-op double.
const dbStub = { run: async () => ({ rows: [], rowCount: 0 }), getOne: async () => null, getAll: async () => [], exec: async () => {} };
const restoreDb = installResolveStub({ '../db': dbStub });
const realCfs = require('../../stores/customFrameworkStore.js');
restoreDb();
const customFrameworkStoreStub = {
    customCheckId: realCfs.customCheckId,
    isCurrent: realCfs.isCurrent,
    listFrameworks: async (orgId) => { fx.calls.push(['listFrameworks', orgId]); return fx.frameworks; },
    listChecks: async (orgId, fwId) => { fx.calls.push(['listChecks', orgId, fwId]); return fx.checks[fwId] || []; },
    listLatestByPrefix: async (orgId, prefix) => { fx.calls.push(['listLatestByPrefix', orgId, prefix]); return fx.attestations.filter(a => a.check_id.startsWith(prefix)); },
};

const scoreStub = {
    customFrameworkScore: (rows) => {
        const scored = rows.filter(r => r.status !== 'na');
        if (!scored.length) return { score: null };
        return { score: Math.round(100 * scored.filter(r => r.status === 'pass').length / scored.length) };
    },
};

const restore = installResolveStub({
    '../../stores/complianceStore': complianceStoreStub,
    '../../stores/customFrameworkStore': customFrameworkStoreStub,
    '../score': scoreStub,
});
const runner = require('./runner');
test.after(() => restore());

const fw = (over = {}) => ({
    id: '11111111-1111-4111-8111-111111111111', code: 'ACME', name: 'Acme questionnaire', status: 'active',
    attestation_valid_months: 12, created_at: new Date(NOW - 90 * DAY).toISOString(), ...over,
});
const chk = (over = {}) => ({
    id: 'c1', ref: 'A.1', title: 'Item one', severity: 'high', evidence_required: false, mapped_check_id: null, ...over,
});
const att = (over = {}) => ({
    id: 'att-1', check_id: 'CUSTOM-ACME-A.1', subject_id: null, outcome: 'compliant', statement: 'ok',
    evidence_refs: [{ evidence_id: 'e1' }], attested_at: new Date(NOW - DAY).toISOString(),
    expires_at: new Date(NOW + 200 * DAY).toISOString(), superseded_at: null, ...over,
});

test.beforeEach(() => {
    fx.frameworks = [];
    fx.checks = {};
    fx.attestations = [];
    fx.latestBuiltin = [];
    fx.recorded = [];
    fx.calls = [];
});

// ── evaluateCheck (pure) ─────────────────────────────────────────────

test('outcome → status mapping: compliant/partial/non_compliant/not_applicable', () => {
    const f = fw();
    const cases = [['compliant', 'pass'], ['partial', 'warn'], ['non_compliant', 'fail'], ['not_applicable', 'na']];
    for (const [outcome, status] of cases) {
        const r = runner.evaluateCheck(chk(), f, att({ outcome }), null, NOW);
        assert.equal(r.status, status, outcome);
        assert.equal(r.evidence.mode, 'attestation');
        assert.equal(r.evidence.attestation_id, 'att-1');
    }
});

test('no attestation → fail; warn during the 30-day grace after framework creation', () => {
    const old = runner.evaluateCheck(chk(), fw(), null, null, NOW);
    assert.equal(old.status, 'fail');
    assert.equal(old.evidence.grace, false);

    const fresh = fw({ created_at: new Date(NOW - 10 * DAY).toISOString() });
    const young = runner.evaluateCheck(chk(), fresh, null, null, NOW);
    assert.equal(young.status, 'warn');
    assert.equal(young.evidence.grace, true);
    assert.match(young.details, /grace/);

    // Day 30 exactly is out of grace.
    const edge = fw({ created_at: new Date(NOW - 30 * DAY).toISOString() });
    assert.equal(runner.evaluateCheck(chk(), edge, null, null, NOW).status, 'fail');
});

test('expired attestation → warn regardless of outcome', () => {
    const r = runner.evaluateCheck(chk(), fw(), att({ outcome: 'compliant', expires_at: new Date(NOW - DAY).toISOString() }), null, NOW);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.expired, true);
    assert.match(r.details, /expired/);
    // Evergreen (expires_at null) counts as current.
    assert.equal(runner.evaluateCheck(chk(), fw(), att({ expires_at: null }), null, NOW).status, 'pass');
});

test('evidence_required without evidence_refs caps a pass at warn, leaves fail and na alone', () => {
    const c = chk({ evidence_required: true });
    const noRefs = att({ evidence_refs: [] });
    assert.equal(runner.evaluateCheck(c, fw(), noRefs, null, NOW).status, 'warn');
    assert.match(runner.evaluateCheck(c, fw(), noRefs, null, NOW).details, /evidence required/);
    assert.equal(runner.evaluateCheck(c, fw(), att({ evidence_refs: [], outcome: 'non_compliant' }), null, NOW).status, 'fail');
    assert.equal(runner.evaluateCheck(c, fw(), att({ evidence_refs: [], outcome: 'not_applicable' }), null, NOW).status, 'na');
    // With refs the pass stands; a JSON-string column is understood too.
    assert.equal(runner.evaluateCheck(c, fw(), att(), null, NOW).status, 'pass');
    assert.equal(runner.evaluateCheck(c, fw(), att({ evidence_refs: '[{"evidence_id":"e1"}]' }), null, NOW).status, 'pass');
});

test('mapped_check_id copies the built-in result with satisfied_by/source_run_at; no result yet → warn', () => {
    const c = chk({ mapped_check_id: 'GDPR-Art32-encryption-at-rest', severity: 'low' });
    const built = { check_id: 'GDPR-Art32-encryption-at-rest', status: 'fail', severity: 'critical', details: 'Tier off', run_at: '2026-09-14T08:00:00Z' };
    const r = runner.evaluateCheck(c, fw(), att(), built, NOW); // an attestation is ignored for mapped items
    assert.equal(r.status, 'fail');
    assert.equal(r.severity, 'critical');
    assert.deepEqual({ satisfied_by: r.evidence.satisfied_by, source_run_at: r.evidence.source_run_at }, { satisfied_by: 'GDPR-Art32-encryption-at-rest', source_run_at: '2026-09-14T08:00:00Z' });

    const pending = runner.evaluateCheck(c, fw(), null, null, NOW);
    assert.equal(pending.status, 'warn');
    assert.equal(pending.evidence.satisfied_by, 'GDPR-Art32-encryption-at-rest');
    assert.equal(pending.evidence.source_run_at, null);
});

// ── runAll ───────────────────────────────────────────────────────────

test('runAll: only active frameworks run; rows are persisted with regulation CUSTOM, framework_code and the custom check id', async () => {
    fx.frameworks = [fw(), fw({ id: '22222222-2222-4222-8222-222222222222', code: 'DRAFTY', status: 'draft' }), fw({ id: '33333333-3333-4333-8333-333333333333', code: 'OLD', status: 'archived' })];
    fx.checks[fw().id] = [chk(), chk({ id: 'c2', ref: 'A 2 (b)', severity: 'medium' })];
    fx.attestations = [att()];

    const out = await runner.runAll(ORG, { runType: 'manual' });

    assert.equal(fx.recorded.length, 2);
    const [r1, r2] = fx.recorded;
    assert.equal(r1.organization_id, ORG);
    assert.equal(r1.regulation, 'CUSTOM');
    assert.equal(r1.framework_code, 'ACME');
    assert.equal(r1.check_id, 'CUSTOM-ACME-A.1');
    assert.equal(r1.article, 'A.1');
    assert.equal(r1.status, 'pass');
    assert.equal(r1.severity, 'high');
    assert.equal(r1.scope_type, 'global');
    assert.equal(r1.run_type, 'manual');
    assert.equal(r2.check_id, 'CUSTOM-ACME-A-2-b');
    assert.equal(r2.status, 'fail'); // no attestation, framework 90 days old

    assert.equal(out.rows.length, 2);
    assert.deepEqual(Object.keys(out.scores), [`custom:${fw().id}`]);
    assert.equal(out.scores[`custom:${fw().id}`], 50);
    // Drafts and archived frameworks were never read.
    assert.ok(!fx.calls.some(c => c[0] === 'listChecks' && c[2] !== fw().id));
});

test('runAll: every store read is scoped to the org and the attestation prefix is CUSTOM-<CODE>-', async () => {
    fx.frameworks = [fw()];
    fx.checks[fw().id] = [chk({ mapped_check_id: 'GDPR-Art33-breach-detection' })];
    fx.latestBuiltin = [{ check_id: 'GDPR-Art33-breach-detection', status: 'pass', severity: 'high', details: 'ok', run_at: '2026-09-14T09:00:00Z', scope_type: 'global' }];

    await runner.runAll(ORG);

    for (const c of fx.calls) assert.equal(c[1], ORG, `${c[0]} scoped`);
    assert.ok(fx.calls.some(c => c[0] === 'listLatestByPrefix' && c[2] === 'CUSTOM-ACME-'));
    assert.equal(fx.recorded[0].status, 'pass');
    assert.equal(fx.recorded[0].evidence.satisfied_by, 'GDPR-Art33-breach-detection');
});

test('runAll: a check mapped to a per-source built-in takes the worst subject verdict', async () => {
    const id = 'GDPR-Art35-dpia-high-risk';
    const base = { check_id: id, severity: 'high', run_at: '2026-09-14T09:00:00Z' };
    fx.frameworks = [fw()];
    fx.checks[fw().id] = [chk({ mapped_check_id: id })];
    fx.latestBuiltin = [
        { ...base, scope_type: 'coverage', scope_id: 'coverage', status: 'pass', details: 'all examined' },
        { ...base, scope_type: 'global', scope_id: null, status: 'not_applicable', details: 'Subject not found.' },
        { ...base, scope_type: 'per-source', scope_id: 'a1', status: 'pass', details: 'ok' },
        { ...base, scope_type: 'per-source', scope_id: 'a2', status: 'fail', details: 'no DPIA' },
        { ...base, scope_type: 'per-source', scope_id: 'a3', status: 'not_applicable', details: 'No longer exists.', evidence: { retired: true } },
    ];

    await runner.runAll(ORG);

    assert.equal(fx.recorded[0].status, 'fail');
    assert.equal(fx.recorded[0].evidence.source_status, 'fail');
});

test('runAll: with no live subject, a failing coverage row outweighs the "No subjects" placeholder', async () => {
    const id = 'GDPR-Art35-dpia-high-risk';
    const base = { check_id: id, severity: 'high', run_at: '2026-09-14T09:00:00Z' };
    fx.frameworks = [fw()];
    fx.checks[fw().id] = [chk({ mapped_check_id: id })];
    fx.latestBuiltin = [
        { ...base, scope_type: 'global', scope_id: null, status: 'not_applicable', details: 'No subjects to evaluate.' },
        { ...base, scope_type: 'coverage', scope_id: 'coverage', status: 'fail', details: 'nothing examined' },
    ];

    await runner.runAll(ORG);

    assert.equal(fx.recorded[0].status, 'fail');
});

test('runAll: subject-scoped attestations under the prefix are ignored for framework items', async () => {
    fx.frameworks = [fw()];
    fx.checks[fw().id] = [chk()];
    fx.attestations = [att({ subject_id: 'automation:x', outcome: 'compliant' })];
    await runner.runAll(ORG);
    assert.equal(fx.recorded[0].status, 'fail');
});

test('runAll: no active framework → empty result, nothing persisted, no built-in read', async () => {
    fx.frameworks = [fw({ status: 'draft' })];
    const out = await runner.runAll(ORG);
    assert.deepEqual(out, { rows: [], scores: {} });
    assert.equal(fx.recorded.length, 0);
    assert.ok(!fx.calls.some(c => c[0] === 'getLatestPerCheck'));
});

test('runAll: a framework whose checks cannot be read does not stop the others', async () => {
    const good = fw({ id: '44444444-4444-4444-8444-444444444444', code: 'GOOD' });
    fx.frameworks = [fw({ code: 'BAD' }), good];
    fx.checks[good.id] = [chk()];
    const origListChecks = customFrameworkStoreStub.listChecks;
    customFrameworkStoreStub.listChecks = async (orgId, fwId) => {
        if (fwId === fw().id) throw new Error('boom');
        return origListChecks(orgId, fwId);
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
        const out = await runner.runAll(ORG);
        assert.equal(out.rows.length, 1);
        assert.equal(out.rows[0].framework_code, 'GOOD');
        assert.equal(out.scores[`custom:${fw().id}`], null);
    } finally {
        console.warn = warn;
        customFrameworkStoreStub.listChecks = origListChecks;
    }
});

test('runAll requires an orgId', async () => {
    await assert.rejects(() => runner.runAll(''), /orgId/);
});
