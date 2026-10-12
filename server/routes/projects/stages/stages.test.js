/**
 * The licensed stage API (routes/projects/stages), served by makeStagesRouter
 * over a REAL project store and solution-stage store on pglite, with doubles
 * for the engine (runner, plan, release cut), the part stores and the
 * licence. No module is replaced.
 *
 * Pinned:
 *   - the role matrix: SO, SE, SV, DE, DV and OA on a spread of routes; a Dev
 *     role grants nothing on a stage route and a stage role nothing on a Dev
 *     route; a stage-only member reaches its stage and reads `dev: null`;
 *   - a stage project id as `:id`, and a workspace, answer 404;
 *   - the engine's refusals pass through with their status and code (409
 *     plan_stale, stage_busy, approval_pending, release_not_in_uat,
 *     managed_part), and a deployment is admitted as 202;
 *   - variables: secret-like names refused, steering names SO-only, typed
 *     values, a steering value sets bindingsPending;
 *   - the gate: turning it off under the gate is a `settings` deployment (202),
 *     a policy without an approver is 400, UAT has no gate;
 *   - detach, remove (202), pause / resume round trip, parts on and off and
 *     managed_part_not_deployed;
 *   - bindings: the validator refuses another stage's table;
 *   - deployments scoped to the caller's stage, no request key, differsFromUat
 *     only for someone who holds both stages.
 *
 * Run: cd server && node --test routes/projects/stages/stages.test.js
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');

const { makeProjectStore, applyProjectSchema } = require('../../../stores/projectStore');
const { makeSolutionStageStore, applySolutionStageSchema } = require('../../../stores/solutionStageStore');
const { pgliteDb } = require('../../../testUtils/pgliteDb');
const { terminalErrorHandler } = require('../../../core/http/terminalErrorHandler');
const { HttpError } = require('../../../core/http/errors');
const { hashPayload, canonicalOf } = require('../../../projects/stages/stagePayload');
const { makeStagesRouter } = require('./index');

const runDdl = (pg) => async (_tag, statements) => {
    for (const stmt of statements) await pg.exec(typeof stmt === 'string' ? stmt : stmt.sql);
};

function facadeFor(db) {
    return {
        run: db.query,
        getOne: async (sql, params) => (await db.query(sql, params)).rows[0] || null,
        getAll: async (sql, params) => (await db.query(sql, params)).rows,
        getClient: async () => ({ query: db.query, release() {} }),
    };
}

// ── The world ─────────────────────────────────────────────────────────────────

let pg;
let projects;
let store;
let server;
let base;

/** Per test: ids, shares and the doubles' state. */
let w;
let seq = 0;

const fx = {
    locked: new Set(),
    calls: [],
    admit: null,
    plan: null,
    notified: [],
    activity: [],
};

const ORG_ADMINS = new Set(['oa']);

/** An in-memory blueprint store: stamps, releases, the ref ledger and payloads. */
function makeBlueprint() {
    const bp = {
        stamps: new Map(),
        releases: [],
        refs: [],
        payloads: new Map(),
        async listStamps(projectId) { return new Map(bp.stamps.get(projectId) || []); },
        async listPipelineReleases(_id, { limit = 50 } = {}) {
            return bp.releases.filter(r => r.channel !== 'gallery').slice(0, limit).map(({ manifest, ...meta }) => meta);
        },
        async getRelease(_id, releaseId) { return bp.releases.find(r => r.id === releaseId) || null; },
        async getReleasePayloads(releaseId) { return bp.payloads.get(releaseId) || []; },
        async refsFor() { return bp.refs; },
    };
    return bp;
}

function stamp(ref, kind, entityId, over = {}) {
    return { ref, kind, entityId, installHash: null, retiredAt: null, ...over };
}

async function fresh() {
    seq += 1;
    const dev = await projects.createProject({ name: `Invoices ${seq}`, ownerId: 'owner', organizationId: 'org1', kind: 'solution' });
    const [uat, prd] = await store.createStages({ devProject: dev, stages: ['uat', 'prd'], actorId: 'owner' });
    const ws = await projects.createProject({ name: `Team ${seq}`, ownerId: 'owner', organizationId: 'org1' });
    // SE / SV of UAT, a viewer of PRD, a Dev editor and a Dev viewer.
    await projects.shareProject(uat.projectId, 'user', 'se', 'editor');
    await projects.shareProject(uat.projectId, 'user', 'sv', 'viewer');
    await projects.shareProject(prd.projectId, 'user', 'pv', 'viewer');
    await projects.shareProject(dev.id, 'user', 'de', 'editor');
    await projects.shareProject(dev.id, 'user', 'dv', 'viewer');
    w = {
        dev, uat, prd, ws,
        bp: makeBlueprint(),
        shapes: new Map(),
        automations: [],
        webhooks: new Map(),
    };
    fx.locked.clear();
    fx.calls.length = 0;
    fx.notified.length = 0;
    fx.activity.length = 0;
    fx.admit = null;
    fx.plan = null;
    return w;
}

const ADMITTED = (over = {}) => ({
    id: 'dep_1', solutionId: w.dev.id, stageProjectId: w.uat.projectId, stage: 'uat', kind: 'deploy', status: 'queued',
    releaseId: 'rel_1', releaseSeq: 3, requestKey: 'SECRET-KEY', leaseOwner: 'worker-1', ...over,
});

