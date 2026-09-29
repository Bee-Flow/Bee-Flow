/**
 * routes/ai/providers.js authorization (U4b — dossier 4b, permission depth).
 *
 * Providers are instance-wide config and each entry carries a real API key.
 * Before this gate the four mutations only required requireAuth, so ANY
 * signed-in user could add/edit/delete providers or flip the default — and
 * because updateProvider keeps the stored key when none is supplied, simply
 * repointing a provider's URL made the instance send its real key to an
 * attacker-chosen host. The fix is the exact sibling idiom: requireAuth in
 * the chain, then requireAdmin built on isAdminUser from config/shared — the
 * same gate POST /ai/config and the /ai/local-runtimes mutations use.
 *
 * isAdminUser's own semantics live in config/shared.js; here it is a spy,
 * and what is proven is that every mutation consults it and honors the
 * verdict, that anonymous stays 401, and that the GET reads keep working for
 * ordinary signed-in users (model pickers need them) with keys masked.
 *
 * Run: cd server && node --test --test-force-exit routes/ai/providers.authz.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── Mutable fixtures ─────────────────────────────────────────────────
const fx = {
    isAdmin: false,
    isAdminCalls: 0,
    addCalls: [],
    updateCalls: [],
    deleteCalls: [],
    defaultCalls: [],
};

const PROVIDERS = [{
    id: 'p1', name: 'EU endpoint', type: 'openai-compatible',
    url: 'https://llm.example.eu/v1', model: 'm', apiKey: 'sk-supergeheim-1234',
    serviceAccountKey: '{"private_key":"geheim"}',
}];

const MOCKS = {
    '../../core/aiAgent': {
        getProviders: async () => ({ providers: PROVIDERS.map(p => ({ ...p })), defaultProviderId: 'p1' }),
        addProvider: async (p) => { fx.addCalls.push(p); return { id: 'p-new', ...p }; },
        updateProvider: async (id, u) => { fx.updateCalls.push([id, u]); return true; },
        deleteProvider: async (id) => { fx.deleteCalls.push(id); return true; },
        setDefaultProvider: async (id) => { fx.defaultCalls.push(id); return true; },
        getModelsForProvider: async () => [{ id: 'model-a' }],
        invalidateModelCache: () => {},
    },
    '../../auth/permissions': {
        // Mirrors the decision line of the real requireAuth (auth/permissions.js).
        requireAuth: (req, res, next) => {
            if (!req.session || !req.session.isAuthenticated || !req.session.user) {
                return res.status(401).json({ error: 'Not authenticated' });
            }
            next();
        },
    },
    './config/shared': {
        isAdminUser: async () => { fx.isAdminCalls++; return fx.isAdmin; },
    },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:providers-authz:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]ai[\\/]providers\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./providers');
test.after(() => { Module._resolveFilename = originalResolve; });

function dispatch({ method, url, session, body = {} }) {
    return new Promise((resolve, reject) => {
        const req = { method, url, body, headers: {}, query: {}, session, get() { return undefined; } };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => reject(err || new Error(`fell through router: ${method} ${url}`)));
    });
}

const MEMBER = { isAuthenticated: true, user: { id: 'u-member' } };
const ADMIN = { isAuthenticated: true, user: { id: 'u-admin' } };

const MUTATIONS = [
    { method: 'POST', url: '/providers', body: { name: 'x', url: 'https://evil.example', type: 'openai-compatible' } },
    { method: 'PUT', url: '/providers/p1', body: { url: 'https://evil.example' } },
    { method: 'DELETE', url: '/providers/p1' },
    { method: 'PUT', url: '/providers/p1/default' },
];

test.beforeEach(() => {
    fx.isAdmin = false;
    fx.isAdminCalls = 0;
    fx.addCalls.length = 0;
    fx.updateCalls.length = 0;
    fx.deleteCalls.length = 0;
    fx.defaultCalls.length = 0;
});

const assertNothingMutated = () => {
    assert.deepStrictEqual(fx.addCalls, []);
    assert.deepStrictEqual(fx.updateCalls, []);
    assert.deepStrictEqual(fx.deleteCalls, []);
    assert.deepStrictEqual(fx.defaultCalls, []);
};

// ═══ Anonymous → 401 before the admin gate even runs ═════════════════

test('anonymous callers get 401 on every mutation — nothing reaches the config', async () => {
    for (const anon of [undefined, {}, { guestId: 'guest_abc' }]) {
        for (const r of MUTATIONS) {
            const res = await dispatch({ ...r, session: anon });
            assert.strictEqual(res.statusCode, 401, `${r.method} ${r.url} with session ${JSON.stringify(anon)}`);
        }
    }
    assert.strictEqual(fx.isAdminCalls, 0, '401 happens before the admin check');
    assertNothingMutated();
});

// ═══ Signed-in non-admin → 403 on mutations ══════════════════════════

test('a signed-in non-admin gets 403 on every mutation, with the sibling error body', async () => {
    for (const r of MUTATIONS) {
        const res = await dispatch({ ...r, session: MEMBER });
        assert.strictEqual(res.statusCode, 403, `${r.method} ${r.url}`);
        assert.deepStrictEqual(res.body, { error: 'Admin access required' }, 'same body as config/shared consumers');
    }
    assert.strictEqual(fx.isAdminCalls, MUTATIONS.length, 'each mutation consults isAdminUser');
    assertNothingMutated();
});

// ═══ Admin passes (not 401/403) and the mutation lands ═══════════════

test('an admin mutates normally: add, update, delete, set-default all reach the store', async () => {
    fx.isAdmin = true;

    const post = await dispatch({ ...MUTATIONS[0], session: ADMIN });
    assert.strictEqual(post.statusCode, 201);
    assert.strictEqual(fx.addCalls.length, 1);

    assert.strictEqual((await dispatch({ ...MUTATIONS[1], session: ADMIN })).statusCode, 200);
    assert.deepStrictEqual(fx.updateCalls[0][0], 'p1');

    assert.strictEqual((await dispatch({ ...MUTATIONS[2], session: ADMIN })).statusCode, 200);
    assert.deepStrictEqual(fx.deleteCalls, ['p1']);

    assert.strictEqual((await dispatch({ ...MUTATIONS[3], session: ADMIN })).statusCode, 200);
    assert.deepStrictEqual(fx.defaultCalls, ['p1']);
});

// ═══ Reads stay member-reachable, and never hand out the real key ════

test('GET /providers still works for a non-admin member — with masked secrets', async () => {
    const res = await dispatch({ method: 'GET', url: '/providers', session: MEMBER });
    assert.strictEqual(res.statusCode, 200, 'model pickers for ordinary users depend on this read');
    const p = res.body.providers[0];
    assert.strictEqual(p.apiKey, '••••1234', 'masked to the last four');
    assert.strictEqual(p.serviceAccountKey, '••••(configured)');
    assert.ok(!JSON.stringify(res.body).includes('sk-supergeheim'), 'the real key never leaves the router');
    assert.ok(!JSON.stringify(res.body).includes('private_key'), 'nor the service-account blob');
});

test('GET /providers/:id/models still works for a non-admin member', async () => {
    const res = await dispatch({ method: 'GET', url: '/providers/p1/models', session: MEMBER });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.models, [{ id: 'model-a' }]);
});

// ═══ Anonymous reads stay 401 (pre-existing requireAuth contract) ════

test('anonymous GET /providers remains 401', async () => {
    const res = await dispatch({ method: 'GET', url: '/providers', session: {} });
    assert.strictEqual(res.statusCode, 401);
});
