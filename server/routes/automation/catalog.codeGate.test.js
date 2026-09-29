'use strict';

/**
 * GET /catalog: the `code` step flag asks the RUNNER's one question.
 *
 * execCode (core/automationRunner/execOutbound.js) refuses a code step only
 * when codeSandbox.isAvailable() is false. There is no switch: no platform
 * config flag and no per-org beta (`ai_code_execution`). The palette used to
 * show the Code step greyed out on every install where nobody had written a
 * flag that nothing in the product could write.
 *
 * The flag stays a BOOLEAN on purpose: the builder palette tests it for
 * truthiness, so an object would be permanently truthy. `flags.codeReason`
 * carries the reason beside it.
 *
 * Same require.cache Module mock + findHandler technique as catalog.test.js
 * (no supertest; the handler is invoked directly).
 *
 * Run: node --test routes/automation/catalog.codeGate.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const SERVER = path.resolve(__dirname, '..', '..');
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

// Per-test mutable state read by the mocks below.
let SANDBOX_AVAILABLE = true;
let PLATFORM_FLAG = null;      // what configStore.getConfig hands back
let CONFIG_THROWS = false;
let ORG_BETA = new Set();      // org-level beta feature ids
let ORG_BETA_THROWS = false;
let ORG_BETA_CALLS = [];       // (orgId, featureId) pairs actually asked

mock(path.join(SERVER, 'stores/automationStore'), {
    getCallableStepsForUser: async () => [],
});
mock(path.join(SERVER, 'stores/configStore'), {
    getConfig: async (key) => {
        if (CONFIG_THROWS) throw new Error('config store down');
        return key === 'automation_code_step_enabled' ? PLATFORM_FLAG : null;
    },
});
mock(path.join(SERVER, 'automation/codeSandbox'), {
    isAvailable: () => SANDBOX_AVAILABLE,
    loadError: () => (SANDBOX_AVAILABLE ? null : 'Cannot find module \'isolated-vm\''),
});
mock(path.join(SERVER, 'automation/toolRegistry'), {
    TOOL_REGISTRY: [{ app: 'gmail', label: 'Gmail' }],
    loadTools: () => [{ function: { name: 'gmail_tool' } }],
});
mock(path.join(SERVER, 'automation/sideEffectMap'), {
    isSideEffect: () => false,
    effectOf: () => 'reads',
});
mock(path.join(SERVER, 'automation/outputSchemas'), {
    getOutputSchema: () => null,
    synthesizeDryRunOutput: () => ({}),
    producesList: () => false,
    iterableFieldsOf: () => [],
});
mock(path.join(SERVER, 'core/integrations/integrationToolMap'), { resolveIntegration: () => null });
mock(path.join(SERVER, 'core/integrations/integrationTools'), {
    getIntegrationTools: async () => ({ tools: [] }),
    getUserPermittedApps: () => { throw new Error('getUserPermittedApps must not be called — fails open'); },
});
mock(path.join(SERVER, 'core/entitlements/betaFeatures'), {
    // The palette's other gates read the USER-level helper; the code step is
    // gated per ORG by the runner, so this route has to ask the org one.
    userHasBetaFeature: async () => false,
    orgHasBetaFeature: async (orgId, featureId) => {
        ORG_BETA_CALLS.push([orgId, featureId]);
        if (ORG_BETA_THROWS) throw new Error('entitlement resolver down');
        return ORG_BETA.has(featureId);
    },
});
mock(path.join(SERVER, 'auth/audience'), {
    resolveAudienceContext: async () => ({ orgIds: [], userGroups: [] }),
    resolveUserGroups: async () => [],
});
mock(path.join(SERVER, 'stores/supportInboxStore'), { listInboxes: async () => [] });
mock(path.join(SERVER, 'automation/triggerBus'), { getPublicBaseUrl: () => null });
mock(path.join(SERVER, 'automation/builderTools'), {
    buildTriggerOutputsCatalog: require(path.join(SERVER, 'automation/builderTools/triggerCatalog')).buildTriggerOutputsCatalog,
});

const catalogRouter = require('./catalog');

function findHandler(router, method, routePath) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
            return layer.route.stack[layer.route.stack.length - 1].handle;
        }
    }
    throw new Error(`route not found: ${method} ${routePath}`);
}
const catalogHandler = findHandler(catalogRouter, 'get', '/catalog');

function makeRes() {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}

function resetState() {
    SANDBOX_AVAILABLE = true;
    PLATFORM_FLAG = null;
    CONFIG_THROWS = false;
    ORG_BETA = new Set();
    ORG_BETA_THROWS = false;
    ORG_BETA_CALLS = [];
}

async function fetchCatalog({ organizationId = 'org1' } = {}) {
    const req = { session: { user: { id: 'user1', organizationId }, isAdmin: false } };
    const res = makeRes();
    await catalogHandler(req, res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    return res.body;
}

test('the code step is offered whatever the config holds: there is no switch', async () => {
    for (const flag of [null, false, 'false', true]) {
        resetState();
        PLATFORM_FLAG = flag;
        const body = await fetchCatalog();
        assert.strictEqual(body.flags.code, true, `config ${JSON.stringify(flag)} changed the answer`);
        assert.strictEqual(body.flags.codeReason, null);
        assert.ok(body.stepTypes.includes('code'), 'stepTypes lists code');
    }
});

test('a config outage cannot hide the code step: the config is never asked', async () => {
    resetState();
    CONFIG_THROWS = true;
    const body = await fetchCatalog();
    assert.strictEqual(body.flags.code, true);
});

test('no organisation beta is asked: every org gets code steps', async () => {
    resetState();
    for (const organizationId of ['org1', null]) {
        const body = await fetchCatalog({ organizationId });
        assert.strictEqual(body.flags.code, true, `org ${organizationId} got no code step`);
    }
    assert.deepStrictEqual(ORG_BETA_CALLS.filter(([, f]) => f === 'ai_code_execution'), [],
        'the retired ai_code_execution beta is never consulted');
});

test('no sandbox on this server: refused with the runtime reason, as a boolean', async () => {
    resetState();
    SANDBOX_AVAILABLE = false;
    const body = await fetchCatalog();
    assert.strictEqual(body.flags.code, false);
    assert.strictEqual(typeof body.flags.code, 'boolean');
    assert.strictEqual(body.flags.codeReason, 'runtime');
    assert.ok(!body.stepTypes.includes('code'), 'stepTypes drops code as well');
});