function deps() {
    return {
        requireFeature: (feature) => (req, res, next) => (fx.locked.has(feature)
            ? res.status(403).json({ error: 'feature_locked', feature }) : next()),
        stageStore: store,
        projectStore: projects,
        blueprintStore: w.bp,
        getProjectRole: (userId, projectId) => projects.getProjectRole(userId, projectId, []),
        isOrgAdminForOrg: async (req) => ORG_ADMINS.has(req.session.user.id),
        logActivity: async (projectId, actorId, action, details) => { fx.activity.push({ projectId, actorId, action, details }); },
        notify: async (n) => { fx.notified.push(n); },
        runner: {
            workerId: 'w1',
            async admit(input) {
                fx.calls.push(['admit', input]);
                if (fx.admit) return fx.admit(input);
                return { deployment: ADMITTED({ kind: input.kind, stage: input.stage }), replayed: false };
            },
            async resumeStale() { fx.calls.push(['resumeStale']); return []; },
        },
        plan: async (input) => {
            fx.calls.push(['plan', input]);
            if (fx.plan) return fx.plan(input);
            return { kind: input.kind, planHash: 'ph_1', acknowledgementsRequired: [{ code: 'stage.remove' }], blocking: [] };
        },
        cutRelease: async (input) => {
            fx.calls.push(['cut', input]);
            const release = { id: 'rel_9', seq: 9, publishedAt: '2026-10-01T00:00:00Z', notes: { changes: [] }, gate: { blocked: false } };
            return { release, reused: false, replayed: false, findings: [] };
        },
        readStageShape: async (_kind, id) => w.shapes.get(id) || null,
        automationStore: {
            getAutomationsForProject: async () => w.automations,
            getAutomation: async (id) => w.automations.find(a => a.id === id) || null,
            getWebhooksForAutomation: async (id) => w.webhooks.get(id) || [],
        },
        goLive: {
            activateCore: async ({ automation }) => { automation.isActive = true; fx.calls.push(['activate', automation.id]); return { ok: true, automation }; },
            deactivateCore: async ({ automation }) => { automation.isActive = false; fx.calls.push(['deactivate', automation.id]); return { ok: true, automation }; },
        },
        setAppAudience: async (input) => { fx.calls.push(['appAudience', input.publishing]); return { ok: true, isPublished: input.publishing, sharedGroups: [] }; },
        appAudienceDeps: {},
        validateSharedGroupsForOrg: async (_org, groups) => groups,
        webpageStore: { setWebpagePublished: async (...a) => { fx.calls.push(['webpage', ...a.slice(0, 2)]); return true; } },
        agentStore: { setAgentPublished: async (...a) => { fx.calls.push(['agent', ...a.slice(0, 2)]); return true; } },
        userStore: { getUser: async (id) => ({ id, name: `User ${id}` }) },
        releaseGate: async () => ({ blocked: false, findings: [{ code: 'x' }] }),
        readCutState: async () => ({ tokens: { 'automation:a1': { version: 2 }, 'app:new': { v: 1 } } }),
        readSourceCut: async () => ({ tokens: { 'automation:a1': { version: 1 }, 'app:gone': { v: 1 } } }),
        publicBaseUrl: () => 'https://bee.test',
        webhookUrl: (id) => `https://bee.test/api/automation/webhook/${id}`,
        defer: (fn) => fn(),
        bindingDeps: {
            get solutionStageStore() { return store; },
            ownersOf: async () => new Map([['tbl_dev', { projectId: w.dev.id, stage: 'dev' }]]),
        },
    };
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

function call(user, method, path, body) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const headers = { ...(user ? { 'x-user': user } : {}), ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) };
        const req = http.request(`${base}${path}`, { method, headers }, (r) => {
            let text = '';
            r.on('data', (c) => { text += c; });
            r.on('end', () => {
                let json = null;
                try { json = JSON.parse(text); } catch { /* not JSON */ }
                resolve({ status: r.statusCode, body: json });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

const P = () => `/api/projects/${w.dev.id}`;
const statusOf = async (user, method, path, body) => (await call(user, method, path, body)).status;

before(async () => {
    pg = new PGlite();
    await applyProjectSchema({ exec: (sql) => pg.exec(sql), runDdl: runDdl(pg) });
    await applySolutionStageSchema({ runDdl: runDdl(pg) });
    const { db } = pgliteDb(pg);
    projects = makeProjectStore(facadeFor(db));
    store = makeSolutionStageStore(db, { projectStore: projects });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { const u = req.headers['x-user']; req.session = u ? { user: { id: u, organizationId: 'org1' }, isAuthenticated: true } : {}; next(); });
    // The router is built per request from the CURRENT doubles: `deps()` reads the test's world.
    app.use('/api/projects', (req, res, next) => makeStagesRouter(deps())(req, res, next));
    app.use(terminalErrorHandler);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pg.close();
});

beforeEach(async () => { await fresh(); });

// ── Who may do what ───────────────────────────────────────────────────────────

test('the role matrix: each route admits exactly its roles', async () => {
    w.shapes.set('rt1', { id: 'rt1', title: 'Nightly', isActive: false, liveVersion: 1, projectId: w.uat.projectId });
    w.bp.stamps.set(w.uat.projectId, new Map([['aut_1', stamp('aut_1', 'automation', 'rt1')]]));
    const d = w.dev.id;
    const u = w.uat.projectId;
    const matrix = [
        // [method, path, body, { user: status }]
        ['GET', `/api/projects/${d}/pipeline`, undefined, { owner: 200, de: 200, dv: 200, se: 200, sv: 200, oa: 404, stranger: 404 }],
        ['GET', `/api/projects/${d}/stages/uat`, undefined, { owner: 200, se: 200, sv: 200, de: 404, dv: 404, oa: 200, stranger: 404 }],
        ['GET', `/api/projects/${d}/stages/prd`, undefined, { owner: 200, pv: 200, se: 404, sv: 404, de: 404 }],
        ['POST', `/api/projects/${d}/stages/uat/deployments`, { releaseId: 'rel_1', kind: 'deploy', planHash: 'ph', requestKey: 'k1' }, { owner: 202, se: 403, sv: 403, de: 404, dv: 404, oa: 404 }],
        ['PATCH', `/api/projects/${d}/stages/uat/parts/aut_1`, { active: true }, { owner: 200, se: 200, sv: 403, de: 404, dv: 404, oa: 404 }],
        // A Dev editor is refused on PRD routes, and so is the editor of UAT.
        ['POST', `/api/projects/${d}/stages/prd/deployments`, { releaseId: 'rel_1', kind: 'deploy', planHash: 'ph', requestKey: 'k1p' }, { owner: 202, de: 404, se: 404, pv: 403 }],
        ['PATCH', `/api/projects/${d}/stages/prd/parts/aut_1`, { active: true }, { de: 404, se: 404, pv: 403 }],
        ['POST', `/api/projects/${d}/stages/uat/pause`, {}, { owner: 200, se: 200, oa: 200, sv: 403, de: 404, stranger: 404 }],
        ['POST', `/api/projects/${d}/releases`, { requestKey: 'k2' }, { owner: 201, de: 403, dv: 403, se: 404, oa: 404 }],
        ['GET', `/api/projects/${d}/releases`, undefined, { owner: 200, de: 200, dv: 403, se: 404, sv: 404 }],
        ['PUT', `/api/projects/${d}/variables`, { variables: [] }, { owner: 200, de: 200, dv: 403, se: 404 }],
        ['GET', `/api/projects/${d}/variables`, undefined, { owner: 200, de: 200, dv: 200, se: 404 }],
        ['PUT', `/api/projects/${d}/stages/uat/bindings`, { settingsVersion: 1, bindings: [{ slot: 'slug:web_1', value: null }] }, { se: 403, sv: 403, de: 404 }],
        ['POST', `/api/projects/${d}/stages/uat/plan`, { releaseId: 'rel_1' }, { owner: 200, se: 403, de: 404 }],
    ];
    for (const [method, path, body, expected] of matrix) {
        for (const [user, status] of Object.entries(expected)) {
            // Each call starts from a stage that is not paused.
            await store.setPausedState(u, null);
            const res = await call(user, method, path, body);
            assert.strictEqual(res.status, status, `${user} ${method} ${path.replace(`/api/projects/${d}`, '')} -> ${res.status} ${JSON.stringify(res.body)}`);
        }
    }
});

test('no session is a 401', async () => {
    assert.strictEqual(await statusOf(null, 'GET', `${P()}/pipeline`), 401);
});

test('a stage project id as :id and a workspace answer 404 on every kind of route', async () => {
    const stageId = w.uat.projectId;
    for (const path of [`/api/projects/${stageId}/pipeline`, `/api/projects/${stageId}/stages/uat`, `/api/projects/${stageId}/releases`, `/api/projects/${stageId}/variables`]) {
        assert.strictEqual(await statusOf('owner', 'GET', path), 404, path);
    }
    assert.strictEqual(await statusOf('owner', 'POST', `/api/projects/${stageId}/stages`, { stages: ['uat'] }), 404);
    assert.strictEqual(await statusOf('owner', 'POST', `/api/projects/${w.ws.id}/stages`, { stages: ['uat'] }), 404);
    assert.strictEqual(await statusOf('owner', 'GET', `/api/projects/${w.ws.id}/pipeline`), 404);
    assert.strictEqual(await statusOf('owner', 'GET', `/api/projects/nope/pipeline`), 404);
    // ':stage' is uat or prd; dev is a Dev thing and unknown names are nothing.
    assert.strictEqual(await statusOf('owner', 'GET', `${P()}/stages/dev`), 404);
    assert.strictEqual(await statusOf('owner', 'GET', `${P()}/stages/qa`), 404);
});

test('a stage-only member reaches its stage and reads dev: null, no releases, only its own stages', async () => {
    w.bp.releases.push({ id: 'rel_1', seq: 1, publishedAt: 'x', notes: {}, gate: { blocked: false } });
    const se = await call('se', 'GET', `${P()}/pipeline`);
    assert.strictEqual(se.status, 200);
    assert.strictEqual(se.body.dev, null);
    assert.strictEqual(se.body.releases, null);
    assert.deepStrictEqual(se.body.stages.map(s => [s.stage, s.role]), [['uat', 'editor']]);
    const pv = await call('pv', 'GET', `${P()}/pipeline`);
    assert.deepStrictEqual(pv.body.stages.map(s => [s.stage, s.role]), [['prd', 'viewer']]);

    const owner = await call('owner', 'GET', `${P()}/pipeline`);
    assert.deepStrictEqual(owner.body.stages.map(s => s.stage), ['uat', 'prd']);
    assert.deepStrictEqual(owner.body.dev.aheadOf, { seq: 1, changed: 1, added: 1, removed: 1 });
    assert.deepStrictEqual(owner.body.dev.checks, { blocked: false, count: 1 });
    assert.deepStrictEqual(owner.body.releases.map(r => r.id), ['rel_1']);
    // A Dev viewer sees the pipeline, and holds no role on its stages.
    const dv = await call('dv', 'GET', `${P()}/pipeline`);
    assert.deepStrictEqual(dv.body.stages.map(s => [s.stage, s.role]), [['uat', null], ['prd', null]]);
});

// ── Creating and reading stages ───────────────────────────────────────────────

test('POST /stages is idempotent and checks a legacy Dev for content a Solution cannot hold', async () => {
    const legacy = await projects.createProject({ name: 'Legacy', ownerId: 'owner', organizationId: 'org1', kind: 'solution' });
    await pg.query('UPDATE projects SET kind = NULL, kind_guessed = TRUE WHERE id = $1', [legacy.id]);
    const asked = [];
    const held = { documents: 2 };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { user: { id: 'owner' }, isAuthenticated: true }; next(); });
    app.use('/api/projects', makeStagesRouter({
        ...deps(), refusedContent: async (project, kind) => { asked.push([project.id, kind]); return held; },
    }));
    app.use(terminalErrorHandler);
    const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    try {
        const url = `http://127.0.0.1:${srv.address().port}/api/projects/${legacy.id}/stages`;
        const post = (body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const refused = await post({ stages: ['uat'] });
        assert.strictEqual(refused.status, 409);
        const body = await refused.json();
        assert.strictEqual(body.code, 'KIND_HOLDS_OTHER_CONTENT');
        assert.deepStrictEqual(body.details.held, held);
        assert.deepStrictEqual(asked, [[legacy.id, 'solution']]);
        assert.strictEqual((await store.listStages(legacy.id)).length, 0);

        delete held.documents;
        const made = await post({ stages: ['uat', 'prd'] });
        assert.strictEqual(made.status, 201);
        assert.deepStrictEqual((await made.json()).stages.map(s => [s.stage, s.created]), [['uat', true], ['prd', true]]);
        const again = await post({ stages: ['uat'] });
        assert.deepStrictEqual((await again.json()).stages.map(s => [s.stage, s.created]), [['uat', false]]);
        assert.deepStrictEqual((await projects.getProject(legacy.id)).kind, 'solution');
    } finally {
        await new Promise((resolve) => srv.close(resolve));
    }
});

test('POST /stages: an unknown stage and an extra key are 400, a Solution without organisation is 409', async () => {
    assert.strictEqual(await statusOf('owner', 'POST', `${P()}/stages`, { stages: ['qa'] }), 400);
    assert.strictEqual(await statusOf('owner', 'POST', `${P()}/stages`, { stages: ['uat'], runAs: 'mallory' }), 400);
    assert.strictEqual(await statusOf('owner', 'POST', `${P()}/stages`, { stages: [] }), 400);
    const loose = await projects.createProject({ name: 'Loose', ownerId: 'owner', kind: 'solution' });
    const res = await call('owner', 'POST', `/api/projects/${loose.id}/stages`, { stages: ['uat'] });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'stages_need_org');
});

test('GET /stages/:stage lists the parts with their drift and the inbound addresses; webhooks only for the owner', async () => {
    const shape = { title: 'Nightly', definition: { steps: [] }, isActive: true, liveVersion: 1 };
    const hash = hashPayload(canonicalOf('automation', shape));
    w.shapes.set('rt1', shape);
    w.shapes.set('rt2', { title: 'Edited', definition: { steps: [1] }, isActive: false });
    w.shapes.set('wp1', { name: 'Landing', slug: 'landing-uat', isPublished: true });
    w.bp.stamps.set(w.uat.projectId, new Map([
        ['aut_1', stamp('aut_1', 'automation', 'rt1', { installHash: hash })],
        ['aut_2', stamp('aut_2', 'automation', 'rt2', { installHash: 'sha256:old' })],
        ['aut_3', stamp('aut_3', 'automation', 'gone', { retiredAt: '2026-01-01' })],
        ['pg_1', stamp('pg_1', 'webpage', 'wp1')],
    ]));
    w.webhooks.set('rt1', [{ id: 'hook-slug' }]);

    const so = await call('owner', 'GET', `${P()}/stages/uat`);
    assert.strictEqual(so.status, 200);
    const byRef = Object.fromEntries(so.body.parts.map(p => [p.ref, p]));
    assert.deepStrictEqual(byRef.aut_1, { ref: 'aut_1', kind: 'automation', name: 'Nightly', entityId: 'rt1', active: true, retired: false, drift: false });
    assert.strictEqual(byRef.aut_2.drift, true);
    assert.strictEqual(byRef.aut_3.retired, true);
    assert.strictEqual(byRef.pg_1.active, true);
    assert.deepStrictEqual(so.body.inbound.map(i => [i.kind, i.url]), [
        ['webhook', 'https://bee.test/api/automation/webhook/hook-slug'], ['webpage', 'https://bee.test/w/landing-uat'],
    ]);
    assert.strictEqual(so.body.settingsVersion, 1);
    assert.deepStrictEqual(so.body.runAs, { userId: 'owner', name: 'User owner' });

    const sv = await call('sv', 'GET', `${P()}/stages/uat`);
    assert.deepStrictEqual(sv.body.inbound.map(i => i.kind), ['webpage'], 'a webhook slug is a credential');
});

// ── Parts on and off ──────────────────────────────────────────────────────────

test('parts on and off: automations, apps, pages and agents; a part with no live copy is managed_part_not_deployed', async () => {
    const r1 = { id: 'rt1', title: 'Live', isActive: false, liveVersion: 4, projectId: w.uat.projectId };
    const r2 = { id: 'rt2', title: 'Never live', isActive: false, liveVersion: null, projectId: w.uat.projectId };
    w.automations.push(r1, r2);
    w.shapes.set('rt1', r1);
    w.shapes.set('rt2', r2);
    w.shapes.set('app1', { id: 'app1', userId: 'run', publishedDefinition: { v: 1 }, isPublished: false });
    w.shapes.set('app2', { id: 'app2', userId: 'run', publishedDefinition: null, isPublished: false });
    w.shapes.set('wp1', { id: 'wp1', userId: 'run', publishedVersionId: 'v1', isPublished: false });
    w.shapes.set('wp2', { id: 'wp2', userId: 'run', publishedVersionId: null, isPublished: false });
    w.shapes.set('ag1', { id: 'ag1', owner_id: 'run', published_version: 2, organization_id: 'org1' });
    w.shapes.set('ag2', { id: 'ag2', owner_id: 'run', published_version: 0, organization_id: 'org1' });
    w.shapes.set('tb1', { id: 'tb1' });
    w.bp.stamps.set(w.uat.projectId, new Map([
        ['aut_1', stamp('aut_1', 'automation', 'rt1')], ['aut_2', stamp('aut_2', 'automation', 'rt2')],
        ['app_1', stamp('app_1', 'app', 'app1')], ['app_2', stamp('app_2', 'app', 'app2')],
        ['pg_1', stamp('pg_1', 'webpage', 'wp1')], ['pg_2', stamp('pg_2', 'webpage', 'wp2')],
        ['ag_1', stamp('ag_1', 'agent', 'ag1')], ['ag_2', stamp('ag_2', 'agent', 'ag2')],
        ['dt_1', stamp('dt_1', 'datatable', 'tb1')],
    ]));
    const patch = (ref, body, user = 'se') => call(user, 'PATCH', `${P()}/stages/uat/parts/${ref}`, body);

    assert.strictEqual((await patch('aut_1', { active: true })).status, 200);
    assert.strictEqual(r1.isActive, true);
    assert.strictEqual((await patch('aut_1', { active: false })).status, 200);
    assert.strictEqual(r1.isActive, false);
    const never = await patch('aut_2', { active: true });
    assert.strictEqual(never.status, 409);
    assert.strictEqual(never.body.code, 'managed_part_not_deployed');
    assert.strictEqual((await patch('aut_2', { active: false })).status, 200, 'switching off needs no live copy');

    assert.strictEqual((await patch('app_1', { active: true })).status, 200);
    assert.deepStrictEqual(fx.calls.find(c => c[0] === 'appAudience'), ['appAudience', true]);
    assert.strictEqual((await patch('app_2', { active: true })).body.code, 'managed_part_not_deployed');
    assert.strictEqual((await patch('pg_1', { audience: { published: true, sharedGroups: ['g1'] } })).status, 200);
    assert.deepStrictEqual(fx.calls.find(c => c[0] === 'webpage'), ['webpage', 'wp1', true]);
    assert.strictEqual((await patch('pg_2', { active: true })).body.code, 'managed_part_not_deployed');
    assert.strictEqual((await patch('ag_1', { active: true })).status, 200);
    assert.strictEqual((await patch('ag_2', { active: true })).body.code, 'managed_part_not_deployed');

    // No switch on a table, no audience on an automation, no part that is not in the stage.
    assert.strictEqual((await patch('dt_1', { active: true })).body.code, 'part_not_switchable');
    assert.strictEqual((await patch('aut_1', { audience: { published: true } })).body.code, 'audience_not_supported');
    assert.strictEqual((await patch('aut_99', { active: true })).status, 404);
    assert.strictEqual((await patch('aut_1', {})).status, 400);
    assert.strictEqual((await patch('aut_1', { active: true, owner: 'x' })).status, 400);
    assert.ok(fx.activity.some(a => a.action === 'stage_part_switched' && a.projectId === w.uat.projectId));
});

test('pause switches the stage\'s automations off and remembers them; resume restores exactly that set', async () => {
    const mk = (id, isActive, liveVersion = 1) => ({ id, title: id, isActive, liveVersion, projectId: w.uat.projectId });
    w.automations.push(mk('r_on_1', true), mk('r_on_2', true), mk('r_off', false));
    const paused = await call('se', 'POST', `${P()}/stages/uat/pause`, {});
    assert.strictEqual(paused.status, 200);
    assert.strictEqual(paused.body.paused, true);
    assert.strictEqual(paused.body.count, 2);
    assert.deepStrictEqual(w.automations.map(r => r.isActive), [false, false, false]);
    let row = await store.getStage(w.uat.projectId);
    assert.strictEqual(row.enabled, false);
    assert.deepStrictEqual(row.pausedState.automations, ['r_on_1', 'r_on_2']);
    assert.strictEqual(row.settingsVersion, 2);

    // Pausing twice keeps the record of what was on.
    const twice = await call('se', 'POST', `${P()}/stages/uat/pause`, {});
    assert.strictEqual(twice.body.changed, false);
    assert.deepStrictEqual((await store.getStage(w.uat.projectId)).pausedState.automations, ['r_on_1', 'r_on_2']);

    // Somebody switched one of them on meanwhile, and one lost its automation: resume leaves both alone.
    w.automations[1].isActive = true;
    const resumed = await call('se', 'POST', `${P()}/stages/uat/resume`, {});
    assert.strictEqual(resumed.status, 200);
    assert.strictEqual(resumed.body.paused, false);
    assert.deepStrictEqual(w.automations.map(r => r.isActive), [true, true, false]);
    row = await store.getStage(w.uat.projectId);
    assert.strictEqual(row.enabled, true);
    assert.strictEqual(row.pausedState, null);
});

test('an org admin pauses a stage they do not own, and the Solution owner hears about it', async () => {
    w.automations.push({ id: 'r1', isActive: true, liveVersion: 1, projectId: w.uat.projectId });
    const res = await call('oa', 'POST', `${P()}/stages/uat/pause`, {});
    assert.strictEqual(res.status, 200);
    assert.strictEqual(fx.notified.length, 1);
    assert.strictEqual(fx.notified[0].userId, 'owner');
    assert.ok(fx.activity.some(a => a.action === 'stage_paused' && a.actorId === 'oa' && a.details.viaOrgAdmin === true));
    // The owner pausing their own stage is not announced to themselves.
    fx.notified.length = 0;
    await call('owner', 'POST', `${P()}/stages/uat/resume`, {});
    assert.strictEqual(fx.notified.length, 0);
});

test('an automation that cannot come back on stays recorded, and the stage stays paused', async () => {
    const r = { id: 'r1', isActive: true, liveVersion: 1, projectId: w.uat.projectId };
    w.automations.push(r);
    await call('owner', 'POST', `${P()}/stages/uat/pause`, {});
    const app = deps();
    app.goLive = { ...app.goLive, activateCore: async () => ({ ok: false, code: 'ai_act_blocked', status: 409 }) };
    const e = express();
    e.use(express.json());
    e.use((req, _res, next) => { req.session = { user: { id: 'owner' }, isAuthenticated: true }; next(); });
    e.use('/api/projects', makeStagesRouter(app));
    e.use(terminalErrorHandler);
    const srv = await new Promise((resolve) => { const s = e.listen(0, () => resolve(s)); });
    try {
        const res = await fetch(`http://127.0.0.1:${srv.address().port}${P()}/stages/uat/resume`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        const body = await res.json();
        assert.deepStrictEqual(body.failed, [{ id: 'r1', code: 'ai_act_blocked' }]);
        assert.strictEqual(body.paused, true);
        assert.deepStrictEqual((await store.getStage(w.uat.projectId)).pausedState.automations, ['r1']);
    } finally {
        await new Promise((resolve) => srv.close(resolve));
    }
});

// ── Settings and the PRD gate ─────────────────────────────────────────────────

test('PATCH settings: version CAS, stage editors switch the stage, only the owner changes the rest', async () => {
    const patch = (user, stage, body) => call(user, 'PATCH', `${P()}/stages/${stage}`, body);
    const ok = await patch('owner', 'uat', { settingsVersion: 1, newPartsActive: false });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.newPartsActive, false);
    assert.strictEqual(ok.body.settingsVersion, 2);
    const stale = await patch('owner', 'uat', { settingsVersion: 1, newPartsActive: true });
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(stale.body.code, 'settings_stale');
    assert.strictEqual((await patch('se', 'uat', { settingsVersion: 2, newPartsActive: true })).status, 403);
    // enabled goes through pause / resume
    const off = await patch('se', 'uat', { settingsVersion: 2, enabled: false });
    assert.strictEqual(off.status, 200);
    assert.strictEqual(off.body.enabled, false);
    assert.strictEqual(off.body.paused, true);
    const on = await patch('se', 'uat', { settingsVersion: off.body.settingsVersion, enabled: true });
    assert.strictEqual(on.body.enabled, true);
    assert.strictEqual((await patch('owner', 'uat', { settingsVersion: 1 })).status, 400, 'say what to change');
    assert.strictEqual((await patch('owner', 'uat', { settingsVersion: 1, runAsUserId: 'x' })).status, 400);
});

test('the approval gate is Production only; UAT has none', async () => {
    const res = await call('owner', 'PATCH', `${P()}/stages/uat`, { settingsVersion: 1, requiresApproval: true, approvalPolicy: { stages: [] } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'approval_not_on_uat');
});

test('turning the gate on without an approver other than the owner is 400 approval_policy_needs_approver', async () => {
    const approvalGate = { validatePolicy: async (policy) => { if (!policy) throw new HttpError(400, 'approval_policy_needs_approver', 'Production approval needs at least one approver who is not the Solution owner.'); return []; } };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { user: { id: 'owner' }, isAuthenticated: true }; next(); });
    app.use('/api/projects', makeStagesRouter({ ...deps(), approvalGate }));
    app.use(terminalErrorHandler);
    const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    try {
        const url = `http://127.0.0.1:${srv.address().port}${P()}/stages/prd`;
        const patch = async (body) => { const r = await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
        const bad = await patch({ settingsVersion: 1, requiresApproval: true });
        assert.strictEqual(bad.status, 400);
        assert.strictEqual(bad.body.code, 'approval_policy_needs_approver');
        assert.strictEqual((await store.getStage(w.prd.projectId)).requiresApproval, false);
        // The real validator agrees about an empty policy.
        const real = await call('owner', 'PATCH', `${P()}/stages/prd`, { settingsVersion: 1, requiresApproval: true });
        assert.strictEqual(real.status, 400);
        assert.strictEqual(real.body.code, 'approval_policy_needs_approver');

        const good = await patch({ settingsVersion: 1, requiresApproval: true, approvalPolicy: { stages: [{ approvers: [{ userId: 'boss' }] }] } });
        assert.strictEqual(good.status, 200, JSON.stringify(good.body));
        assert.strictEqual(good.body.requiresApproval, true);
        assert.strictEqual(good.body.settingsVersion, 2);
        assert.ok(!fx.calls.some(c => c[0] === 'admit'), 'turning the gate on is a plain write, no deployment');
    } finally {
        await new Promise((resolve) => srv.close(resolve));
    }
});

test('under the gate, switching it off or changing its policy is a settings deployment (202), not a write', async () => {
    await store.updateStageSettings(w.prd.projectId, 1, { requiresApproval: true, approvalPolicy: { stages: [{ approvers: [{ userId: 'boss' }] }] } });
    const approvalGate = { validatePolicy: async () => [] };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { user: { id: 'owner' }, isAuthenticated: true }; next(); });
    app.use('/api/projects', makeStagesRouter({ ...deps(), approvalGate }));
    app.use(terminalErrorHandler);
    const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    try {
        const url = `http://127.0.0.1:${srv.address().port}${P()}/stages/prd`;
        const patch = async (body) => { const r = await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
        const off = await patch({ settingsVersion: 2, requiresApproval: false });
        assert.strictEqual(off.status, 202);
        assert.strictEqual(off.body.deployment.id, 'dep_1');
        assert.strictEqual(off.body.deployment.requestKey, undefined);
        const admit = fx.calls.find(c => c[0] === 'admit')[1];
        assert.strictEqual(admit.kind, 'settings');
        assert.deepStrictEqual(admit.settingsPatch, { requiresApproval: false });
        assert.strictEqual(admit.actor.id, 'owner');
        const plan = fx.calls.find(c => c[0] === 'plan')[1];
        assert.deepStrictEqual([plan.kind, plan.settingsPatch], ['settings', { requiresApproval: false }]);
        assert.strictEqual((await store.getStage(w.prd.projectId)).requiresApproval, true, 'nothing is written until the deployment commits');

        // A policy change is a deployment too, and a no-op change is neither.
        fx.calls.length = 0;
        const policy = await patch({ settingsVersion: 2, approvalPolicy: { stages: [{ approvers: [{ userId: 'boss2' }] }] } });
        assert.strictEqual(policy.status, 202);
        assert.deepStrictEqual(Object.keys(fx.calls.find(c => c[0] === 'admit')[1].settingsPatch), ['approvalPolicy']);
        fx.calls.length = 0;
        const same = await patch({ settingsVersion: 2, requiresApproval: true });
        assert.strictEqual(same.status, 200);
        assert.ok(!fx.calls.some(c => c[0] === 'admit'));
        // The rollback switch sits behind the gate as well.
        const rollback = await patch({ settingsVersion: 2, rollbackNeedsApproval: true });
        assert.strictEqual(rollback.status, 202);
    } finally {
        await new Promise((resolve) => srv.close(resolve));
    }
});

