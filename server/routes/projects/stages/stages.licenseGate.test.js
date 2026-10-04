/**
 * The licence gates of the stage API, route by route.
 *
 * Every licensed route carries its OWN gate (never a path-less router.use, see
 * routes/projects/packaging.licenseGate.test.js for what that cost once): this
 * file locks one feature at a time and proves that exactly the routes that
 * name it answer 403 feature_locked, and that with the licence open the same
 * requests are not stopped by the licence. It also proves the other half of
 * D13: the drain router needs no licence and no `projects` capability, so a
 * lapse never strands production, while the licensed router beside it is shut.
 *
 * Fakes only; no module is replaced.
 *
 * Run: cd server && node --test routes/projects/stages/stages.licenseGate.test.js
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const { terminalErrorHandler } = require('../../../core/http/terminalErrorHandler');
const { makeStagesRouter } = require('./index');
const { makeSolutionStagesDrainRouter } = require('../../solutionStages');

const DEV = { id: 'dev', name: 'Invoices', ownerId: 'so', organizationId: 'org1', kind: 'solution', stage: null };
const STAGE = {
    projectId: 'uat', solutionId: 'dev', stage: 'uat', organizationId: 'org1', runAsUserId: 'so', enabled: true, pausedState: null,
    requiresApproval: false, settingsVersion: 1, currentReleaseId: null, bindingsPending: false,
};

const locked = new Set();
let featureAsked = [];

/** Everything answers; the routes stop at the gate or get as far as a plain 2xx/4xx of their own. */
const deps = () => ({
    requireFeature: (feature) => (req, res, next) => {
        featureAsked.push(feature);
        return locked.has(feature) ? res.status(403).json({ error: 'feature_locked', feature }) : next();
    },
    projectStore: { getProject: async (id) => (id === 'dev' ? DEV : null), logActivity: async () => {} },
    stageStore: {
        getStage: async (id) => (id === 'uat' ? STAGE : null),
        getStageFor: async (_dev, stage) => (stage === 'uat' ? STAGE : null),
        listStages: async () => [STAGE],
        listDeployments: async () => [],
        getDeployment: async () => null,
        listVariables: async () => [],
        listVariableValues: async () => [],
        listBindings: async () => [],
        setPausedState: async () => ({ ...STAGE, pausedState: null }),
        createStages: async () => [],
        detachStage: async () => ({ stage: 'uat' }),
    },
    blueprintStore: {
        listStamps: async () => new Map(),
        listPipelineReleases: async () => [],
        getRelease: async () => null,
        getReleasePayloads: async () => [],
        refsFor: async () => [],
    },
    getProjectRole: async () => 'owner',
    isOrgAdminForOrg: async () => false,
    refusedContent: async () => ({}),
    approvalGate: { validatePolicy: async () => [] },
    runner: { admit: async () => ({ deployment: { id: 'dep_1', status: 'queued' }, replayed: false }), workerId: 'w' },
    plan: async () => ({ planHash: 'ph', acknowledgementsRequired: [], blocking: [] }),
    cutRelease: async () => ({ release: { id: 'rel_1', seq: 1 }, reused: false, replayed: false, findings: [] }),
    releaseGate: async () => ({ blocked: false, findings: [] }),
    readCutState: async () => ({ tokens: {} }),
    readSourceCut: async () => null,
    automationStore: { getAutomationsForProject: async () => [] },
    userStore: { getUser: async () => null },
    publicBaseUrl: () => 'https://bee.test',
    notify: async () => {},
    defer: (fn) => fn(),
});

// ── [feature(s) the route needs, method, path, body] ─────────────────────────────

