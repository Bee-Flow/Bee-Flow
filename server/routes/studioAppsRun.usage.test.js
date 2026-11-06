/**
 * The usage row of a signed-in App Studio action (routes/studioAppsRunUsage.js):
 * the row is the OWNER's (the real work happens under the owner), the viewer
 * who clicked is the actor, and the AI calls inside a step are attributed to
 * that viewer. The real router behind its real gates, the real stores on one
 * PGlite database; only the executor's answer is set (the step itself is not
 * what this is about).
 *
 * Run: cd server && node --test routes/studioAppsRun.usage.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'usage-test-session-secret-0123456789abcdef';
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'usage-test-master-key-0123456789abcdef0123456789';

const { usePglitePool } = require('../testUtils/pglitePool');
const { query, close: closePg } = usePglitePool();

const h = require('../testUtils/routeHarness');
const { actionUsageRow } = require('./studioAppsRunUsage');
const { usageAttributionFields } = require('../appStudio/usageAttribution');

const ORG = 'org-usage';
const OWNER = { id: 'u-usage-owner', username: 'otto', email: 'otto@usage.test', displayName: 'Otto Owner', organizationId: ORG, role: 'user', orgRole: 'member', groups: [] };
const VIEWER = { id: 'u-usage-viewer', username: 'vic', email: 'vic@usage.test', displayName: 'Vic Viewer', organizationId: ORG, role: 'user', orgRole: 'member', groups: [] };

const SEQ = { kind: 'sequence', steps: [{ kind: 'create_record', tableId: 'tbl_x', values: {} }] };

let api;
/** What the executor saw of the usage attribution, per step. */
const seen = [];

test.before(async () => {
    const userStore = require('../stores/userStore');
    await userStore.initDB();
    const plan = await userStore.createPlan({ name: 'Usage plan', tier: 'pro', allowed_features: ['automations'] });
    await userStore.createOrganization({ id: ORG, name: 'Usage org' }, { autoGrantTrial: false });
    await userStore.setOrgSubscription(ORG, { plan_id: plan.id, status: 'active' });
    for (const u of [OWNER, VIEWER]) await userStore.createUser({ ...u, passwordHash: 'x' });
    await require('../stores/studioAppStore').initDB();
    await require('../stores/usageStore').initDB();

    const actionExecutor = require('../appStudio/actionExecutor');
    actionExecutor.executeDataStep = async () => {
        seen.push(usageAttributionFields());
        return { ok: true, result: { id: 'rec_1' } };
    };
    api = h.serve('/api/studio-apps', require('./studioAppsRun'), { user: VIEWER });
}, { timeout: 120_000 });

test.after(async () => {
    if (api) await api.close();
    await closePg();
});

test.beforeEach(() => { seen.length = 0; });

let n = 0;
async function makeApp() {
    const studioAppStore = require('../stores/studioAppStore');
    const app = await studioAppStore.createStudioApp({ userId: OWNER.id, organizationId: ORG, name: `Usage app ${++n}` });
    const def = { schemaVersion: 1, meta: {}, theme: {}, homeScreenId: 's1', screens: [], actions: { seq: SEQ } };
    const saved = await studioAppStore.saveDefinition(app.id, OWNER.id, def);
    assert.ok(saved && saved.ok, 'definition saved');
    assert.ok(await studioAppStore.setStudioAppPublished(app.id, true, OWNER.id, [], ORG), 'published to the org');
    return app.id;
}

/**
 * The usage rows of one app, once the fire-and-forget write has landed.
 * @param {string} appId
 */
async function usageRows(appId) {
    for (let i = 0; i < 100; i++) {
        const r = await query('SELECT user_id, organization_id, source, actor_user_id, run_id FROM ai_usage_log WHERE agent_id = $1', [appId]);
        if (r.rows.length) return r.rows;
        await new Promise((resolve) => { setTimeout(resolve, 10); });
    }
    return [];
}

