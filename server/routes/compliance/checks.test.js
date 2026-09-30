/**
 * Route tests for the check surface (routes/compliance/checks.js) — the layer
 * the SPA actually calls. `runner.test.js` and `frameworkPolicy.test.js` prove
 * the licence gate at module level; until this file there was nothing between
 * them and the browser (review finding M8).
 *
 * Doubles go in through installResolveStub, exactly as frameworks.test.js does
 * it. REAL modules on purpose: `compliance/frameworks` (the catalogue),
 * `compliance/score` (the maths) and `./shared` — so `activeResultsFilter`,
 * `resolveOrgId` and the framework-id↔regulation-code mapping are the shipped
 * code, not a restatement of it.
 *
 * Pinned here:
 *   · a DISABLED framework contributes neither a check row nor a historical
 *     result row — the documented "rows stay in history, filtered at read time"
 *   · `?framework=<id>` narrowing, including the secondary-mapping case (a GDPR
 *     Art. 33 result also counts for ISO A.5.24) and 400 unknown_framework
 *   · per-source checks fan out one row per subject; a check with no result is
 *     `pending`, never invented
 *   · POST /checks/run hands scoresByFramework a set of REGULATION CODES — the
 *     trap the comment at checks.js:165 flags: ids make every score null
 *   · POST /checks/:id/run passes FrameworkDisabledError through as 409
 *     framework_disabled (the stale-tab case) and anything else as 500
 *   · the gate is requireAuth + requirePermission('admin_compliance'), and
 *     behind a refusal NOTHING is read and NOTHING is run
 *
 * Run: cd server && node --test --test-force-exit routes/compliance/checks.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

const { installResolveStub } = require('../../testUtils/stubRequire');

// ── Catalogue doubles ──────────────────────────────────────────────────────
// GDPR-Art33 carries a SECONDARY ISO mapping: asking for ?framework=iso27001
// must return it even though its home regulation is GDPR.
const DEFS = {
    'GDPR-Art33-breach-notification': {
        id: 'GDPR-Art33-breach-notification', regulation: 'GDPR', article: '33', severity: 'high',
        scope: 'global', verification: 'automated',
        frameworks: [{ regulation: 'GDPR', ref: 'Art. 33' }, { regulation: 'ISO27001', ref: 'A.5.24' }],
        titleKey: 'compliance.check_breach_notification_title',
        descriptionKey: 'compliance.check_breach_notification_desc',
        remediationKey: 'compliance.check_breach_notification_fix',
        remediationLink: 'admin/compliance/incidents',
        autoFixId: null,
    },
    'GDPR-Art32-dlp-enabled': {
        id: 'GDPR-Art32-dlp-enabled', regulation: 'GDPR', article: '32', severity: 'critical',
        scope: 'global', verification: 'automated',
        frameworks: [{ regulation: 'GDPR', ref: 'Art. 32' }],
        titleKey: 'compliance.check_dlp_enabled_title', autoFixId: 'enable_dlp',
    },
    'AIA-Art50-ai-disclosure': {
        id: 'AIA-Art50-ai-disclosure', regulation: 'AIA', article: '50', severity: 'medium',
        scope: 'per-source', verification: 'automated',
        frameworks: [{ regulation: 'AIA', ref: 'Art. 50' }],
        titleKey: 'compliance.check_ai_disclosure_title',
    },
    'ISO27001-A.5.1-policies': {
        id: 'ISO27001-A.5.1-policies', regulation: 'ISO27001', article: 'A.5.1', severity: 'medium',
        scope: 'global', verification: 'attestation',
        frameworks: [{ regulation: 'ISO27001', ref: 'A.5.1' }],
        titleKey: 'compliance.check_iso_policies_title',
    },
    // NIS2 is NOT active for this org. Its definition and its historical result
    // row both exist; neither may reach the response.
    'NIS2-Art21(2)(j)-admin-mfa': {
        id: 'NIS2-Art21(2)(j)-admin-mfa', regulation: 'NIS2', article: '21(2)(j)', severity: 'high',
        scope: 'global', verification: 'automated',
        frameworks: [{ regulation: 'NIS2', ref: 'Art. 21(2)(j)' }],
        titleKey: 'compliance.check_admin_mfa_title',
    },
};

const RUN_AT = '2026-09-14T10:00:00.000Z';
const LATEST = [
    { check_id: 'GDPR-Art33-breach-notification', regulation: 'GDPR', severity: 'high', status: 'pass', details: 'ok', run_at: RUN_AT },
    { check_id: 'GDPR-Art32-dlp-enabled', regulation: 'GDPR', severity: 'critical', status: 'fail', details: 'shield off', run_at: RUN_AT },
    { check_id: 'AIA-Art50-ai-disclosure', regulation: 'AIA', severity: 'medium', status: 'warn', scope_id: 'agent-1', run_at: RUN_AT },
    { check_id: 'AIA-Art50-ai-disclosure', regulation: 'AIA', severity: 'medium', status: 'pass', scope_id: 'agent-2', run_at: RUN_AT },
    // the stale row of a framework that was enabled once and disabled since
    { check_id: 'NIS2-Art21(2)(j)-admin-mfa', regulation: 'NIS2', severity: 'high', status: 'fail', details: 'no mfa', run_at: RUN_AT },
];
// ISO27001-A.5.1 deliberately has NO row → it must come back `pending`.

const registry = {
    get: (id) => DEFS[id] || null,
    getAll: () => Object.values(DEFS),
    getByFramework: (code) => Object.values(DEFS).filter(d => d.frameworks.some(f => f.regulation === code)),
    getPrimary: (code) => Object.values(DEFS).filter(d => d.regulation === code),
};

// ── Recording doubles ──────────────────────────────────────────────────────
const calls = { latest: [], history: [], runAll: [], runOne: [], autoFix: [], users: [] };
const reset = () => { for (const k of Object.keys(calls)) calls[k].length = 0; };

const ACTIVE_REGS = new Set(['GDPR', 'AIA', 'ISO27001', 'CUSTOM']);

class HttpishError extends Error {
    constructor(status, body) { super(body.error); this.status = status; this.body = body; }
}

let runOneImpl = async (orgId, id) => ({ check_id: id, status: 'pass', run_at: RUN_AT });
let autoFixImpl = async () => ({ fixed: true });

const runner = {
    runAll: async (orgId, opts) => {
        calls.runAll.push({ orgId, opts });
        return [
            { check_id: 'GDPR-Art33-breach-notification', regulation: 'GDPR', status: 'pass' },
            { check_id: 'GDPR-Art32-dlp-enabled', regulation: 'GDPR', status: 'fail' },
            { check_id: 'ISO27001-A.5.1-policies', regulation: 'ISO27001', status: 'pass' },
            { check_id: 'AIA-Art50-ai-disclosure', regulation: 'AIA', status: 'warn' },
        ];
    },
    runOne: async (orgId, id) => { calls.runOne.push({ orgId, id }); return runOneImpl(orgId, id); },
    autoFix: async (orgId, id, opts) => { calls.autoFix.push({ orgId, id, opts }); return autoFixImpl(orgId, id, opts); },
};

const complianceStore = {
    getLatestPerCheck: async (orgId) => { calls.latest.push(orgId); return LATEST; },
    getCheckHistory: async (orgId, id, limit) => { calls.history.push({ orgId, id, limit }); return [{ check_id: id, status: 'pass', run_at: RUN_AT }]; },
    getSettings: async () => ({}),
};

// The real ./shared resolves the org through userStore — keep that path real
// so `resolveOrgId`'s fallback semantics are the shipped ones.
const userStore = {
    getUser: async (id) => { calls.users.push(id); return id === 'u-orgless' ? { id } : { id, organizationId: 'orgA' }; },
    getOrganization: async () => ({ name: 'ACME' }),
};

const frameworkPolicy = {
    activeRegulations: async () => new Set(ACTIVE_REGS),
    resolve: async () => [],
};

const CUSTOM_FW = { id: 'cf1', code: 'ACME', name: 'ACME policy', status: 'active' };
const customFrameworkStore = {
    listFrameworks: async () => [CUSTOM_FW],
    listChecks: async () => [
        { ref: 'Q1', title: 'Board sign-off', severity: 'high', evidence_required: true, mapped_check_id: null },
        { ref: 'Q2', title: 'Annual review', severity: 'low', evidence_required: false, mapped_check_id: null },
    ],
    customCheckId: (code, ref) => `CUSTOM-${code}-${ref}`,
};

// The gate. `requirePermission` is called at route-definition time, so the
// names it was asked for are collected once, at require.
const permissionsAsked = [];
let denyPermission = false;
const permissions = {
    requireAuth: (req, res, next) => (req.headers['x-test-user'] ? next() : res.status(401).json({ error: 'Not authenticated' })),
    requirePermission: (name) => {
        permissionsAsked.push(name);
        return (req, res, next) => (denyPermission ? res.status(403).json({ error: 'forbidden' }) : next());
    },
};

// compliance/score.js and routes/compliance/shared.js both require the
// registry under their own path spelling — poking the resolved filename gives
// every one of them the same fake.
const registryPath = require.resolve(path.join(__dirname, '../../compliance/registry.js'));
require.cache[registryPath] = { id: registryPath, filename: registryPath, loaded: true, exports: registry };

const restore = installResolveStub({
    '../../stores/complianceStore': complianceStore,
    '../../stores/userStore': userStore,
    // Same double under the spelling auth/orgScope.js uses — that is where
    // ./shared's org read happens, and installResolveStub keys on the string
    // as written, so without this the real store loads and the org is wrong.
    '../stores/userStore': userStore,
    '../../stores/soaStore': { getStats: async () => null },
    '../../stores/ismsDocStore': { listDocs: async () => [] },
    '../../stores/customFrameworkStore': customFrameworkStore,
    '../../compliance/runner': runner,
    '../../compliance/frameworkPolicy': frameworkPolicy,
    '../../auth/permissions': permissions,
});

const router = require('./checks');
test.after(() => restore());

// ── Harness ────────────────────────────────────────────────────────────────
let server; let baseUrl;
test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.session = req.headers['x-test-user'] ? { isAuthenticated: true, user: { id: req.headers['x-test-user'] } } : {};
        next();
    });
    app.use('/api/compliance', router);
    app.use(require('../../core/http/terminalErrorHandler').terminalErrorHandler);
    server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise(r => server.close(r)); });
test.beforeEach(() => {
    reset();
    denyPermission = false;
    runOneImpl = async (orgId, id) => ({ check_id: id, status: 'pass', run_at: RUN_AT });
    autoFixImpl = async () => ({ fixed: true });
});

const hdrs = (over = {}) => ({ 'x-test-user': 'u1', 'content-type': 'application/json', ...over });
const api = (p, init) => fetch(`${baseUrl}/api/compliance${p}`, { headers: hdrs(), ...init });
const getJson = async (p, init) => {
    const res = await api(p, init);
    return { status: res.status, body: await res.json() };
};

// ── GET /checks ────────────────────────────────────────────────────────────

test('GET /checks: one row per active check, per-source checks fan out, a check with no result is pending', async () => {
    const { status, body } = await getJson('/checks');
    assert.equal(status, 200);
    const ids = body.map(r => r.check_id);
    assert.deepEqual(ids.filter(id => id === 'AIA-Art50-ai-disclosure').length, 2, 'per-source: one row per subject');
    assert.deepEqual(
        body.filter(r => r.check_id === 'AIA-Art50-ai-disclosure').map(r => r.scope_id).sort(),
        ['agent-1', 'agent-2'],
    );
    const iso = body.find(r => r.check_id === 'ISO27001-A.5.1-policies');
    assert.equal(iso.status, 'pending', 'no result row → pending, never a made-up pass');
    assert.equal(iso.run_at, null);
    assert.equal(iso.verification, 'attestation');

    const dlp = body.find(r => r.check_id === 'GDPR-Art32-dlp-enabled');
    assert.equal(dlp.status, 'fail');
    assert.equal(dlp.framework_id, 'gdpr', 'regulation code → framework id comes from the real catalogue');
    assert.equal(dlp.weight, 3, 'critical weighs 3 — the same table the score uses');
    assert.equal(dlp.autoFixId, 'enable_dlp');
    assert.equal(calls.latest.length, 1, 'one store read for the whole table');
});

test('GET /checks: a DISABLED framework contributes neither a check row nor its historical result row', async () => {
    const { body } = await getJson('/checks');
    assert.equal(body.find(r => r.check_id === 'NIS2-Art21(2)(j)-admin-mfa'), undefined,
        'the NIS2 definition is not listed for an org that does not have NIS2 active');
    assert.equal(body.some(r => r.regulation === 'NIS2'), false);
    // The row IS still in the store — history is append-only; it is the READ
    // that filters. Prove the row was offered and refused, not simply absent.
    assert.ok(LATEST.some(r => r.regulation === 'NIS2'), 'the fixture really does carry a stale NIS2 row');
    assert.equal(JSON.stringify(body).includes('no mfa'), false, 'not even its details leak');
});

test('GET /checks?framework= narrows, and follows the SECONDARY mapping (a GDPR Art. 33 row is ISO A.5.24 evidence)', async () => {
    const gdpr = (await getJson('/checks?framework=gdpr')).body;
    assert.deepEqual(gdpr.map(r => r.check_id).sort(), ['GDPR-Art32-dlp-enabled', 'GDPR-Art33-breach-notification']);

    const iso = (await getJson('/checks?framework=iso27001')).body;
    assert.deepEqual(iso.map(r => r.check_id).sort(),
        ['GDPR-Art33-breach-notification', 'ISO27001-A.5.1-policies'],
        'the tagged GDPR check joins the ISO list; the untagged GDPR check does not');
    assert.equal(iso.find(r => r.check_id === 'GDPR-Art33-breach-notification').framework_id, 'gdpr',
        'it keeps its HOME framework id — the narrowing does not rewrite where it lives');

    const aia = (await getJson('/checks?framework=aia')).body;
    assert.deepEqual(aia.map(r => r.check_id), ['AIA-Art50-ai-disclosure', 'AIA-Art50-ai-disclosure']);
});

test('GET /checks?framework=<unknown> is 400 unknown_framework and reads nothing', async () => {
    const { status, body } = await getJson('/checks?framework=gpdr');
    assert.equal(status, 400);
    assert.deepEqual(body, { error: 'unknown_framework', framework: 'gpdr' });
    assert.equal(calls.latest.length, 0, 'the 400 is decided before the store is touched');
    // A framework id that is disabled but real is NOT an unknown framework —
    // it is a valid narrowing that simply yields nothing.
    const nis2 = await getJson('/checks?framework=nis2');
    assert.equal(nis2.status, 200);
    assert.deepEqual(nis2.body, []);
});

test('GET /checks: custom-framework rows appear when CUSTOM is active, and ?framework=custom:<id> narrows to them', async () => {
    const all = (await getJson('/checks')).body;
    const custom = all.filter(r => r.regulation === 'CUSTOM');
    assert.deepEqual(custom.map(r => r.check_id), ['CUSTOM-ACME-Q1', 'CUSTOM-ACME-Q2']);
    assert.equal(custom[0].framework_id, 'custom:cf1');
    assert.equal(custom[0].verification, 'attestation');
    assert.equal(custom[0].status, 'pending', 'no persisted CUSTOM result row yet');
    assert.equal(custom[0].evidence_required, true);

    const only = (await getJson('/checks?framework=custom:cf1')).body;
    assert.deepEqual(only.map(r => r.check_id), ['CUSTOM-ACME-Q1', 'CUSTOM-ACME-Q2']);
    assert.equal(only.some(r => r.regulation !== 'CUSTOM'), false, 'a custom narrowing lists no built-in checks');
});

test('GET /checks: CUSTOM inactive → no custom rows at all', async () => {
    ACTIVE_REGS.delete('CUSTOM');
    try {
        const body = (await getJson('/checks')).body;
        assert.equal(body.some(r => r.regulation === 'CUSTOM'), false);
    } finally { ACTIVE_REGS.add('CUSTOM'); }
});

// ── GET /checks/:id/history ────────────────────────────────────────────────

test('GET /checks/:id/history reads that check, capped at 100 rows', async () => {
    const { status, body } = await getJson('/checks/GDPR-Art32-dlp-enabled/history');
    assert.equal(status, 200);
    assert.deepEqual(calls.history, [{ orgId: 'orgA', id: 'GDPR-Art32-dlp-enabled', limit: 100 }]);
    assert.equal(body.length, 1);
});

// ── POST /checks/run ───────────────────────────────────────────────────────

test('POST /checks/run scores against REGULATION CODES — an id set would empty every score', async () => {
    const { status, body } = await getJson('/checks/run', { method: 'POST' });
    assert.equal(status, 200);
    assert.deepEqual(calls.runAll, [{ orgId: 'orgA', opts: { runType: 'manual' } }]);
    assert.equal(body.ran, 4);
    // Only the ACTIVE built-in frameworks get a key. Two failure modes this
    // catches: handing scoresByFramework framework ids (→ `{}`), and falling
    // into the catch-all fallback (→ a key for all ten built-ins).
    assert.deepEqual(Object.keys(body.scores).sort(), ['aia', 'gdpr', 'iso27001']);
    assert.equal(body.scores.gdpr, 40, 'Art. 33 pass (high, w2) + Art. 32 fail (critical, w3) → 2/5');
    assert.equal(body.scores.iso27001, 100, 'A.5.1 pass + the Art. 33 pass tagged A.5.24');
    assert.equal(body.scores.aia, 50, 'one medium warn');
    assert.equal(body.score.total, 4, 'the overall counters come from the same run');
});

test('POST /checks/run: a failing policy read degrades to every built-in framework rather than to no scores', async () => {
    const orig = frameworkPolicy.activeRegulations;
    frameworkPolicy.activeRegulations = async () => { throw new Error('policy down'); };
    try {
        const { status, body } = await getJson('/checks/run', { method: 'POST' });
        assert.equal(status, 200);
        assert.ok(Object.keys(body.scores).length > 3, 'the documented fallback: score everything rather than nothing');
        assert.equal(body.scores.gdpr, 40);
    } finally { frameworkPolicy.activeRegulations = orig; }
});

// ── POST /checks/:id/run ───────────────────────────────────────────────────

test('POST /checks/:id/run passes FrameworkDisabledError through as 409 framework_disabled (the stale-tab case)', async () => {
    runOneImpl = async () => { throw new HttpishError(409, { error: 'framework_disabled', framework: 'nis2' }); };
    const { status, body } = await getJson('/checks/NIS2-Art21(2)(j)-admin-mfa/run', { method: 'POST' });
    assert.equal(status, 409, 'not 500 — the client distinguishes "stale tab" from "server broke"');
    assert.deepEqual(body, { error: 'framework_disabled', framework: 'nis2' });
    assert.deepEqual(calls.runOne, [{ orgId: 'orgA', id: 'NIS2-Art21(2)(j)-admin-mfa' }]);
});

test('POST /checks/:id/run: an error WITHOUT status/body is a 500 that keeps its message server-side', async () => {
    runOneImpl = async () => { throw new Error('pool exhausted'); };
    const { status, body } = await getJson('/checks/GDPR-Art32-dlp-enabled/run', { method: 'POST' });
    assert.equal(status, 500);
    assert.equal(body.error, 'Internal server error');
    assert.match(body.correlationId, /^[0-9a-f-]{36}$/);
    assert.ok(!JSON.stringify(body).includes('pool exhausted'), 'the driver message stays out of the response');
});

test('POST /checks/:id/run: the happy path returns the runner result as-is', async () => {
    const { status, body } = await getJson('/checks/GDPR-Art32-dlp-enabled/run', { method: 'POST' });
    assert.equal(status, 200);
    assert.deepEqual(body, { check_id: 'GDPR-Art32-dlp-enabled', status: 'pass', run_at: RUN_AT });
});

// ── POST /checks/:id/auto-fix ──────────────────────────────────────────────

test('POST /checks/:id/auto-fix runs the fix with the actor, re-runs the check, and reports 400 on refusal', async () => {
    const ok = await getJson('/checks/GDPR-Art32-dlp-enabled/auto-fix', { method: 'POST', body: JSON.stringify({ mode: 'redact' }) });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { ok: true, result: { fixed: true } });
    assert.deepEqual(calls.autoFix, [{ orgId: 'orgA', id: 'GDPR-Art32-dlp-enabled', opts: { mode: 'redact', actorId: 'u1' } }]);
    assert.deepEqual(calls.runOne, [{ orgId: 'orgA', id: 'GDPR-Art32-dlp-enabled' }], 'the UI gets a fresh result');

    autoFixImpl = async () => { throw new Error('no auto-fix for this check'); };
    const bad = await getJson('/checks/ISO27001-A.5.1-policies/auto-fix', { method: 'POST' });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body, { error: 'no auto-fix for this check' });
});

test('POST /checks/:id/auto-fix: a failed re-run never turns a successful fix into an error', async () => {
    runOneImpl = async () => { throw new Error('re-run exploded'); };
    const { status, body } = await getJson('/checks/GDPR-Art32-dlp-enabled/auto-fix', { method: 'POST' });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
});

// ── The gate ───────────────────────────────────────────────────────────────

test('every route asks for admin_compliance, on top of requireAuth', () => {
    assert.equal(permissionsAsked.length, 6, 'six routes: list, history, run-all, run-one, auto-fix, finding state');
    assert.deepEqual([...new Set(permissionsAsked)], ['admin_compliance']);
});

test('no session → 401 on every route, and nothing is read or run', async () => {
    for (const [p, init] of [
        ['/checks', undefined],
        ['/checks/GDPR-Art32-dlp-enabled/history', undefined],
        ['/checks/run', { method: 'POST' }],
        ['/checks/GDPR-Art32-dlp-enabled/run', { method: 'POST' }],
        ['/checks/GDPR-Art32-dlp-enabled/auto-fix', { method: 'POST' }],
    ]) {
        const res = await fetch(`${baseUrl}/api/compliance${p}`, { headers: { 'content-type': 'application/json' }, ...init });
        assert.equal(res.status, 401, `${p} is gated`);
    }
    assert.deepEqual(calls, { latest: [], history: [], runAll: [], runOne: [], autoFix: [], users: [] },
        'behind the 401 nothing was read, nothing was run');
});

test('permission refused → 403, and again nothing is read or run', async () => {
    denyPermission = true;
    for (const [p, init] of [
        ['/checks', undefined],
        ['/checks/run', { method: 'POST' }],
        ['/checks/GDPR-Art32-dlp-enabled/run', { method: 'POST' }],
        ['/checks/GDPR-Art32-dlp-enabled/auto-fix', { method: 'POST' }],
    ]) {
        const { status } = await getJson(p, init);
        assert.equal(status, 403, `${p} is behind admin_compliance`);
    }
    assert.deepEqual(calls.latest, []);
    assert.deepEqual(calls.runAll, []);
    assert.deepEqual(calls.runOne, []);
    assert.deepEqual(calls.autoFix, []);
    assert.deepEqual(calls.users, [], 'not even the org lookup happens behind the gate');
});

// ── Finding states and retired subjects ────────────────────────────────────

test('GET /checks: a decided finding carries its public state; a retired subject row is left out', async () => {
    const findingState = require('../../compliance/findingState');
    const warnRow = LATEST.find(r => r.check_id === 'AIA-Art50-ai-disclosure' && r.scope_id === 'agent-1');
    LATEST.push({ check_id: 'AIA-Art50-ai-disclosure', regulation: 'AIA', severity: 'medium', status: 'not_applicable', scope_type: 'per-source', scope_id: 'agent-gone', evidence: { retired: true }, run_at: RUN_AT });
    complianceStore.listFindingStates = async () => [{
        check_id: 'AIA-Art50-ai-disclosure', scope_key: 'agent-1', fingerprint: findingState.fingerprintOf(warnRow),
        state: 'acknowledged', reason: null, until: null, actor_id: 'u1', updated_at: RUN_AT,
    }];
    try {
        const { body } = await getJson('/checks');
        const agents = body.filter(r => r.check_id === 'AIA-Art50-ai-disclosure');
        assert.deepEqual(agents.map(r => r.scope_id).sort(), ['agent-1', 'agent-2'], 'the retired slot is history, not a row');
        const acked = agents.find(r => r.scope_id === 'agent-1');
        assert.equal(acked.finding_state.state, 'acknowledged');
        assert.equal(acked.finding_state.active, true);
        assert.equal('fingerprint' in acked.finding_state, false);
        assert.equal(agents.find(r => r.scope_id === 'agent-2').finding_state, null);
    } finally {
        LATEST.pop();
        delete complianceStore.listFindingStates;
    }
});