// ── Deployments ───────────────────────────────────────────────────────────────

test('POST deployments admits through the runner and answers 202 with an allow-listed row', async () => {
    const res = await call('owner', 'POST', `${P()}/stages/uat/deployments`, {
        releaseId: 'rel_1', kind: 'deploy', planHash: 'ph_1', requestKey: 'rk-1',
        acknowledgements: [{ code: 'drift', ref: 'aut_1' }], note: 'first one',
    });
    assert.strictEqual(res.status, 202);
    assert.deepStrictEqual([res.body.deployment.id, res.body.deployment.status], ['dep_1', 'queued']);
    assert.strictEqual(res.body.deployment.requestKey, undefined);
    assert.strictEqual(res.body.deployment.leaseOwner, undefined);
    const input = fx.calls.find(c => c[0] === 'admit')[1];
    assert.deepStrictEqual(input, {
        solutionId: w.dev.id, stage: 'uat', releaseId: 'rel_1', kind: 'deploy', planHash: 'ph_1', requestKey: 'rk-1',
        acknowledgements: [{ code: 'drift', ref: 'aut_1' }], actor: { id: 'owner' },
    });
    assert.ok(fx.activity.some(a => a.action === 'deployment_requested' && a.details.note === 'first one'));
});

test('POST deployments: the body is closed and needs its release, hash and key', async () => {
    const post = (body) => call('owner', 'POST', `${P()}/stages/uat/deployments`, body);
    assert.strictEqual((await post({ kind: 'deploy', planHash: 'p', requestKey: 'k' })).body.code, 'release_required');
    assert.strictEqual((await post({ releaseId: 'r', planHash: 'p' })).status, 400, 'no request key');
    assert.strictEqual((await post({ releaseId: 'r', requestKey: 'k' })).status, 400, 'no plan hash');
    assert.strictEqual((await post({ releaseId: 'r', planHash: 'p', requestKey: 'k', kind: 'remove' })).status, 400, 'remove has its own route');
    assert.strictEqual((await post({ releaseId: 'r', planHash: 'p', requestKey: 'k', runAs: 'x' })).status, 400);
    const redeploy = await post({ kind: 'redeploy', planHash: 'p', requestKey: 'k' });
    assert.strictEqual(redeploy.status, 202, 'a redeploy names no release');
});