test('step: usage is logged under the OWNER, the viewer who clicked is the actor', async () => {
    const appId = await makeApp();
    const r = await api.call('POST', `/api/studio-apps/${appId}/actions/seq/step`, { body: { stepIndex: 0 }, user: VIEWER });
    assert.equal(r.status, 200, r.text);
    const rows = await usageRows(appId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, OWNER.id);
    assert.equal(rows[0].organization_id, ORG);
    assert.equal(rows[0].source, 'studio_app_action');
    assert.equal(rows[0].actor_user_id, VIEWER.id, 'the viewer who clicked is the actor');
    assert.equal(rows[0].run_id, null, 'a step starts no automation run');
});

test('step: the AI calls inside the step are attributed to the viewer who clicked', async () => {
    const appId = await makeApp();
    const r = await api.call('POST', `/api/studio-apps/${appId}/actions/seq/step`, { body: { stepIndex: 0 }, user: VIEWER });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(seen, [{ actor_user_id: VIEWER.id, run_id: null }]);
});

test('the row of a click that started a run names the run; a step row carries no run key', () => {
    const app = { id: 'app-1', userId: OWNER.id, organizationId: ORG, name: 'An app' };
    const run = actionUsageRow(app, { actorUserId: VIEWER.id, runId: 'run-1', startedAt: Date.now() });
    assert.equal(run.user_id, OWNER.id);
    assert.equal(run.actor_user_id, VIEWER.id);
    assert.equal(run.run_id, 'run-1');
    assert.equal(run.agent_name, 'App: An app');
    const step = actionUsageRow({ id: 'app-2', userId: OWNER.id }, { actorUserId: VIEWER.id, startedAt: Date.now() });
    assert.ok(!Object.hasOwn(step, 'run_id'));
    assert.equal(step.organization_id, null);
    assert.equal(step.agent_name, 'App: Untitled app');
});

test('ai chat: a colleague\'s chat turn is the owner\'s row with the colleague as the actor', async () => {
    const studioAppStore = require('../stores/studioAppStore');
    const aiRuntime = require('../appStudio/aiRuntime');
    const llmClient = require('../core/llm/llmClient');
    const app = await studioAppStore.createStudioApp({ userId: OWNER.id, organizationId: ORG, name: `Chat app ${++n}` });
    const chat = { id: 'chat1', type: 'ai_chat', props: {} };
    const def = { schemaVersion: 1, meta: {}, theme: {}, homeScreenId: 's1', screens: [{ id: 's1', name: 'Home', sections: [{ id: 'sec1', children: [chat] }] }], actions: {} };
    const saved = await studioAppStore.saveDefinition(app.id, OWNER.id, def);
    assert.ok(saved && saved.ok, 'definition saved');
    assert.ok(await studioAppStore.setStudioAppPublished(app.id, true, OWNER.id, [], ORG), 'published to the org');
    // The model the owner configured, and its answer: not what this is about.
    const orig = { resolveOwnerModel: aiRuntime.resolveOwnerModel, stream: llmClient.stream };
    aiRuntime.resolveOwnerModel = async () => ({ modelId: 'model-chat', options: {} });
    llmClient.stream = async (_model, _messages, _opts, onEvent) => {
        onEvent('text', { text: 'Hello' });
        onEvent('done', { prompt_tokens: 12, completion_tokens: 3 });
    };
    try {
        const r = await api.call('POST', `/api/studio-apps/${app.id}/ai/chat`, { body: { nodeId: 'chat1', messages: [{ role: 'user', content: 'Hi' }] }, user: VIEWER });
        assert.equal(r.status, 200, r.text);
        assert.match(r.text, /Hello/);
        const rows = await usageRows(app.id);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].source, 'studio_app_chat');
        assert.equal(rows[0].user_id, OWNER.id, 'the owner pays');
        assert.equal(rows[0].actor_user_id, VIEWER.id, 'the colleague who chatted is the actor');
    } finally {
        aiRuntime.resolveOwnerModel = orig.resolveOwnerModel;
        llmClient.stream = orig.stream;
    }
});

test('a public visitor\'s step row is the owner\'s, with no actor', () => {
    const { publicStepUsageRow } = require('./studioAppPublicParts');
    const row = publicStepUsageRow({ id: 'app-3', userId: OWNER.id, organizationId: ORG }, Date.now());
    assert.equal(row.user_id, OWNER.id);
    assert.equal(row.source, 'studio_app_public');
    assert.equal(row.actor_user_id, null);
    assert.ok(!Object.hasOwn(row, 'run_id'));
});
