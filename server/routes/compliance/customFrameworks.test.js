/**
 * routes/compliance/customFrameworks — the capability gate, org scoping of
 * every mutation, the attestation flow (expiry from the framework, evidence
 * row, evidence_required refusal) and the export's allow-listed payload.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { installResolveStub } = require('../../testUtils/stubRequire');

const FW_ID = '11111111-1111-4111-8111-111111111111';
const FW_B = '22222222-2222-4222-8222-222222222222';
const CHK_ID = '33333333-3333-4333-8333-333333333333';
const CHK_B = '44444444-4444-4444-8444-444444444444';

// ── Stand-ins ────────────────────────────────────────────────────────
const state = { calls: [], evidence: [], frameworks: {}, checks: {}, attestations: [], countsInvalidated: [] };

class InvalidCodeError extends Error { constructor(c) { super(`invalid code ${c}`); this.code = 'custom_framework_code_invalid'; } }
class CodeTakenError extends Error { constructor(c) { super(`code ${c} taken`); this.code = 'custom_framework_code_taken'; } }

const rec = (name, orgId, ...rest) => state.calls.push({ name, orgId, args: rest });

const cfsStub = {
    InvalidCodeError,
    CodeTakenError,
    OUTCOMES: ['compliant', 'partial', 'non_compliant', 'not_applicable'],
    customCheckId: (code, ref) => `CUSTOM-${code}-${String(ref).replace(/[^A-Za-z0-9.]+/g, '-')}`,
    listFrameworks: async (orgId, opts) => { rec('listFrameworks', orgId, opts); return Object.values(state.frameworks).filter(f => f.organization_id === orgId); },
    getFramework: async (orgId, id) => { rec('getFramework', orgId, id); const f = state.frameworks[id]; return f && f.organization_id === orgId ? f : null; },
    createFramework: async (orgId, input) => {
        rec('createFramework', orgId, input);
        if (input.code === 'bad code') throw new InvalidCodeError(input.code);
        if (input.code === 'TAKEN') throw new CodeTakenError(input.code);
        return { id: FW_ID, organization_id: orgId, code: input.code, name: input.name, status: input.status || 'draft', attestation_valid_months: input.attestationValidMonths ?? 12, created_by: input.createdBy };
    },
    updateFramework: async (orgId, id, patch) => {
        rec('updateFramework', orgId, id, patch);
        if (patch.code !== undefined) throw new Error('code is immutable');
        const f = state.frameworks[id];
        return f && f.organization_id === orgId ? { ...f, ...patch } : null;
    },
    archiveFramework: async (orgId, id) => { rec('archiveFramework', orgId, id); const f = state.frameworks[id]; return !!(f && f.organization_id === orgId); },
    listChecks: async (orgId, fwId) => { rec('listChecks', orgId, fwId); return Object.values(state.checks).filter(c => c.organization_id === orgId && c.framework_id === fwId); },
    getCheck: async (orgId, id) => { rec('getCheck', orgId, id); const c = state.checks[id]; return c && c.organization_id === orgId ? c : null; },
    upsertChecks: async (orgId, fwId, rows) => {
        rec('upsertChecks', orgId, fwId, rows);
        const f = state.frameworks[fwId];
        if (!f || f.organization_id !== orgId) return null;
        return rows.map((r, i) => ({ id: `row-${i}`, organization_id: orgId, framework_id: fwId, ...r }));
    },
    deleteCheck: async (orgId, id) => { rec('deleteCheck', orgId, id); const c = state.checks[id]; return !!(c && c.organization_id === orgId); },
    attest: async (orgId, input) => {
        rec('attest', orgId, input);
        const row = { id: 'att-1', organization_id: orgId, check_id: input.checkId, subject_id: input.subjectId || null, outcome: input.outcome, statement: input.statement || null, evidence_refs: input.evidenceRefs || [], attested_by: input.attestedBy, attested_at: new Date().toISOString(), expires_at: input.expiresAt ? new Date(input.expiresAt).toISOString() : null, superseded_at: null };
        state.attestations.push(row);
        return row;
    },
    listAttestations: async (orgId, checkId, subjectId, opts) => { rec('listAttestations', orgId, checkId, subjectId, opts); return state.attestations.filter(a => a.organization_id === orgId && a.check_id === checkId); },
    listLatestByPrefix: async (orgId, prefix) => { rec('listLatestByPrefix', orgId, prefix); return state.attestations.filter(a => a.organization_id === orgId && a.check_id.startsWith(prefix) && !a.superseded_at); },
};

const complianceStoreStub = {
    addEvidence: async (row) => { state.evidence.push(row); return { id: 'ev-1', seq: 1, hash: 'h' }; },
};

const permissionsStub = {
    requireAuth: (req, res, next) => (req.session?.user ? next() : res.status(401).json({ error: 'Not authenticated' })),
    requirePermission: () => (req, res, next) => (req.session?.user?.canCompliance ? next() : res.status(403).json({ error: "Permission 'admin_compliance' required" })),
};
const entitlementsStub = {
    requireCapability: (capId) => (req, res, next) => {
        state.calls.push({ name: 'requireCapability', capId });
        if (req.session?.user?.caps?.includes(capId)) return next();
        return res.status(403).json({ error: 'feature_locked', feature: capId });
    },
};
const sharedStub = { resolveOrgId: async (req) => req.session?.user?.orgId || 'default' };
const countsStub = { invalidate: (orgId) => state.countsInvalidated.push(orgId) };

const restore = installResolveStub({
    '../../stores/complianceStore': complianceStoreStub,
    '../../stores/customFrameworkStore': cfsStub,
    '../../auth/permissions': permissionsStub,
    '../../core/entitlements/entitlements': entitlementsStub,
    './shared': sharedStub,
    './counts': countsStub,
});
const router = require('./customFrameworks');
test.after(() => restore());

// ── Harness ──────────────────────────────────────────────────────────
let currentSession = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = currentSession; next(); });
app.use('/api/compliance', router);
let server; let base;
test.before(async () => {
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/compliance`;
});
test.after(async () => { if (server) await new Promise((r) => server.close(r)); });

async function call(method, path, session, body) {
    currentSession = session;
    const withBody = body !== undefined && method !== 'GET' && method !== 'HEAD';
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: withBody ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed, headers: res.headers };
}

const ADMIN_A = { user: { id: 'u_a', orgId: 'org_a', canCompliance: true, caps: ['compliance_hub_custom'] } };
const ADMIN_B = { user: { id: 'u_b', orgId: 'org_b', canCompliance: true, caps: ['compliance_hub_custom'] } };
const UNLICENSED = { user: { id: 'u_c', orgId: 'org_a', canCompliance: true, caps: [] } };
const NO_PERM = { user: { id: 'u_d', orgId: 'org_a', caps: ['compliance_hub_custom'] } };

test.beforeEach(() => {
    state.calls = []; state.evidence = []; state.attestations = []; state.countsInvalidated = [];
    state.frameworks = {
        [FW_ID]: { id: FW_ID, organization_id: 'org_a', code: 'ACME', name: 'Acme', status: 'active', attestation_valid_months: 6, reference: 'v3', description: null, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z', created_by: 'u_a' },
        [FW_B]: { id: FW_B, organization_id: 'org_b', code: 'OTHER', name: 'Other', status: 'active', attestation_valid_months: 12 },
    };
    state.checks = {
        [CHK_ID]: { id: CHK_ID, organization_id: 'org_a', framework_id: FW_ID, framework_code: 'ACME', ref: 'A.1', title: 'Item', severity: 'high', evidence_required: false, mapped_check_id: null, sort_order: 0 },
        [CHK_B]: { id: CHK_B, organization_id: 'org_a', framework_id: FW_ID, framework_code: 'ACME', ref: 'A.2', title: 'Needs proof', severity: 'medium', evidence_required: true, mapped_check_id: null, sort_order: 1 },
    };
});

// ── Gates ────────────────────────────────────────────────────────────

test('every route sits behind auth, admin_compliance and compliance_hub_custom', async () => {
    const routes = [
        ['GET', '/custom/frameworks'], ['POST', '/custom/frameworks'], ['PUT', `/custom/frameworks/${FW_ID}`], ['DELETE', `/custom/frameworks/${FW_ID}`],
        ['POST', `/custom/frameworks/${FW_ID}/checks`], ['DELETE', `/custom/checks/${CHK_ID}`], ['POST', `/custom/checks/${CHK_ID}/attest`],
        ['GET', `/custom/checks/${CHK_ID}/attestations`], ['GET', `/custom/frameworks/${FW_ID}/export.json`],
    ];
    for (const [m, p] of routes) {
        assert.equal((await call(m, p, null, {})).status, 401, `${m} ${p} anon`);
        assert.equal((await call(m, p, NO_PERM, {})).status, 403, `${m} ${p} no permission`);
        const locked = await call(m, p, UNLICENSED, {});
        assert.equal(locked.status, 403, `${m} ${p} unlicensed`);
        assert.equal(locked.body.error, 'feature_locked');
        assert.equal(locked.body.feature, 'compliance_hub_custom');
    }
    // Nothing reached a store while gated.
    assert.ok(!state.calls.some(c => c.orgId));
});

// ── Frameworks ───────────────────────────────────────────────────────

test('GET /custom/frameworks lists the caller org only', async () => {
    const res = await call('GET', '/custom/frameworks', ADMIN_B);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map(f => f.code), ['OTHER']);
    assert.deepEqual(state.calls.filter(c => c.name === 'listFrameworks').map(c => c.orgId), ['org_b']);
});

test('POST /custom/frameworks creates for the caller org with the actor as createdBy; 400 invalid code, 409 taken', async () => {
    const ok = await call('POST', '/custom/frameworks', ADMIN_A, { code: 'NEW', name: 'New one', attestation_valid_months: 3, status: 'active' });
    assert.equal(ok.status, 201);
    const c = state.calls.find(x => x.name === 'createFramework');
    assert.equal(c.orgId, 'org_a');
    assert.equal(c.args[0].createdBy, 'u_a');
    assert.equal(c.args[0].attestationValidMonths, 3);
    assert.deepEqual(state.countsInvalidated, ['org_a']);

    const bad = await call('POST', '/custom/frameworks', ADMIN_A, { code: 'bad code', name: 'x' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'custom_framework_code_invalid');

    const taken = await call('POST', '/custom/frameworks', ADMIN_A, { code: 'TAKEN', name: 'x' });
    assert.equal(taken.status, 409);
    assert.equal(taken.body.error, 'custom_framework_code_taken');
});

test('PUT / DELETE are scoped to the caller org: a foreign id is 404 and the store is asked with the caller org', async () => {
    const put = await call('PUT', `/custom/frameworks/${FW_B}`, ADMIN_A, { name: 'hijack' });
    assert.equal(put.status, 404);
    assert.equal(state.calls.find(c => c.name === 'updateFramework').orgId, 'org_a');

    const del = await call('DELETE', `/custom/frameworks/${FW_B}`, ADMIN_A);
    assert.equal(del.status, 404);
    assert.equal(state.calls.find(c => c.name === 'archiveFramework').orgId, 'org_a');

    const own = await call('DELETE', `/custom/frameworks/${FW_ID}`, ADMIN_A);
    assert.equal(own.status, 200);
    assert.equal(own.body.status, 'archived');
    // A non-uuid never reaches the store.
    const junk = await call('PUT', '/custom/frameworks/not-a-uuid', ADMIN_A, { name: 'x' });
    assert.equal(junk.status, 404);
    assert.equal(state.calls.filter(c => c.name === 'updateFramework').length, 1);
});

test('PUT refuses a code change with 400 (code is immutable)', async () => {
    const res = await call('PUT', `/custom/frameworks/${FW_ID}`, ADMIN_A, { code: 'ELSE' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /immutable/);
});

// ── Checks ───────────────────────────────────────────────────────────

test('POST /custom/frameworks/:id/checks accepts a bare array or {checks:[...]}, 404 on a foreign framework', async () => {
    const rows = [{ ref: 'A.1', title: 'One' }, { ref: 'A.2', title: 'Two', severity: 'high' }];
    const a = await call('POST', `/custom/frameworks/${FW_ID}/checks`, ADMIN_A, rows);
    assert.equal(a.status, 200);
    assert.equal(a.body.count, 2);
    const b = await call('POST', `/custom/frameworks/${FW_ID}/checks`, ADMIN_A, { checks: rows });
    assert.equal(b.status, 200);
    assert.equal(b.body.checks.length, 2);
    const bad = await call('POST', `/custom/frameworks/${FW_ID}/checks`, ADMIN_A, { nope: true });
    assert.equal(bad.status, 400);
    const foreign = await call('POST', `/custom/frameworks/${FW_B}/checks`, ADMIN_A, rows);
    assert.equal(foreign.status, 404);
    for (const c of state.calls.filter(x => x.name === 'upsertChecks')) assert.equal(c.orgId, 'org_a');
});

test('DELETE /custom/checks/:id is org-scoped', async () => {
    assert.equal((await call('DELETE', `/custom/checks/${CHK_ID}`, ADMIN_B)).status, 404);
    assert.equal((await call('DELETE', `/custom/checks/${CHK_ID}`, ADMIN_A)).status, 200);
    assert.deepEqual(state.calls.filter(c => c.name === 'deleteCheck').map(c => c.orgId), ['org_b', 'org_a']);
});

// ── Attestations ─────────────────────────────────────────────────────

test('POST /custom/checks/:id/attest: expiry from the framework months, attester = actor, evidence row subject_type custom_check, counts invalidated', async () => {
    const before = Date.now();
    const res = await call('POST', `/custom/checks/${CHK_ID}/attest`, ADMIN_A, { outcome: 'compliant', statement: 'Policy published', evidence_refs: [{ evidence_id: 'e1', sha256: 'abc' }] });
    assert.equal(res.status, 201);
    const a = state.calls.find(c => c.name === 'attest');
    assert.equal(a.orgId, 'org_a');
    assert.equal(a.args[0].checkId, 'CUSTOM-ACME-A.1');
    assert.equal(a.args[0].attestedBy, 'u_a');
    assert.equal(a.args[0].outcome, 'compliant');
    // framework.attestation_valid_months = 6
    const exp = new Date(a.args[0].expiresAt).getTime();
    const sixMonths = new Date(before); sixMonths.setUTCMonth(sixMonths.getUTCMonth() + 6);
    assert.ok(Math.abs(exp - sixMonths.getTime()) < 5 * 60 * 1000, 'expires ≈ +6 months');

    assert.equal(state.evidence.length, 1);
    const ev = state.evidence[0];
    assert.equal(ev.organization_id, 'org_a');
    assert.equal(ev.subject_type, 'custom_check');
    assert.equal(ev.check_id, 'CUSTOM-ACME-A.1');
    assert.deepEqual(Object.keys(ev.payload).sort(), ['action', 'at', 'attestation_id', 'by', 'check_id', 'evidence_refs', 'expires_at', 'outcome', 'subject_id']);
    assert.deepEqual(ev.payload.evidence_refs, [{ evidence_id: 'e1', sha256: 'abc' }]);
    assert.deepEqual(state.countsInvalidated, ['org_a']);
});

test('attest: expires_in_months overrides (and null = evergreen); invalid outcome 400; foreign check 404', async () => {
    const r1 = await call('POST', `/custom/checks/${CHK_ID}/attest`, ADMIN_A, { outcome: 'partial', expires_in_months: 1 });
    assert.equal(r1.status, 201);
    const one = new Date(state.calls.find(c => c.name === 'attest').args[0].expiresAt).getTime();
    assert.ok(one - Date.now() < 32 * 24 * 3600 * 1000 && one - Date.now() > 27 * 24 * 3600 * 1000);

    state.calls = [];
    const r2 = await call('POST', `/custom/checks/${CHK_ID}/attest`, ADMIN_A, { outcome: 'not_applicable', expires_in_months: null });
    assert.equal(r2.status, 201);
    assert.equal(state.calls.find(c => c.name === 'attest').args[0].expiresAt, null);

    const bad = await call('POST', `/custom/checks/${CHK_ID}/attest`, ADMIN_A, { outcome: 'yes' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'invalid_outcome');

    const tooLong = await call('POST', `/custom/checks/${CHK_ID}/attest`, ADMIN_A, { outcome: 'compliant', expires_in_months: 500 });
    assert.equal(tooLong.status, 400);

    state.calls = [];
    const foreign = await call('POST', `/custom/checks/${CHK_ID}/attest`, ADMIN_B, { outcome: 'compliant' });
    assert.equal(foreign.status, 404);
    assert.ok(!state.calls.some(c => c.name === 'attest'));
});

test('attest refuses an evidence_required item without evidence_refs (400 evidence_required)', async () => {
    const res = await call('POST', `/custom/checks/${CHK_B}/attest`, ADMIN_A, { outcome: 'compliant', statement: 'trust me' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'evidence_required');
    assert.ok(!state.calls.some(c => c.name === 'attest'));
    const ok = await call('POST', `/custom/checks/${CHK_B}/attest`, ADMIN_A, { outcome: 'compliant', evidence_refs: [{ evidence_id: 'e9' }] });
    assert.equal(ok.status, 201);
});

test('GET /custom/checks/:id/attestations reads the history for the org, capped limit', async () => {
    await call('POST', `/custom/checks/${CHK_ID}/attest`, ADMIN_A, { outcome: 'compliant' });
    const res = await call('GET', `/custom/checks/${CHK_ID}/attestations?limit=9999`, ADMIN_A);
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    const l = state.calls.find(c => c.name === 'listAttestations');
    assert.equal(l.orgId, 'org_a');
    assert.equal(l.args[0], 'CUSTOM-ACME-A.1');
    assert.equal(l.args[2].limit, 200);
    assert.equal((await call('GET', `/custom/checks/${CHK_ID}/attestations`, ADMIN_B)).status, 404);
});

// ── Export ───────────────────────────────────────────────────────────

test('export.json: framework + checks + latest attestation, allow-listed fields only, attachment header', async () => {
    await call('POST', `/custom/checks/${CHK_ID}/attest`, ADMIN_A, { outcome: 'compliant', statement: 'done' });
    const res = await call('GET', `/custom/frameworks/${FW_ID}/export.json`, ADMIN_A);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="custom-framework-ACME\.json"/);
    assert.deepEqual(Object.keys(res.body.framework).sort(), ['attestation_valid_months', 'code', 'created_at', 'description', 'id', 'name', 'reference', 'status', 'updated_at']);
    assert.ok(!('organization_id' in res.body.framework));
    assert.ok(!('created_by' in res.body.framework));
    assert.equal(res.body.checks.length, 2);
    const a1 = res.body.checks.find(c => c.ref === 'A.1');
    assert.equal(a1.check_id, 'CUSTOM-ACME-A.1');
    assert.equal(a1.latest_attestation.outcome, 'compliant');
    assert.equal(a1.latest_attestation.attested_by, 'u_a'); // a user id, never a name/e-mail
    assert.ok(!('organization_id' in a1.latest_attestation));
    assert.ok(!('superseded_at' in a1.latest_attestation));
    assert.equal(res.body.checks.find(c => c.ref === 'A.2').latest_attestation, null);
    assert.equal((await call('GET', `/custom/frameworks/${FW_ID}/export.json`, ADMIN_B)).status, 404);
});

// ── computeExpiresAt ─────────────────────────────────────────────────

test('computeExpiresAt clamps to the last day of the target month and rejects out-of-range months', () => {
    const { computeExpiresAt } = router;
    assert.equal(computeExpiresAt('2026-08-31T10:00:00Z', 6).toISOString(), '2027-02-28T10:00:00.000Z');
    assert.equal(computeExpiresAt('2026-01-15T00:00:00Z', 12).toISOString(), '2027-01-15T00:00:00.000Z');
    assert.equal(computeExpiresAt('2026-01-15T00:00:00Z', null), null);
    assert.throws(() => computeExpiresAt('2026-01-15T00:00:00Z', 0), /1\.\.120/);
    assert.throws(() => computeExpiresAt('2026-01-15T00:00:00Z', 'abc'), /1\.\.120/);
});