test('the runner\'s refusals reach the caller with their status and code', async () => {
    const cases = [
        ['plan_stale', 409, { plan: { planHash: 'new' } }], ['stage_busy', 409, { deploymentId: 'd' }],
        ['approval_pending', 409, { deploymentId: 'd' }], ['release_not_in_uat', 409, undefined],
        ['managed_part', 409, undefined], ['managed_part_not_deployed', 409, undefined],
        ['acknowledgement_missing', 409, { missing: [{ code: 'drift' }] }], ['solution_owner_only', 403, undefined],
    ];
    for (const [code, status, details] of cases) {
        fx.admit = async () => { throw new HttpError(status, code, `refused: ${code}`, details); };
        const res = await call('owner', 'POST', `${P()}/stages/uat/deployments`, { releaseId: 'r', kind: 'deploy', planHash: 'p', requestKey: `k-${code}` });
        assert.strictEqual(res.status, status, code);
        assert.strictEqual(res.body.code, code);
        if (details) assert.deepStrictEqual(res.body.details, details);
    }
});

test('a repeated request key answers the same row, flagged as replayed', async () => {
    fx.admit = async () => ({ deployment: ADMITTED({ status: 'succeeded' }), replayed: true });
    const res = await call('owner', 'POST', `${P()}/stages/uat/deployments`, { releaseId: 'r', kind: 'deploy', planHash: 'p', requestKey: 'same' });
    assert.strictEqual(res.status, 202);
    assert.strictEqual(res.body.replayed, true);
    assert.ok(!fx.activity.some(a => a.action === 'deployment_requested'), 'a replay is not a second request');
});

