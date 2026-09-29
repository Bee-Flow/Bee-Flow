/**
 * What the AI Integration Builder API accepts, and what it says when it
 * refuses (routes/orgIntegrations/builder.js).
 *
 * The one that mattered: POST /:id/activate read `!!allowWrites`, so
 * `{ "allowWrites": "false" }` froze the integration WITH writes allowed, and
 * the runner's method gate then let POST/PUT/DELETE through on the org's
 * credentials. Next to it, POST /:id/validate answered a malformed
 * `definition` with the verdict on the STORED draft, and POST / cut a long
 * name to size in silence. What this file pins is the part a caller can act
 * on:
 *
 *   - the 400 NAMES the field (`body.allowWrites`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the store is never reached, so a refused request changes nothing.
 *
 * Run: cd server && node --test routes/orgIntegrations/builder.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store or runner call lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const ROW = {
    id: 'ci-1', orgId: 'org-1', slug: 'crm', kind: 'rest', name: 'CRM', status: 'draft',
    definition: { api: { baseUrl: 'https://crm.example' } }, definitionVersion: 3,
};

const MOCKS = {
    '../../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
    '../../utils/perUserRateLimit': { perUserRateLimit: () => pass },
    '../../core/customIntegrations/validateCustomIntegration': {
        validateCustomIntegration: (def, opts) => ({ ok: true, errors: [], checked: def, strict: opts.strict }),
        deriveOpenAiTools: () => [],
    },
    '../../core/customIntegrations/featureFlag': { isCustomIntegrationsEnabled: async () => true },
    '../../integrations/customIntegrationRunner': {
        executeCustomIntegrationTool: async (name, args) => { touched.push({ what: 'execute', args: [name, args] }); return { status: 200 }; },
    },
    '../../auth/permissions': { requireAuth: pass },
    '../../auth/adminRoutes': { requireOrgAdmin: () => pass },
    '../../stores/orgCustomIntegrationStore': {
        getById: async (id) => (id === ROW.id ? { ...ROW } : null),
        resolveOrgId: (id) => id,
        createIntegration: async (p) => { touched.push({ what: 'createIntegration', args: [p] }); return { id: 'ci-2', ...p }; },
        saveDefinition: async (id, def) => { touched.push({ what: 'saveDefinition', args: [id, def] }); return { ...ROW, definition: def }; },
        activate: async (id, p) => { touched.push({ what: 'activate', args: [id, p] }); return { ...ROW, status: 'active' }; },
        deactivate: async (id) => { touched.push({ what: 'deactivate', args: [id] }); return true; },
    },
    '../../stores/integrationConnectionStore': {
        listConnectionsForUser: async () => [],
        listGrants: async () => [],
        createConnection: async (p) => { touched.push({ what: 'createConnection', args: [p] }); return { id: 'c1' }; },
    },
    '../../stores/userStore': {
        logAccessAudit: async () => {},
        getOrgEnabledIntegrations: async () => [],
        setOrgEnabledIntegrations: async () => {},
    },
    '../../core/entitlements/entitlements': { invalidateForOrg: async () => {} },
    '../../core/entitlements/capabilityRegistry': {},
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:org-integrations-builder-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /orgIntegrations[\\/]builder\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./builder');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, body }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {},
            // Mounted with mergeParams under /api/organizations/:orgId/…
            params: { orgId: 'org-1' },
            session: { user: { id: 'u1' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
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

const refusedAt = (res, path) => res.statusCode === 400 && res.body.details.some((d) => d.path === path);
const calls = (what) => touched.filter((t) => t.what === what);

test.beforeEach(() => { touched.length = 0; });

// ── activate ────────────────────────────────────────────────────────

test('allowWrites "false" is refused instead of freezing the integration with writes allowed', async () => {
    const res = await dispatch({ method: 'POST', url: '/ci-1/activate', body: { allowWrites: 'false' } });
    assert.ok(refusedAt(res, 'body.allowWrites'), JSON.stringify(res.body));
    assert.strictEqual(res.body.error, 'allowWrites is true or false.');
    assert.deepStrictEqual(calls('activate'), []);
});

test('an explicit false activates read-only, and no body at all means the same', async () => {
    let res = await dispatch({ method: 'POST', url: '/ci-1/activate', body: { allowWrites: false } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(calls('activate')[0].args[1].allowWrites, false);

    touched.length = 0;
    res = await dispatch({ method: 'POST', url: '/ci-1/activate', body: undefined });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(calls('activate')[0].args[1].allowWrites, false);
    assert.strictEqual(calls('activate')[0].args[1].lendMode, 'byo');
});

test('a misspelled lendMode is refused rather than quietly lending nothing', async () => {
    const res = await dispatch({ method: 'POST', url: '/ci-1/activate', body: { lendMode: 'Org' } });
    assert.ok(refusedAt(res, 'body.lendMode'));
    assert.strictEqual(res.body.error, "lendMode is 'org' or 'byo'.", 'no zod enum internals');
    assert.deepStrictEqual(calls('activate'), []);
});

// ── validate ────────────────────────────────────────────────────────

test('a definition that is not an object is refused, not swapped for the stored draft', async () => {
    const res = await dispatch({ method: 'POST', url: '/ci-1/validate', body: { definition: '{"api":{}}' } });
    assert.ok(refusedAt(res, 'body.definition'));
    assert.strictEqual(res.body.error, 'definition must be a JSON object.');
});

test('a misspelled definition key is refused, not answered about the stored draft', async () => {
    const res = await dispatch({ method: 'POST', url: '/ci-1/validate', body: { defintion: { api: {} } } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /defintion/);
});

test('strict "false" is refused instead of running a strict validation', async () => {
    const res = await dispatch({ method: 'POST', url: '/ci-1/validate', body: { strict: 'false' } });
    assert.ok(refusedAt(res, 'body.strict'));
});

test('no body still validates the stored draft', async () => {
    const res = await dispatch({ method: 'POST', url: '/ci-1/validate', body: undefined });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.validation.checked, ROW.definition);
    assert.strictEqual(res.body.validation.strict, false);
});

// ── create ──────────────────────────────────────────────────────────

test('an integration with no name is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: {} });
    assert.ok(refusedAt(res, 'body.name'));
    assert.strictEqual(res.body.error, 'An integration needs a name.');
    assert.deepStrictEqual(touched, []);
});

test('a misspelled kind key is refused rather than creating a rest integration', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { name: 'CRM', knid: 'mcp_remote' } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

test('an unknown kind is refused in words', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { name: 'CRM', kind: 'mcp' } });
    assert.ok(refusedAt(res, 'body.kind'));
    assert.strictEqual(res.body.error, "kind is 'rest' or 'mcp_remote'.");
});

test('a name over the limit is refused rather than cut short in silence', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { name: 'x'.repeat(201) } });
    assert.ok(refusedAt(res, 'body.name'));
    assert.deepStrictEqual(touched, []);
});

test('a created integration is trimmed once, and an empty description is none', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { name: '  CRM  ', kind: 'mcp_remote', description: '' } });
    assert.strictEqual(res.statusCode, 201);
    const args = calls('createIntegration')[0].args[0];
    assert.strictEqual(args.name, 'CRM');
    assert.strictEqual(args.kind, 'mcp_remote');
    assert.strictEqual(args.description, null);
});

// ── definition, credentials, test-call, deactivate ──────────────────

test('a definition array is refused and nothing is saved', async () => {
    const res = await dispatch({ method: 'PUT', url: '/ci-1/definition', body: { definition: [] } });
    assert.ok(refusedAt(res, 'body.definition'));
    assert.deepStrictEqual(calls('saveDefinition'), []);
});

test('credentials without a values map are refused in words', async () => {
    const res = await dispatch({ method: 'PUT', url: '/ci-1/credentials', body: {} });
    assert.ok(refusedAt(res, 'body.values'));
    assert.strictEqual(res.body.error, 'values must be an object map of credential fields.');
    assert.deepStrictEqual(calls('createConnection'), []);
});

test('test-call args that are not an object are refused before anything is sent', async () => {
    const res = await dispatch({ method: 'POST', url: '/ci-1/test-call', body: { toolName: 'list_deals', args: ['a'] } });
    assert.ok(refusedAt(res, 'body.args'));
    assert.deepStrictEqual(calls('execute'), []);
});

test('test-call without args sends an empty argument object', async () => {
    const res = await dispatch({ method: 'POST', url: '/ci-1/test-call', body: { toolName: 'list_deals' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(calls('execute')[0].args, ['cint_crm_list_deals', {}]);
});

test('deactivate takes no body, so a key that reads like an option is refused', async () => {
    const res = await dispatch({ method: 'POST', url: '/ci-1/deactivate', body: { purgeCredentials: true } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(calls('deactivate'), []);
});
