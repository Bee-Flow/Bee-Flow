/**
 * What the agent meta routes accept (routes/agents/meta.js): nothing from the
 * query, and that is now said rather than implied.
 *
 * `GET /meta/models?providerId=p1` looked like it narrowed the list to one
 * provider and was answered with every configured provider's models under a
 * 200. And /meta/models answered anybody: the file is exempt from the gate
 * sweep as metadata for the guest chat UI, but that route calls every
 * configured provider with the installation's key on each request. What this
 * file pins:
 *
 *   - a query parameter is refused with a 400 that names it;
 *   - a refused request never reaches a provider;
 *   - /meta/models wants a session, and without one no provider is called;
 *   - /meta/components stays open, as the exemption says;
 *   - the plain requests the designer and the Android app send still pass.
 *
 * Run: cd server && node --test routes/agents/meta.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every provider lookup lands in `touched`. A refused request must leave it empty.
const touched = [];
const inert = {};

const MOCKS = {
    '../../core/agentRuntime': {
        getAvailableComponents: async () => { touched.push('components'); return [{ id: 'c1' }]; },
    },
    '../../core/aiAgent': {
        getAIConfig: async () => ({ model: 'm1' }),
        getProviders: async () => { touched.push('providers'); return { providers: [], defaultProviderId: 'p1' }; },
    },
    // Required for their side effects only; nothing here reads them.
    '../../stores/agentStore': inert,
    '../../stores/configStore': inert,
    '../../auth': inert,
    '../../stores/memoryStore': inert,
    '../../utils/routeHelpers': inert,
    '../../stores/userStore': inert,
    '../../stores/usageStore': inert,
    '../../core/entitlements/limits': inert,
    '../../core/http/sseHelpers': inert,
    // The gate's own work (the user still exists) is its own file's to test;
    // here it only has to be in the chain, answering as the real one does
    // when there is no session.
    '../../auth/permissions': {
        requireAuth: (req, res, next) => (req.session?.isAuthenticated && req.session.user
            ? next()
            : res.status(401).json({ error: 'Not authenticated' })),
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:agent-meta-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /agents[\\/]meta\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./meta');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

const SIGNED_IN = { isAuthenticated: true, user: { id: 'u1' } };

function dispatch({ method, url, session = SIGNED_IN }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = url.split('?');
        const query = Object.fromEntries(new URLSearchParams(search));
        const req = {
            method, url, originalUrl: url, path: pathname, body: undefined, query, headers: {},
            session, get() { return undefined; },
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

test.beforeEach(() => { touched.length = 0; });

test('a provider filter is refused by name, not answered with every provider', async () => {
    const res = await dispatch({ method: 'GET', url: '/meta/models?providerId=p1' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.match(res.body.error, /providerId/);
    assert.ok(res.body.details.some((d) => d.path === 'query'));
    assert.deepStrictEqual(touched, [], 'no provider is asked on a refused request');
});

test('the component catalogue takes no query either', async () => {
    const res = await dispatch({ method: 'GET', url: '/meta/components?type=tool' });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

test('the plain requests the designer and the Android app send still pass', async () => {
    const models = await dispatch({ method: 'GET', url: '/meta/models' });
    assert.strictEqual(models.statusCode, 200);
    assert.deepStrictEqual(models.body, { models: [], currentModel: 'm1', defaultProviderId: 'p1' });
    const components = await dispatch({ method: 'GET', url: '/meta/components' });
    assert.strictEqual(components.statusCode, 200);
    assert.deepStrictEqual(components.body, [{ id: 'c1' }]);
});

test('the model list wants a session, and without one no provider is called', async () => {
    const res = await dispatch({ method: 'GET', url: '/meta/models', session: {} });
    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(touched, [], 'an anonymous request never reaches a provider');
});

test('the component catalogue stays open, as its exemption says', async () => {
    const res = await dispatch({ method: 'GET', url: '/meta/components', session: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, [{ id: 'c1' }]);
});
