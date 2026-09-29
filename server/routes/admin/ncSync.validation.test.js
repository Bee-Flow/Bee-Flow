'use strict';

/**
 * What the Nextcloud sync routes accept, and what they say when they refuse
 * (routes/admin/ncSync.js).
 *
 * Both write routes read the body key by key, kept what they recognised and
 * dropped the rest under a 200 `{ ok: true }` — and the panel answers that
 * with "Settings saved". Three of those drops changed a decision:
 *
 *   - `syncGroups: 'Interns'` (one name, not a list) never reached the org,
 *     so selective sync stayed on whatever group set was already stored;
 *   - a misspelled `excludeGroups` was ignored, so an org-admin removing an
 *     exclusion was told it was saved while everyone stayed excluded;
 *   - `piiDetectionAction: 'blok'` in the onboarding wizard stored
 *     **tokenize** for an organisation that had chosen to BLOCK.
 *
 * What this file pins is the part a caller can act on:
 *
 *   - the 400 NAMES the field (`body.syncGroups`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the stores are never reached, so a refused request changes nothing.
 *
 * Run: cd server && node --test routes/admin/ncSync.validation.test.js
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

// Every store write lands in `touched`. A refused request must leave it empty.
const touched = [];
const ORG = { id: 'org1', nc_instance_id: 'nc1', nc_base_url: 'https://nc.example' };

mock(path.join(SERVER, 'stores/userStore'), {
    getOrganization: async () => ({ ...ORG }),
    updateOrganization: async (id, updates) => { touched.push({ what: 'updateOrganization', args: [id, updates] }); return true; },
    getAllUsers: async () => [],
    getPlan: async () => ({ id: 'plan1' }),
});
mock(path.join(SERVER, 'stores/configStore'), {
    getConfig: async () => null,
    setConfig: async (key, value) => { touched.push({ what: 'setConfig', args: [key, value] }); return true; },
});
const fullSyncs = [];
mock(path.join(SERVER, 'services/ncUserGroupSync'), {
    runFullSync: async (org) => { fullSyncs.push(org && org.id); return { created: 0, deactivated: 0, groupsCreated: 0, errors: [] }; },
    listNcGroups: async () => [],
});
mock(path.join(SERVER, 'services/orgHealth'), { event: () => {}, resolve: () => {} });
mock(path.join(SERVER, 'auth/permissions'), {
    requireAuth: (req, res, next) => next(),
    isOrgAdminForOrg: async () => true,
});
mock(path.join(SERVER, 'auth/gateMeta'), { tagGate: (fn) => fn });

const router = require('./ncSync');
const { terminalErrorHandler } = require(path.join(SERVER, 'core/http/terminalErrorHandler'));

function dispatch({ method, url, body }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, query, body, headers: {},
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

// ═══ PUT /admin/:orgId/nc-sync ══════════════════════════════════════

test('one group name instead of a list is refused, not silently skipped', async () => {
    // `Array.isArray(syncGroups)` was false, so the whole selection was
    // dropped and the panel still said "Settings saved".
    await refuses({ method: 'PUT', url: '/admin/org1/nc-sync', body: { mode: 'selective_groups', syncGroups: 'Interns' } }, 'body.syncGroups');
});

test('a misspelled key is refused rather than answered with ok:true', async () => {
    await refuses({ method: 'PUT', url: '/admin/org1/nc-sync', body: { excludeGroups: ['Interns'] } }, 'body');
});

test('an unknown sync mode is refused in words, not with an enum dump', async () => {
    const res = await refuses({ method: 'PUT', url: '/admin/org1/nc-sync', body: { mode: 'mirror-all' } }, 'body.mode');
    assert.strictEqual(res.body.error, 'mode is "mirror_all", "selective_groups" or "manual".');
});

test('the settings a caller may change still reach the org', async () => {
    const res = await dispatch({ method: 'PUT', url: '/admin/org1/nc-sync', body: { mode: 'manual', syncGroups: ['Staff'], newUserDefaultStatus: 'pending' } });
    assert.strictEqual(res.statusCode, 200);
    const updates = touched.find((t) => t.what === 'updateOrganization').args[1];
    assert.deepStrictEqual(updates, { ncSyncMode: 'manual', ncSyncGroups: ['Staff'], ncNewUserDefaultStatus: 'pending' });
});

// ═══ POST /admin/:orgId/nc-onboarding/complete ══════════════════════

const ONBOARDING = { syncMode: 'mirror_all', newUserDefaultStatus: 'active' };

test('a misspelled PII action is refused instead of tokenising what should be blocked', async () => {
    const res = await refuses({
        method: 'POST', url: '/admin/org1/nc-onboarding/complete',
        body: { ...ONBOARDING, privacyShield: { enabled: true, piiDetectionAction: 'blok' } },
    }, 'body.privacyShield.piiDetectionAction');
    assert.strictEqual(res.body.error, 'piiDetectionAction is "tokenize" or "block".');
});

test('a shield switch that is a string, not a boolean, is refused by name', async () => {
    await refuses({
        method: 'POST', url: '/admin/org1/nc-onboarding/complete',
        body: { ...ONBOARDING, privacyShield: { enabled: 'false' } },
    }, 'body.privacyShield.enabled');
});

test('a PII category list that is one category is refused, not read as none', async () => {
    await refuses({
        method: 'POST', url: '/admin/org1/nc-onboarding/complete',
        body: { ...ONBOARDING, privacyShield: { piiDetectionCategories: 'EMAIL' } },
    }, 'body.privacyShield.piiDetectionCategories');
});

test('selective sync without a group is still refused, now by name', async () => {
    await refuses({
        method: 'POST', url: '/admin/org1/nc-onboarding/complete',
        body: { syncMode: 'selective_groups', newUserDefaultStatus: 'active', syncGroups: [] },
    }, 'body.syncGroups');
});

test('a key the wizard does not send is refused rather than quietly dropped', async () => {
    await refuses({
        method: 'POST', url: '/admin/org1/nc-onboarding/complete',
        body: { ...ONBOARDING, privacyShiled: {} },
    }, 'body');
});

test('block means block, all the way into the stored shield', async () => {
    const res = await dispatch({
        method: 'POST', url: '/admin/org1/nc-onboarding/complete',
        body: { ...ONBOARDING, deploymentMode: 'self-hosted', privacyShield: { enabled: true, piiDetectionAction: 'block', piiDetectionCategories: ['EMAIL'] } },
    });
    assert.strictEqual(res.statusCode, 200);
    const shield = touched.find((t) => t.what === 'setConfig').args[1];
    assert.strictEqual(shield.piiDetectionAction, 'block');
    assert.deepStrictEqual(shield.piiDetectionCategories, ['EMAIL']);
});

// ═══ POST /admin/:orgId/nc-sync/run ═════════════════════════════════

test('"Sync now" goes straight to runFullSync: the backstop\'s 24h backoff never applies to it', async () => {
    // The backoff after a failed sync lives in jobs/ncSyncBackstop.js alone.
    // An admin who just re-paired the connector must be able to retry at once.
    fullSyncs.length = 0;
    const res = await dispatch({ method: 'POST', url: '/admin/org1/nc-sync/run' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fullSyncs, ['org1']);
});
