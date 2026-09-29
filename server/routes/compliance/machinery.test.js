/**
 * routes/compliance/machinery — the capability gate, the detections read
 * (503 without the detector), and the Art. 18 attestation: check id,
 * subject id, classification marker, evidence row, org scoping.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { installResolveStub } = require('../../testUtils/stubRequire');

const ART18 = 'MACHINERY-Art18-safety-component-assessment';

const state = { calls: [], evidence: [], reruns: [], attestations: [], detectorAvailable: true, detectCalls: [], settings: {} };
const rec = (name, orgId, ...rest) => state.calls.push({ name, orgId, args: rest });

const cfsStub = {
    isCurrent: (row) => !row.expires_at || new Date(row.expires_at).getTime() > Date.now(),
    attest: async (orgId, input) => {
        rec('attest', orgId, input);
        const row = { id: `att-${state.attestations.length + 1}`, organization_id: orgId, check_id: input.checkId, subject_id: input.subjectId, outcome: input.outcome, statement: input.statement, evidence_refs: input.evidenceRefs || [], attested_by: input.attestedBy, attested_at: new Date().toISOString(), expires_at: input.expiresAt ? new Date(input.expiresAt).toISOString() : null, superseded_at: null };
        state.attestations.push(row);
        return row;
    },
    listAttestations: async (orgId, checkId, subjectId) => { rec('listAttestations', orgId, checkId, subjectId); return state.attestations.filter(a => a.organization_id === orgId && a.check_id === checkId && a.subject_id === subjectId); },
    listLatestByPrefix: async (orgId, prefix) => { rec('listLatestByPrefix', orgId, prefix); return state.attestations.filter(a => a.organization_id === orgId && a.check_id.startsWith(prefix)); },
};
const complianceStoreStub = {
    addEvidence: async (row) => { state.evidence.push(row); return { id: 'ev', seq: 1, hash: 'h' }; },
    getSettings: async (orgId) => state.settings[orgId] || {},
};
const runnerStub = { runOne: async (orgId, checkId, opts) => { state.reruns.push({ orgId, checkId, opts }); } };
const permissionsStub = {
    requireAuth: (req, res, next) => (req.session?.user ? next() : res.status(401).json({ error: 'Not authenticated' })),
    requirePermission: () => (req, res, next) => (req.session?.user?.canCompliance ? next() : res.status(403).json({ error: 'forbidden' })),
};
const entitlementsStub = {
    requireCapability: (capId) => (req, res, next) => (req.session?.user?.caps?.includes(capId) ? next() : res.status(403).json({ error: 'feature_locked', feature: capId })),
};
const sharedStub = { resolveOrgId: async (req) => req.session?.user?.orgId || 'default' };

// The detector is required lazily by the route, so the stub can toggle availability per test.
const detectorStub = {
    detect: async (orgId) => {
        state.detectCalls.push(orgId);
        return {
            scanned: { automations: 3 },
            matches: [{ source: 'automation', id: 'a1', label: 'PLC bridge', signals: ['opc.tcp://'], confidence: 'high' }],
            skipped: [],
        };
    },
};
const Module = require('node:module');
const realResolve = Module._resolveFilename;
const restore = installResolveStub({
    '../../stores/complianceStore': complianceStoreStub,
    '../../stores/customFrameworkStore': cfsStub,
    '../../compliance/runner': runnerStub,
    '../../auth/permissions': permissionsStub,
    '../../core/entitlements/entitlements': entitlementsStub,
    './shared': sharedStub,
    '../../compliance/detectors/industrialIntegrations': detectorStub,
});
// Layer a switch on top: when detectorAvailable is false, resolving the detector throws (module absent).
const stubbedResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === '../../compliance/detectors/industrialIntegrations' && !state.detectorAvailable) {
        const e = new Error(`Cannot find module '${request}'`); e.code = 'MODULE_NOT_FOUND'; throw e;
    }
    return stubbedResolve.call(this, request, ...rest);
};
const router = require('./machinery');
test.after(() => { restore(); Module._resolveFilename = realResolve; });

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
    const withBody = body !== undefined && method !== 'GET';
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: withBody ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed };
}
const tick = () => new Promise(r => setImmediate(r));

const ADMIN_A = { user: { id: 'u_a', orgId: 'org_a', canCompliance: true, caps: ['compliance_hub_machinery'] } };
const ADMIN_B = { user: { id: 'u_b', orgId: 'org_b', canCompliance: true, caps: ['compliance_hub_machinery'] } };
const UNLICENSED = { user: { id: 'u_c', orgId: 'org_a', canCompliance: true, caps: [] } };

test.beforeEach(() => {
    state.calls = []; state.evidence = []; state.reruns = []; state.attestations = []; state.detectCalls = []; state.settings = {};
    state.detectorAvailable = true;
});

test('gates: 401 anonymous, 403 without compliance_hub_machinery', async () => {
    for (const [m, p] of [['GET', '/machinery/detections'], ['POST', '/machinery/subjects/automation:a1/attest'], ['GET', '/machinery/subjects/automation:a1/attestations']]) {
        assert.equal((await call(m, p, null, {})).status, 401, `${m} ${p}`);
        const locked = await call(m, p, UNLICENSED, {});
        assert.equal(locked.status, 403);
        assert.equal(locked.body.feature, 'compliance_hub_machinery');
    }
    assert.equal(state.detectCalls.length, 0);
    assert.equal(state.calls.length, 0);
});

test('GET /machinery/detections runs the detector for the caller org and decorates subjects with their assessment', async () => {
    state.settings.org_a = { machinery_manual_subjects: ['press-line-2', { id: 'robot-7', label: 'Welding robot' }] };
    state.attestations.push({ id: 'att-0', organization_id: 'org_a', check_id: ART18, subject_id: 'automation:a1', outcome: 'compliant', statement: '[monitoring_only] reads only', evidence_refs: [], attested_at: '2026-09-01T00:00:00Z', expires_at: null, superseded_at: null });
    const res = await call('GET', '/machinery/detections', ADMIN_A);
    assert.equal(res.status, 200);
    assert.deepEqual(state.detectCalls, ['org_a']);
    assert.equal(res.body.matches.length, 1);
    assert.equal(res.body.matches[0].subject_id, 'automation:a1');
    assert.equal(res.body.matches[0].assessment.classification, 'monitoring_only');
    assert.equal(res.body.matches[0].assessment.current, true);
    assert.deepEqual(res.body.manual_subjects.map(s => s.subject_id), ['manual:press-line-2', 'manual:robot-7']);
    assert.equal(res.body.manual_subjects[1].label, 'Welding robot');
    assert.equal(res.body.manual_subjects[0].assessment, null);
    assert.deepEqual(res.body.classifications, ['safety_component', 'monitoring_only', 'not_safety_component']);
    assert.equal(state.calls.find(c => c.name === 'listLatestByPrefix').orgId, 'org_a');
});

test('GET /machinery/detections → 503 not_provisioned when the detector module is absent', async () => {
    state.detectorAvailable = false;
    const res = await call('GET', '/machinery/detections', ADMIN_A);
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'not_provisioned');
});

test('POST /machinery/subjects/:id/attest writes the Art-18 attestation with the classification marker, 12-month expiry, evidence row and rerun', async () => {
    const res = await call('POST', '/machinery/subjects/automation:a1/attest', ADMIN_A, { outcome: 'safety_component', statement: 'Drives the light-curtain reset.', evidence_refs: [{ evidence_id: 'e1', sha256: 'ff' }] });
    assert.equal(res.status, 201);
    assert.equal(res.body.classification, 'safety_component');
    const a = state.calls.find(c => c.name === 'attest');
    assert.equal(a.orgId, 'org_a');
    assert.equal(a.args[0].checkId, ART18);
    assert.equal(a.args[0].subjectId, 'automation:a1');
    assert.equal(a.args[0].outcome, 'compliant');
    assert.equal(a.args[0].statement, '[safety_component] Drives the light-curtain reset.');
    assert.equal(a.args[0].attestedBy, 'u_a');
    const months = (new Date(a.args[0].expiresAt) - Date.now()) / (30 * 24 * 3600 * 1000);
    assert.ok(months > 11 && months < 13, `≈12 months (${months})`);

    assert.equal(state.evidence.length, 1);
    const ev = state.evidence[0];
    assert.equal(ev.organization_id, 'org_a');
    assert.equal(ev.check_id, ART18);
    assert.equal(ev.subject_type, 'machinery_subject');
    assert.equal(ev.subject_id, 'automation:a1');
    assert.deepEqual(Object.keys(ev.payload).sort(), ['action', 'at', 'attestation_id', 'by', 'classification', 'evidence_refs', 'expires_at', 'subject_id']);
    assert.deepEqual(ev.payload.evidence_refs, [{ evidence_id: 'e1', sha256: 'ff' }]);
    await tick();
    assert.deepEqual(state.reruns, [{ orgId: 'org_a', checkId: ART18, opts: { runType: 'event', subjectId: 'automation:a1' } }]);
});

test('attest: a stale marker typed into the statement is replaced, `classification` is accepted as alias, invalid outcome/subject → 400', async () => {
    await call('POST', '/machinery/subjects/manual:press-1/attest', ADMIN_A, { classification: 'not_safety_component', statement: '[safety_component] actually not' });
    assert.equal(state.calls.find(c => c.name === 'attest').args[0].statement, '[not_safety_component] actually not');

    const bad = await call('POST', '/machinery/subjects/manual:press-1/attest', ADMIN_A, { outcome: 'compliant' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'invalid_outcome');
    const badSubject = await call('POST', '/machinery/subjects/nocolon/attest', ADMIN_A, { outcome: 'monitoring_only' });
    assert.equal(badSubject.status, 400);
    assert.equal(badSubject.body.error, 'invalid_subject');
    assert.equal(state.calls.filter(c => c.name === 'attest').length, 1);
});

test('GET /machinery/subjects/:id/attestations is scoped to the caller org and exposes the classification', async () => {
    await call('POST', '/machinery/subjects/automation:a1/attest', ADMIN_A, { outcome: 'monitoring_only' });
    const own = await call('GET', '/machinery/subjects/automation:a1/attestations', ADMIN_A);
    assert.equal(own.status, 200);
    assert.equal(own.body.length, 1);
    assert.equal(own.body[0].classification, 'monitoring_only');
    const other = await call('GET', '/machinery/subjects/automation:a1/attestations', ADMIN_B);
    assert.deepEqual(other.body, []);
    assert.deepEqual(state.calls.filter(c => c.name === 'listAttestations').map(c => c.orgId), ['org_a', 'org_b']);
});
