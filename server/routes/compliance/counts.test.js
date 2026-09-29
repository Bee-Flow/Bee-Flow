/**
 * Route tests for GET /api/compliance/counts (routes/compliance/counts.js).
 *
 * Every dependency is injected through createCountsRouter(deps) — no DB, no
 * pool; requests go over real HTTP against express app.listen(0). Pinned is
 * the CONTRACT: the §1.2 shape and tones, ISO keys omitted when iso27001 is
 * not active, `frameworks.<id>` only for enabled frameworks, a failing store
 * drops one key and that partial body is not cached, 60 s per-org cache +
 * invalidate(orgId), `?keys=` filtering, `Cache-Control: private, no-store`,
 * 403 no_organisation — and that the endpoint NEVER calls the runner (the
 * injected runner throws; nothing here even requires it).
 *
 * Run: cd server && node --test --test-force-exit routes/compliance/counts.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

// A runner that throws on every call: if counts.js ever reaches for it, the
// require.cache poke makes it explode loudly instead of running checks.
const runnerPath = require.resolve(path.join(__dirname, '../../compliance/runner.js'));
require.cache[runnerPath] = {
    id: runnerPath, filename: runnerPath, loaded: true,
    exports: new Proxy({}, { get: (_t, prop) => () => { throw new Error(`counts.js must not call runner.${String(prop)}`); } }),
};

const { createCountsRouter, KIND_KEYS, CACHE_TTL_MS, invalidate, toneOfScore } = require('./counts');

const NOW = Date.parse('2026-09-14T12:00:00Z');
const H = 3600_000;
const D = 24 * H;
const at = (ms) => new Date(ms).toISOString();

const DEFS = {
    'GDPR-Art32-dlp-enabled': { id: 'GDPR-Art32-dlp-enabled', regulation: 'GDPR', severity: 'critical', frameworks: [{ regulation: 'GDPR', ref: 'Art. 32' }] },
    'GDPR-Art28-subprocessors': { id: 'GDPR-Art28-subprocessors', regulation: 'GDPR', severity: 'high', frameworks: [{ regulation: 'GDPR', ref: 'Art. 28' }, { regulation: 'ISO27001', ref: 'A.5.20' }] },
    'AIA-Art50-ai-disclosure': { id: 'AIA-Art50-ai-disclosure', regulation: 'AIA', severity: 'medium', frameworks: [{ regulation: 'AIA', ref: 'Art. 50' }] },
    'ISO27001-A.5.1-policies': { id: 'ISO27001-A.5.1-policies', regulation: 'ISO27001', severity: 'medium', frameworks: [{ regulation: 'ISO27001', ref: 'A.5.1' }] },
    'NIS2-Art21(2)(j)-admin-mfa': { id: 'NIS2-Art21(2)(j)-admin-mfa', regulation: 'NIS2', severity: 'high', frameworks: [{ regulation: 'NIS2', ref: 'Art. 21(2)(j)' }] },
};

function policyRows(over = {}) {
    const base = {
        gdpr: { regulation: 'GDPR', enabled: true, core: true, locked: null, relevance: 'unknown' },
        aia: { regulation: 'AIA', enabled: true, core: true, locked: null, relevance: 'unknown' },
        iso27001: { regulation: 'ISO27001', enabled: true, core: true, locked: null, relevance: 'unknown' },
        nis2: { regulation: 'NIS2', enabled: false, core: false, locked: 'ceiling', relevance: 'unknown' },   // in force 2026-08-15 → 30 d ago
        cra: { regulation: 'CRA', enabled: false, core: false, locked: null, relevance: 'unknown' },          // in force 2026-09-11 → 3 d ago
        data_act: { regulation: 'DATA_ACT', enabled: false, core: false, locked: null, relevance: 'unknown' },
        pld: { regulation: 'PLD', enabled: false, core: false, locked: 'not_granted', relevance: 'unknown' },
        eaa: { regulation: 'EAA', enabled: false, core: false, locked: null, relevance: 'unknown' },
        dora: { regulation: 'DORA', enabled: false, core: false, locked: null, relevance: 'not_relevant' },
        machinery: { regulation: 'MACHINERY', enabled: false, core: false, locked: null, relevance: 'not_relevant' },
    };
    return Object.entries({ ...base, ...over }).map(([id, p]) => ({ id, ...p }));
}

// The real score module is pure (needs the registry for shared checks); we
// hand it a registry fake through the same deps object.
const realScore = require('../../compliance/score');

function makeDeps(overrides = {}) {
    const calls = {};
    const rec = (n) => { calls[n] = (calls[n] || 0) + 1; };
    let clock = NOW;
    const registry = { get: (id) => DEFS[id] || null, getAll: () => Object.values(DEFS) };
    const latest = [
        { check_id: 'GDPR-Art32-dlp-enabled', regulation: 'GDPR', severity: 'critical', status: 'pass', run_at: at(NOW - 2 * H) },
        { check_id: 'GDPR-Art28-subprocessors', regulation: 'GDPR', severity: 'high', status: 'warn', run_at: at(NOW - H) },
        { check_id: 'AIA-Art50-ai-disclosure', regulation: 'AIA', status: 'fail', run_at: at(NOW - 3 * H) },
        { check_id: 'ISO27001-A.5.1-policies', regulation: 'ISO27001', severity: 'medium', status: 'pass', run_at: at(NOW - 3 * H) },
        { check_id: 'NIS2-Art21(2)(j)-admin-mfa', regulation: 'NIS2', status: 'fail', run_at: at(NOW - 3 * H) }, // stale row of a non-active framework
    ];
    const deps = {
        now: () => clock,
        _tick: (ms) => { clock += ms; },
        _calls: calls,
        shared: {
            requireOrgId: async (req, res) => {
                const org = req.headers['x-test-org'];
                if (!org) { res.status(403).json({ error: 'no_organisation' }); return null; }
                return org;
            },
        },
        permissions: {
            requireAuth: (req, res, next) => (req.headers['x-test-user'] ? next() : res.status(401).json({ error: 'Not authenticated' })),
            requirePermission: () => (req, res, next) => next(),
        },
        complianceStore: {
            getLatestPerCheck: async () => { rec('latest'); return latest; },
            getSettings: async () => ({ onboarded_at: at(NOW - 100 * D), ropa_reviewed_at: at(NOW - 10 * D), dpo_name: 'x', breach_recipients: ['a'] }),
        },
        frameworkPolicy: { resolve: async () => { rec('policy'); return policyRows(); }, activeRegulations: async () => new Set(['GDPR', 'AIA', 'ISO27001']) },
        frameworks: require('../../compliance/frameworks'),
        registry,
        score: {
            scoresByFramework: (rows, active) => {
                // Mirrors compliance/score.js: keyed by framework ID, gated on
                // a Set of REGULATION CODES (not ids — pinning that here is the
                // point, an id set silently scores nothing). Registry-
                // independent: home regulation only + the explicit tag.
                const by = {};
                for (const fw of deps.frameworks.listBuiltin()) {
                    if (active && !active.has(fw.regulation)) continue;
                    const mine = rows.filter(r => (DEFS[r.check_id]?.frameworks || []).some(f => f.regulation === fw.regulation));
                    by[fw.id] = mine.length ? realScore.computeScore(mine) : null;
                }
                return by;
            },
        },
        attention: { build: async (orgId, opts) => { rec('attention'); assert.equal(opts.limit, 0); return { total: 7, items: [], complete: true }; } },
        chain: { verifyChain: async (orgId, { limit }) => { rec('chain'); assert.equal(limit, 200); return { ok: true, rows_total: 2053, verified_rows: 200 }; } },
        dsrStore: {
            listOpenWithDeadlines: async () => [
                { id: 1, due_at: at(NOW - D) }, { id: 2, due_at: at(NOW + 3 * D) }, { id: 3, due_at: at(NOW + 20 * D) }, { id: 4, due_at: at(NOW + 25 * D) },
            ],
        },
        incidentStore: {
            getDeadlineStats: async () => ({ open: 1, overdue_unnotified: 0, nearing_deadline: 0, vulnerabilities_open: 3 }),
            listOpenClocks: async () => [{ id: 7, deadline_at: at(NOW + 41 * H + 30 * 60_000), authority_notified_at: null }],
        },
        dpiaStore: {
            listForOrg: async () => [{ agent_id: 'a1', approved_at: at(NOW - D), expires_at: at(NOW + D) }, { agent_id: 'a2', approved_at: null }],
            isCurrent: (r) => !!r.approved_at && (!r.expires_at || new Date(r.expires_at).getTime() > clock),
        },
        riskStore: { getStats: async () => ({ total: 12, high: 2 }) },
        soaStore: { getStats: async () => ({ total: 93, approved: 9, todo: 61 }) },
        ismsDocStore: { listDocs: async () => [{ status: 'published', review_due_at: at(NOW - D) }, { status: 'published', review_due_at: at(NOW + D) }, { status: 'draft' }] },
        isoAuditStore: { listAudits: async () => [{ id: 1, status: 'planned' }, { id: 2, status: 'completed', completed_at: at(NOW - D) }] },
        isoEvidenceStore: { listConfigs: async () => [{ enabled: true, last_sweep_at: at(NOW - 2 * H) }, { enabled: true, last_sweep_at: at(NOW - 5 * H) }, { enabled: false }] },
        db: { getOne: async () => ({ total: 44, done: 41 }) },
    };
    return Object.assign(deps, overrides);
}

// ── Server harness ──────────────────────────────────────────────────────────
let server;
let baseUrl;

function mount(deps) {
    const app = express();
    app.use('/api/compliance', createCountsRouter(deps));
    return app;
}
async function listen(app) {
    if (server) await new Promise((resolve) => server.close(resolve));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
}
test.after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); });
test.beforeEach(() => invalidate());

const get = ({ user = 'u1', org = 'orgA', query = '' } = {}) => fetch(`${baseUrl}/api/compliance/counts${query}`, {
    headers: { ...(user ? { 'x-test-user': user } : {}), ...(org ? { 'x-test-org': org } : {}) },
});

test('full body: every key of the §1.2 shape, tones per score, ISO keys present when iso27001 is active', async () => {
    const deps = makeDeps();
    await listen(mount(deps));
    const res = await get();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), [...KIND_KEYS].sort());

    assert.equal(body.attention_open, 7);
    assert.deepEqual(body.last_run, { at: at(NOW - H), interval_hours: 6 });
    // gdpr: pass(w3) + warn(w2×.5) = 4/5 → 80 good; aia: fail → 0 bad; iso: A.5.1 pass(w1) + A.5.20-tagged warn(w2×.5) = 2/3 → 67 warn
    assert.deepEqual(body.frameworks, {
        gdpr: { score: 80, tone: 'good' },
        aia: { score: 0, tone: 'bad' },
        iso27001: { score: 67, tone: 'warn' },
    });
    assert.ok(!('nis2' in body.frameworks), 'a candidate never gets a score key');
    // 3 active; 7 candidates; nis2 (30 d) + cra (3 d) recently in force; nis2 + pld locked
    assert.deepEqual(body.frameworks_summary, { active: 3, candidates: 7, recently_in_force: 2, locked: 2 });
    assert.deepEqual(body.dsr, { open: 4, overdue: 1, due_soon: 1 });
    assert.deepEqual(body.incidents, { open: 1, next_deadline_at: at(NOW + 41 * H + 30 * 60_000), hours_left: 41, vulnerabilities_open: null });
    assert.deepEqual(body.ropa, { last_reviewed_at: at(NOW - 10 * D) });
    assert.deepEqual(body.dpia, { todo: 1 });
    assert.deepEqual(body.risks, { total: 12, high: 2 });
    assert.deepEqual(body.soa, { approved: 9, total: 93 });
    assert.deepEqual(body.policies, { total: 2, review_due: 1 });
    assert.deepEqual(body.audits, { planned: 1 });
    assert.deepEqual(body.training, { done: 41, total: 44 });
    assert.deepEqual(body.connectors, { count: 2, next_sweep_at: at(NOW - 2 * H + 6 * H) });
    assert.deepEqual(body.evidence, { rows: 2053, chain_ok: true, algorithm: 'SHA-256', checked_rows: 200 });
    assert.equal(body.onboarded, true);
    assert.equal(body.setup_step, null);
    // the two expensive reads happen once per computation, not once per key
    assert.equal(deps._calls.latest, 1);
    assert.equal(deps._calls.policy, 1);
});

// ── "counts NEVER triggers a check run" ────────────────────────────────────
//
// This used to be pinned by poking a throwing runner into require.cache and
// then asserting that the poke itself throws — green whatever counts.js does,
// for two independent reasons (review finding M9): counts.js never requires
// the runner, so the poked module is unreachable from the subject; and even a
// real call would be swallowed by computeCounts' per-kind try/catch, turning
// into a dropped key rather than a failure.
//
// The three assertions below can each fail on their own:
//   1. a tripwire on Module.prototype.require that RECORDS (outside any
//      try/catch of the subject) and then throws, armed for the duration of a
//      real request — wiring the runner in, lazily or at load, trips it;
//   2. an injected `runner` double on the deps object, resolved the way every
//      other dependency is, that records and throws if anything reaches for it;
//   3. a source-level assertion that no `require(…runner…)` appears in
//      counts.js's live code at all.
// 1 and 2 would be swallowed downstream, so the response is also asserted
// COMPLETE (every KIND_KEYS key present) and console.warn asserted silent —
// the two symptoms a swallowed throw leaves behind.
const Module = require('node:module');

function armRunnerTripwire() {
    const original = Module.prototype.require;
    const hits = [];
    Module.prototype.require = function (request) {
        let resolved = null;
        try { resolved = Module._resolveFilename(request, this); } catch { /* unresolvable — not the runner */ }
        if (resolved === runnerPath) {
            hits.push(request);
            throw new Error(`counts.js must not require the runner (saw require('${request}'))`);
        }
        return original.apply(this, arguments);
    };
    return { hits, disarm: () => { Module.prototype.require = original; } };
}