const D = '/api/projects/dev';
const ROUTES = [
    ['projects', 'GET', `${D}/pipeline`],
    ['blueprint_packaging', 'POST', `${D}/stages`, { stages: ['uat'] }],
    ['blueprint_packaging', 'DELETE', `${D}/stages/uat`, { confirm: 'Invoices', mode: 'delete' }],
    ['projects', 'GET', `${D}/stages/uat`],
    ['blueprint_packaging', 'PATCH', `${D}/stages/uat`, { settingsVersion: 1, requiresApproval: false }],
    // Turning the gate ON needs the approvals feature as well.
    [['blueprint_packaging', 'approvals'], 'PATCH', `${D}/stages/uat`, { settingsVersion: 1, requiresApproval: true }],
    ['projects', 'GET', `${D}/stages/uat/requirements`],
    ['blueprint_packaging', 'PUT', `${D}/stages/uat/bindings`, { settingsVersion: 1, bindings: [{ slot: 'slug:w', value: null }] }],
    ['projects', 'GET', `${D}/variables`],
    ['blueprint_packaging', 'PUT', `${D}/variables`, { variables: [] }],
    ['projects', 'GET', `${D}/stages/uat/variables`],
    ['projects', 'PUT', `${D}/stages/uat/variables`, { values: { a: 'b' } }],
    ['projects', 'PATCH', `${D}/stages/uat/parts/aut_1`, { active: true }],
    ['projects', 'POST', `${D}/stages/uat/pause`, {}],
    ['projects', 'POST', `${D}/stages/uat/resume`, {}],
    ['blueprint_packaging', 'PATCH', `${D}/parts/dt_1/options`, { reference: true }],
    ['blueprint_packaging', 'POST', `${D}/releases`, { requestKey: 'k' }],
    ['blueprint_packaging', 'GET', `${D}/releases`],
    ['blueprint_packaging', 'GET', `${D}/releases/rel_1`],
    ['blueprint_packaging', 'POST', `${D}/stages/uat/plan`, { releaseId: 'rel_1' }],
    ['blueprint_packaging', 'POST', `${D}/release-and-deploy`, { requestKey: 'k' }],
    ['blueprint_packaging', 'POST', `${D}/stages/uat/deployments`, { releaseId: 'r', kind: 'deploy', planHash: 'p', requestKey: 'k' }],
    ['projects', 'GET', `${D}/deployments`],
    ['projects', 'GET', `${D}/deployments/dep_1`],
    ['blueprint_packaging', 'POST', `${D}/deployments/dep_1/cancel`, {}],
    ['blueprint_packaging', 'POST', `${D}/deployments/dep_1/retry`, {}],
];

// ── Harness ───────────────────────────────────────────────────────────────────

let server;
let base;
const projectsCapability = { allowed: true };

before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { user: { id: 'so', organizationId: 'org1' }, isAuthenticated: true }; next(); });
    // The wiring of index.js: the licensed router sits behind the `projects` capability, the drain router does not.
    const projectsCapabilityGate = (req, res, next) => (projectsCapability.allowed ? next() : res.status(403).json({ error: 'capability_missing', capability: 'projects' }));
    app.use('/api/projects', projectsCapabilityGate, (req, res, next) => makeStagesRouter(deps())(req, res, next));
    app.use('/api/solution-stages', (req, res, next) => makeSolutionStagesDrainRouter(deps())(req, res, next));
    app.use(terminalErrorHandler);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => { locked.clear(); featureAsked = []; projectsCapability.allowed = true; });

function call(method, path, body) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const req = http.request(`${base}${path}`, {
            method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
        }, (r) => {
            let text = '';
            r.on('data', (c) => { text += c; });
            r.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* none */ } resolve({ status: r.statusCode, body: json }); });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

const isLicenceRefusal = (res) => res.status === 403 && res.body && res.body.error === 'feature_locked';

// ── The licensed routes ───────────────────────────────────────────────────────

test('each licensed route is shut by exactly the feature it names', async () => {
    for (const [feature, method, path, body] of ROUTES) {
        for (const lock of ['projects', 'blueprint_packaging', 'approvals']) {
            locked.clear();
            locked.add(lock);
            const res = await call(method, path, body);
            const label = `${method} ${path.replace(D, '')} with ${lock} locked`;
            if ([].concat(feature).includes(lock)) {
                assert.ok(isLicenceRefusal(res), `${label} -> ${res.status} ${JSON.stringify(res.body)}`);
                assert.strictEqual(res.body.feature, lock, label);
            } else {
                assert.ok(!isLicenceRefusal(res), `${label} must not be stopped by ${lock}: ${res.status} ${JSON.stringify(res.body)}`);
            }
        }
    }
});

