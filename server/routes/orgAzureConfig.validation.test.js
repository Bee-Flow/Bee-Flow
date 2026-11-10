/**
 * What the organisation Azure panel may write, who may write it, and what the
 * route says when it refuses (routes/orgAzureConfig.js).
 *
 * Every section of PUT /:orgId writes PLATFORM-wide keys, and the body was read
 * key by key: an unknown `section` answered `{ ok: true }` having written
 * nothing; `useAzureDocProcessing: "false"` switched document processing ON and
 * `autoApproveSSO: "false"` auto-approved every Microsoft sign-in; a chat-models
 * save dropped the `standard` and `swarm` tiers it does not show; and
 * `destructiveSync: "false"` switched destructive group sync on.
 *
 *   - the 400 names the field, in a sentence — the section one included;
 *   - a refused request writes nothing;
 *   - only a platform admin reaches the platform keys, in cloud and
 *     self-hosted alike; the group-sync routes stay with the organisation's
 *     admin.
 *
 * Run: cd server && node --test routes/orgAzureConfig.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every write lands in `touched`. A refused request must leave it empty.
const touched = [];
const fx = { superAdmin: true, stored: {} };
const pass = (req, res, next) => next();

const MOCKS = {
    '../stores/configStore': {
        getConfig: async (key) => (key in fx.stored ? fx.stored[key] : null),
        getSecret: async () => null,
        setConfig: async (key, value) => { touched.push({ what: 'setConfig', args: [key, value] }); },
        setSecret: async (key, value) => { touched.push({ what: 'setSecret', args: [key, value] }); },
    },
    '../stores/userStore': {
        getOrganization: async () => ({ autoApproveSSO: false }),
        updateOrganization: async (orgId, patch) => { touched.push({ what: 'updateOrganization', args: [orgId, patch] }); },
    },
    '../auth': { resolveUserOrgIds: async () => new Set(['org1']) },
    '../auth/permissions': {
        requireAuth: pass,
        isOrgAdminForOrg: async () => true,
        isSuperAdmin: () => fx.superAdmin,
        saveConfig: async patch => {
            if ('providers' in fx.stored) { /* read failures must propagate */ }
            touched.push({ what: 'saveConfig', args: [patch] }); return true;
        },
        loadConfig: async () => ({
            admin: { username: 'admin', passwordHash: 'hash' },
            oauth: {},
            providers: { google: { clientId: 'g' }, microsoft: { clientId: 'old', tenantId: 'common' } },
        }),
    },
    '../integrations/azureGroupSync': {
        syncAzureGroupsToOrg: async (orgId) => { touched.push({ what: 'sync', args: [orgId] }); return { ok: true }; },
        assertSyncBinding: async () => ({ syncOrganizationId: 'org1', syncTenantId: '11111111-1111-1111-1111-111111111111' }),
        getSyncSettings: async () => ({}),
        setSyncSettings: async (orgId, updates) => { touched.push({ what: 'setSyncSettings', args: [orgId, updates] }); return updates; },
        getSyncStatus: async () => ({}),
        getSyncBinding: async () => ({ syncOrganizationId: 'org1', syncTenantId: '11111111-1111-1111-1111-111111111111' }),
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:org-azure-config-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]orgAzureConfig\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./orgAzureConfig');
test.after(() => { Module._resolveFilename = originalResolve; });

const { dispatcher } = require('../testUtils/routeHarness');

const dispatch = dispatcher(router);

const put = (body) => dispatch({ method: 'PUT', url: '/org1', body });
const SECTION_TEXT = 'section is one of openai, chatModels, piiDetection, docProcessing or sso.';

// The body checks below run as a platform admin: the platform gate comes first.
test.beforeEach(() => {
    touched.length = 0;
    fx.superAdmin = true;
    fx.stored = {};
});

/**
 * Runs `fn` once per deployment mode; the gate must not depend on it.
 * @param {(mode: string) => Promise<void>} fn
 */
async function inEachMode(fn) {
    const before = process.env.DEPLOYMENT_MODE;
    try {
        for (const mode of ['cloud', 'self-hosted']) {
            process.env.DEPLOYMENT_MODE = mode;
            touched.length = 0;
            await fn(mode);
        }
    } finally {
        if (before === undefined) delete process.env.DEPLOYMENT_MODE;
        else process.env.DEPLOYMENT_MODE = before;
    }
}

// ── the section ─────────────────────────────────────────────────────