test('plan: a release is needed unless it is a redeploy', async () => {
    assert.strictEqual((await call('owner', 'POST', `${P()}/stages/uat/plan`, {})).body.code, 'release_required');
    const ok = await call('owner', 'POST', `${P()}/stages/uat/plan`, { releaseId: 'rel_1', kind: 'rollback' });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.planHash, 'ph_1');
    assert.deepStrictEqual(fx.calls.filter(c => c[0] === 'plan').pop()[1], { stageProjectId: w.uat.projectId, releaseId: 'rel_1', kind: 'rollback' });
    assert.strictEqual((await call('owner', 'POST', `${P()}/stages/uat/plan`, { kind: 'redeploy' })).status, 200);
});

test('release and deploy: cut, plan, deploy to UAT; a blocked plan is a 409 that carries the plan', async () => {
    const ok = await call('owner', 'POST', `${P()}/release-and-deploy`, { requestKey: 'rd-1' });
    assert.strictEqual(ok.status, 202);
    assert.strictEqual(ok.body.release.id, 'rel_9');
    assert.strictEqual(ok.body.deployment.id, 'dep_1');
    const admit = fx.calls.find(c => c[0] === 'admit')[1];
    assert.deepStrictEqual([admit.stage, admit.releaseId, admit.requestKey], ['uat', 'rel_9', 'rd-1:uat']);

    fx.calls.length = 0;
    fx.plan = async () => ({ kind: 'deploy', planHash: 'ph_b', blocking: [{ code: 'binding.missing', slot: 'connection:cn_1' }], acknowledgementsRequired: [] });
    const blocked = await call('owner', 'POST', `${P()}/release-and-deploy`, { requestKey: 'rd-2' });
    assert.strictEqual(blocked.status, 409);
    assert.strictEqual(blocked.body.code, 'plan_blocked');
    assert.strictEqual(blocked.body.details.plan.planHash, 'ph_b');
    assert.strictEqual(blocked.body.details.release.id, 'rel_9');
    assert.ok(!fx.calls.some(c => c[0] === 'admit'));

    fx.plan = null;
    fx.admit = async () => { throw new HttpError(409, 'acknowledgement_missing', 'Confirm', { missing: [{ code: 'drift' }] }); };
    const missing = await call('owner', 'POST', `${P()}/release-and-deploy`, { requestKey: 'rd-3' });
    assert.strictEqual(missing.body.code, 'acknowledgement_missing');
    assert.deepStrictEqual(missing.body.details.missing, [{ code: 'drift' }]);
    assert.strictEqual(missing.body.details.plan.planHash, 'ph_1');

    await store.detachStage(w.uat.projectId, 'owner');
    const noUat = await call('owner', 'POST', `${P()}/release-and-deploy`, { requestKey: 'rd-4' });
    assert.strictEqual(noUat.status, 404);
});

test('release routes: cut (201, then 200 for a replay), list, read with counts instead of rows', async () => {
    const cut = await call('owner', 'POST', `${P()}/releases`, { requestKey: 'rk', notes: 'first' });
    assert.strictEqual(cut.status, 201);
    assert.strictEqual(cut.body.release.seq, 9);
    const input = fx.calls.find(c => c[0] === 'cut')[1];
    assert.deepStrictEqual([input.actorId, input.requestKey, input.notes], ['owner', 'rk', 'first']);

    w.bp.releases.push({
        id: 'rel_1', seq: 1, publishedAt: '2026-10-01', notes: { text: 'hello', changes: [{ change: 'added' }, { change: 'changed' }, { change: 'unchanged' }] },
        gate: { blocked: false, findings: [] }, contentHash: 'h', channel: 'pipeline', manifest: { solution: { entities: {} } },
    }, { id: 'gal_1', seq: null, channel: 'gallery', manifest: {} });
    w.bp.payloads.set('rel_1', [
        { ref: 'dt_1', kind: 'reference_rows', payload: { rows: [{ secret: 'row 1' }, { secret: 'row 2' }] } },
        { ref: 'kb_1', kind: 'knowledge_listing', payload: { docs: [{ piiStatus: 'found', title: 'private' }, { piiStatus: 'clean' }] } },
    ]);
    await store.setCurrentRelease(null, { stageProjectId: w.uat.projectId, releaseId: 'rel_1', releaseSeq: 1 });
    const list = await call('de', 'GET', `${P()}/releases`);
    assert.deepStrictEqual(list.body.releases.map(r => [r.id, r.deployedTo, r.notes.summary, r.notes.added, r.notes.changed]), [['rel_1', ['uat'], 'hello', 1, 1]]);
    const one = await call('de', 'GET', `${P()}/releases/rel_1`);
    assert.strictEqual(one.status, 200);
    assert.deepStrictEqual(one.body.release.payloads, [
        { ref: 'dt_1', kind: 'reference_rows', rows: 2 },
        { ref: 'kb_1', kind: 'knowledge_listing', documents: 2, personalDataFlagged: 1 },
    ]);
    assert.ok(!JSON.stringify(one.body).includes('row 1') && !JSON.stringify(one.body).includes('private'), 'no row or title leaves');
    assert.strictEqual((await call('de', 'GET', `${P()}/releases/gal_1`)).status, 404, 'a gallery release is not a pipeline release');
    assert.strictEqual((await call('de', 'GET', `${P()}/releases/nope`)).status, 404);
});

