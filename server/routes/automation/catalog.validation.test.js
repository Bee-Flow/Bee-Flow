'use strict';

/**
 * What GET /catalog/agent/:agentId accepts, and what it says when it refuses
 * (routes/automation/catalog.js).
 *
 * The permission capsule in the step editor answers "what would this agent
 * actually bring to THIS step". Its three switches arrived as query flags and
 * were read as `v === '1' || v === 'true'`, so every other spelling —
 * `useTools=yes`, `=on`, `=True` — read as OFF: the capsule drew an agent
 * with fewer rights than the author had just granted it, under a 200, and a
 * misspelled switch NAME left no trace at all.
 *
 * `tools` keeps its two distinct empty states, which the editor relies on and
 * a `.min(1)` would have destroyed: absent = the author set no allowlist,
 * `tools=` = the author set an empty one, and execAi reads that as no tools.
 *
 * Run: cd server && node --test routes/automation/catalog.validation.test.js
 */

process.env.NODE_ENV = 'test';

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

// Every gate call lands in `touched`. A refused request must leave it empty.
const touched = [];

// The rest of the catalogue is kept silent so only this branch speaks.
mock(path.join(SERVER, 'stores/automationStore'), { getCallableStepsForUser: async () => [] });
mock(path.join(SERVER, 'stores/configStore'), { getConfig: async () => null });
mock(path.join(SERVER, 'automation/toolRegistry'), { TOOL_REGISTRY: [], loadTools: () => [] });
mock(path.join(SERVER, 'automation/sideEffectMap'), { isSideEffect: () => false, effectOf: () => 'reads' });
mock(path.join(SERVER, 'automation/outputSchemas'), {
    getOutputSchema: () => null, synthesizeDryRunOutput: () => ({}),
    producesList: () => false, iterableFieldsOf: () => [],
});
mock(path.join(SERVER, 'automation/deliverableEvents'), { deliverabilityForCatalog: async () => ({}) });
mock(path.join(SERVER, 'core/integrations/integrationToolMap'), { resolveIntegration: () => null });
mock(path.join(SERVER, 'auth/audience'), { resolveUserGroups: async () => ['g1'] });
mock(path.join(SERVER, 'auth/datatableAccess'), {
    resolveDatatablePrincipal: async () => ({ orgId: 'org1', organizationId: 'org1', identityError: null }),
});
mock(path.join(SERVER, 'core/automationRunner/aiStepAgent'), {
    resolveStepAgent: async (step) => { touched.push({ what: 'resolveStepAgent', args: [step] }); return { agent: { id: step.agentId }, permissions: step.agentPermissions }; },
    agentToolsForStep: async (args) => { touched.push({ what: 'agentToolsForStep', args: [args] }); return { tools: [], withheld: [], reasons: {} }; },
});

const router = require('./catalog');
const { terminalErrorHandler } = require(path.join(SERVER, 'core/http/terminalErrorHandler'));

function dispatch({ method, url }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, query, body: {}, headers: {},
            session: { user: { id: 'u1', organizationId: 'org1' }, isAdmin: false },
            get() { return undefined; }, setTimeout() {},
        };
        const res = {
            statusCode: 200, headersSent: false,
            set() { return this; }, setHeader() {},
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched.length = 0; });

async function refuses(url, field) {
    const res = await dispatch({ method: 'GET', url });
    assert.strictEqual(res.statusCode, 400, `${url} -> ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the gate');
    return res;
}

test('a permission flag that is not a flag is refused, not read as "off"', async () => {
    const res = await refuses('/catalog/agent/a1?startAutomations=yes&useKnowledge=0&useTools=0', 'query.startAutomations');
    assert.strictEqual(res.body.error, 'startAutomations is "1" or "0".');
});

test('a misspelled switch name is refused rather than leaving no trace', async () => {
    await refuses('/catalog/agent/a1?useTool=1', 'query');
});

test('the flags the editor sends still reach the gate', async () => {
    const res = await dispatch({ method: 'GET', url: '/catalog/agent/a1?startAutomations=1&useKnowledge=0&useTools=1' });
    assert.strictEqual(res.statusCode, 200);
    const step = touched.find((t) => t.what === 'resolveStepAgent').args[0];
    assert.deepStrictEqual(step.agentPermissions, { startAutomations: true, useKnowledge: false, useTools: true });
});

test('an EMPTY tools list stays a list, not "the author set none"', async () => {
    // `tools=` means the author set an empty allowlist, which execAi reads as
    // NO tools; `tools` absent means they set none at all. A `.min(1)` on the
    // string would have collapsed the two.
    const res = await dispatch({ method: 'GET', url: '/catalog/agent/a1?useTools=1&tools=' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'agentToolsForStep').args[0].allowList, []);
});

test('no tools key at all is still "the author set no allowlist"', async () => {
    const res = await dispatch({ method: 'GET', url: '/catalog/agent/a1?useTools=1' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'agentToolsForStep').args[0].allowList, null);
});