test('the runner is never required and never called — tripwire, injected double and source all say so', async () => {
    const runnerCalls = [];
    const deps = makeDeps({
        // Resolved through makeLazyDeps like every other dependency: the day
        // someone adds `runner: () => require(...)` to DEFAULT_LOADERS and
        // calls it, this double answers instead of the real one.
        runner: new Proxy({}, {
            get: (_t, prop) => (...args) => {
                runnerCalls.push({ fn: String(prop), args });
                throw new Error(`counts.js must not call runner.${String(prop)}`);
            },
        }),
    });
    await listen(mount(deps));

    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...a) => warnings.push(a.join(' '));
    const tripwire = armRunnerTripwire();
    let res;
    try {
        res = await get();
    } finally {
        tripwire.disarm();
        console.warn = realWarn;
    }

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(tripwire.hits, [], 'nothing in the request path required compliance/runner');
    assert.deepEqual(runnerCalls, [], 'nothing reached for an injected runner either');
    // A tripped tripwire inside a kind would be swallowed by the per-kind
    // try/catch, so the symptoms it leaves behind are pinned as well.
    assert.deepEqual(Object.keys(body).sort(), [...KIND_KEYS].sort(), 'a complete body: no kind quietly dropped a key');
    assert.deepEqual(warnings, [], 'and nothing was logged as a failed kind');
});