/** A finished deployment row: admitted as queued (the only way in), then settled. */
async function finished(stage, key, over = {}) {
    const row = await store.insertDeployment({
        solutionId: w.dev.id, stageProjectId: stage.projectId, stage: stage.stage, releaseId: 'rel_1', releaseSeq: 1, kind: 'deploy',
        status: 'queued', plan: { planHash: 'h', differsFromUat: [{ kind: 'binding', label: 'x' }], parts: [] }, planHash: 'h',
        stageSettingsVersion: 1, requestKey: key, requestedBy: 'owner', ...over,
    });
    await pg.query(`UPDATE solution_deployments SET status = 'succeeded', finished_at = NOW() WHERE id = $1`, [row.id]);
    return row;
}

test('history is scoped to the caller\'s stages, shows no request key, and differsFromUat only to someone holding both', async () => {
    const u1 = await finished(w.uat, 'secret-uat-key');
    const p1 = await finished(w.prd, 'secret-prd-key');

    const so = await call('owner', 'GET', `${P()}/deployments`);
    assert.strictEqual(so.status, 200);
    assert.strictEqual(so.body.deployments.length, 2);
    assert.ok(!JSON.stringify(so.body).includes('secret-'), 'no request key');
    assert.ok(!JSON.stringify(so.body).includes('leaseOwner'));

    const se = await call('se', 'GET', `${P()}/deployments`);
    assert.deepStrictEqual(se.body.deployments.map(d => d.stage), ['uat']);
    assert.strictEqual((await call('se', 'GET', `${P()}/deployments?stage=prd`)).status, 404, 'not their stage');
    assert.strictEqual((await call('de', 'GET', `${P()}/deployments`)).body.deployments.length, 0, 'a Dev role reads no stage history');
    assert.strictEqual((await call('stranger', 'GET', `${P()}/deployments`)).status, 404);

    assert.strictEqual((await call('se', 'GET', `${P()}/deployments/${p1.id}`)).status, 404, 'the PRD deployment is not theirs');
    const seOne = await call('se', 'GET', `${P()}/deployments/${u1.id}`);
    assert.strictEqual(seOne.status, 200);
    assert.strictEqual(seOne.body.deployment.plan.differsFromUat, undefined);
    assert.strictEqual(seOne.body.deployment.requestKey, undefined);
    const soOne = await call('owner', 'GET', `${P()}/deployments/${p1.id}`);
    assert.deepStrictEqual(soOne.body.deployment.plan.differsFromUat, [{ kind: 'binding', label: 'x' }]);
    assert.strictEqual(soOne.body.approval, null);
});

