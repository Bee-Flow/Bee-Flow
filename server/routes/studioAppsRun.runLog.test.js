/**
 * The run log of a browser run, end to end: the real routers (routes/studioAppsRun.js for /step
 * and /runs/end, routes/studioApps/runLog.js for the reads) behind their real gates, the real
 * stores on one PGlite database. Only the executor's answer is set per test (the step itself is
 * not what this is about); the run log is switched on through its seam (configureClickRuns).
 *
 * Spec: a run with a failing step appears with the error reason and the duration per step.
 *
 * Run: cd server && node --test routes/studioAppsRun.runLog.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'runlog-test-session-secret-0123456789abcdef';
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'runlog-test-master-key-0123456789abcdef0123456789';

const { usePglitePool } = require('../testUtils/pglitePool');
const { close: closePg } = usePglitePool();

const h = require('../testUtils/routeHarness');
const clickRuns = require('../appStudio/runLog/clickRuns.mts');
const { runLogStore } = require('../stores/studioAppData/runLogStore.mts');

const ORG = 'org-runlog';
const OWNER = { id: 'u-runlog-owner', username: 'olga', email: 'olga@runlog.test', displayName: 'Olga Owner', organizationId: ORG, role: 'user', orgRole: 'member', groups: [] };
const VIEWER = { id: 'u-runlog-viewer', username: 'vera', email: 'vera@runlog.test', displayName: 'Vera Viewer', organizationId: ORG, role: 'user', orgRole: 'member', groups: [] };
const OTHER = { id: 'u-runlog-other', username: 'mal', email: 'mal@runlog.test', displayName: 'Mal', organizationId: ORG, role: 'user', orgRole: 'member', groups: [] };

const SEQ = {
    kind: 'sequence',
    steps: [
        { kind: 'create_record', tableId: 'tbl_x', values: {} },
        { kind: 'toast', message: 'hi' },
        { kind: 'update_record', tableId: 'tbl_x', recordId: 'r1', values: {} },
        { kind: 'call_action', actionId: 'helper' },
    ],
};
const HELPER = { kind: 'sequence', steps: [{ kind: 'delete_record', tableId: 'tbl_x', recordId: 'r2' }] };

let api;
let nextResults = [];
let storeBroken = false;
const warnings = [];

test.before(async () => {
    const userStore = require('../stores/userStore');
    await userStore.initDB();
    const plan = await userStore.createPlan({ name: 'Run log plan', tier: 'pro', allowed_features: ['automations'] });
    await userStore.createOrganization({ id: ORG, name: 'Run log org' }, { autoGrantTrial: false });
    await userStore.setOrgSubscription(ORG, { plan_id: plan.id, status: 'active' });
    for (const u of [OWNER, VIEWER, OTHER]) await userStore.createUser({ ...u, passwordHash: 'x' });
    await require('../stores/studioAppStore').initDB();

    // The step's answer, per test: the run log records whatever the executor says.
    const actionExecutor = require('../appStudio/actionExecutor');
    actionExecutor.executeDataStep = async () => {
        await new Promise((r) => { setTimeout(r, 3); });
        return nextResults.shift() ?? { ok: true, result: { id: 'rec_1' } };
    };
    const real = runLogStore();
    // A store whose writes can fail, to show a step never depends on its log.
    const store = new Proxy(real, {
        get(target, prop) {
            const fn = target[prop];
            if (typeof fn !== 'function') return fn;
            return (...a) => (storeBroken && ['claimClickRun', 'insertRun', 'appendSteps'].includes(prop) ? Promise.reject(new Error('db down')) : fn(...a));
        },
    });
    clickRuns.configureClickRuns({ store: () => store, log: { warn: (...a) => warnings.push(a.join(' ')) } });
    api = h.serve('/api/studio-apps', [require('./studioAppsRun'), require('./studioApps/runLog')], { user: VIEWER });
}, { timeout: 120_000 });

test.after(async () => {
    clickRuns.configureClickRuns(null);
    if (api) await api.close();
    await closePg();
});

test.beforeEach(() => { nextResults = []; storeBroken = false; warnings.length = 0; });

let n = 0;
async function makeApp() {
    const studioAppStore = require('../stores/studioAppStore');
    const app = await studioAppStore.createStudioApp({ userId: OWNER.id, organizationId: ORG, name: `Run log app ${++n}` });
    const def = { schemaVersion: 1, meta: {}, theme: {}, homeScreenId: 's1', screens: [], actions: { seq: SEQ, helper: HELPER } };
    const saved = await studioAppStore.saveDefinition(app.id, OWNER.id, def);
    assert.ok(saved && saved.ok, 'definition saved');
    assert.ok(await studioAppStore.setStudioAppPublished(app.id, true, OWNER.id, [], ORG), 'published to the org');
    return app.id;
}

const KEY = 'rk_0123456789abcdefXYZ';
const step = (appId, body, user = VIEWER) => api.call('POST', `/api/studio-apps/${appId}/actions/seq/step`, { body, user });
const runs = (appId, query = '', user = OWNER) => api.call('GET', `/api/studio-apps/${appId}/runs${query}`, { user });

test('spec: a run with a failing step appears with the error reason and the duration per step', async () => {
    const appId = await makeApp();
    nextResults = [{ ok: true, result: { id: 'rec_1' } }, { ok: false, error: 'Record r1 was not found', code: 'not_found' }];
    const s1 = await step(appId, { stepIndex: 0, runKey: KEY });
    assert.deepEqual(s1.body, { ok: true, result: { id: 'rec_1' } }, 'the step answers as before');
    const s2 = await step(appId, { stepIndex: 2, runKey: KEY });
    assert.equal(s2.body.ok, false);
    await clickRuns._settledClickSteps();
    const end = await api.call('POST', `/api/studio-apps/${appId}/actions/seq/runs/end`, { body: { runKey: KEY, status: 'error', error: 'Record r1 was not found' }, user: VIEWER });
    assert.deepEqual(end.body, { ok: true, recorded: true });

    const list = await runs(appId);
    assert.equal(list.status, 200, list.text);
    assert.equal(list.body.runs.length, 1, 'two steps of one click are one run');
    const run = list.body.runs[0];
    assert.equal(run.status, 'error');
    assert.equal(run.error, 'Record r1 was not found');
    assert.equal(run.errorCode, 'not_found');
    assert.equal(run.errorStep.path, 'steps[2]');
    assert.equal(run.origin, 'click');
    assert.equal(run.endedBy, 'client');
    assert.equal(run.actor.kind, 'user');
    assert.equal(run.actor.name, 'Vera Viewer');
    assert.equal(list.body.retentionDays, 30);
    assert.ok(!JSON.stringify(list.body).includes('@runlog.test'), 'never an e-mail address');

    const detail = await api.call('GET', `/api/studio-apps/${appId}/runs/${run.id}`, { user: OWNER });
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body.steps.map((s) => [s.path, s.kind, s.status]), [['steps[0]', 'create_record', 'ok'], ['steps[2]', 'update_record', 'error']]);
    for (const s of detail.body.steps) assert.ok(Number.isInteger(s.durationMs) && s.durationMs >= 0, `${s.path} has a duration`);
    assert.equal(detail.body.steps[1].error, 'Record r1 was not found');
});

test('a callee step (callPath) lands in the same run with the callee as its action', async () => {
    const appId = await makeApp();
    await step(appId, { stepIndex: 0, runKey: KEY });
    await step(appId, { stepIndex: 0, callPath: [3], runKey: KEY });
    await clickRuns._settledClickSteps();
    const list = await runs(appId);
    assert.equal(list.body.runs.length, 1);
    const detail = await api.call('GET', `/api/studio-apps/${appId}/runs/${list.body.runs[0].id}`, { user: OWNER });
    assert.deepEqual(detail.body.steps.map((s) => [s.path, s.actionId]), [['steps[0]', 'seq'], ['steps[3].call.steps[0]', 'helper']]);
});

test('without a runKey a step is a run of its own; an end without a key records nothing', async () => {
    const appId = await makeApp();
    await step(appId, { stepIndex: 0 });
    await step(appId, { stepIndex: 2 });
    await clickRuns._settledClickSteps();
    const list = await runs(appId);
    assert.equal(list.body.runs.length, 2);
    assert.ok(list.body.runs.every((r) => r.tracked === false && r.stepCount === 1 && r.status === 'success'));
    const end = await api.call('POST', `/api/studio-apps/${appId}/actions/seq/runs/end`, { body: {}, user: VIEWER });
    assert.deepEqual(end.body, { ok: true, recorded: false });
    const unknown = await api.call('POST', `/api/studio-apps/${appId}/actions/nope/runs/end`, { body: {}, user: VIEWER });
    assert.equal(unknown.status, 404);
});

test('someone else\'s runKey never joins their run', async () => {
    const appId = await makeApp();
    await step(appId, { stepIndex: 0, runKey: KEY });
    await step(appId, { stepIndex: 2, runKey: KEY }, OTHER);
    await clickRuns._settledClickSteps();
    const end = await api.call('POST', `/api/studio-apps/${appId}/actions/seq/runs/end`, { body: { runKey: KEY, status: 'success' }, user: OTHER });
    assert.equal(end.body.recorded, false);
    assert.equal((await runs(appId)).body.runs.length, 2);
    const vera = await runs(appId, `?user=${VIEWER.id}`);
    assert.equal(vera.body.runs.length, 1);
    assert.equal(vera.body.runs[0].stepCount, 1);
});

test('only the owner reads the runs: everyone else gets 404', async () => {
    const appId = await makeApp();
    await step(appId, { stepIndex: 0, runKey: KEY });
    await clickRuns._settledClickSteps();
    assert.equal((await runs(appId, '', VIEWER)).status, 404);
    const owner = await runs(appId);
    const detail = await api.call('GET', `/api/studio-apps/${appId}/runs/${owner.body.runs[0].id}`, { user: VIEWER });
    assert.equal(detail.status, 404);
    const bad = await api.call('GET', `/api/studio-apps/${appId}/runs/sar_nope`, { user: OWNER });
    assert.equal(bad.status, 404);
});

test('filters and pages: status, action, cursor', async () => {
    const appId = await makeApp();
    nextResults = [{ ok: true }, { ok: false, error: 'boom' }, { ok: true }];
    for (let i = 0; i < 3; i += 1) await step(appId, { stepIndex: 0 });
    await clickRuns._settledClickSteps();
    assert.equal((await runs(appId, '?status=error')).body.runs.length, 1);
    const page1 = await runs(appId, '?limit=2');
    assert.equal(page1.body.runs.length, 2);
    assert.ok(page1.body.nextCursor);
    const page2 = await runs(appId, `?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`);
    assert.equal(page2.body.runs.length, 1);
    assert.equal(page2.body.nextCursor, null);
    assert.equal(page2.body.actors, undefined, 'facets on the first page only');
    assert.equal((await runs(appId, '?actionId=helper')).body.runs.length, 0);
    assert.equal((await runs(appId, '?status=done')).status, 400);
});

test('a failing run log never changes the step\'s answer', async () => {
    const appId = await makeApp();
    storeBroken = true;
    const r = await step(appId, { stepIndex: 0, runKey: KEY });
    assert.deepEqual(r.body, { ok: true, result: { id: 'rec_1' } });
    const r2 = await step(appId, { stepIndex: 0 });
    assert.equal(r2.body.ok, true);
    await clickRuns._settledClickSteps();
    assert.ok(warnings.some((w) => /StudioRunLog/.test(w) && /db down/.test(w)), 'logged with the message only');
});