test('an unknown section is refused in one sentence, instead of "Saved" over nothing', async () => {
    const res = await put({ section: 'SSO', ssoTenantId: 'common' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, SECTION_TEXT);
    assert.deepStrictEqual(touched, []);
});

test('a save with no section gets the same sentence', async () => {
    const res = await put({ azureEndpoint: 'https://x.openai.azure.com/' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, SECTION_TEXT);
    assert.deepStrictEqual(touched, []);
});

test('a key sent under the wrong section is refused by name', async () => {
    const res = await put({ section: 'openai', ssoClientId: 'abc' });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/ssoClientId/.test(res.body.error), `the 400 names the key: ${res.body.error}`);
    assert.deepStrictEqual(touched, []);
});

// ── booleans that were truthiness ───────────────────────────────────

test('"false" does not switch Azure document processing ON', async () => {
    const res = await put({ section: 'docProcessing', useAzureDocProcessing: 'false' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'useAzureDocProcessing is true or false.');
    assert.deepStrictEqual(touched, []);
});

test('"false" does not auto-approve every Microsoft sign-in', async () => {
    const res = await put({ section: 'sso', autoApproveSSO: 'false' });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.autoApproveSSO'));
    assert.deepStrictEqual(touched, []);
});

test('"false" does not switch PII detection on — it is refused like the others', async () => {
    const res = await put({ section: 'piiDetection', piiDetectionEnabled: 'false' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'piiDetectionEnabled is true or false.');
    assert.deepStrictEqual(touched, []);
});

// ── the PII action ──────────────────────────────────────────────────

test('piiDetectionAction "allow" is refused — it makes the scan skip every message', async () => {
    const res = await put({ section: 'piiDetection', piiDetectionEnabled: true, piiDetectionAction: 'allow' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'piiDetectionAction is one of block, tokenize, warn.');
    assert.ok(res.body.details.some((d) => d.path === 'body.piiDetectionAction'));
    assert.deepStrictEqual(touched, [], 'the global ai config is not written');
});

test('the actions an org shield offers still save', async () => {
    fx.stored = { ai: { piiDetectionEnabled: false } };
    const res = await put({ section: 'piiDetection', piiDetectionEnabled: true, piiDetectionAction: 'tokenize' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched, [{ what: 'setConfig', args: ['ai', { piiDetectionEnabled: true, piiDetectionAction: 'tokenize' }] }]);
});

test('a real boolean still reaches the store as that boolean', async () => {
    const res = await put({ section: 'docProcessing', useAzureDocProcessing: false });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched, [{ what: 'setConfig', args: ['use_azure_doc_processing', ''] }]);
});

// ── chat model tiers ────────────────────────────────────────────────

test('a chat-models save keeps the standard and swarm tiers it does not show', async () => {
    fx.stored.chat_model_tiers = {
        fast: { modelId: 'f' }, standard: { modelId: 'gpt-4o', label: 'Flow (Direct)' },
        swarm: { modelId: 's' }, thinking: { modelId: 't' }, writer: { modelId: 'w' }, pro: { modelId: 'p' },
    };
    const res = await put({
        section: 'chatModels',
        chatModelTiers: { fast: { modelId: 'f2', maxTokens: 4000 }, thinking: { modelId: 't' }, writer: { modelId: 'w' }, pro: { modelId: 'p' } },
    });
    assert.strictEqual(res.statusCode, 200);
    const [key, tiers] = touched.find((t) => t.what === 'setConfig').args;
    assert.strictEqual(key, 'chat_model_tiers');
    assert.deepStrictEqual(tiers.standard, { modelId: 'gpt-4o', label: 'Flow (Direct)' }, 'standard survives');
    assert.deepStrictEqual(tiers.swarm, { modelId: 's' }, 'swarm survives');
    assert.deepStrictEqual(tiers.fast, { modelId: 'f2', maxTokens: 4000 }, 'a tier stays an open object');
});

test('a misspelled tier name is refused, instead of resetting the four to empty', async () => {
    const res = await put({ section: 'chatModels', chatModelTiers: { fsat: { modelId: 'x' } } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/fsat/.test(res.body.error), res.body.error);
    assert.deepStrictEqual(touched, []);
});

// ── SSO ─────────────────────────────────────────────────────────────

test('an invalid tenant id is refused in a sentence and nothing is written', async () => {
    const res = await put({ section: 'sso', ssoClientId: 'abc', ssoTenantId: 'contoso' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'ssoTenantId is your directory (tenant) GUID, or one of common, organizations, consumers.');
    assert.deepStrictEqual(touched, []);
});

test('an SSO save writes the providers key alone — never admin or oauth', async () => {
    fx.stored.providers = { google: { clientId: 'g' }, microsoft: { clientId: 'old', tenantId: 'common' } };
    const res = await put({
        section: 'sso', ssoClientId: ' new-id ', ssoClientSecret: '', ssoTenantId: 'Organizations', autoApproveSSO: true,
    });
    assert.strictEqual(res.statusCode, 200);
    const writes = touched.filter(t => t.what === 'saveConfig');
    assert.strictEqual(writes.length, 1);
    const patch = writes[0].args[0];
    assert.deepStrictEqual(Object.keys(patch), ['providers']);
    assert.strictEqual(patch.providers.microsoft.clientId, 'new-id');
    assert.strictEqual(patch.providers.microsoft.tenantId, 'Organizations');
    assert.ok(!patch.providers.microsoft.clientSecret, 'blank secret delegates preservation to the atomic storage layer');
    assert.strictEqual(patch.providers.google, undefined, 'the other provider is not rewritten');
    assert.deepStrictEqual(touched.find((t) => t.what === 'updateOrganization').args, ['org1', { autoApproveSSO: true }]);
});

test('a failed read of the providers is a 500 that writes nothing — not defaults over Google SSO', async () => {
    fx.stored = new Proxy({}, { has: (_, key) => { if (key === 'providers') throw new Error('store unreachable'); return false; } });
    const res = await put({ section: 'sso', ssoClientId: 'new-id' });
    assert.strictEqual(res.statusCode, 500);
    assert.deepStrictEqual(touched, []);
});

test('an endpoint without a scheme is refused, not saved for the SDK to fail on later', async () => {
    const res = await put({ section: 'openai', azureEndpoint: 'myres.openai.azure.com' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'azureEndpoint is an https:// address, or empty to clear it.');
    assert.deepStrictEqual(touched, []);
});

test('the body the OpenAI card sends still saves, an old client\'s api-version ignored', async () => {
    const res = await put({
        section: 'openai', azureEndpoint: 'https://res.openai.azure.com/', azureApiVersion: '2025-04-01-preview', azureModels: 'gpt-4o',
    });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.map((t) => t.args[0]), ['azure_endpoint', 'azure_models']);
});

// ── group sync ──────────────────────────────────────────────────────

test('"false" does not switch destructive group sync ON', async () => {
    const res = await dispatch({ method: 'PUT', url: '/org1/sync-groups/settings', body: { destructiveSync: 'false' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'destructiveSync is true or false.');
    assert.deepStrictEqual(touched, []);
});

test('an interval out of range is refused, instead of silently not saved', async () => {
    const res = await dispatch({ method: 'PUT', url: '/org1/sync-groups/settings', body: { syncIntervalHours: 200 } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'syncIntervalHours is a whole number of hours from 1 to 168.');
    assert.deepStrictEqual(touched, []);
});

test('one sync setting is saved as exactly that one setting', async () => {
    const res = await dispatch({ method: 'PUT', url: '/org1/sync-groups/settings', body: { periodicSync: true } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched, [{ what: 'setSyncSettings', args: ['org1', { periodicSync: true }] }]);
});

test('a sync run with an option it would ignore is refused, not run for real', async () => {
    const res = await dispatch({ method: 'POST', url: '/org1/sync-groups', body: { dryRun: true } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/dryRun/.test(res.body.error), res.body.error);
    assert.deepStrictEqual(touched, []);
});

test('a sync run with no body still runs', async () => {
    const res = await dispatch({ method: 'POST', url: '/org1/sync-groups', body: undefined });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched, [{ what: 'sync', args: ['org1'] }]);
});

// ── who may touch the platform keys ─────────────────────────────────

test('an org admin can neither read nor write the platform configuration, in cloud and self-hosted alike', async () => {
    fx.superAdmin = false;
    await inEachMode(async (mode) => {
        const read = await dispatch({ method: 'GET', url: '/org1', body: undefined });
        assert.strictEqual(read.statusCode, 403, mode);
        assert.strictEqual(read.body.code, 'platform_managed');
        const write = await put({ section: 'openai', azureEndpoint: 'https://other.example/' });
        assert.strictEqual(write.statusCode, 403, mode);
        const sso = await put({ section: 'sso', ssoClientId: 'x', autoApproveSSO: true });
        assert.strictEqual(sso.statusCode, 403, mode);
        assert.deepStrictEqual(touched, [], `${mode}: the platform configuration was not rewritten`);
    });
});

test('a platform admin passes, in cloud and self-hosted alike', async () => {
    await inEachMode(async (mode) => {
        const res = await put({ section: 'openai', azureModels: 'gpt-4o' });
        assert.strictEqual(res.statusCode, 200, mode);
        assert.deepStrictEqual(touched, [{ what: 'setConfig', args: ['azure_models', 'gpt-4o'] }]);
        const read = await dispatch({ method: 'GET', url: '/org1', body: undefined });
        assert.strictEqual(read.statusCode, 200, mode);
    });
});

test('the group-sync routes stay with the organisation admin, in cloud and self-hosted alike', async () => {
    fx.superAdmin = false;
    await inEachMode(async (mode) => {
        const settings = await dispatch({ method: 'PUT', url: '/org1/sync-groups/settings', body: { periodicSync: true } });
        assert.strictEqual(settings.statusCode, 200, mode);
        const status = await dispatch({ method: 'GET', url: '/org1/sync-groups/status', body: undefined });
        assert.strictEqual(status.statusCode, 200, mode);
        const run = await dispatch({ method: 'POST', url: '/org1/sync-groups', body: undefined });
        assert.strictEqual(run.statusCode, 200, mode);
    });
});

test('the platform gate is tagged on the platform axis', () => {
    const { readGate } = require('../auth/gateMeta');
    const putRoute = router.stack.find((l) => l.route && l.route.path === '/:orgId' && l.route.methods.put);
    const tags = putRoute.route.stack.map((x) => readGate(x.handle)).filter(Boolean);
    assert.ok(tags.some((t) => t.axis === 'platform' && t.kind === 'superAdmin'), JSON.stringify(tags));
});
