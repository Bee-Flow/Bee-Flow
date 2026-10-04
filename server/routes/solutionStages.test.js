/**
 * The drain-exempt stage router (routes/solutionStages.js), served by
 * makeSolutionStagesDrainRouter over a real project store and solution-stage
 * store on pglite. No module is replaced.
 *
 * `requireFeature` is a trap here: the drain router must never ask for a
 * licence feature, so a lapse cannot strand a stage that runs in production.
 *
 * Pinned:
 *   - a stage is addressed by its own project id and the role is checked on THAT
 *     project: a Dev role opens nothing, a Dev id is no stage;
 *   - read, switch parts (`active` only, no audience), pause and resume,
 *     non-steering values, detach (SO and OA);
 *   - a steering value is refused here whoever asks: it goes through a deployment;
 *   - the same handlers as the licensed router (the same answers).
 *
 * Run: cd server && node --test routes/solutionStages.test.js
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');

const { makeProjectStore, applyProjectSchema } = require('../stores/projectStore');
const { makeSolutionStageStore, applySolutionStageSchema } = require('../stores/solutionStageStore');
const { pgliteDb } = require('../testUtils/pgliteDb');
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');
const { makeSolutionStagesDrainRouter } = require('./solutionStages');

const runDdl = (pg) => async (_tag, statements) => {
    for (const stmt of statements) await pg.exec(typeof stmt === 'string' ? stmt : stmt.sql);
};
const facadeFor = (db) => ({
    run: db.query,
    getOne: async (sql, params) => (await db.query(sql, params)).rows[0] || null,
    getAll: async (sql, params) => (await db.query(sql, params)).rows,
    getClient: async () => ({ query: db.query, release() {} }),
});

let pg;
let projects;
let store;
let server;
let base;
let w;
let seq = 0;
const calls = [];
const notified = [];
const featureAsked = [];

async function fresh() {
    seq += 1;
    const dev = await projects.createProject({ name: `Orders ${seq}`, ownerId: 'owner', organizationId: 'org1', kind: 'solution' });
    const [uat, prd] = await store.createStages({ devProject: dev, stages: ['uat', 'prd'], actorId: 'owner' });
    await projects.shareProject(uat.projectId, 'user', 'se', 'editor');
    await projects.shareProject(uat.projectId, 'user', 'sv', 'viewer');
    await projects.shareProject(dev.id, 'user', 'de', 'editor');
    w = { dev, uat, prd, automations: [], shapes: new Map(), stamps: new Map() };
    calls.length = 0;
    notified.length = 0;
    featureAsked.length = 0;
}

const deps = () => ({
    requireFeature: (feature) => { featureAsked.push(feature); throw new Error(`the drain router asked for ${feature}`); },
    stageStore: store,
    projectStore: projects,
    blueprintStore: { listStamps: async (id) => new Map(w.stamps.get(id) || []), getRelease: async () => null },
    getProjectRole: (userId, projectId) => projects.getProjectRole(userId, projectId, []),
    isOrgAdminForOrg: async (req) => req.session.user.id === 'oa',
    logActivity: async (...a) => { calls.push(['activity', ...a]); },
    notify: async (n) => { notified.push(n); },
    readStageShape: async (_k, id) => w.shapes.get(id) || null,
    automationStore: { getAutomationsForProject: async () => w.automations, getAutomation: async (id) => w.automations.find(r => r.id === id) || null, getWebhooksForAutomation: async () => [] },
    goLive: {
        activateCore: async ({ automation }) => { automation.isActive = true; return { ok: true }; },
        deactivateCore: async ({ automation }) => { automation.isActive = false; return { ok: true }; },
    },
    userStore: { getUser: async () => null },
    publicBaseUrl: () => 'https://bee.test',
});

function call(user, method, path, body) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const req = http.request(`${base}${path}`, {
            method, headers: { 'x-user': user, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
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

before(async () => {
    pg = new PGlite();
    await applyProjectSchema({ exec: (sql) => pg.exec(sql), runDdl: runDdl(pg) });
    await applySolutionStageSchema({ runDdl: runDdl(pg) });
    const { db } = pgliteDb(pg);
    projects = makeProjectStore(facadeFor(db));
    store = makeSolutionStageStore(db, { projectStore: projects });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { user: { id: req.headers['x-user'] }, isAuthenticated: true }; next(); });
    app.use('/api/solution-stages', (req, res, next) => makeSolutionStagesDrainRouter(deps())(req, res, next));
    app.use(terminalErrorHandler);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pg.close();
});
beforeEach(fresh);

const U = () => `/api/solution-stages/${w.uat.projectId}`;

test('a stage is read by its own project id; the role is the stage\'s, a Dev role opens nothing', async () => {
    for (const [user, status] of Object.entries({ owner: 200, se: 200, sv: 200, de: 404, oa: 404, stranger: 404 })) {
        assert.strictEqual((await call(user, 'GET', U())).status, status, user);
    }
    const res = await call('sv', 'GET', U());
    assert.deepStrictEqual([res.body.stage, res.body.solutionId, res.body.role], ['uat', w.dev.id, 'viewer']);
    assert.strictEqual((await call('owner', 'GET', `/api/solution-stages/${w.dev.id}`)).status, 404, 'a Dev id is no stage');
    assert.strictEqual((await call('owner', 'GET', '/api/solution-stages/nope')).status, 404);
    assert.deepStrictEqual(featureAsked, [], 'no licence feature was asked for');
});

test('parts switch on and off with `active` only', async () => {
    const r = { id: 'rt1', title: 'Nightly', isActive: false, liveVersion: 2, projectId: w.uat.projectId };
    w.automations.push(r);
    w.shapes.set('rt1', r);
    w.stamps.set(w.uat.projectId, new Map([['aut_1', { ref: 'aut_1', kind: 'automation', entityId: 'rt1', retiredAt: null }]]));
    assert.strictEqual((await call('se', 'PATCH', `${U()}/parts/aut_1`, { active: true })).status, 200);
    assert.strictEqual(r.isActive, true);
    assert.strictEqual((await call('se', 'PATCH', `${U()}/parts/aut_1`, { active: false })).status, 200);
    assert.strictEqual(r.isActive, false);
    assert.strictEqual((await call('se', 'PATCH', `${U()}/parts/aut_1`, { audience: { published: true } })).status, 400, 'audience is a licensed change');
    assert.strictEqual((await call('se', 'PATCH', `${U()}/parts/aut_1`, {})).status, 400);
    assert.strictEqual((await call('sv', 'PATCH', `${U()}/parts/aut_1`, { active: true })).status, 403);
    r.liveVersion = null;
    const never = await call('se', 'PATCH', `${U()}/parts/aut_1`, { active: true });
    assert.deepStrictEqual([never.status, never.body.code], [409, 'managed_part_not_deployed']);
});

test('pause and resume round trip for a stage editor and an org admin', async () => {
    w.automations.push({ id: 'a', isActive: true, liveVersion: 1, projectId: w.uat.projectId }, { id: 'b', isActive: false, liveVersion: 1, projectId: w.uat.projectId });
    assert.strictEqual((await call('sv', 'POST', `${U()}/pause`, {})).status, 403);
    const paused = await call('se', 'POST', `${U()}/pause`, {});
    assert.deepStrictEqual([paused.status, paused.body.paused, paused.body.count], [200, true, 1]);
    assert.deepStrictEqual(w.automations.map(r => r.isActive), [false, false]);
    assert.deepStrictEqual((await store.getStage(w.uat.projectId)).pausedState.automations, ['a']);
    const resumed = await call('oa', 'POST', `${U()}/resume`, {});
    assert.deepStrictEqual([resumed.status, resumed.body.paused], [200, false]);
    assert.deepStrictEqual(w.automations.map(r => r.isActive), [true, false]);
    assert.strictEqual(notified.length, 1, 'the owner is told that an org admin resumed the stage');
    assert.strictEqual(notified[0].userId, 'owner');
    assert.strictEqual((await call('de', 'POST', `${U()}/pause`, {})).status, 404);
    assert.strictEqual((await call('stranger', 'POST', `${U()}/pause`, {})).status, 404);
});

test('non-steering values are written here; a steering value is refused whoever asks', async () => {
    await store.replaceVariables(w.dev.id, [
        { name: 'greeting', type: 'text' }, { name: 'api_base', type: 'url' }, { name: 'limit', type: 'number' },
    ]);
    const ok = await call('se', 'PUT', `${U()}/variables`, { values: { greeting: 'Hi', limit: '5' } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.deepStrictEqual([ok.body.written, ok.body.pending, ok.body.bindingsPending], [2, false, false]);
    const live = Object.fromEntries((await store.listVariableValues(w.uat.projectId)).map(v => [v.name, v.appliedValue]));
    assert.deepStrictEqual(live, { greeting: 'Hi', limit: 5 });

    for (const user of ['se', 'owner']) {
        const steer = await call(user, 'PUT', `${U()}/variables`, { values: { api_base: 'https://x.example' } });
        assert.strictEqual(steer.status, 403, user);
        assert.strictEqual(steer.body.code, 'steering_not_here');
    }
    assert.ok(!(await store.listVariableValues(w.uat.projectId)).some(v => v.name === 'api_base'));
    assert.strictEqual((await call('se', 'PUT', `${U()}/variables`, { values: { limit: 'lots' } })).body.code, 'variable_invalid');
    assert.strictEqual((await call('sv', 'PUT', `${U()}/variables`, { values: { greeting: 'x' } })).status, 403);
    const read = await call('sv', 'GET', `${U()}/variables`);
    assert.strictEqual(read.status, 200);
    assert.strictEqual(read.body.variables.find(v => v.name === 'api_base').steering, true);
});

test('detach: the owner and an org admin may, a stage editor may not; the name is confirmed', async () => {
    const name = `Orders ${seq} (UAT)`;
    assert.strictEqual((await call('se', 'POST', `${U()}/detach`, { confirm: name })).status, 403);
    assert.strictEqual((await call('owner', 'POST', `${U()}/detach`, { confirm: 'nope' })).body.code, 'confirm_mismatch');
    assert.strictEqual((await call('owner', 'POST', `${U()}/detach`, {})).status, 400);
    assert.ok(await store.getStage(w.uat.projectId), 'nothing happened yet');

    const res = await call('oa', 'POST', `${U()}/detach`, { confirm: name });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual([res.body.detached, res.body.solutionId], [true, w.dev.id]);
    assert.strictEqual(await store.getStage(w.uat.projectId), null);
    assert.strictEqual((await projects.getProject(w.uat.projectId)).stage, null, 'an ordinary Solution now');
    assert.strictEqual(notified.length, 1);
    assert.ok(calls.some(c => c[0] === 'activity' && c[3] === 'stage_detached'));
    assert.strictEqual((await call('owner', 'GET', U())).status, 404, 'no longer a stage');
});

test('detach is refused while a deployment is running', async () => {
    await store.insertDeployment({
        solutionId: w.dev.id, stageProjectId: w.uat.projectId, stage: 'uat', releaseId: 'r', kind: 'deploy', status: 'queued',
        plan: {}, planHash: 'h', stageSettingsVersion: 1, requestKey: 'busy', requestedBy: 'owner',
    });
    const res = await call('owner', 'POST', `${U()}/detach`, { confirm: `Orders ${seq} (UAT)` });
    assert.deepStrictEqual([res.status, res.body.code], [409, 'stage_busy']);
});

test('the routes the licence guards are not here', async () => {
    for (const [method, path] of [
        ['POST', `${U()}/deployments`], ['POST', `${U()}/releases`], ['PUT', `${U()}/bindings`], ['PATCH', U()], ['DELETE', U()],
        ['POST', `${U()}/plan`],
    ]) {
        assert.strictEqual((await call('owner', method, path, {})).status, 404, `${method} ${path}`);
    }
});
