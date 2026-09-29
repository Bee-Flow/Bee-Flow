/**
 * Route-level tests — the never-redact allowlist round-trip.
 *
 * `piiAllowTerms` / `piiAllowPublicOrgs` are the mirror image of
 * `customSensitiveTerms`: values that must NOT be treated as personal data.
 * They shipped as a runtime feature (core/dlp/allowTerms.js) before the route
 * knew about them, so the PUT handler dropped both on every save and the
 * settings UI would have written into a void.
 *
 * The load-bearing assertion here is the DEFAULT. `allowTerms.js` reads
 * `piiAllowPublicOrgs !== false`, i.e. an absent value means ON. If the route
 * ever coerces with `!!`, an org that saves its shield silently switches the
 * shipped public-organisation list OFF and starts redacting Microsoft, PostNL
 * and every other public brand — a change nobody asked for and nobody sees.
 *
 * Run: node server/routes/orgPrivacyShield.allowterms.test.js
 */

const assert = require('assert');
const path = require('path');
const Module = require('module');
const http = require('http');

let mockTier = 'enterprise';
const storeBlobs = {};

const tiersStub = require('../license/tiers');
const licenseStub = { tiers: tiersStub, async resolveTier() { return mockTier; } };
const configStoreStub = {
    async getConfig(key) { return storeBlobs[key] !== undefined ? storeBlobs[key] : null; },
    async setConfig(key, value) { storeBlobs[key] = value; return true; },
};
const userStoreStub = {
    async getUser(id) { return { id, organizationId: 'org_test', orgRole: 'org_admin', groups: '[]' }; },
    async getAllGroups() { return []; },
};
const authStub = {
    SystemRoles: { SUPER_ADMIN: 'admin' }, OrgRoles: {}, Permissions: {},
    isOrgAdminRole: (role) => role === 'org_admin',
    async hasPermission() { return false; },
    async resolveUserOrgIds(req) {
        const orgId = req?.session?.user?.organizationId;
        return orgId ? new Set([orgId]) : new Set();
    },
};

const ROUTES_DIR = path.sep + path.join('routes');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && parent.filename && parent.filename.includes(ROUTES_DIR + path.sep)) {
        if (request === '../license') return path.join(__dirname, '__stub_lic_allow__.js');
        if (request === '../stores/configStore') return path.join(__dirname, '__stub_cfg_allow__.js');
        if (request === '../stores/userStore') return path.join(__dirname, '__stub_us_allow__.js');
        if (request === '../auth') return path.join(__dirname, '__stub_auth_allow__.js');
        // The route pulls isOrgAdminForOrg straight from auth/permissions
        // (orgPrivacyShield.js:97), which requires stores/userStore from inside
        // auth/ — outside this interceptor's reach — and that opens a real
        // Postgres connection. Without this stub every PUT is a 500 ECONNREFUSED
        // and the test reports a route bug that does not exist.
        if (request === '../auth/permissions') return path.join(__dirname, '__stub_perm_allow__.js');
        if (request === '../core/dlp/customTerms') return path.join(__dirname, '__stub_ct_allow__.js');
        if (request === '../core/privacy/orgShield') return path.join(__dirname, '__stub_os_allow__.js');
    }
    return origResolve.call(this, request, parent, ...rest);
};
const stubExports = {
    '__stub_lic_allow__.js': licenseStub,
    '__stub_cfg_allow__.js': configStoreStub,
    '__stub_us_allow__.js': userStoreStub,
    '__stub_auth_allow__.js': authStub,
    '__stub_perm_allow__.js': {
        // The route takes BOTH of these from auth/permissions — requireAuth at
        // module scope (line 90) and isOrgAdminForOrg at line 97. A stub that
        // omits requireAuth makes the router throw at load time, not at request
        // time, which reads as an unrelated crash.
        requireAuth(req, res, next) {
            if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Unauthenticated' });
            return next();
        },
        async isOrgAdminForOrg(req, orgId) {
            return req?.session?.user?.orgRole === 'org_admin'
                && req?.session?.user?.organizationId === orgId;
        },
    },
    '__stub_ct_allow__.js': { invalidate() {} },
    '__stub_os_allow__.js': { async resolveOrgShield() { return null; } },
};
for (const [fname, exp] of Object.entries(stubExports)) {
    const full = path.join(__dirname, fname);
    require.cache[full] = { id: full, filename: full, loaded: true, exports: exp };
}

const express = require('express');
const router = require('./orgPrivacyShield');
const app = express();
app.use(express.json());
let currentSession = null;
app.use((req, _res, next) => { req.session = currentSession; next(); });
app.use('/api/org-privacy-shield', router);
const server = app.listen(0);

