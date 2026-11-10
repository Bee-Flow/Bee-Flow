/**
 * GET /:id/deployments at the largest page size: `nextCursor` is there exactly
 * when another page follows. The route reads one row more than the page to
 * know, so the store must hand it that row at limit=100 too.
 *
 * Fakes only; no module is replaced.
 *
 * Run: cd server && node --test routes/projects/stages/deployments.pagination.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const { terminalErrorHandler } = require('../../../core/http/terminalErrorHandler');
const { makeStagesRouter } = require('./index');
const { makeDeploymentsStore } = require('../../../stores/solutionStage/deployments');

const DEV = { id: 'dev', name: 'Invoices', ownerId: 'so', organizationId: 'org1', kind: 'solution', stage: null };
const STAGE = {
    projectId: 'uat', solutionId: 'dev', stage: 'uat', organizationId: 'org1', runAsUserId: 'so', enabled: true, pausedState: null,
    requiresApproval: false, settingsVersion: 1, currentReleaseId: null, bindingsPending: false,
};

/** The stage's history, newest first; `total` is set per test. */
let total = 0;
const history = () => Array.from({ length: total }, (_, i) => ({
    id: `dep_${String(total - i).padStart(4, '0')}`, solutionId: 'dev', stageProjectId: 'uat', stage: 'uat', kind: 'deploy', status: 'succeeded',
    createdAt: new Date(Date.UTC(2026, 0, 1) + (total - i) * 60_000).toISOString(),
}));
const asked = [];

// The store's own page-size rule decides what the route gets: the real store over a database that records its LIMIT.
const realStore = makeDeploymentsStore({ query: async (_sql, params) => { asked.push(params[1]); return { rows: [] }; } }, { ready: async () => {} });

const deps = () => ({
    requireFeature: () => (_req, _res, next) => next(),
    projectStore: { getProject: async (id) => (id === 'dev' ? DEV : null), logActivity: async () => {} },
    stageStore: {
        getStage: async (id) => (id === 'uat' ? STAGE : null),
        getStageFor: async (_dev, stage) => (stage === 'uat' ? STAGE : null),
        listStages: async () => [STAGE],
        listDeployments: async (projectId, opts) => {
            await realStore.listDeployments(projectId, opts);
            const cap = asked[asked.length - 1];
            const rows = history();
            const from = opts.before ? rows.findIndex((r) => r.id === opts.before) + 1 : 0;
            return rows.slice(from, from + cap);
        },
    },
    blueprintStore: {},
    getProjectRole: async () => 'owner',
    isOrgAdminForOrg: async () => false,
    approvalGate: {},
    runner: {},
    automationStore: {},
    userStore: { getUser: async () => null },
    publicBaseUrl: () => 'https://bee.test',
    notify: async () => {},
    defer: (fn) => fn(),
});

let server;
let base;
before(async () => {
    const app = express();
    app.use((req, _res, next) => { req.session = { user: { id: 'so', organizationId: 'org1' }, isAuthenticated: true }; next(); });
    app.use('/api/projects', (req, res, next) => makeStagesRouter(deps())(req, res, next));
    app.use(terminalErrorHandler);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); });

function get(path) {
    return new Promise((resolve, reject) => {
        http.get(`${base}${path}`, (r) => {
            let text = '';
            r.on('data', (c) => { text += c; });
            r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(text) }));
        }).on('error', reject);
    });
}

test('limit=100 over exactly 100 deployments: one full page and no cursor to an empty one', async () => {
    total = 100;
    const res = await get('/api/projects/dev/deployments?limit=100');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.deployments.length, 100);
    assert.strictEqual(res.body.nextCursor, null);
});

test('limit=100 over 101 deployments: a cursor, and the second page holds the last one and ends', async () => {
    total = 101;
    const first = await get('/api/projects/dev/deployments?limit=100');
    assert.strictEqual(first.body.deployments.length, 100);
    assert.ok(first.body.nextCursor);
    const second = await get(`/api/projects/dev/deployments?limit=100&cursor=${first.body.nextCursor}`);
    assert.deepStrictEqual(second.body.deployments.map((d) => d.id), ['dep_0001']);
    assert.strictEqual(second.body.nextCursor, null);
});

test('a smaller page behaves the same way at its own edge', async () => {
    total = 20;
    assert.strictEqual((await get('/api/projects/dev/deployments?limit=20')).body.nextCursor, null);
    total = 21;
    assert.ok((await get('/api/projects/dev/deployments?limit=20')).body.nextCursor);
});

test('the store reads at most the largest page plus the one row that says more follow', async () => {
    asked.length = 0;
    await realStore.listDeployments('uat', { limit: 101 });
    await realStore.listDeployments('uat', { limit: 5000 });
    assert.deepStrictEqual(asked, [101, 101]);
});
