/**
 * What the deployment-wide config routes accept, and what they say when they
 * refuse (auth/admin/platformConfigRoutes.js).
 *
 * `PUT /default-integrations` read `defaults` off the body and stored it as
 * it found it. The difference between `null` and ABSENT is load-bearing here —
 * null means "every integration enabled" — but absent became
 * `setConfig(key, undefined)`, so a body that mis-spelled the key ERASED the
 * deployment's default integration set for every organisation that had not
 * overridden it, and answered 200. What this file pins:
 *
 *   - the 400 NAMES the field (`body.defaults`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - `null` still means "all enabled", and still reaches the store as null;
 *   - configStore is never written, so a refused save changes nothing.
 *
 * Run: cd server && node --test --test-force-exit auth/admin/platformConfigRoutes.validation.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store and side-effect call lands in `touched`. A refused request must
// leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../permissions': { requireSuperAdmin: pass },
    '../../stores/configStore': {
        getConfig: async () => null,
        setConfig: async (key, value) => { touched.push({ what: 'setConfig', args: [key, value] }); },
    },
    '../../utils/freeEmailDomains': {
        FREE_EMAIL_DOMAINS: new Set(['gmail.com']),
        EXTRA_CONFIG_KEY: 'free_email_domains_extra',
        getExtraFreeEmailDomains: async () => [],
        normalizeDomain: (d) => (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(d)) ? String(d).toLowerCase() : null),
    },
    './integrationCatalog': { ALL_INTEGRATIONS: [{ id: 'gmail' }, { id: 'drive' }] },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:platform-config-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /admin[\\/]platformConfigRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./platformConfigRoutes');
test.after(() => { Module._resolveFilename = originalResolve; });

const { dispatcher } = require('../../core/http/routeHarness');

const dispatch = dispatcher(router, { session: () => ({ user: { id: 'root' }, isAdmin: true }) });

test.beforeEach(() => { touched.length = 0; });

/** Assert: refused with 400, the named field is in `details`, nothing touched. */
async function refuses(request, field) {
    const res = await dispatch(request);
    const what = `${request.method} ${request.url} ${JSON.stringify(request.body)}`;
    assert.strictEqual(res.statusCode, 400, what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
}

test('a body with no defaults is refused instead of erasing the set', async () => {
    const res = await dispatch({ method: 'PUT', url: '/default-integrations', body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Send a list of integration ids, or null for "all enabled".');
    assert.ok(res.body.details.some((d) => d.path === 'body.defaults'));
    assert.deepStrictEqual(touched, []);
});

test('a misspelled key is refused rather than wiping the deployment default', async () => {
    await refuses({ method: 'PUT', url: '/default-integrations', body: { defualts: ['gmail'] } }, 'body.defaults');
});

test('null still means "every integration enabled"', async () => {
    const res = await dispatch({ method: 'PUT', url: '/default-integrations', body: { defaults: null } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'setConfig').args, ['default_org_integrations', null]);
});

test('a misspelled provisioning mode is still refused, now in the same words', async () => {
    const res = await dispatch({ method: 'PUT', url: '/connector-provisioning-mode', body: { mode: 'pairing-only' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'mode must be one of open, pairing_only, or null');
    assert.deepStrictEqual(touched, []);
});

test('a misspelled domain key is refused rather than saving an empty list', async () => {
    await refuses({ method: 'PUT', url: '/free-email-domains', body: { exta: ['a.test'] } }, 'body.extra');
});
