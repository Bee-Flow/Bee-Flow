'use strict';

/**
 * GET /catalog: how the response is assembled.
 *
 * catalog.test.js pins the app_event providers, catalog.agents.test.js the
 * agent picker and catalog.codeGate.test.js the code flag. This file pins the
 * rest: the exact key set, the datatable and knowledge-base pickers (what is
 * asked of their collaborators and how a failure degrades), the reusable
 * steps and their availability, the form pick sources and the static lists.
 *
 * Route handler invoked directly, collaborators mocked through testUtils/stubRequire.
 *
 * Run: node --test routes/automation/catalog.sections.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { preloadStubs } = require('../../testUtils/stubRequire');

/** Replace a server module (path relative to server/) by a stub, before anything requires it. */
const stub = (rel, exports) => preloadStubs(require, { [`../../${rel}`]: exports });

// Per-test mutable state read by the mocks.
const S = {};
function reset() {
    Object.assign(S, {
        availableTools: ['gmail_tool'],
        toolsThrow: false,
        beta: new Set(),
        callable: [],
        callableThrows: false,
        callableArgs: null,
        audience: { orgIds: ['o1'], userGroups: ['g1'] },
        datatables: [{ id: 'dt1' }],
        datatablesThrow: false,
        datatableArgs: null,
        principalReqs: [],
        orgIds: new Set(['o1']),
        permission: true,
        permissionThrows: false,
        groups: ['g1'],
        groupsThrow: false,
        orgAdmin: true,
        orgAdminThrows: false,
        kbThrows: false,
        kbArgs: null,
        agents: { agents: [{ id: 'a1' }], agentsError: null },
        agentsThrow: false,
        agentArgs: null,
        providerArgs: null,
        sandbox: true,
        probe: { available: true, reason: null, defaultThreshold: 0.4, maxLabels: 10 },
        pickSources: [{ id: 'internal-src', internal: true }, { id: 'ext-src', internal: false }, { id: 'ext-other', internal: false }],
        pickTools: { 'ext-src': ['gmail_tool'], 'ext-other': ['missing_tool'] },
        events: [],
    });
}
reset();

stub('stores/automationStore', {
    getCallableStepsForUser: async (userId, opts) => {
        S.callableArgs = { userId, opts };
        if (S.callableThrows) throw new Error('steps down');
        return S.callable;
    },
});
stub('automation/toolRegistry', {
    TOOL_REGISTRY: [
        { app: 'gmail', label: 'Gmail' },
        { app: 'webpages', label: 'Webpages' },
    ],
    loadTools: (entry) => [
        { function: { name: `${entry.app}_tool`, description: 'does it', parameters: { type: 'object' } } },
        { function: {} },
        null,
    ],
});
stub('automation/sideEffectMap', { isSideEffect: () => true, effectOf: () => 'writes' });
stub('automation/outputSchemas', {
    getOutputSchema: () => ({ sample: { x: 1 } }),
    synthesizeDryRunOutput: () => ({}),
    producesList: () => true,
    iterableFieldsOf: () => ['rows', 'more'],
});
stub('core/integrations/integrationToolMap', {
    resolveIntegration: (name) => (name === 'gmail_tool' ? { integration: 'google-mail', label: 'Google Mail' } : null),
});
stub('core/integrations/integrationTools', {
    getIntegrationTools: async (args) => {
        S.toolArgs = args;
        if (S.toolsThrow) throw new Error('no tools');
        return { tools: S.availableTools.map(n => ({ function: { name: n } })) };
    },
});
stub('core/entitlements/betaFeatures', {
    userHasBetaFeature: async (userId, feature) => { S.events.push(['beta', userId, feature]); return S.beta.has(feature); },
});
stub('auth/audience', { resolveAudienceContext: async () => S.audience });
stub('core/classify/classifierClient', { probe: async () => S.probe });
stub('automation/codeSandbox', { isAvailable: () => S.sandbox });
stub('automation/builderTools', { buildTriggerOutputsCatalog: () => ({ 'x.y': { sample: {} } }) });
stub('auth/datatableAccess', {
    resolveDatatablePrincipal: async (req) => { S.principalReqs.push(req); return { userId: 'user1', organizationId: 'org1' }; },
});
stub('automation/builderDatatableCatalog', {
    buildDatatableCatalogForUser: async (userId, opts) => {
        S.datatableArgs = { userId, opts };
        if (S.datatablesThrow) throw new Error('dt down');
        return S.datatables;
    },
});
stub('auth', {
    resolveUserOrgIds: async () => S.orgIds,
    hasPermission: async (userId, perm) => {
        S.events.push(['perm', userId, perm]);
        if (S.permissionThrows) throw new Error('perm down');
        return S.permission;
    },
    resolveUserGroups: async (userId) => {
        S.events.push(['groups', userId]);
        if (S.groupsThrow) throw new Error('groups down');
        return S.groups;
    },
});
stub('support/kbAccess', {
    resolveIsOrgAdmin: async () => { if (S.orgAdminThrows) throw new Error('admin down'); return S.orgAdmin; },
});
stub('automation/builderPickerCatalog', {
    buildAppEventProvidersFor: async (args) => { S.providerArgs = args; return [{ id: 'approvals' }]; },
    listKnowledgeBasePicker: async (args) => {
        S.kbArgs = args;
        if (S.kbThrows) throw new Error('kb down');
        return [{ id: 'kb1', canWrite: true }];
    },
    buildAgentPickerForUser: async (userId, opts) => {
        S.agentArgs = { userId, opts };
        if (S.agentsThrow) throw new Error('agents down');
        return S.agents;
    },
});
stub('automation/formPickSources', {
    catalog: () => S.pickSources,
    getSource: (id) => id,
    toolsFor: (id) => S.pickTools[id] || [],
});

