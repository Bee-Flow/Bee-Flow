'use strict';

/**
 * Background actions over the REAL action-run router (routes/studioAppsRun.js with
 * routes/studioAppBackground.js), the real gates and the real stores on PGlite; only the
 * executor's executeDataStep is swapped, so a step can be held open.
 *
 *   - spec: POST …/background answers 202 with a jobId before the step finishes; the job ends
 *     after the request is gone and GET …/jobs/:jobId shows its result;
 *   - spec: a second start with the same lockKey is refused (409 action_locked, with the job id
 *     for the same viewer only), and so is /step of the same action;
 *   - a sequence without background, an unknown action, a browser-only step: refused;
 *   - a colleague asking ?draft=1 runs the published definition;
 *   - readers: the starter and the owner; another viewer gets a uniform 404; the list is the caller's own.
 *
 * Run: cd server && node --test routes/studioAppBackground.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'background-test-session-secret-0123456789abcdef';
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'background-test-master-key-0123456789abcdef0123456789';

const { usePglitePool } = require('../testUtils/pglitePool');
const { close: closePg } = usePglitePool();
const h = require('../testUtils/routeHarness');

const ORG = 'org-bg';
const OWNER = { id: 'u-bg-owner', username: 'bg-owner', email: 'owner@bg.test', organizationId: ORG, role: 'user', orgRole: 'member', groups: [] };
const VIEWER = { id: 'u-bg-viewer', username: 'bg-viewer', email: 'viewer@bg.test', organizationId: ORG, role: 'user', orgRole: 'member', groups: [] };
const OTHER = { id: 'u-bg-other', username: 'bg-other', email: 'other@bg.test', organizationId: ORG, role: 'user', orgRole: 'member', groups: [] };

let gate = Promise.resolve();
const stepCalls = [];
let api;
let BG;

before(async () => {
    const userStore = require('../stores/userStore');
    await userStore.initDB();
    await userStore.createOrganization({ id: ORG, name: 'Org BG' }, { autoGrantTrial: false });
    for (const u of [OWNER, VIEWER, OTHER]) await userStore.createUser({ ...u, passwordHash: 'x' });
    for (const store of ['studioAppStore', 'studioAppDataStore']) {
        const s = require(`../stores/${store}`);
        if (typeof s.initDB === 'function') await s.initDB();
    }
    const actionExecutor = require('../appStudio/actionExecutor');
    actionExecutor.executeDataStep = async (_app, _model, step, ctx) => {
        stepCalls.push({ step, ctx });
        await gate;
        return { ok: true, result: { done: step.tableId } };
    };
    BG = require('../appStudio/backgroundRun.mts');
    api = h.serve('/api/studio-apps', require('./studioAppsRun'), { user: OWNER });
}, { timeout: 120_000 });

after(async () => {
    if (api) await api.close();
    await closePg();
});

beforeEach(() => { gate = Promise.resolve(); stepCalls.length = 0; });

function hold() {
    let release;
    gate = new Promise((resolve) => { release = resolve; });
    return () => { release(); gate = Promise.resolve(); };
}

const LOCKED = { kind: 'sequence', background: true, lockKey: { kind: 'formula', expr: 'form.orderId' }, steps: [{ kind: 'create_record', tableId: 'tbl_x', values: {} }] };

let n = 0;
/** A published app of OWNER's org with `actions` (the draft may differ). */
async function makeApp(actions, draftActions = actions) {
    const store = require('../stores/studioAppStore');
    const def = (acts) => ({ schemaVersion: 2, meta: { name: 'Jobs' }, theme: {}, homeScreenId: 'scr_1', screens: [{ id: 'scr_1', name: 'Home', sections: [] }], actions: acts });
    const app = await store.createStudioApp({ userId: OWNER.id, organizationId: ORG, name: `Jobs ${++n}`, definition: def(draftActions) });
    await store.setStudioAppPublished(app.id, true, OWNER.id, [], ORG, def(actions), 1);
    return app;
}

const start = (app, actionId, body, user = VIEWER, query = '') => api.call('POST', `/api/studio-apps/${app.id}/actions/${actionId}/background${query}`, { body, user });
const job = (app, jobId, user = VIEWER) => api.call('GET', `/api/studio-apps/${app.id}/actions/jobs/${jobId}`, { user });

test('spec: the start answers 202 before the step finishes; the job ends after the request is gone', async () => {
    const app = await makeApp({ act_bg: LOCKED });
    const release = hold();
    const r = await start(app, 'act_bg', { formValues: { orderId: 'o1' } });
    assert.equal(r.status, 202, r.text);
    assert.equal(r.body.status, 'running');
    assert.match(r.body.jobId, /^sar_[0-9a-f]{32}$/);
    assert.equal((await job(app, r.body.jobId)).body.status, 'running');
    release();
    await BG._settled(r.body.jobId);
    const done = await job(app, r.body.jobId);
    assert.equal(done.status, 200);
    assert.equal(done.body.status, 'success');
    assert.deepEqual(done.body.result, { done: 'tbl_x' });
    assert.equal(stepCalls[0].ctx.viewerId, VIEWER.id);
});

