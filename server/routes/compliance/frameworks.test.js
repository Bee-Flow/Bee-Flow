/**
 * Route tests for /api/compliance/frameworks (routes/compliance/frameworks.js).
 *
 * The policy, the runner, the stores and the auth gate are swapped through
 * installResolveStub; the catalogue (compliance/frameworks.js), the registry
 * shape and the score model are real. Pinned: the §1.2 GET shape (a locked
 * framework is returned locked, never hidden; a candidate carries no score),
 * enable → setEnabled + runFramework + evidence row (allow-listed payload) +
 * counts invalidation, the 403 feature_locked body identical to
 * requireCapability's, 400 framework_core / unknown_framework, relevance
 * validation.
 *
 * Run: cd server && node --test --test-force-exit routes/compliance/frameworks.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { installResolveStub } = require('../../testUtils/stubRequire');

// ── Doubles ────────────────────────────────────────────────────────────────
const calls = { setEnabled: [], setRelevance: [], runFramework: [], evidence: [], invalidated: [] };

const UPGRADE_URL = 'https://beeflow.nl/pricing';
class PolicyError extends Error {
    constructor(status, body) { super(body.error); this.status = status; this.body = body; }
}

let policyState;
function resetPolicy() {
    policyState = {
        gdpr: { regulation: 'GDPR', enabled: true, core: true, locked: null, lock: null, relevance: 'unknown' },
        aia: { regulation: 'AIA', enabled: true, core: true, locked: null, lock: null, relevance: 'unknown' },
        iso27001: { regulation: 'ISO27001', enabled: true, core: true, locked: null, lock: null, relevance: 'unknown' },
        nis2: { regulation: 'NIS2', enabled: false, core: false, locked: 'ceiling', lock: { feature: 'compliance_hub_nis2', required: 'enterprise', current: 'community', upgrade_url: UPGRADE_URL }, relevance: 'unknown' },
        cra: { regulation: 'CRA', enabled: false, core: false, locked: null, lock: null, relevance: 'unknown' },
        data_act: { regulation: 'DATA_ACT', enabled: false, core: false, locked: null, lock: null, relevance: 'unknown' },
        pld: { regulation: 'PLD', enabled: false, core: false, locked: 'not_granted', lock: { feature: 'compliance_hub_pld', required: 'enterprise', upgrade_url: UPGRADE_URL }, relevance: 'unknown' },
        eaa: { regulation: 'EAA', enabled: true, core: false, locked: null, lock: null, relevance: 'unknown' },
        dora: { regulation: 'DORA', enabled: false, core: false, locked: null, lock: null, relevance: 'not_relevant' },
        machinery: { regulation: 'MACHINERY', enabled: false, core: false, locked: null, lock: null, relevance: 'unknown' },
    };
}
resetPolicy();
const resolvePolicy = async () => Object.entries(policyState).map(([id, p]) => ({ id, ...p }));

const frameworkPolicy = {
    resolve: resolvePolicy,
    customUnlocked: async () => false,
    activeRegulations: async () => new Set(Object.values(policyState).filter(p => p.enabled && !p.locked).map(p => p.regulation)),
    setEnabled: async (orgId, id, on, actorId) => {
        calls.setEnabled.push({ orgId, id, on, actorId });
        const p = policyState[id];
        if (!p) throw new PolicyError(400, { error: 'unknown_framework', framework: id });
        if (p.core) throw new PolicyError(400, { error: 'framework_core', framework: id });
        if (on && p.locked === 'ceiling') throw new PolicyError(403, { error: 'feature_locked', feature: p.lock.feature, required: 'enterprise', current: 'community', upgrade_url: UPGRADE_URL });
        if (on && p.locked === 'not_granted') throw new PolicyError(403, { error: 'feature_disabled', feature: p.lock.feature });
        p.enabled = on;
        return { id, ...p };
    },
    setRelevance: async (orgId, id, relevance, actorId, note) => {
        calls.setRelevance.push({ orgId, id, relevance, actorId, note });
        policyState[id].relevance = relevance;
        return { id, ...policyState[id] };
    },
};

const NOW = Date.parse('2026-09-14T12:00:00Z');
const latestRows = [
    { check_id: 'GDPR-Art32-dlp-enabled', regulation: 'GDPR', severity: 'critical', status: 'pass', run_at: new Date(NOW).toISOString() },
    { check_id: 'GDPR-Art28-subprocessors', regulation: 'GDPR', severity: 'high', status: 'fail', run_at: new Date(NOW).toISOString() },
    { check_id: 'CRA-Art14-vuln-reporting-clocks', regulation: 'CRA', severity: 'critical', status: 'fail', run_at: new Date(NOW).toISOString() },
];
const DEFS = {
    'GDPR-Art32-dlp-enabled': { id: 'GDPR-Art32-dlp-enabled', regulation: 'GDPR', severity: 'critical', frameworks: [{ regulation: 'GDPR', ref: 'Art. 32', framework_id: 'gdpr' }] },
    'GDPR-Art28-subprocessors': { id: 'GDPR-Art28-subprocessors', regulation: 'GDPR', severity: 'high', frameworks: [{ regulation: 'GDPR', ref: 'Art. 28', framework_id: 'gdpr' }, { regulation: 'ISO27001', ref: 'A.5.20', framework_id: 'iso27001' }] },
    'CRA-Art14-vuln-reporting-clocks': { id: 'CRA-Art14-vuln-reporting-clocks', regulation: 'CRA', severity: 'critical', frameworks: [{ regulation: 'CRA', ref: 'Art. 14', framework_id: 'cra' }] },
    'ISO27001-A.5.1-policies': { id: 'ISO27001-A.5.1-policies', regulation: 'ISO27001', severity: 'medium', frameworks: [{ regulation: 'ISO27001', ref: 'A.5.1', framework_id: 'iso27001' }] },
};
const registry = {
    get: (id) => DEFS[id] || null,
    getAll: () => Object.values(DEFS),
    getByFramework: (code) => Object.values(DEFS).filter(d => d.frameworks.some(f => f.regulation === code)),
    getPrimary: (code) => Object.values(DEFS).filter(d => d.regulation === code),
};
const complianceStore = {
    getLatestPerCheck: async () => latestRows,
    addEvidence: async (row) => { calls.evidence.push(row); return { id: calls.evidence.length, seq: 1, hash: 'h' }; },
    getSettings: async () => ({}),
};
const runner = {
    runFramework: async (orgId, id, opts) => { calls.runFramework.push({ orgId, id, opts }); return [{ check_id: 'CRA-Art14-vuln-reporting-clocks', status: 'fail' }]; },
    runOne: async () => { throw new Error('not used'); },
};
const calendarStub = {
    countByFramework: () => ({ aia: 7, eaa: 2, cra: 2, gdpr: 1, nis2: 1 }),
    affectsCounts: async (kind) => (kind === 'marking' ? { automations: 3, agents: 4, webpages: null, forms: null } : { automations: null, agents: null, webpages: 6, forms: 2 }),
    invalidate: () => {},
};
const counts = { invalidate: (orgId) => calls.invalidated.push(orgId) };

const restore = installResolveStub({
    '../../compliance/frameworkPolicy': frameworkPolicy,
    '../../compliance/registry': registry,
    '../../compliance/runner': runner,
    '../../compliance/calendar': calendarStub,
    '../../stores/complianceStore': complianceStore,
    '../../stores/customFrameworkStore': { listFrameworks: async () => [] },
    '../../auth/permissions': {
        requireAuth: (req, res, next) => (req.headers['x-test-user'] ? next() : res.status(401).json({ error: 'Not authenticated' })),
        requirePermission: () => (req, res, next) => next(),
    },
    './shared': {
        requireOrgId: async (req, res) => {
            const org = req.headers['x-test-org'];
            if (!org) { res.status(403).json({ error: 'no_organisation' }); return null; }
            return org;
        },
    },
    './counts': counts,
});
// compliance/score.js requires './registry' — its own path form; give it the same fake.
const path = require('node:path');
const registryPath = require.resolve(path.join(__dirname, '../../compliance/registry.js'));
require.cache[registryPath] = { id: registryPath, filename: registryPath, loaded: true, exports: registry };

const router = require('./frameworks');
test.after(() => restore());

// ── Harness ────────────────────────────────────────────────────────────────
let server; let baseUrl;
test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = req.headers['x-test-user'] ? { isAuthenticated: true, user: { id: req.headers['x-test-user'] } } : {}; next(); });
    app.use('/api/compliance', router);
    server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise(r => server.close(r)); });
test.beforeEach(() => { for (const k of Object.keys(calls)) calls[k].length = 0; resetPolicy(); });

const hdrs = { 'x-test-user': 'u1', 'x-test-org': 'orgA', 'content-type': 'application/json' };
const get = () => fetch(`${baseUrl}/api/compliance/frameworks`, { headers: hdrs });
const post = (p, body) => fetch(`${baseUrl}/api/compliance/frameworks${p}`, { method: 'POST', headers: hdrs, body: body ? JSON.stringify(body) : undefined });

test('GET: all ten built-ins, locked ones returned locked (never hidden), scores only for active frameworks', async () => {
    const res = await get();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const body = await res.json();
    assert.deepEqual(body.frameworks.map(f => f.id), ['gdpr', 'aia', 'iso27001', 'nis2', 'cra', 'data_act', 'pld', 'eaa', 'dora', 'machinery']);
    assert.deepEqual(body.custom, []);
    const gdpr = body.frameworks[0];
    assert.equal(gdpr.name_key, 'compliance.fw_gdpr_name');
    assert.equal(gdpr.regulation_code, 'Verordening (EU) 2016/679 · UAVG');
    assert.equal(gdpr.in_force_since, '2018-05-25');
    assert.equal(gdpr.core, true);
    assert.equal(gdpr.enabled, true);
    assert.equal(gdpr.locked, null);
    assert.equal(gdpr.checks_count, 2);
    assert.deepEqual(gdpr.registers, ['dsr', 'incidents', 'ropa', 'dpia']);
    assert.equal(gdpr.calendar_count, 1);
    assert.equal(gdpr.score, 60, 'pass(w3) + fail(w2) = 3/5');
    assert.equal(gdpr.recently_in_force, false);
    assert.deepEqual(Object.keys(gdpr.phases[0]), ['date', 'label_key']);

    const nis2 = body.frameworks.find(f => f.id === 'nis2');
    assert.equal(nis2.locked, 'ceiling');
    assert.deepEqual(nis2.lock, { feature: 'compliance_hub_nis2', required: 'enterprise', current: 'community', upgrade_url: UPGRADE_URL });
    assert.equal(nis2.score, null, 'a locked framework has no score');
    assert.equal(nis2.recently_in_force, true, 'in force 2026-08-15, 30 days ago');

    const cra = body.frameworks.find(f => f.id === 'cra');
    assert.equal(cra.enabled, false);
    assert.equal(cra.score, null, 'a candidate carries no score even when stale rows exist');
    assert.equal(cra.recently_in_force, true);
    assert.equal(cra.checks_count, 1);

    const iso = body.frameworks.find(f => f.id === 'iso27001');
    assert.equal(iso.in_force_since, null);
    assert.equal(iso.score, 0, 'the A.5.20-tagged GDPR failure counts for ISO');

    const aia = body.frameworks.find(f => f.id === 'aia');
    assert.deepEqual(aia.affects, { automations: 3, agents: 4, webpages: null, forms: null });
    assert.deepEqual(body.frameworks.find(f => f.id === 'eaa').affects, { automations: null, agents: null, webpages: 6, forms: 2 });
    assert.equal(body.frameworks.find(f => f.id === 'dora').relevance, 'not_relevant');
    assert.equal(body.frameworks.find(f => f.id === 'dora').affects, null);
});

test('GET: every framework carries its sources and legal review, and the catalogue its oldest check', async () => {
    const body = await (await get()).json();
    for (const f of body.frameworks) {
        assert.ok(Array.isArray(f.sources) && f.sources.length > 0, `${f.id} sources`);
        assert.match(f.sources[0].url, /^https:\/\//);
        assert.equal(typeof f.legal_review.stale, 'boolean');
        assert.equal(f.legal_review.stale_after_days, 90);
    }
    assert.ok(body.catalogue && typeof body.catalogue.stale === 'boolean');
    assert.match(body.catalogue.verified_on, /^\d{4}-\d{2}-\d{2}$/);
});

test('POST enable: setEnabled → runFramework (awaited) → evidence row with an allow-listed payload → counts invalidated; response carries the framework', async () => {
    const res = await post('/cra/enable');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(calls.setEnabled, [{ orgId: 'orgA', id: 'cra', on: true, actorId: 'u1' }]);
    assert.deepEqual(calls.runFramework, [{ orgId: 'orgA', id: 'cra', opts: { runType: 'manual' } }]);
    assert.equal(calls.evidence.length, 1);
    const ev = calls.evidence[0];
    assert.equal(ev.organization_id, 'orgA');
    assert.equal(ev.subject_type, 'framework');
    assert.equal(ev.subject_id, 'cra');
    assert.equal(ev.check_id, null);
    assert.deepEqual(Object.keys(ev.payload).sort(), ['action', 'at', 'by', 'checks_ran', 'framework_id', 'regulation']);
    assert.equal(ev.payload.action, 'framework_enabled');
    assert.equal(ev.payload.regulation, 'CRA');
    assert.equal(ev.payload.checks_ran, 1);
    assert.deepEqual(calls.invalidated, ['orgA']);
    assert.equal(body.ran, 1);
    assert.equal(body.framework.id, 'cra');
    assert.equal(body.framework.enabled, true);
    assert.equal(body.framework.score, 0, 'the fresh CRA failure is now scored');
});

test('POST enable on a ceiling-locked framework → 403 with requireCapability\'s feature_locked body; nothing runs, nothing is written', async () => {
    const res = await post('/nis2/enable');
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), {
        error: 'feature_locked', feature: 'compliance_hub_nis2', required: 'enterprise', current: 'community', upgrade_url: UPGRADE_URL,
    });
    assert.equal(calls.runFramework.length, 0);
    assert.equal(calls.evidence.length, 0);
    assert.equal(calls.invalidated.length, 0);
});

test('POST enable on a not-granted framework → 403 feature_disabled', async () => {
    const res = await post('/pld/enable');
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'feature_disabled', feature: 'compliance_hub_pld' });
});

test('POST disable on a core framework → 400 framework_core; unknown id → 400 unknown_framework (before the policy is asked)', async () => {
    const r1 = await post('/gdpr/disable');
    assert.equal(r1.status, 400);
    assert.deepEqual(await r1.json(), { error: 'framework_core', framework: 'gdpr' });
    const r2 = await post('/hipaa/enable');
    assert.equal(r2.status, 400);
    assert.deepEqual(await r2.json(), { error: 'unknown_framework', framework: 'hipaa' });
    assert.equal(calls.setEnabled.length, 1, 'the unknown id never reached setEnabled');
});

test('POST disable: setEnabled(false) + evidence, no run; the returned framework is disabled and scoreless', async () => {
    const res = await post('/eaa/disable');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(calls.setEnabled, [{ orgId: 'orgA', id: 'eaa', on: false, actorId: 'u1' }]);
    assert.equal(calls.runFramework.length, 0);
    assert.equal(calls.evidence[0].payload.action, 'framework_disabled');
    assert.equal(body.framework.enabled, false);
    assert.equal(body.framework.score, null);
});

test('POST relevance: validated, stored with the note, evidence row carries relevance + note (truncated), response reflects it', async () => {
    const bad = await post('/dora/relevance', { relevance: 'maybe' });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'invalid_relevance', allowed: ['relevant', 'not_relevant', 'unknown'] });
    const res = await post('/dora/relevance', { relevance: 'relevant', note: 'x'.repeat(600) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(calls.setRelevance.length, 1);
    assert.equal(calls.setRelevance[0].relevance, 'relevant');
    assert.equal(calls.setRelevance[0].note.length, 500);
    assert.equal(calls.evidence[0].payload.action, 'framework_relevance_changed');
    assert.equal(calls.evidence[0].payload.relevance, 'relevant');
    assert.equal(calls.evidence[0].payload.note.length, 500);
    assert.equal(body.framework.relevance, 'relevant');
});

test('a misspelled note key is refused, so a "not relevant" never lands with no reason beside it', async () => {
    // `notes` used to be dropped: the decision reached the evidence chain with
    // no justification, under a 200 carrying the updated framework.
    const res = await post('/dora/relevance', { relevance: 'not_relevant', notes: 'We serve no financial entities.' });
    assert.equal(res.status, 400);
    assert.equal(calls.setRelevance.length, 0, 'a refused request must not reach the policy');
    assert.equal(calls.evidence.length, 0);
});

test('the enable button posts nothing, and a key in its body is a mistake rather than a default', async () => {
    assert.equal((await post('/data_act/enable')).status, 200);
    assert.equal((await post('/dora/enable', { relevance: 'relevant' })).status, 400);
});

test('a failing first sweep still leaves the framework enabled and reports run_error', async () => {
    const warn = console.warn; console.warn = () => {};
    const orig = runner.runFramework;
    runner.runFramework = async () => { throw new Error('checks exploded'); };
    try {
        const res = await post('/data_act/enable');
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.framework.enabled, true);
        assert.equal(body.ran, null);
        assert.equal(body.run_error, 'checks exploded');
        assert.equal(calls.evidence.length, 1, 'the enable is still evidenced');
        assert.ok(!('checks_ran' in calls.evidence[0].payload));
    } finally { runner.runFramework = orig; console.warn = warn; }
});

test('a tagged check whose home framework is off neither scores nor counts for the framework it is tagged for', async () => {
    // The runner runs a check only when its HOME framework is active, so a
    // NIS2 row written before NIS2 was switched off is frozen: it must not keep
    // a pass on the DORA card, and the NIS2 check must not be counted as one
    // of DORA's checks while it cannot run.
    DEFS['NIS2-mfa'] = { id: 'NIS2-mfa', regulation: 'NIS2', severity: 'high', frameworks: [{ regulation: 'NIS2', ref: 'Art. 21', framework_id: 'nis2' }, { regulation: 'DORA', ref: 'Art. 9', framework_id: 'dora' }] };
    DEFS['DORA-reg'] = { id: 'DORA-reg', regulation: 'DORA', severity: 'high', frameworks: [{ regulation: 'DORA', ref: 'Art. 28(3)', framework_id: 'dora' }] };
    latestRows.push({ check_id: 'NIS2-mfa', regulation: 'NIS2', severity: 'high', status: 'pass', run_at: new Date(NOW).toISOString() });
    policyState.dora.enabled = true;
    try {
        const body = await (await get()).json();
        const dora = body.frameworks.find(f => f.id === 'dora');
        assert.equal(dora.checks_count, 1, 'only the DORA-home check would run');
        assert.equal(dora.score, null, 'the frozen NIS2 pass does not score for DORA');
    } finally {
        delete DEFS['NIS2-mfa'];
        delete DEFS['DORA-reg'];
        latestRows.splice(latestRows.findIndex(r => r.check_id === 'NIS2-mfa'), 1);
    }
});

test('the Machinery card counts the detector\'s matches, not NaN of the match list', async () => {
    latestRows.push({
        check_id: 'MACHINERY-Art3-industrial-detection', regulation: 'MACHINERY', severity: 'medium', status: 'warn', run_at: new Date(NOW).toISOString(),
        evidence: { matches: [{ source: 'automation', id: 'a1' }, { source: 'connection', id: 'c1' }], match_count: 7, derived_relevance: 'relevant' },
    });
    try {
        const body = await (await get()).json();
        const machinery = body.frameworks.find(f => f.id === 'machinery');
        assert.deepEqual(machinery.affects, { detections: 7, derived_relevance: 'relevant' });
    } finally {
        latestRows.splice(latestRows.findIndex(r => r.check_id === 'MACHINERY-Art3-industrial-detection'), 1);
    }
});

test('a relevance decision re-runs that framework at once', async () => {
    const res = await post('/dora/relevance', { relevance: 'not_relevant', note: 'No financial-sector clients.' });
    assert.equal(res.status, 200);
    assert.deepEqual(calls.runFramework.map(c => c.id), ['dora']);
    assert.equal(calls.runFramework[0].opts.runType, 'event');
});

test('a failing re-run after a relevance decision still stores the decision', async () => {
    const warn = console.warn; console.warn = () => {};
    const orig = runner.runFramework;
    runner.runFramework = async () => { throw new Error('checks exploded'); };
    try {
        const res = await post('/dora/relevance', { relevance: 'not_relevant', note: 'No financial-sector clients.' });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).framework.relevance, 'not_relevant');
        assert.equal(calls.evidence.length, 1);
    } finally { runner.runFramework = orig; console.warn = warn; }
});

test('no org → 403 no_organisation; no session → 401', async () => {
    const r403 = await fetch(`${baseUrl}/api/compliance/frameworks`, { headers: { 'x-test-user': 'u1' } });
    assert.equal(r403.status, 403);
    assert.deepEqual(await r403.json(), { error: 'no_organisation' });
    const r401 = await fetch(`${baseUrl}/api/compliance/frameworks`);
    assert.equal(r401.status, 401);
});