test('with the licence open the same requests are not stopped by it', async () => {
    for (const [, method, path, body] of ROUTES) {
        const res = await call(method, path, body);
        assert.ok(!isLicenceRefusal(res), `${method} ${path} -> ${res.status}`);
    }
});

test('detaching a stage and the stage operator\'s own switches ask for no feature beyond the mount\'s', async () => {
    // Everything locked: the escape hatch, the enabled switch and a part switch must not be a licence question.
    for (const f of ['projects', 'blueprint_packaging', 'approvals']) locked.add(f);
    const detach = await call('DELETE', `${D}/stages/uat`, { confirm: 'Invoices', mode: 'detach' });
    assert.strictEqual(detach.status, 200, JSON.stringify(detach.body));
    assert.deepStrictEqual(featureAsked, [], 'detach never asked for a feature');
    featureAsked = [];
    const enabled = await call('PATCH', `${D}/stages/uat`, { settingsVersion: 1, enabled: true });
    assert.ok(!isLicenceRefusal(enabled), `enabled -> ${enabled.status}`);
    assert.deepStrictEqual(featureAsked, [], 'the enabled switch asked for no feature');
});

test('the gate comes from the router\'s own routes: a request that is not a stage route asks for no feature', async () => {
    const res = await call('GET', '/api/projects/dev/not-a-stage-route');
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(featureAsked, []);
});

// ── The drain router ──────────────────────────────────────────────────────────

test('the drain router needs no licence and no projects capability; the licensed router beside it is shut', async () => {
    for (const f of ['projects', 'blueprint_packaging', 'approvals']) locked.add(f);
    projectsCapability.allowed = false;

    const licensed = await call('GET', `${D}/stages/uat`);
    assert.strictEqual(licensed.status, 403);
    assert.strictEqual(licensed.body.error, 'capability_missing');

    const drain = [
        ['GET', '/api/solution-stages/uat'],
        ['GET', '/api/solution-stages/uat/variables'],
        ['PATCH', '/api/solution-stages/uat/parts/aut_1', { active: false }],
        ['POST', '/api/solution-stages/uat/pause', {}],
        ['POST', '/api/solution-stages/uat/resume', {}],
        ['PUT', '/api/solution-stages/uat/variables', { values: { greeting: 'hi' } }],
        ['POST', '/api/solution-stages/uat/detach', { confirm: 'Invoices' }],
    ];
    for (const [method, path, body] of drain) {
        const res = await call(method, path, body);
        assert.ok(!isLicenceRefusal(res) && res.body && res.body.error !== 'capability_missing', `${method} ${path} -> ${res.status} ${JSON.stringify(res.body)}`);
    }
    assert.deepStrictEqual(featureAsked, [], 'the drain router never asked for a feature');
    assert.strictEqual((await call('GET', '/api/solution-stages/uat')).status, 200);
    assert.strictEqual((await call('POST', '/api/solution-stages/uat/pause', {})).status, 200);
    assert.strictEqual((await call('POST', '/api/solution-stages/uat/detach', { confirm: 'Invoices' })).status, 200);
});

test('what a lapse should refuse is not on the drain router: no deploy, release, binding or steering write', async () => {
    for (const [method, path] of [
        ['POST', '/api/solution-stages/uat/deployments'], ['POST', '/api/solution-stages/uat/releases'],
        ['PUT', '/api/solution-stages/uat/bindings'], ['PATCH', '/api/solution-stages/uat'], ['DELETE', '/api/solution-stages/uat'],
    ]) {
        const res = await call(method, path, {});
        assert.strictEqual(res.status, 404, `${method} ${path}`);
    }
});