test('spec: a double start with the same lockKey is refused while the first runs', async () => {
    const app = await makeApp({ act_bg: LOCKED });
    const release = hold();
    const first = await start(app, 'act_bg', { formValues: { orderId: 'o9' } });
    assert.equal(first.status, 202, first.text);
    const second = await start(app, 'act_bg', { formValues: { orderId: 'o9' } });
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'action_locked');
    assert.match(second.body.error, /already running for the same item/);
    assert.equal(second.body.jobId, first.body.jobId, 'the same viewer gets the job to follow');
    const other = await start(app, 'act_bg', { formValues: { orderId: 'o9' } }, OTHER);
    assert.equal(other.status, 409);
    assert.equal(other.body.jobId, undefined);
    const step = await api.call('POST', `/api/studio-apps/${app.id}/actions/act_bg/step`, { body: { stepIndex: 0, formValues: { orderId: 'o9' } }, user: VIEWER });
    assert.equal(step.status, 409);
    assert.equal(step.body.code, 'action_locked');
    release();
    await BG._settled(first.body.jobId);
    const again = await start(app, 'act_bg', { formValues: { orderId: 'o9' } });
    assert.equal(again.status, 202);
    await BG._settled(again.body.jobId);
});

test('a sequence without background, an unknown action and a browser-only step are refused', async () => {
    const app = await makeApp({
        act_fg: { kind: 'sequence', steps: [{ kind: 'toast', message: 'x' }] },
        act_nav: { kind: 'sequence', background: true, steps: [{ kind: 'navigate', screenId: 'scr_1' }] },
    });
    const fg = await start(app, 'act_fg', {});
    assert.equal(fg.status, 400);
    assert.equal(fg.body.code, 'not_background');
    assert.equal((await start(app, 'act_zz', {})).status, 404);
    const nav = await start(app, 'act_nav', {});
    assert.equal(nav.status, 400);
    assert.equal(nav.body.code, 'background_not_runnable');
});

test('a colleague asking for ?draft=1 runs the published definition', async () => {
    const step = (tableId) => ({ kind: 'sequence', background: true, steps: [{ kind: 'create_record', tableId, values: {} }] });
    const app = await makeApp({ act_bg: step('tbl_pub') }, { act_bg: step('tbl_draft') });
    const r = await start(app, 'act_bg', {}, VIEWER, '?draft=1');
    assert.equal(r.status, 202, r.text);
    await BG._settled(r.body.jobId);
    assert.equal(stepCalls[0].step.tableId, 'tbl_pub');
});

test('readers: the starter and the owner; another viewer gets a uniform 404; the list is the caller\'s own', async () => {
    const app = await makeApp({ act_bg: { kind: 'sequence', background: true, steps: [{ kind: 'create_record', tableId: 't', values: {} }] } });
    const release = hold();
    const r = await start(app, 'act_bg', {});
    assert.equal((await job(app, r.body.jobId, OWNER)).status, 200);
    const stranger = await job(app, r.body.jobId, OTHER);
    assert.equal(stranger.status, 404);
    assert.equal(stranger.body.error, 'Run not found');
    assert.equal((await job(app, 'not-a-job')).status, 404, 'a malformed id is the same 404');
    const mine = await api.call('GET', `/api/studio-apps/${app.id}/actions/jobs?active=1`, { user: VIEWER });
    assert.deepEqual(mine.body.jobs.map((j) => j.jobId), [r.body.jobId]);
    const theirs = await api.call('GET', `/api/studio-apps/${app.id}/actions/jobs?active=1`, { user: OTHER });
    assert.deepEqual(theirs.body.jobs, []);
    release();
    await BG._settled(r.body.jobId);
});

/** The smallest response refusePublicLocked writes to. */
function fakeRes() {
    const res = { statusCode: 200, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
}

test('#590: a public visitor\'s /step of a background action is refused while a job holds the same lockKey', async () => {
    const { refusePublicLocked } = require('./studioAppBackground');
    const app = await makeApp({ act_bg: LOCKED, act_plain: { kind: 'sequence', steps: LOCKED.steps } });
    const store = require('../stores/studioAppStore');
    const published = (await store.getStudioApp(app.id)).publishedDefinition;
    const release = hold();
    const first = await start(app, 'act_bg', { formValues: { orderId: 'p1' } });
    assert.equal(first.status, 202, first.text);
    const visit = async (actionId, orderId) => {
        const res = fakeRes();
        const refused = await refusePublicLocked({ body: { stepIndex: 0, formValues: { orderId } } }, res,
            { app, definition: published }, { model: null, role: 'public', viewerId: 'anon_0123456789abcdef01234567' }, actionId);
        return { refused, res };
    };
    const same = await visit('act_bg', 'p1');
    assert.equal(same.refused, true);
    assert.equal(same.res.statusCode, 409);
    assert.equal(same.res.body.code, 'action_locked');
    assert.equal(same.res.body.jobId, undefined, 'a visitor never gets the job id to follow');
    assert.equal((await visit('act_bg', 'p2')).refused, false, 'another key is not locked');
    assert.equal((await visit('act_plain', 'p1')).refused, false, 'an action without background/lockKey is never refused');
    release();
    await BG._settled(first.body.jobId);
    assert.equal((await visit('act_bg', 'p1')).refused, false, 'the lock ends with the job');
});
