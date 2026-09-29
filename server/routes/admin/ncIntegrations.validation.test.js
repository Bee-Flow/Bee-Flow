'use strict';

/**
 * What the org-admin Nextcloud integration toggles accept, and what they say
 * when they refuse (routes/admin/ncIntegrations.js).
 *
 * Both writes ran the body through `filterToNcIds`, which keeps the ids it
 * knows and drops the rest — silently, under a 200, and the panel only looks
 * at `res.ok`. Two shapes came out wrong:
 *
 *   - `enabled: 'nextcloud-talk'` (one id, not a list) filtered to `[]`, and
 *     an empty list is not "nothing to change" here: the scope doc records a
 *     mode per integration, so it was written as EVERY Nextcloud integration
 *     off for the whole organisation;
 *   - `enabled: ['nextcloud-tlk']` dropped the misspelling, so Talk was
 *     switched off by a request that asked for it to be on.
 *
 * What this file pins is the part a caller can act on:
 *
 *   - the 400 NAMES the field (`body.enabled`) and the id it did not know;
 *   - the message is a sentence, including for a field simply left out;
 *   - the store and the scope doc are never reached, so a refused request
 *     changes nothing.
 *
 * Run: cd server && node --test routes/admin/ncIntegrations.validation.test.js
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

// Every write lands in `touched`. A refused request must leave it empty.
const touched = [];
const ORG = { id: 'org1', nc_instance_id: 'nc1', enabledIntegrations: null };
const GROUP = { id: 'g1', organizationId: 'org1', name: 'Interns', source: 'nextcloud', disabled_integrations: [] };

mock(path.join(SERVER, 'stores/userStore'), {
    getOrganization: async () => ({ ...ORG }),
    updateOrganization: async (id, updates) => { touched.push({ what: 'updateOrganization', args: [id, updates] }); return true; },
    getAllGroups: async () => [{ ...GROUP }],
    getAllUsers: async () => [],
    updateGroup: async (id, patch) => { touched.push({ what: 'updateGroup', args: [id, patch] }); return true; },
});
mock(path.join(SERVER, 'stores/guardrailEventStore'), { logGuardrailEvent: async () => true });
mock(path.join(SERVER, 'core/integrations/ncScope'), {
    getOrgScopeDoc: async () => null,
    sanitizeIntegrations: (v) => v,
    setOrgEnabledIntegrations: async (orgId, ids) => { touched.push({ what: 'setOrgEnabledIntegrations', args: [orgId, ids] }); return true; },
});
mock(path.join(SERVER, 'auth/permissions'), {
    requireAuth: (req, res, next) => next(),
    requireOrgAdmin: () => (req, res, next) => next(),
});

const router = require('./ncIntegrations');
const { terminalErrorHandler } = require(path.join(SERVER, 'core/http/terminalErrorHandler'));

function dispatch({ method, url, body }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, query: {}, body, headers: {},
            session: { user: { id: 'u1' } }, get() { return undefined; }, setTimeout() {},
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

/** Assert: refused with 400, the named field is in `details`, nothing written. */
async function refuses(request, field) {
    const res = await dispatch(request);
    const what = `${request.method} ${request.url} ${JSON.stringify(request.body)}`;
    assert.strictEqual(res.statusCode, 400, `${what} -> ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'invalid_request', what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
    return res;
}

// ═══ PUT /admin/:orgId/nc-integrations ══════════════════════════════

test('one id instead of a list is refused, not read as "switch everything off"', async () => {
    await refuses({ method: 'PUT', url: '/admin/org1/nc-integrations', body: { enabled: 'nextcloud-talk' } }, 'body.enabled');
});

test('a misspelled integration id is named back, not dropped', async () => {
    const res = await refuses({ method: 'PUT', url: '/admin/org1/nc-integrations', body: { enabled: ['nextcloud-tlk'] } }, 'body.enabled.0');
    assert.ok(res.body.error.includes('nextcloud-tlk'), `the caller must read which id: ${res.body.error}`);
});

test('a body with no enabled list at all is refused in words', async () => {
    const res = await refuses({ method: 'PUT', url: '/admin/org1/nc-integrations', body: {} }, 'body.enabled');
    assert.strictEqual(res.body.error, 'enabled is a list of Nextcloud integration ids.');
});

test('a misspelled key is refused rather than answered with ok:true', async () => {
    await refuses({ method: 'PUT', url: '/admin/org1/nc-integrations', body: { enabled: [], enabledIntegrations: [] } }, 'body');
});

test('the ids a caller may switch on still reach the scope doc', async () => {
    const res = await dispatch({ method: 'PUT', url: '/admin/org1/nc-integrations', body: { enabled: ['nextcloud-talk', 'nextcloud-deck'] } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'setOrgEnabledIntegrations').args[1], ['nextcloud-talk', 'nextcloud-deck']);
});

test('an empty list still means "everything off", because that is what it says', async () => {
    const res = await dispatch({ method: 'PUT', url: '/admin/org1/nc-integrations', body: { enabled: [] } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'setOrgEnabledIntegrations').args[1], []);
});

// ═══ PUT /admin/:orgId/nc-integrations/groups/:groupId ══════════════

test('a group exception that is one id, not a list, is refused', async () => {
    // `[]` here clears every exception the group had, under a 200.
    await refuses({ method: 'PUT', url: '/admin/org1/nc-integrations/groups/g1', body: { disabledIntegrations: 'nextcloud-talk' } }, 'body.disabledIntegrations');
});

test('a misspelled id in a group exception is refused, not left enabled', async () => {
    await refuses({ method: 'PUT', url: '/admin/org1/nc-integrations/groups/g1', body: { disabledIntegrations: ['nextcloud-tals'] } }, 'body.disabledIntegrations.0');
});

test('a real group exception still lands', async () => {
    const res = await dispatch({ method: 'PUT', url: '/admin/org1/nc-integrations/groups/g1', body: { disabledIntegrations: ['nextcloud-talk'] } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'updateGroup').args[1], { disabledIntegrations: ['nextcloud-talk'] });
});