function request(method, pathname, { body = null } = {}) {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
        const req = http.request(`http://127.0.0.1:${port}${pathname}`, {
            method, headers: { 'Content-Type': 'application/json' },
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                let parsed = null;
                try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

const ORG_ID = 'org_test';
const STORE_KEY = `org_privacy_shield_${ORG_ID}`;
const SESSION = { isAuthenticated: true, user: { id: 'u_orgadmin', organizationId: ORG_ID, orgRole: 'org_admin' } };

function payload(overrides = {}) {
    return {
        enabled: true, collectionIds: [], scope: { userInput: true, agentOutput: true }, action: 'delete',
        euModeEnabled: false, webSearchGuardEnabled: false, disableSearchOnUpload: false,
        piiDetectionCategories: ['Person'], piiDetectionConfidenceThreshold: 0.7, piiDetectionAction: 'block',
        webSearchGuardPiiCategories: [], monitorIntegrations: false,
        dlpEnabled: false, dlpScope: 'external', dlpMode: 'ask', dlpFailureMode: 'fail_closed',
        dlpAllowlistedHosts: [], customSensitiveTerms: [], showRawPayload: false, ...overrides,
    };
}

(async () => {
    try {
        currentSession = SESSION;
        storeBlobs['ai'] = {};

        // ── 1. A brand-new org reads the public list as ON ──────────────
        // undefined would render as "off" in the settings UI while the runtime
        // treats it as on — the UI must never lie about what the shield does.
        delete storeBlobs[STORE_KEY];
        const fresh = await request('GET', `/api/org-privacy-shield/${ORG_ID}`);
        assert.strictEqual(fresh.status, 200);
        assert.strictEqual(fresh.body.piiAllowPublicOrgs, true,
            'a fresh org must read piiAllowPublicOrgs=true, not undefined');
        assert.deepStrictEqual(fresh.body.piiAllowTerms, [], 'a fresh org has no own allow terms');

        // ── 2. Terms round-trip, and objects are normalised to strings ──
        const put = await request('PUT', `/api/org-privacy-shield/${ORG_ID}`, {
            body: payload({
                piiAllowTerms: ['Dekker Techniek', { term: 'Bee Flow' }, '  Padded  ', '', '   '],
            }),
        });
        assert.strictEqual(put.status, 200);
        const got = await request('GET', `/api/org-privacy-shield/${ORG_ID}`);
        assert.deepStrictEqual(got.body.piiAllowTerms, ['Dekker Techniek', 'Bee Flow', 'Padded'],
            'objects normalise to strings, blanks are dropped, values are trimmed');

        // A term that is not text is refused rather than dropped under a 200:
        // the list the admin sent is not the list that would have been kept.
        const junk = await request('PUT', `/api/org-privacy-shield/${ORG_ID}`, {
            body: payload({ piiAllowTerms: ['Eigen BV', null, 42] }),
        });
        assert.strictEqual(junk.status, 400, 'a null or a number in the allowlist is a 400');
        assert.deepStrictEqual(storeBlobs[STORE_KEY].piiAllowTerms, ['Dekker Techniek', 'Bee Flow', 'Padded'],
            'and the stored list is untouched');

        // ── 3. An OMITTED flag must persist as ON, not off ──────────────
        // This is the `!!` vs `!== false` trap. A client that does not know the
        // field yet (an older SPA build) must not silently disable the list.
        const body3 = payload();
        delete body3.piiAllowPublicOrgs;
        await request('PUT', `/api/org-privacy-shield/${ORG_ID}`, { body: body3 });
        const afterOmit = await request('GET', `/api/org-privacy-shield/${ORG_ID}`);
        assert.strictEqual(afterOmit.body.piiAllowPublicOrgs, true,
            'an omitted piiAllowPublicOrgs must persist as true');

        // ── 4. An explicit false is honoured ────────────────────────────
        await request('PUT', `/api/org-privacy-shield/${ORG_ID}`, {
            body: payload({ piiAllowPublicOrgs: false, piiAllowTerms: ['Eigen BV'] }),
        });
        const off = await request('GET', `/api/org-privacy-shield/${ORG_ID}`);
        assert.strictEqual(off.body.piiAllowPublicOrgs, false, 'an explicit false must stick');
        assert.deepStrictEqual(off.body.piiAllowTerms, ['Eigen BV']);

        // ── 5. The list is capped ───────────────────────────────────────
        await request('PUT', `/api/org-privacy-shield/${ORG_ID}`, {
            body: payload({ piiAllowTerms: Array.from({ length: 900 }, (_, i) => `term${i}`) }),
        });
        const capped = await request('GET', `/api/org-privacy-shield/${ORG_ID}`);
        assert.strictEqual(capped.body.piiAllowTerms.length, 500, 'the allow list is capped at 500 entries');
        assert.ok(capped.body.piiAllowTerms.every(t => t.length <= 120), 'each term is capped at 120 chars');

        console.log('✓ routes/orgPrivacyShield.allowterms.test.js — all assertions passed');
    } finally {
        server.close();
    }
})().catch(err => {
    console.error('✗ routes/orgPrivacyShield.allowterms.test.js failed:', err);
    server.close();
    process.exit(1);
});