test('counts.js does not require the runner at all — the dependency is absent, not merely unused', () => {
    // Bewust brontekst, en dat is de bedoeling: dit pint een eigenschap van de
    // STATISCHE require-graaf ('geen enkele require-specifier noemt de
    // runner'), niet van uitvoering. De tripwire-test hierboven bewijst al dat
    // niets de runner AANROEPT tijdens een echte request; deze test is de
    // sterkere garantie dat de import ook niet in een dode tak bestaat om
    // later per ongeluk bereikbaar te worden.
    const src = require('node:fs').readFileSync(path.join(__dirname, 'counts.js'), 'utf8');
    const live = src
        .replace(/\/\*[\s\S]*?\*\//g, '')       // block comments (the module docstring talks about the runner)
        .replace(/^[ \t]*\/\/.*$/gm, '');       // whole-line // comments
    const specifiers = [...live.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
    assert.ok(specifiers.length > 5, 'the scan really did see the require graph');
    assert.deepEqual(specifiers.filter(s => /runner/i.test(s)), [],
        'the auto-run on staleness lives in overview.js and only there');
    // The word survives only in prose.
    assert.equal(/runner/i.test(live), false, 'no live reference to a runner of any spelling');
    assert.ok(/runner/i.test(src), 'the rule is still documented in the comments');
});

test('ISO register keys are OMITTED (not 0) when iso27001 is not active; vulnerabilities_open appears with CRA', async () => {
    await listen(mount(makeDeps({
        frameworkPolicy: {
            resolve: async () => policyRows({
                iso27001: { regulation: 'ISO27001', enabled: false, core: true, locked: 'ceiling' },
                cra: { regulation: 'CRA', enabled: true, core: false, locked: null },
            }),
        },
    })));
    const body = await (await get()).json();
    for (const k of ['risks', 'soa', 'policies', 'audits', 'training', 'connectors']) assert.ok(!(k in body), `${k} omitted`);
    assert.ok(!('iso27001' in body.frameworks));
    assert.equal(body.incidents.vulnerabilities_open, 3);
    assert.equal(body.frameworks_summary.active, 3, 'gdpr + aia + cra');
});

test('one failing store drops ONE key, the body is served, and that partial body is NOT cached', async () => {
    const warn = console.warn; console.warn = () => {};
    try {
        let fail = true;
        const deps = makeDeps({ soaStore: { getStats: async () => { if (fail) throw new Error('db down'); return { total: 93, approved: 9 }; } } });
        await listen(mount(deps));
        const b1 = await (await get()).json();
        assert.ok(!('soa' in b1));
        assert.deepEqual(b1.risks, { total: 12, high: 2 }, 'the rest is there');
        fail = false;
        const b2 = await (await get()).json();
        assert.deepEqual(b2.soa, { approved: 9, total: 93 }, 'recounted on the next request — nothing was cached');
        assert.equal(deps._calls.latest, 2);
    } finally { console.warn = warn; }
});

test('a complete body is cached 60 s per org; invalidate(orgId) drops it; another org is not served from it', async () => {
    const deps = makeDeps();
    await listen(mount(deps));
    await get(); await get();
    assert.equal(deps._calls.latest, 1, 'second request from cache');
    await get({ org: 'orgB' });
    assert.equal(deps._calls.latest, 2, 'per-org cache');
    invalidate('orgA');
    await get();
    assert.equal(deps._calls.latest, 3);
    deps._tick(CACHE_TTL_MS + 1);
    await get();
    assert.equal(deps._calls.latest, 4, 'expired');
});

test('?keys= filters the (cached) body to the requested keys; unknown keys are ignored', async () => {
    const deps = makeDeps();
    await listen(mount(deps));
    const body = await (await get({ query: '?keys=attention_open,dsr,nope' })).json();
    assert.deepEqual(body, { attention_open: 7, dsr: { open: 4, overdue: 1, due_soon: 1 } });
    const full = await (await get()).json();
    assert.equal(Object.keys(full).length, KIND_KEYS.length, 'the filter never narrows the cache');
    assert.equal(deps._calls.latest, 1);
});

test('no organisation → 403 no_organisation; no session → 401', async () => {
    await listen(mount(makeDeps()));
    const r403 = await get({ org: null });
    assert.equal(r403.status, 403);
    assert.deepEqual(await r403.json(), { error: 'no_organisation' });
    const r401 = await get({ user: null });
    assert.equal(r401.status, 401);
});

test('an incomplete attention list drops attention_open rather than reporting a too-small number', async () => {
    const warn = console.warn; console.warn = () => {};
    try {
        await listen(mount(makeDeps({ attention: { build: async () => ({ total: 2, items: [], complete: false }) } })));
        const body = await (await get()).json();
        assert.ok(!('attention_open' in body));
    } finally { console.warn = warn; }
});

test('setup_step walks the four tiles until onboarded', async () => {
    const mk = (settings) => makeDeps({ complianceStore: { getLatestPerCheck: async () => [], getSettings: async () => settings } });
    await listen(mount(mk({})));
    assert.equal((await (await get()).json()).setup_step, 1);
    invalidate();
    await listen(mount(mk({ dpo_name: 'Ann' })));
    assert.equal((await (await get()).json()).setup_step, 2);
    invalidate();
    await listen(mount(mk({ dpo_name: 'Ann', breach_recipients: ['dpo@x'] })));
    assert.equal((await (await get()).json()).setup_step, 3);
    invalidate();
    await listen(mount(mk({ dpo_name: 'Ann', breach_recipients: ['dpo@x'], ropa_reviewed_at: at(NOW) })));
    const b = await (await get()).json();
    assert.equal(b.setup_step, 4);
    assert.equal(b.onboarded, false);
});

test('toneOfScore thresholds: good ≥ 80, warn ≥ 60, bad below, none for null', () => {
    assert.equal(toneOfScore(100), 'good');
    assert.equal(toneOfScore(80), 'good');
    assert.equal(toneOfScore(79), 'warn');
    assert.equal(toneOfScore(60), 'warn');
    assert.equal(toneOfScore(59), 'bad');
    assert.equal(toneOfScore(0), 'bad');
    assert.equal(toneOfScore(null), 'none');
});
