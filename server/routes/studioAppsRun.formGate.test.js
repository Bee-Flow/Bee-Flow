'use strict';

/**
 * The form values a step, a background job and an automation receive, over the REAL action-run
 * router (routes/studioAppsRun.js with routes/studioAppBackground.js), the real gates and the
 * real stores on PGlite. Only the executor's executeDataStep, the automation lookup and the
 * automation runner are swapped, so what they are handed can be read.
 *
 *   - a form without a gated field: every route hands on exactly what was sent;
 *   - a field gated to a role: a viewer without that role has its value left out on /step,
 *     /background and /run (declared inputs and plain inputs); the role itself and the owner
 *     keep it.
 *
 * Run: cd server && node --test routes/studioAppsRun.formGate.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'form-gate-test-session-secret-0123456789abcdef';
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'form-gate-test-master-key-0123456789abcdef0123456789';

const { usePglitePool } = require('../testUtils/pglitePool');
const { close: closePg } = usePglitePool();
const h = require('../testUtils/routeHarness');

const ORG = 'org-fg';
const person = (id) => ({ id, username: id, email: `${id}@fg.test`, organizationId: ORG, role: 'user', orgRole: 'member', groups: [] });
const OWNER = person('u-fg-owner');
const MEMBER = person('u-fg-member');
const ADMIN = person('u-fg-admin');

const stepCalls = [];
const runnerCalls = [];
const automations = new Map();
let api;
let BG;

before(async () => {
    const userStore = require('../stores/userStore');
    await userStore.initDB();
    await userStore.createOrganization({ id: ORG, name: 'Org FG' }, { autoGrantTrial: false });
    for (const u of [OWNER, MEMBER, ADMIN]) await userStore.createUser({ ...u, passwordHash: 'x' });
    for (const store of ['studioAppStore', 'studioAppDataStore']) {
        const s = require(`../stores/${store}`);
        if (typeof s.initDB === 'function') await s.initDB();
    }
    const actionExecutor = require('../appStudio/actionExecutor');
    actionExecutor.executeDataStep = async (_app, _model, step, ctx) => {
        stepCalls.push({ step, ctx });
        return { ok: true, result: { id: 'rec_1' } };
    };
    require('../stores/automationStore').getAutomation = async (id) => automations.get(id) || null;
    require('../core/automationRunner').executeAutomation = async (automation, opts) => {
        runnerCalls.push({ automation, opts });
        return { id: 'run-1', status: 'success', output: null, error: null };
    };
    BG = require('../appStudio/backgroundRun.mts');
    api = h.serve('/api/studio-apps', require('./studioAppsRun'), { user: MEMBER });
}, { timeout: 120_000 });

after(async () => {
    if (api) await api.close();
    await closePg();
});

beforeEach(() => { stepCalls.length = 0; runnerCalls.length = 0; });

const WRITE = { kind: 'create_record', tableId: 'tbl_x', values: {} };
const ACTIONS = {
    act_save: { kind: 'sequence', steps: [WRITE] },
    act_bg: { kind: 'sequence', background: true, steps: [WRITE] },
    act_flow: { kind: 'run_automation', automationId: 'auto-plain' },
    act_typed: { kind: 'run_automation', automationId: 'auto-typed' },
};

/** One form per action, each with the same three fields; `gate` goes on approvedBy. */
function screensWith(gate) {
    const fields = () => [
        { id: 'in_title', type: 'input_text', props: { name: 'title' } },
        { id: 'in_amount', type: 'input_number', props: { name: 'amount' } },
        { id: 'in_by', type: 'input_text', props: { name: 'approvedBy' }, ...(gate ? { visibleToRoles: gate } : {}) },
    ];
    const children = Object.keys(ACTIONS).map((actionId, i) => ({ id: `frm_${i}`, type: 'form', props: { name: `form_${i}` }, onSubmit: actionId, children: fields() }));
    return [{ id: 'scr_1', name: 'Home', sections: [{ id: 'sec_1', children }] }];
}

let n = 0;
/** A published app of OWNER's org; ADMIN is a member with the role `admin`, MEMBER has no role. */
async function makeApp(gate, extra = {}) {
    const store = require('../stores/studioAppStore');
    const def = { schemaVersion: 2, meta: { name: 'Forms' }, theme: {}, homeScreenId: 'scr_1', screens: screensWith(gate), actions: ACTIONS, ...extra };
    const app = await store.createStudioApp({ userId: OWNER.id, organizationId: ORG, name: `Forms ${++n}`, definition: def });
    await store.setStudioAppPublished(app.id, true, OWNER.id, [], ORG, def, 1);
    assert.ok(await require('../stores/studioAppDataStore').addMember(app.id, OWNER.id, ADMIN.id, 'admin'), 'admin role given');
    return app;
}

