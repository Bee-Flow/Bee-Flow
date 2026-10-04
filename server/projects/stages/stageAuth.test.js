/**
 * stageAuth: the one resolver of who may do what on a Solution and its stages
 * (projects/stages/stageAuth.js), with fakes for every collaborator.
 *
 * Pinned:
 *   - `:id` is the Dev Solution: a workspace, a stage project and a missing
 *     project are 404 (a guessed workspace is not yet a workspace);
 *   - a stage route checks the role ON THE STAGE PROJECT and a Dev route the
 *     role on Dev; neither ever grants the other;
 *   - no role at all is 404 (not probeable), a role that is too low is 403;
 *   - `orgAdmin` admits an org admin of the Dev organisation, and says so;
 *   - `anyStage` lets a stage-only member through a Dev route, with the roles
 *     it found; `:stage = dev` needs `devStage`;
 *   - the drain router's `:stageProjectId` resolves the same way;
 *   - the context lands on `req.stageCtx`.
 *
 * Run: cd server && node --test projects/stages/stageAuth.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { stageAuth, stageAuthMw, rank } = require('./stageAuth');

const PROJECTS = {
    dev: { id: 'dev', name: 'Invoices', ownerId: 'so', organizationId: 'org1', kind: 'solution', stage: null, stageOf: null },
    uat: { id: 'uat', name: 'Invoices (UAT)', ownerId: 'so', organizationId: 'org1', kind: 'solution', stage: 'uat', stageOf: 'dev' },
    prd: { id: 'prd', name: 'Invoices (Production)', ownerId: 'so', organizationId: 'org1', kind: 'solution', stage: 'prd', stageOf: 'dev' },
    ws: { id: 'ws', name: 'Team', ownerId: 'so', organizationId: 'org1', kind: 'workspace', kindGuessed: false, stage: null },
    guessed: { id: 'guessed', name: 'Maybe', ownerId: 'so', organizationId: 'org1', kind: 'workspace', kindGuessed: true, stage: null },
    legacy: { id: 'legacy', name: 'Old', ownerId: 'so', organizationId: 'org1', kind: null, stage: null },
};
const STAGES = {
    uat: { projectId: 'uat', solutionId: 'dev', stage: 'uat' },
    prd: { projectId: 'prd', solutionId: 'dev', stage: 'prd' },
};
const ROLES = {
    so: { dev: 'owner', uat: 'owner', prd: 'owner', ws: 'owner', guessed: 'owner', legacy: 'owner' },
    de: { dev: 'editor' },
    dv: { dev: 'viewer' },
    se: { uat: 'editor' },
    sv: { uat: 'viewer' },
    pv: { prd: 'viewer' },
    oa: {},
};

const deps = {
    stageStore: {
        async getStage(id) { return Object.values(STAGES).find(s => s.projectId === id) || null; },
        async getStageFor(solutionId, stage) { return solutionId === 'dev' ? STAGES[stage] || null : null; },
        async listStages(solutionId) { return solutionId === 'dev' ? [STAGES.uat, STAGES.prd] : []; },
    },
    projectStore: { async getProject(id) { return PROJECTS[id] || null; } },
    async getProjectRole(userId, projectId) {
        const roles = ROLES[userId] || {};
        return roles[projectId] || null;
    },
    async isOrgAdminForOrg(req, orgId) { return req.session.user.id === 'oa' && orgId === 'org1'; },
};

const req = (user, params) => ({ session: user ? { user: { id: user } } : {}, params });
const run = (user, params, opts) => stageAuth(req(user, params), opts, deps);
const refuses = (promise, status, code) => assert.rejects(promise, (e) => e.status === status && (code === undefined || e.code === code));

test('rank orders the three roles and knows no others', () => {
    assert.ok(rank('owner') > rank('editor') && rank('editor') > rank('viewer') && rank('viewer') > rank(null));
    assert.strictEqual(rank('god'), 0);
});

test('no session is 401', async () => {
    await refuses(run(null, { id: 'dev' }, { dev: 'viewer' }), 401);
});

test('a Dev route needs a Dev role: none is 404, too low is 403, enough passes', async () => {
    await refuses(run('se', { id: 'dev' }, { dev: 'viewer' }), 404);
    await refuses(run('nobody', { id: 'dev' }, { dev: 'viewer' }), 404);
    await refuses(run('dv', { id: 'dev' }, { dev: 'editor' }), 403, 'insufficient_permissions');
    const ctx = await run('de', { id: 'dev' }, { dev: 'editor' });
    assert.strictEqual(ctx.devRole, 'editor');
    assert.strictEqual(ctx.isSolutionOwner, false);
    assert.strictEqual(ctx.stage, null);
    assert.strictEqual((await run('so', { id: 'dev' }, { dev: 'owner' })).isSolutionOwner, true);
});

test('a stage route checks the role on the stage project; a Dev role grants nothing on it', async () => {
    const ok = await run('se', { id: 'dev', stage: 'uat' }, { stage: 'editor' });
    assert.deepStrictEqual([ok.stageName, ok.stageRole, ok.stage.projectId], ['uat', 'editor', 'uat']);
    await refuses(run('sv', { id: 'dev', stage: 'uat' }, { stage: 'editor' }), 403);
    await refuses(run('de', { id: 'dev', stage: 'uat' }, { stage: 'viewer' }), 404);
    // A route that names only a Dev role has not asked for a stage role: nobody is let in on Dev's account.
    await refuses(run('so', { id: 'dev', stage: 'prd' }, { dev: 'owner' }), 403);
    await refuses(run('se', { id: 'dev', stage: 'prd' }, { stage: 'viewer' }), 404);
    assert.strictEqual((await run('so', { id: 'dev', stage: 'prd' }, { stage: 'owner' })).stageRole, 'owner');
});

test('a stage role grants nothing on a Dev route', async () => {
    await refuses(run('se', { id: 'dev' }, { dev: 'viewer' }), 404);
    await refuses(run('sv', { id: 'dev' }, { dev: 'viewer' }), 404);
});

test('the Solution id must be a Dev Solution: workspace, stage project and unknown ids are 404', async () => {
    await refuses(run('so', { id: 'ws' }, { dev: 'viewer' }), 404);
    await refuses(run('so', { id: 'uat' }, { dev: 'viewer' }), 404);
    await refuses(run('so', { id: 'nope' }, { dev: 'viewer' }), 404);
    await refuses(run('so', { id: 'uat', stage: 'uat' }, { stage: 'viewer' }), 404);
    await refuses(run('so', {}, { dev: 'viewer' }), 404);
    // A guessed workspace and a legacy project may still be turned into a Solution.
    assert.strictEqual((await run('so', { id: 'guessed' }, { dev: 'owner' })).dev.id, 'guessed');
    assert.strictEqual((await run('so', { id: 'legacy' }, { dev: 'owner' })).dev.id, 'legacy');
});

test('an unknown stage name and a stage that was not created are 404', async () => {
    await refuses(run('so', { id: 'dev', stage: 'qa' }, { stage: 'viewer' }), 404);
    await refuses(run('so', { id: 'legacy', stage: 'uat' }, { stage: 'viewer' }), 404, 'stage_not_found');
});

test(':stage = dev needs devStage and checks Dev', async () => {
    await refuses(run('so', { id: 'dev', stage: 'dev' }, { stage: 'owner', dev: 'owner' }), 404);
    const ctx = await run('de', { id: 'dev', stage: 'dev' }, { stage: 'editor', devStage: 'editor' });
    assert.deepStrictEqual([ctx.stageName, ctx.devRole, ctx.stage], ['dev', 'editor', null]);
    await refuses(run('dv', { id: 'dev', stage: 'dev' }, { devStage: 'editor' }), 403);
    await refuses(run('se', { id: 'dev', stage: 'dev' }, { stage: 'editor', devStage: 'viewer' }), 404, undefined);
});

test('anyStage lets a stage-only member through a Dev route and records the roles it found', async () => {
    const opts = { dev: 'viewer', anyStage: 'viewer' };
    const se = await run('se', { id: 'dev' }, opts);
    assert.deepStrictEqual([se.devRole, se.stageRoles.uat, se.stageRoles.prd], [null, 'editor', null]);
    const pv = await run('pv', { id: 'dev' }, opts);
    assert.strictEqual(pv.stageRoles.prd, 'viewer');
    const dv = await run('dv', { id: 'dev' }, opts);
    assert.strictEqual(dv.devRole, 'viewer');
    await refuses(run('nobody', { id: 'dev' }, opts), 404);
    await refuses(run('oa', { id: 'dev' }, opts), 404);
});

test('orgAdmin admits an org admin, flagged; without the option they get nothing', async () => {
    const stage = await run('oa', { id: 'dev', stage: 'uat' }, { stage: 'owner', orgAdmin: true });
    assert.deepStrictEqual([stage.isOrgAdmin, stage.viaOrgAdmin, stage.stageRole], [true, true, null]);
    await refuses(run('oa', { id: 'dev', stage: 'uat' }, { stage: 'owner' }), 404);
    const dev = await run('oa', { id: 'dev' }, { dev: 'owner', orgAdmin: true });
    assert.strictEqual(dev.viaOrgAdmin, true);
    // Not an admin of this organisation, or no admin at all.
    await refuses(run('se', { id: 'dev', stage: 'prd' }, { stage: 'owner', orgAdmin: true }), 404);
    // Somebody who passes on a role is not flagged.
    assert.strictEqual((await run('so', { id: 'dev', stage: 'uat' }, { stage: 'owner', orgAdmin: true })).viaOrgAdmin, false);
});

test('the drain router addresses a stage by its own project id', async () => {
    const ctx = await run('sv', { stageProjectId: 'uat' }, { stage: 'viewer' });
    assert.deepStrictEqual([ctx.stage.projectId, ctx.dev.id, ctx.stageRole], ['uat', 'dev', 'viewer']);
    await refuses(run('sv', { stageProjectId: 'uat' }, { stage: 'editor' }), 403);
    await refuses(run('de', { stageProjectId: 'uat' }, { stage: 'viewer' }), 404);
    await refuses(run('so', { stageProjectId: 'dev' }, { stage: 'viewer' }), 404, undefined);
    await refuses(run('so', { stageProjectId: 'nope' }, { stage: 'viewer' }), 404);
    assert.strictEqual((await run('oa', { stageProjectId: 'prd' }, { stage: 'owner', orgAdmin: true })).viaOrgAdmin, true);
});

test('the middleware sets req.stageCtx and calls next; a refusal rejects', async () => {
    const mw = stageAuthMw({ stage: 'viewer' }, deps);
    assert.strictEqual(mw.name, 'stageAuthMiddleware');
    const r = req('sv', { id: 'dev', stage: 'uat' });
    let called = 0;
    await mw(r, {}, () => { called += 1; });
    assert.strictEqual(called, 1);
    assert.strictEqual(r.stageCtx.stageRole, 'viewer');
    await assert.rejects(mw(req('de', { id: 'dev', stage: 'uat' }), {}, () => { called += 1; }), (e) => e.status === 404);
    assert.strictEqual(called, 1);
});