test('the history pages by cursor across stages', async () => {
    for (let i = 0; i < 3; i += 1) {
        await finished(i % 2 ? w.prd : w.uat, `k${i}`, { releaseSeq: i + 1 });
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const first = await call('owner', 'GET', `${P()}/deployments?limit=2`);
    assert.deepStrictEqual(first.body.deployments.map(d => d.releaseSeq), [3, 2]);
    assert.ok(first.body.nextCursor);
    const second = await call('owner', 'GET', `${P()}/deployments?limit=2&cursor=${first.body.nextCursor}`);
    assert.deepStrictEqual(second.body.deployments.map(d => d.releaseSeq), [1]);
    assert.strictEqual(second.body.nextCursor, null);
    assert.strictEqual((await call('owner', 'GET', `${P()}/deployments?cursor=%25%25`)).status, 400);
});

test('cancel: a queued deployment is closed; one awaiting approval is withdrawn first, then closed', async () => {
    const queued = await store.insertDeployment({
        solutionId: w.dev.id, stageProjectId: w.uat.projectId, stage: 'uat', releaseId: 'r', kind: 'deploy', status: 'queued',
        plan: {}, planHash: 'h', stageSettingsVersion: 1, requestKey: 'q1', requestedBy: 'owner',
    });
    assert.strictEqual((await call('de', 'POST', `${P()}/deployments/${queued.id}/cancel`, {})).status, 404, 'a Dev editor holds no stage');
    assert.strictEqual((await call('se', 'POST', `${P()}/deployments/${queued.id}/cancel`, {})).status, 403, 'neither requester nor owner');
    const done = await call('owner', 'POST', `${P()}/deployments/${queued.id}/cancel`, {});
    assert.strictEqual(done.status, 200);
    assert.strictEqual(done.body.deployment.status, 'cancelled');
    assert.strictEqual((await call('owner', 'POST', `${P()}/deployments/${queued.id}/cancel`, {})).body.code, 'deployment_not_cancellable');

    const awaiting = await store.insertDeployment({
        solutionId: w.dev.id, stageProjectId: w.prd.projectId, stage: 'prd', releaseId: 'r', kind: 'deploy', status: 'awaiting_approval',
        plan: {}, planHash: 'h', stageSettingsVersion: 1, requestKey: 'a1', requestedBy: 'owner',
    });
    await store.setApprovalId(awaiting.id, 'appr_1');
    const withdrawn = [];
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { user: { id: 'owner' }, isAuthenticated: true }; next(); });
    app.use('/api/projects', makeStagesRouter({
        ...deps(),
        getApproval: async (id) => ({ id, status: 'pending' }),
        approvalService: { withdraw: async (input) => { withdrawn.push(input.approval.id); return { code: 200, body: {} }; } },
    }));
    app.use(terminalErrorHandler);
    const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    try {
        const res = await fetch(`http://127.0.0.1:${srv.address().port}${P()}/deployments/${awaiting.id}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(withdrawn, ['appr_1']);
        assert.strictEqual((await res.json()).deployment.status, 'cancelled');
    } finally {
        await new Promise((resolve) => srv.close(resolve));
    }
});

test('retry: a deployment with warnings converges again; a failed one is planned and admitted again', async () => {
    const warned = await store.insertDeployment({
        solutionId: w.dev.id, stageProjectId: w.uat.projectId, stage: 'uat', releaseId: 'r', kind: 'deploy', status: 'queued',
        plan: {}, planHash: 'h', stageSettingsVersion: 1, requestKey: 'w1', requestedBy: 'owner',
    });
    await pg.query(`UPDATE solution_deployments SET status = 'succeeded_with_warnings', finished_at = NOW() WHERE id = $1`, [warned.id]);
    const res = await call('owner', 'POST', `${P()}/deployments/${warned.id}/retry`, {});
    assert.strictEqual(res.status, 202);
    assert.strictEqual(res.body.deployment.status, 'converging');
    assert.ok(fx.calls.some(c => c[0] === 'resumeStale'), 'the runner finishes the converge');

    await pg.query(`UPDATE solution_deployments SET status = 'failed', finished_at = NOW(), error = '{"code":"x"}'::jsonb WHERE id = $1`, [warned.id]);
    await pg.query(`UPDATE solution_deployments SET acknowledgements = '[{"code":"drift","ref":"aut_1"}]'::jsonb WHERE id = $1`, [warned.id]);
    fx.calls.length = 0;
    const again = await call('owner', 'POST', `${P()}/deployments/${warned.id}/retry`, {});
    assert.strictEqual(again.status, 202);
    const admit = fx.calls.find(c => c[0] === 'admit')[1];
    assert.deepStrictEqual([admit.kind, admit.releaseId, admit.planHash, admit.acknowledgements], ['deploy', 'r', 'ph_1', [{ code: 'drift', ref: 'aut_1' }]]);
    assert.match(admit.requestKey, /^retry:/);

    await pg.query(`UPDATE solution_deployments SET status = 'succeeded' WHERE id = $1`, [warned.id]);
    assert.strictEqual((await call('owner', 'POST', `${P()}/deployments/${warned.id}/retry`, {})).body.code, 'deployment_not_retryable');
});

// ── Removing a stage ──────────────────────────────────────────────────────────

test('detach: the name must match, the stage becomes an ordinary Solution, the history stays', async () => {
    const url = `${P()}/stages/uat`;
    assert.strictEqual((await call('owner', 'DELETE', url, { confirm: 'wrong', mode: 'detach' })).body.code, 'confirm_mismatch');
    assert.strictEqual((await call('owner', 'DELETE', url, { mode: 'detach' })).status, 400);
    assert.strictEqual((await call('se', 'DELETE', url, { confirm: `Invoices ${seq} (UAT)`, mode: 'detach' })).status, 403);
    const res = await call('owner', 'DELETE', url, { confirm: `Invoices ${seq} (UAT)`, mode: 'detach' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.detached, true);
    assert.strictEqual(await store.getStage(w.uat.projectId), null);
    assert.strictEqual((await projects.getProject(w.uat.projectId)).stage, null);
    assert.ok(fx.activity.some(a => a.action === 'stage_detached' && a.projectId === w.dev.id));
    assert.strictEqual((await call('owner', 'GET', url)).status, 404);
});

test('detach is refused while a deployment runs; an org admin may detach, and the owner is told', async () => {
    const running = await store.insertDeployment({
        solutionId: w.dev.id, stageProjectId: w.prd.projectId, stage: 'prd', releaseId: 'r', kind: 'deploy', status: 'queued',
        plan: {}, planHash: 'h', stageSettingsVersion: 1, requestKey: 'busy', requestedBy: 'owner',
    });
    const busy = await call('owner', 'DELETE', `${P()}/stages/prd`, { confirm: `Invoices ${seq}`, mode: 'detach' });
    assert.strictEqual(busy.status, 409);
    assert.strictEqual(busy.body.code, 'stage_busy');
    await store.transitionDeployment(running.id, ['queued'], 'cancelled', {});
    const res = await call('oa', 'DELETE', `${P()}/stages/prd`, { confirm: `Invoices ${seq} (Production)`, mode: 'detach' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(fx.notified.length, 1);
    assert.strictEqual(fx.notified[0].userId, 'owner');
});

test('delete is a remove deployment (202); deleteData rides into the plan and the stage.delete_data acknowledgement', async () => {
    fx.plan = async (input) => ({
        kind: 'remove', planHash: input.deleteData ? 'ph_data' : 'ph_plain', deleteData: input.deleteData === true, blocking: [],
        acknowledgementsRequired: [{ code: 'stage.remove' }, ...(input.deleteData ? [{ code: 'stage.delete_data' }] : [])],
    });
    const url = `${P()}/stages/prd`;
    const plain = await call('owner', 'DELETE', url, { confirm: `Invoices ${seq} (Production)`, mode: 'delete' });
    assert.strictEqual(plain.status, 202);
    let admit = fx.calls.find(c => c[0] === 'admit')[1];
    assert.deepStrictEqual([admit.kind, admit.planHash, admit.settingsPatch, admit.acknowledgements], ['remove', 'ph_plain', null, [{ code: 'stage.remove' }]]);

    fx.calls.length = 0;
    const withData = await call('oa', 'DELETE', url, { confirm: `Invoices ${seq}`, mode: 'delete', deleteData: true, requestKey: 'rm-1' });
    assert.strictEqual(withData.status, 202);
    admit = fx.calls.find(c => c[0] === 'admit')[1];
    assert.deepStrictEqual([admit.planHash, admit.settingsPatch, admit.requestKey, admit.actor.id], ['ph_data', { deleteData: true }, 'rm-1', 'oa']);
    assert.deepStrictEqual(admit.acknowledgements.map(a => a.code), ['stage.remove', 'stage.delete_data']);
    assert.strictEqual(fx.notified.length, 1, 'the owner hears that an admin asked for the removal');
    assert.ok(await store.getStage(w.prd.projectId), 'the runner removes the rows, not the route');
});

// ── Bindings ──────────────────────────────────────────────────────────────────

test('bindings: validated, stored, flagged pending; another stage\'s table is refused; a stale version is 409', async () => {
    const put = (body) => call('owner', 'PUT', `${P()}/stages/uat/bindings`, body);
    w.bp.releases.push({
        id: 'rel_1', seq: 1, channel: 'pipeline',
        manifest: { solution: { slots: [{ slot: 'slug:web_1', kind: 'webpage_slug', ref: 'web_1', label: 'Page address', suggested: { slug: 'dev-page' } }] } },
    });

    const refused = await put({ settingsVersion: 1, bindings: [{ slot: 'table:orders', value: { datatableId: 'tbl_dev' } }] });
    assert.strictEqual(refused.status, 400);
    assert.strictEqual(refused.body.code, 'binding_invalid');
    assert.deepStrictEqual(refused.body.details, { slot: 'table:orders', why: 'other_stage' });
    assert.strictEqual((await store.listBindings(w.uat.projectId)).length, 0, 'nothing was written');
    assert.strictEqual((await put({ settingsVersion: 1, bindings: [{ slot: 'nonsense', value: {} }] })).body.details.why, 'unknown_slot');
    assert.strictEqual((await put({ settingsVersion: 1, bindings: [{ slot: 'slug:web_1', value: { slug: 'A b' } }] })).status, 400);

    const ok = await put({ settingsVersion: 1, bindings: [{ slot: 'slug:web_1', value: { slug: ' Landing-UAT ' } }, { slot: 'slug:old_9', value: { slug: 'old' } }] });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.deepStrictEqual(ok.body.bindings.map(b => [b.slot, b.value]), [['slug:old_9', { slug: 'old' }], ['slug:web_1', { slug: 'landing-uat' }]]);
    assert.deepStrictEqual(ok.body.ignored, ['slug:old_9'], 'a slot no release needs is stored and named');
    assert.strictEqual(ok.body.bindingsPending, true);
    assert.strictEqual(ok.body.settingsVersion, 2);
    const row = await store.getStage(w.uat.projectId);
    assert.strictEqual(row.bindingsPending, true);
    const stale = await put({ settingsVersion: 1, bindings: [{ slot: 'slug:web_1', value: null }] });
    assert.strictEqual(stale.body.code, 'settings_stale');
    const cleared = await put({ settingsVersion: 2, bindings: [{ slot: 'slug:old_9', value: null }] });
    assert.deepStrictEqual(cleared.body.bindings.map(b => b.slot), ['slug:web_1']);
    assert.strictEqual((await put({ settingsVersion: 3, bindings: [{ slot: 'slug:web_1', value: null }, { slot: 'slug:web_1', value: null }] })).body.details.why, 'duplicate');
});

test('requirements list every slot with who needs it; the Dev value and the binding are the owner\'s to see', async () => {
    w.bp.releases.push({
        id: 'rel_1', seq: 1, channel: 'pipeline',
        manifest: { solution: { slots: [
            { slot: 'connection:cn_1', kind: 'connection', ref: 'aut_1', label: 'API', suggested: { connectionId: 'conn_dev' } },
            { slot: 'connection:cn_1', kind: 'connection', ref: 'aut_2', label: 'API', suggested: { connectionId: 'conn_dev' } },
            { slot: 'slug:web_1', kind: 'webpage_slug', ref: 'web_1', label: 'Address', suggested: null },
        ] } },
    });
    await store.upsertBindings(w.uat.projectId, [{ slot: 'slug:web_1', kind: 'webpage_slug', value: { slug: 's' } }], 'owner');
    const so = await call('owner', 'GET', `${P()}/stages/uat/requirements`);
    assert.strictEqual(so.status, 200);
    assert.deepStrictEqual(so.body.release, { id: 'rel_1', seq: 1 });
    assert.deepStrictEqual(so.body.requirements.map(r => [r.slot, r.neededBy, r.bound]), [['connection:cn_1', ['aut_1', 'aut_2'], false], ['slug:web_1', ['web_1'], true]]);
    assert.deepStrictEqual(so.body.requirements[0].suggested, { connectionId: 'conn_dev' });
    const se = await call('se', 'GET', `${P()}/stages/uat/requirements?releaseId=rel_1`);
    assert.strictEqual(se.status, 200);
    assert.ok(!JSON.stringify(se.body).includes('conn_dev') && se.body.requirements.every(r => r.suggested === undefined && r.binding === undefined));
    assert.strictEqual((await call('owner', 'GET', `${P()}/stages/uat/requirements?releaseId=nope`)).status, 404);
});

// ── Variables ─────────────────────────────────────────────────────────────────

test('variable declarations: typed, secret-like names refused, a choice needs choices', async () => {
    const put = (variables, user = 'owner') => call(user, 'PUT', `${P()}/variables`, { variables });
    const secret = await put([{ name: 'api_key', type: 'text' }]);
    assert.strictEqual(secret.status, 400);
    assert.strictEqual(secret.body.code, 'variable_secret_name');
    for (const name of ['client_secret', 'bearer_value', 'db_password', 'authorization']) {
        assert.strictEqual((await put([{ name }])).body.code, 'variable_secret_name', name);
    }
    assert.strictEqual((await put([{ name: 'Bad Name' }])).body.code, 'variable_name_invalid');
    assert.strictEqual((await put([{ name: 'a' }, { name: 'a' }])).body.code, 'variable_duplicate');
    assert.strictEqual((await put([{ name: 'size', type: 'choice' }])).body.code, 'variable_choices_missing');
    assert.strictEqual((await put([{ name: 'size', type: 'colour' }])).status, 400);

    const ok = await put([
        { name: 'greeting', type: 'text', description: 'Opening line' },
        { name: 'limit', type: 'number', required: false },
        { name: 'api_base', type: 'url' },
        { name: 'size', type: 'choice', choices: ['s', 'm'] },
        { name: 'sender', type: 'text', steering: true },
    ], 'de');
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const byName = Object.fromEntries(ok.body.variables.map(v => [v.name, v]));
    assert.strictEqual(byName.api_base.steering, true, 'a url steers');
    assert.strictEqual(byName.sender.steering, true, 'the author can mark one');
    assert.strictEqual(byName.greeting.steering, false);
    assert.strictEqual(byName.limit.required, false);
    assert.deepStrictEqual(byName.size.choices, ['s', 'm']);
    const read = await call('dv', 'GET', `${P()}/variables`);
    assert.deepStrictEqual(read.body.variables.map(v => v.name), ['greeting', 'limit', 'api_base', 'size', 'sender']);
});

async function declare() {
    const res = await call('owner', 'PUT', `${P()}/variables`, { variables: [
        { name: 'greeting', type: 'text' }, { name: 'limit', type: 'number' }, { name: 'live', type: 'boolean' },
        { name: 'api_base', type: 'url' }, { name: 'size', type: 'choice', choices: ['s', 'm'] },
    ] });
    assert.strictEqual(res.status, 200);
}

test('values: a stage editor writes a text value, but not a url (steering); the owner writes both', async () => {
    await declare();
    const put = (user, values, stage = 'uat') => call(user, 'PUT', `${P()}/stages/${stage}/variables`, { values });
    const text = await put('se', { greeting: 'Hello' });
    assert.strictEqual(text.status, 200, JSON.stringify(text.body));
    assert.deepStrictEqual([text.body.written, text.body.pending, text.body.bindingsPending], [1, false, false]);

    const steer = await put('se', { api_base: 'https://evil.example' });
    assert.strictEqual(steer.status, 403);
    assert.strictEqual(steer.body.code, 'steering_owner_only');
    assert.strictEqual((await store.listVariableValues(w.uat.projectId)).filter(v => v.name === 'api_base').length, 0);

    const owner = await put('owner', { api_base: 'https://api.example', greeting: 'Hi' });
    assert.strictEqual(owner.status, 200);
    assert.strictEqual(owner.body.pending, true);
    assert.strictEqual(owner.body.bindingsPending, true, 'a steering value waits for a redeploy');
    const stored = Object.fromEntries((await store.listVariableValues(w.uat.projectId)).map(v => [v.name, v]));
    assert.deepStrictEqual([stored.api_base.value, stored.api_base.appliedValue], ['https://api.example', null], 'draft only');
    assert.deepStrictEqual([stored.greeting.value, stored.greeting.appliedValue], ['Hi', 'Hi'], 'non-steering is live at once');
    assert.strictEqual((await store.getStage(w.uat.projectId)).bindingsPending, true);
    assert.deepStrictEqual(await store.variableValuesFor(w.uat.projectId), {}, 'no release runs yet, so nothing is applied');
});

test('values are typed and coerced; the wrong type, an unknown name and a viewer are refused', async () => {
    await declare();
    const put = (user, values, stage = 'uat') => call(user, 'PUT', `${P()}/stages/${stage}/variables`, { values });
    assert.strictEqual((await put('se', { limit: '42', live: 'true', size: 'm' })).status, 200);
    const stored = Object.fromEntries((await store.listVariableValues(w.uat.projectId)).map(v => [v.name, v.value]));
    assert.deepStrictEqual(stored, { limit: 42, live: true, size: 'm' });
    const bad = await put('se', { limit: 'many' });
    assert.strictEqual(bad.status, 400);
    assert.deepStrictEqual([bad.body.code, bad.body.details], ['variable_invalid', { name: 'limit', type: 'number' }]);
    assert.strictEqual((await put('se', { size: 'xl' })).body.code, 'variable_invalid');
    assert.strictEqual((await put('se', { nothing: 'x' })).body.code, 'variable_unknown');
    assert.strictEqual((await put('se', {})).status, 400);
    assert.strictEqual((await put('se', { greeting: { a: 1 } })).status, 400);
    assert.strictEqual((await put('sv', { greeting: 'x' })).status, 403);
    assert.strictEqual((await put('stranger', { greeting: 'x' })).status, 404);
    // null clears
    assert.strictEqual((await put('se', { limit: null })).status, 200);
    assert.ok(!(await store.listVariableValues(w.uat.projectId)).some(v => v.name === 'limit'));
});

test('values for dev: Dev editors write non-steering values, the Dev owner steering ones; the stage roles do not count', async () => {
    await declare();
    const put = (user, values) => call(user, 'PUT', `${P()}/stages/dev/variables`, { values });
    assert.strictEqual((await put('de', { greeting: 'dev hello' })).status, 200);
    assert.strictEqual((await put('de', { api_base: 'https://dev.example' })).body.code, 'steering_owner_only');
    const ownerPut = await put('owner', { api_base: 'https://dev.example' });
    assert.strictEqual(ownerPut.status, 200);
    assert.strictEqual(ownerPut.body.pending, false, 'Dev has no deployment, so nothing waits');
    assert.strictEqual((await store.variableValuesFor(w.dev.id)).api_base, 'https://dev.example', 'a Dev steering value is applied at once');
    assert.strictEqual((await put('dv', { greeting: 'x' })).status, 403);
    assert.strictEqual((await put('se', { greeting: 'x' })).status, 404, 'a stage editor holds nothing on Dev');
    const read = await call('dv', 'GET', `${P()}/stages/dev/variables`);
    assert.strictEqual(read.status, 200);
    assert.deepStrictEqual(read.body.values.map(v => v.name).sort(), ['api_base', 'greeting']);
    assert.strictEqual((await call('se', 'GET', `${P()}/stages/dev/variables`)).status, 404);
    const stageRead = await call('sv', 'GET', `${P()}/stages/uat/variables`);
    assert.strictEqual(stageRead.status, 200);
    assert.strictEqual(stageRead.body.variables.find(v => v.name === 'api_base').steering, true);
});

test('a stage checks its values against the release it runs; Dev\'s newer type does not rewrite what is applied', async () => {
    await declare();
    w.bp.releases.push({ id: 'rel_1', seq: 1, channel: 'pipeline', manifest: { solution: { variables: [{ name: 'limit', type: 'text' }] } } });
    await store.setCurrentRelease(null, { stageProjectId: w.uat.projectId, releaseId: 'rel_1', releaseSeq: 1 });
    // The release says text; Dev says number: the stage follows the release.
    assert.strictEqual((await call('se', 'PUT', `${P()}/stages/uat/variables`, { values: { limit: 'plenty' } })).status, 200);
    // Dev has `greeting` too, which this release does not declare yet: a value may be entered before the deploy.
    assert.strictEqual((await call('se', 'PUT', `${P()}/stages/uat/variables`, { values: { greeting: 'early' } })).status, 200);
});

// ── Part options ──────────────────────────────────────────────────────────────

test('part options: merged per part, only for the kind they belong to', async () => {
    w.bp.refs.push(
        { kind: 'datatables', ref: 'dt_1', entityId: 't1', retiredAt: null },
        { kind: 'knowledgeBases', ref: 'kb_1', entityId: 'k1', retiredAt: null },
        { kind: 'datatables', ref: 'dt_2', entityId: 't2', retiredAt: '2026-01-01' },
    );
    const patch = (ref, body, user = 'owner') => call(user, 'PATCH', `${P()}/parts/${ref}/options`, body);
    const ref = await patch('dt_1', { reference: true });
    assert.strictEqual(ref.status, 200);
    assert.deepStrictEqual(ref.body.options, { reference: true });
    const kb = await patch('kb_1', { contentMode: 'carry', acks: [{ docRef: 'doc_1', contentHash: 'h1' }, 'doc_2'] });
    assert.strictEqual(kb.status, 200);
    assert.deepStrictEqual((await patch('kb_1', { acks: ['doc_3'] })).body.options, { contentMode: 'carry', acks: ['doc_3'] }, 'merged, not replaced');
    assert.strictEqual((await patch('kb_1', { reference: true })).body.code, 'option_not_for_kind');
    assert.strictEqual((await patch('dt_1', { contentMode: 'carry' })).body.code, 'option_not_for_kind');
    assert.strictEqual((await patch('dt_2', { reference: true })).status, 404, 'a retired part');
    assert.strictEqual((await patch('nope', { reference: true })).status, 404);
    assert.strictEqual((await patch('dt_1', {})).status, 400);
    assert.strictEqual((await patch('dt_1', { reference: true }, 'de')).status, 403);
    assert.strictEqual((await store.getPartOptions(w.dev.id, { ref: 'dt_1' })).options.reference, true);
});