const SENT = { title: 'Laptop', amount: 1200, approvedBy: 'someone' };
const KEPT = { title: 'Laptop', amount: 1200 };
const post = (app, path, body, user) => api.call('POST', `/api/studio-apps/${app.id}/actions/${path}`, { body, user });

before(() => {
    automations.set('auto-plain', { id: 'auto-plain', userId: OWNER.id, definition: { trigger: { kind: 'manual' }, steps: [] } });
    automations.set('auto-typed', {
        id: 'auto-typed', userId: OWNER.id,
        definition: { trigger: { kind: 'app_trigger', params: [{ name: 'title', type: 'string' }, { name: 'approvedBy', type: 'string' }] }, steps: [] },
    });
});

/** What each route hands on for one viewer of one app. */
async function handedOn(app, user) {
    const out = {};
    const step = await post(app, 'act_save/step', { stepIndex: 0, formValues: SENT }, user);
    assert.equal(step.status, 200, step.text);
    out.step = stepCalls.at(-1).ctx.formValues;

    const bg = await post(app, 'act_bg/background', { formValues: SENT }, user);
    assert.equal(bg.status, 202, bg.text);
    await BG._settled(bg.body.jobId);
    out.background = stepCalls.at(-1).ctx.formValues;

    const plain = await post(app, 'act_flow/run', { formValues: SENT }, user);
    assert.equal(plain.status, 200, plain.text);
    out.plain = runnerCalls.at(-1).opts.triggerPayload.inputs;

    const typed = await post(app, 'act_typed/run', { formValues: SENT }, user);
    assert.equal(typed.status, 200, typed.text);
    const { title, approvedBy } = runnerCalls.at(-1).opts.triggerPayload;
    out.typed = { title, ...(approvedBy === undefined ? {} : { approvedBy }) };
    return out;
}

test('the typed fixture is an app-trigger automation (otherwise the typed path is not under test)', () => {
    assert.equal(require('../appStudio/actionExecutor').isAppTriggerAutomation(automations.get('auto-typed')), true);
    assert.equal(require('../appStudio/actionExecutor').isAppTriggerAutomation(automations.get('auto-plain')), false);
});

test('a form without a gated field: every route hands on exactly what was sent', async () => {
    const app = await makeApp(null);
    for (const user of [MEMBER, ADMIN, OWNER]) {
        assert.deepEqual(await handedOn(app, user), {
            step: SENT, background: SENT, plain: SENT, typed: { title: 'Laptop', approvedBy: 'someone' },
        }, user.id);
    }
});

test('a field gated to a role: left out for a viewer without it, on every route', async () => {
    const app = await makeApp(['admin']);
    assert.deepEqual(await handedOn(app, MEMBER), { step: KEPT, background: KEPT, plain: KEPT, typed: { title: 'Laptop' } });
});

test('a field gated to a role: the role itself and the owner keep it', async () => {
    const app = await makeApp(['admin']);
    const all = { step: SENT, background: SENT, plain: SENT, typed: { title: 'Laptop', approvedBy: 'someone' } };
    assert.deepEqual(await handedOn(app, ADMIN), all);
    assert.deepEqual(await handedOn(app, OWNER), all);
});

test('the wide server scope: the forms a step is sent follow the same field gate', async () => {
    const app = await makeApp(['admin'], { schemaVersion: 3, serverScope: 'wide' });
    const body = { stepIndex: 0, formValues: SENT, forms: { form_0: SENT, form_1: SENT }, screenParams: { id: 'r1' } };
    const sentAs = async (user) => {
        const res = await post(app, 'act_save/step', body, user);
        assert.equal(res.status, 200, res.text);
        return JSON.parse(JSON.stringify(stepCalls.at(-1).ctx.wideScope));
    };
    const member = await sentAs(MEMBER);
    assert.deepEqual(member.forms, { form_0: KEPT, form_1: KEPT });
    assert.deepEqual(member.screen, { params: { id: 'r1' } });
    assert.deepEqual((await sentAs(ADMIN)).forms, { form_0: SENT, form_1: SENT });
    assert.deepEqual((await sentAs(OWNER)).forms, { form_0: SENT, form_1: SENT });
});

test('an app without the wide server scope is handed no forms at all', async () => {
    const app = await makeApp(['admin']);
    const res = await post(app, 'act_save/step', { stepIndex: 0, formValues: SENT, forms: { form_0: SENT } }, MEMBER);
    assert.equal(res.status, 200, res.text);
    assert.equal(stepCalls.at(-1).ctx.wideScope, undefined);
});
