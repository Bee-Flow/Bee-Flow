/**
 * What the "keep integration answers between runs" save accepts, and what it
 * says when it refuses (routes/orgIntegrationCache.js).
 *
 * On this route a body the handler did not understand was never a no-op. It
 * read as an OFF, and an OFF purges: `enabled: "true"` — a client that MEANT
 * on — deleted every answer the organisation had stored and came back 200 with
 * `purged: N`. So did a misspelled `enabled`. And `scopes.integration: "false"`
 * read as not-false, leaving app look-ups on for an admin switching them off.
 *
 *   - the 400 names the field, in a sentence;
 *   - a refused request neither writes the policy nor purges a single row.
 *
 * Run: cd server && node --test routes/orgIntegrationCache.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every write and purge lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../stores/configStore': {
        getConfig: async () => null,
        setConfig: async (key, value) => { touched.push({ what: 'setConfig', args: [key, value] }); return true; },
    },
    '../auth': { resolveUserOrgIds: async () => new Set(['org1']) },
    '../auth/permissions': { requireAuth: pass, isOrgAdminForOrg: async () => true },
    '../stores/integrationCacheStore': {
        statsForOrg: async () => ({ entries: 0, expiredEntries: 0, bytes: 0 }),
        purgeForOrg: async (orgId) => { touched.push({ what: 'purgeForOrg', args: [orgId] }); return 5; },
        shrinkTtlForOrg: async (orgId, ttl) => { touched.push({ what: 'shrinkTtlForOrg', args: [orgId, ttl] }); return 0; },
    },
    '../core/automationRunner/integrationCachePolicy': {
        // The real normalizePolicy is exercised by orgIntegrationCache.test.js;
        // here it only has to show what reached it.
        normalizePolicy: (p) => ({
            enabled: p.enabled === true,
            ttlSeconds: p.ttlSeconds ?? 300,
            scopes: { integration: p.scopes?.integration !== false, http: p.scopes?.http === true },
        }),
        invalidateCachePolicy: () => {},
        killSwitchOn: () => false,
        CONFIG_KEY_PREFIX: 'org_integration_cache_',
        MIN_TTL_SECONDS: 60,
        MAX_TTL_SECONDS: 3600,
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:org-integration-cache-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]orgIntegrationCache\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./orgIntegrationCache');
test.after(() => { Module._resolveFilename = originalResolve; });

const { dispatcher } = require('../core/http/routeHarness');

const dispatch = dispatcher(router, { session: () => ({ user: { id: 'admin1' } }) });

const ENABLED_TEXT = 'Say whether answers may be kept: enabled is true or false.';

test.beforeEach(() => { touched.length = 0; });

test('"true" as a string is refused, instead of switching OFF and purging', async () => {
    const res = await dispatch({ method: 'PUT', url: '/org1', body: { enabled: 'true', ttlSeconds: 600 } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, ENABLED_TEXT);
    assert.ok(res.body.details.some((d) => d.path === 'body.enabled'));
    assert.deepStrictEqual(touched, [], 'nothing written, nothing purged');
});

test('a save without the switch is refused in words, not purged as an OFF', async () => {
    const res = await dispatch({ method: 'PUT', url: '/org1', body: { ttlSeconds: 600 } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, ENABLED_TEXT, 'the caller reads this sentence, not "Required"');
    assert.deepStrictEqual(touched, []);
});

test('a misspelled switch is refused by name', async () => {
    const res = await dispatch({ method: 'PUT', url: '/org1', body: { enabled: true, enabeld: true } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/enabeld/.test(res.body.error), `the 400 names the key: ${res.body.error}`);
    assert.deepStrictEqual(touched, []);
});

test('scopes.integration "false" is refused, instead of leaving app look-ups on', async () => {
    const res = await dispatch({
        method: 'PUT', url: '/org1',
        body: { enabled: true, scopes: { integration: 'false', http: false } },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'scopes.integration is true or false.');
    assert.ok(res.body.details.some((d) => d.path === 'body.scopes.integration'));
    assert.deepStrictEqual(touched, []);
});

test('a misspelled scope is refused by name', async () => {
    const res = await dispatch({ method: 'PUT', url: '/org1', body: { enabled: true, scopes: { integraton: false } } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/integraton/.test(res.body.error), res.body.error);
    assert.deepStrictEqual(touched, []);
});

test('a ttl that is not a number is refused by name', async () => {
    const res = await dispatch({ method: 'PUT', url: '/org1', body: { enabled: true, ttlSeconds: '10m' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'ttlSeconds is a number of seconds.');
    assert.deepStrictEqual(touched, []);
});

test('the body the settings screen sends is saved as sent', async () => {
    const res = await dispatch({
        method: 'PUT', url: '/org1',
        body: { enabled: true, ttlSeconds: 600, scopes: { integration: false, http: true } },
    });
    assert.strictEqual(res.statusCode, 200);
    const saved = touched.find((t) => t.what === 'setConfig').args[1];
    assert.strictEqual(saved.enabled, true);
    assert.strictEqual(saved.ttlSeconds, 600);
    assert.deepStrictEqual(saved.scopes, { integration: false, http: true });
    assert.ok(!touched.some((t) => t.what === 'purgeForOrg'), 'an ON does not purge');
});

test('a real OFF still purges, as it always did', async () => {
    const res = await dispatch({ method: 'PUT', url: '/org1', body: { enabled: false } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.purged, 5);
});

test('the purge takes no options — one it would ignore is refused, not read as "everything"', async () => {
    const refused = await dispatch({ method: 'DELETE', url: '/org1/entries', body: { integration: 'gmail' } });
    assert.strictEqual(refused.statusCode, 400);
    assert.ok(/integration/.test(refused.body.error), refused.body.error);
    assert.deepStrictEqual(touched, [], 'nothing was purged');
    const res = await dispatch({ method: 'DELETE', url: '/org1/entries', body: undefined });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched, [{ what: 'purgeForOrg', args: ['org1'] }]);
});