const catalogRouter = require('./catalog');

function findHandler(router, method, routePath) {
    const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
    if (!layer) throw new Error(`route not found: ${method} ${routePath}`);
    return layer.route.stack.at(-1).handle;
}
const handler = findHandler(catalogRouter, 'get', '/catalog');

async function fetchCatalog({ user = { id: 'user1', organizationId: 'org1' } } = {}) {
    const req = { session: { user, isAdmin: false } };
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await handler(req, res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    return { body: res.body, req };
}

test('the response has exactly this key set', async () => {
    reset();
    const { body } = await fetchCatalog();
    assert.deepStrictEqual(Object.keys(body).sort(), [
        'agents', 'agentsError', 'apps', 'datatableOps', 'datatables', 'deliverability', 'flags', 'formPickSources',
        'knowledgeBases', 'knowledgeWriteStrategies', 'stepTypes', 'steps', 'topics', 'triggerMeta', 'triggerOutputs', 'triggers',
    ]);
    assert.deepStrictEqual(Object.keys(body.flags).sort(), ['automations', 'code', 'codeReason', 'topics', 'topicsReason']);
});

test('an action carries its brand, label, schema, list hints and effect', async () => {
    reset();
    const { body } = await fetchCatalog();
    const gmail = body.apps.find(a => a.id === 'gmail');
    assert.strictEqual(gmail.label, 'Gmail');
    assert.strictEqual(gmail.available, true);
    assert.strictEqual(gmail.actions.length, 1, 'tools without a name are skipped');
    assert.deepStrictEqual(gmail.actions[0], {
        name: 'gmail_tool',
        label: 'Tool',
        description: 'does it',
        inputSchema: { type: 'object' },
        outputSchema: { sample: { x: 1 } },
        outputSample: { x: 1 },
        producesList: true,
        listField: 'rows',
        sideEffect: true,
        effect: 'writes',
        integrationId: 'google-mail',
        integrationLabel: 'Google Mail',
    });
    const web = body.apps.find(a => a.id === 'webpages').actions[0];
    assert.strictEqual(web.integrationId, 'webpages', 'falls back to the app id');
    assert.strictEqual(web.integrationLabel, 'Webpages');
});

test('getIntegrationTools is asked with the session, the admin flag and automationStep', async () => {
    reset();
    const { req } = await fetchCatalog();
    assert.deepStrictEqual(S.toolArgs, { userId: 'user1', session: req.session, isAdmin: false, automationStep: true });
});

test('a failing tool lookup leaves every app unavailable but the catalog answers', async () => {
    reset();
    S.toolsThrow = true;
    const { body } = await fetchCatalog();
    assert.ok(body.apps.every(a => a.available === false));
});

test('webpages is available through the beta feature even without its tools', async () => {
    reset();
    S.beta = new Set(['webpages']);
    S.availableTools = [];
    const { body } = await fetchCatalog();
    assert.strictEqual(body.apps.find(a => a.id === 'webpages').available, true);
    assert.strictEqual(body.apps.find(a => a.id === 'gmail').available, false);
    assert.deepStrictEqual(S.events.find(e => e[0] === 'beta'), ['beta', 'user1', 'webpages']);
});

test('datatables: the caller principal feeds the shared catalog builder', async () => {
    reset();
    const { body, req } = await fetchCatalog();
    assert.deepStrictEqual(body.datatables, [{ id: 'dt1' }]);
    assert.deepStrictEqual(S.datatableArgs, { userId: 'user1', opts: { principal: { userId: 'user1', organizationId: 'org1' } } });
    assert.ok(S.principalReqs.every(r => r === req));
});

test('a datatable outage empties only that picker', async () => {
    reset();
    S.datatablesThrow = true;
    const { body } = await fetchCatalog();
    assert.deepStrictEqual(body.datatables, []);
    assert.ok(body.apps.length > 0);
});

test('knowledge bases: the write picker is asked with org ids, permission, groups and org-admin', async () => {
    reset();
    const { body } = await fetchCatalog();
    assert.deepStrictEqual(body.knowledgeBases, [{ id: 'kb1', canWrite: true }]);
    assert.deepStrictEqual(S.kbArgs, { userId: 'user1', orgIds: new Set(['o1']), userGroups: ['g1'], canManage: true, isOrgAdmin: true });
    assert.deepStrictEqual(S.events.filter(e => e[0] === 'perm'), [['perm', 'user1', 'manage_knowledge']]);
    assert.deepStrictEqual(S.events.filter(e => e[0] === 'groups'), [['groups', 'user1']], 'groups are resolved from the user id');
});

test('knowledge bases: org ids are never null, and every failed sub-lookup degrades to a closed answer', async () => {
    reset();
    S.orgIds = ['a', 'b'];
    S.permissionThrows = true;
    S.groupsThrow = true;
    S.orgAdminThrows = true;
    await fetchCatalog();
    assert.deepStrictEqual(S.kbArgs, { userId: 'user1', orgIds: new Set(['a', 'b']), userGroups: [], canManage: false, isOrgAdmin: false });

    reset();
    S.orgIds = null;
    await fetchCatalog();
    assert.deepStrictEqual(S.kbArgs.orgIds, new Set());
});

test('a knowledge-base outage empties only that picker', async () => {
    reset();
    S.kbThrows = true;
    const { body } = await fetchCatalog();
    assert.deepStrictEqual(body.knowledgeBases, []);
    assert.deepStrictEqual(body.datatables, [{ id: 'dt1' }]);
});

test('agents come from the shared picker with the request principal', async () => {
    reset();
    const { body } = await fetchCatalog();
    assert.deepStrictEqual(body.agents, [{ id: 'a1' }]);
    assert.strictEqual(body.agentsError, null);
    assert.deepStrictEqual(S.agentArgs, { userId: 'user1', opts: { principal: { userId: 'user1', organizationId: 'org1' } } });
});

test('a failed agent read is an error beside an empty list, never a silent empty list', async () => {
    reset();
    S.agentsThrow = true;
    const { body } = await fetchCatalog();
    assert.deepStrictEqual(body.agents, []);
    assert.strictEqual(body.agentsError, 'agents down');
});

test('app_event providers are built from the apps, tool names and the home org', async () => {
    reset();
    const { body, req } = await fetchCatalog();
    assert.strictEqual(S.providerArgs.userId, 'user1');
    assert.strictEqual(S.providerArgs.session, req.session);
    assert.strictEqual(S.providerArgs.orgId, 'org1');
    assert.deepStrictEqual([...S.providerArgs.userToolNames], ['gmail_tool']);
    assert.strictEqual(S.providerArgs.userToolDefs.length, 1);
    assert.deepStrictEqual(S.providerArgs.apps.map(a => a.id), ['gmail', 'webpages']);
    assert.strictEqual(S.providerArgs.apps.length, body.apps.length);
    assert.deepStrictEqual(body.triggers.find(t => t.kind === 'app_event'), { kind: 'app_event', providers: [{ id: 'approvals' }] });
    await fetchCatalog({ user: { id: 'user1' } });
    assert.strictEqual(S.providerArgs.orgId, null);
});

test('reusable steps: available only when every integration they touch is available', async () => {
    reset();
    S.callable = [
        { id: 's1', title: 'One', description: 'd', icon: null, category: null, params: [], outputFields: [], requiredIntegrations: ['gmail', 'google-mail'] },
        { id: 's2', title: 'Two', description: 'd2', icon: 'i', category: 'c', params: [1], outputFields: [2], requiredIntegrations: ['gmail', 'outlook'] },
        { id: 's3', title: 'Three', requiredIntegrations: undefined },
    ];
    const { body } = await fetchCatalog();
    assert.deepStrictEqual(S.callableArgs, { userId: 'user1', opts: { orgIds: ['o1'], userGroups: ['g1'] } });
    assert.deepStrictEqual(body.steps.map(s => [s.id, s.available]), [['s1', true], ['s2', false], ['s3', true]]);
    assert.deepStrictEqual(Object.keys(body.steps[1]).sort(), [
        'available', 'category', 'description', 'icon', 'id', 'outputFields', 'params', 'requiredIntegrations', 'title',
    ]);
    assert.strictEqual(body.steps[1].icon, 'i');
    assert.strictEqual(body.steps[0].icon, null);
    assert.ok(body.stepTypes.includes('call_block'));
});

test('steps: a null audience org list asks for none, and a failing load leaves no steps and no call_block', async () => {
    reset();
    S.audience = { orgIds: null, userGroups: null };
    await fetchCatalog();
    assert.deepStrictEqual(S.callableArgs.opts, { orgIds: [], userGroups: [] });

    reset();
    S.callableThrows = true;
    const { body } = await fetchCatalog();
    assert.deepStrictEqual(body.steps, []);
    assert.ok(!body.stepTypes.includes('call_block'));
});

test('stepTypes lists the code step only when the sandbox can run', async () => {
    reset();
    let { body } = await fetchCatalog();
    assert.deepStrictEqual(body.stepTypes, ['trigger', 'integration_action', 'ai_step', 'condition', 'guard', 'tokenize', 'loop', 'code', 'notification', 'parse_json', 'datatable']);
    assert.strictEqual(body.flags.code, true);
    assert.strictEqual(body.flags.automations, true);
    S.sandbox = false;
    ({ body } = await fetchCatalog());
    assert.ok(!body.stepTypes.includes('code'));
    assert.deepStrictEqual([body.flags.code, body.flags.codeReason], [false, 'runtime']);
});

test('form pick sources: internal ones are always available, others when the author has every tool', async () => {
    reset();
    const { body } = await fetchCatalog();
    assert.deepStrictEqual(body.formPickSources.map(s => [s.id, s.available]), [
        ['internal-src', true], ['ext-src', true], ['ext-other', false],
    ]);
});

test('topics and flags follow the classifier probe', async () => {
    reset();
    S.probe = { available: false, reason: 'not_configured', defaultThreshold: 0.5, maxLabels: 9999 };
    const { body } = await fetchCatalog();
    assert.strictEqual(body.flags.topics, false);
    assert.strictEqual(body.flags.topicsReason, 'not_configured');
    assert.strictEqual(body.topics.defaultThreshold, 0.5);
    assert.ok(body.topics.maxLabels <= 9999 && body.topics.maxLabels > 0, 'capped by the server-wide ceiling');
});

test('the static lists keep their values and order', async () => {
    reset();
    const { body } = await fetchCatalog();
    assert.deepStrictEqual(body.knowledgeWriteStrategies.map(s => s.value), ['skip', 'merge', 'replace', 'add']);
    assert.deepStrictEqual(body.datatableOps.map(o => [o.op, o.writes]), [
        ['find_rows', false], ['count_rows', false], ['add_row', true], ['save_row', true], ['update_rows', true], ['delete_rows', true],
    ]);
    assert.deepStrictEqual(body.triggers.map(t => t.kind), ['schedule', 'manual', 'webhook', 'form', 'app_event', 'agent_call']);
    assert.deepStrictEqual(body.triggerOutputs, { 'x.y': { sample: {} } });
});

test('GET /catalog/form-pick-sources serves just the sources, with the same availability rule', async () => {
    reset();
    const pickHandler = findHandler(catalogRouter, 'get', '/catalog/form-pick-sources');
    const run = async () => {
        const req = { session: { user: { id: 'user1' }, isAdmin: false } };
        const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
        await pickHandler(req, res);
        return res;
    };
    let res = await run();
    assert.deepStrictEqual(Object.keys(res.body), ['sources']);
    assert.deepStrictEqual(res.body.sources.map(s => [s.id, s.available]), [['internal-src', true], ['ext-src', true], ['ext-other', false]]);
    assert.deepStrictEqual(S.toolArgs.automationStep, true);

    S.toolsThrow = true;
    res = await run();
    assert.deepStrictEqual(res.body.sources.map(s => [s.id, s.available]), [['internal-src', true], ['ext-src', false], ['ext-other', false]],
        'unknown tools grey out a hint, never remove a choice');
});

test('form-pick-sources: a tools module that will not load reads every source as unavailable', async () => {
    reset();
    const tools = require('../../core/integrations/integrationTools');
    stub('core/integrations/integrationTools', Object.defineProperty({}, 'getIntegrationTools', { get() { throw new Error('module failed to load'); } }));
    try {
        const pickHandler = findHandler(catalogRouter, 'get', '/catalog/form-pick-sources');
        const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
        await pickHandler({ session: { user: { id: 'user1' }, isAdmin: false } }, res);
        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(res.body.sources.map(x => [x.id, x.available]), [['internal-src', true], ['ext-src', false], ['ext-other', false]]);
    } finally {
        stub('core/integrations/integrationTools', tools);
    }
});
