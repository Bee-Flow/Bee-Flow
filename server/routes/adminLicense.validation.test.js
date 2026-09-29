/**
 * What the admin licence routes accept, and what they say when they refuse
 * (routes/adminLicense.js).
 *
 * Each of these used to mint a DIFFERENT licence than the one asked for,
 * under a 200 that the wizard answers with "License granted.":
 *
 *   - `maxSeats: 'ten'` (or 0) became a seat cap the seat check reads as
 *     "no cap" — UNLIMITED seats;
 *   - `scope: 'Server'` bound the licence to the organisation in the body
 *     instead of minting the unbound blob;
 *   - `featuresOverride: 'chat_basic'` (one key, not a list) was dropped and
 *     the tier's full feature list was recorded instead;
 *   - `deliverEmail` without an '@' was skipped, with no word in the answer;
 *   - on import, `organisationId` (British spelling) was dropped and the
 *     licence landed in the organisation the blob names.
 *
 * What this file pins:
 *
 *   - the 400 NAMES the field (`body.maxSeats`);
 *   - the message is a sentence, including for a field simply left out;
 *   - adminIssuance is never reached, so a refused request mints nothing.
 *
 * Run: cd server && node --test routes/adminLicense.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every issuance, import and store write lands in `touched`. A refused request must leave it empty.
const touched = [];
const mailed = [];
const pass = (req, res, next) => next();
const ADMIN_LIC = { id: 'lic_1', issuer: 'beeflow.admin.console', tier: 'enterprise' };

const MOCKS = {
    '../license': {},
    '../license/adminIssuance': {
        BLOB_PREFIX: 'beeflow-admin-v1.',
        publicLicenseShape: (l) => (l ? { id: l.id, tier: l.tier } : null),
        isAdminIssuedLicense: (l) => !!l && l.issuer === 'beeflow.admin.console',
        issueAdminLicense: async (args) => {
            touched.push({ what: 'issueAdminLicense', args: [args] });
            return { license: { id: 'lic_new', expiresAt: '2027-12-31T23:59:59.000Z' }, blob: 'beeflow-admin-v1.xyz' };
        },
        importAdminLicense: async (blob, opts) => {
            touched.push({ what: 'importAdminLicense', args: [blob, opts] });
            return { license: { id: 'lic_imp' }, blob };
        },
    },
    '../license/store': {
        getAdminIssuedLicenses: async (opts) => { touched.push({ what: 'getAdminIssuedLicenses', args: [opts] }); return []; },
        getLicenseById: async (id) => (id === 'lic_1' ? { ...ADMIN_LIC } : null),
        markRevoked: async (id, reason) => { touched.push({ what: 'markRevoked', args: [id, reason] }); },
        extendExpiry: async (id, iso) => { touched.push({ what: 'extendExpiry', args: [id, iso] }); return { ...ADMIN_LIC, expiresAt: iso }; },
    },
    '../stores/userStore': {
        getAllOrganizations: async () => [],
        logSubscriptionAudit: async () => {},
    },
    '../utils/emailService': {
        getServiceEmailConfig: async () => ({ configured: true }),
        sendServiceEmail: async (m) => { mailed.push(m); return { success: true }; },
    },
    '../auth/permissions': { requireSuperAdmin: pass },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:admin-license-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]adminLicense\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./adminLicense');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ method, url, body }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = url.split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, body, query, headers: {},
            session: { isAuthenticated: true, user: { id: 'op1' } }, get() { return undefined; },
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

const GRANT = { scope: 'organization', organizationId: 'acme', tier: 'enterprise', expiresAt: '2027-12-31T23:59:59.000Z' };
const grant = (extra) => dispatch({ method: 'POST', url: '/grant', body: { ...GRANT, ...extra } });

test.beforeEach(() => { touched.length = 0; mailed.length = 0; });

test('a seat count in words — or zero — is refused, instead of granting unlimited seats', async () => {
    for (const maxSeats of ['ten', 0, -5, 2.5]) {
        const res = await grant({ maxSeats });
        assert.strictEqual(res.statusCode, 400, `maxSeats ${JSON.stringify(maxSeats)}`);
        assert.strictEqual(res.body.error, 'maxSeats is a whole number of seats, 1 or more — or empty for no cap.');
        assert.ok(res.body.details.some((d) => d.path === 'body.maxSeats'));
    }
    assert.deepStrictEqual(touched, [], 'nothing was minted');
});

test('a misspelled scope is refused, instead of binding the licence to the organisation', async () => {
    const res = await grant({ scope: 'Server' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'scope is "organization" or "server".');
    assert.deepStrictEqual(touched, []);
});

test('features as one key, and limits as JSON text, are refused rather than replaced by the tier defaults', async () => {
    let res = await grant({ featuresOverride: 'chat_basic' });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.featuresOverride'));

    res = await grant({ limitsOverride: '{"max_users":50}' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'limitsOverride is an object of limits, like { "max_users": 50 }.');
    assert.deepStrictEqual(touched, []);
});

test('an address a mail cannot go to is refused, instead of skipping the mail without a word', async () => {
    const res = await grant({ deliverEmail: 'jan.acme.nl' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'deliverEmail is an e-mail address.');
    assert.deepStrictEqual(touched, []);
    assert.deepStrictEqual(mailed, []);
});

test('an organisation licence without its organisation is refused in words, before adminIssuance', async () => {
    const res = await grant({ organizationId: null });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.organizationId'));
    assert.deepStrictEqual(touched, []);
});

test('a grant with no tier, or no date, says so in a sentence', async () => {
    let res = await dispatch({ method: 'POST', url: '/grant', body: { organizationId: 'acme', expiresAt: GRANT.expiresAt } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /^tier is one of: /);

    res = await dispatch({ method: 'POST', url: '/grant', body: { organizationId: 'acme', tier: 'enterprise' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'expiresAt is a date, like 2027-12-31T23:59:59Z.');
    assert.deepStrictEqual(touched, []);
});

test('the wizard\'s grant still mints, mails, and passes the seat cap through as a number', async () => {
    const res = await grant({
        billingInterval: 'monthly', notes: null, deliverEmail: '  ops@acme.example ',
        featuresOverride: ['chat_basic'], limitsOverride: { max_users: 50 }, maxSeats: 10,
    });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const args = touched.find((t) => t.what === 'issueAdminLicense').args[0];
    assert.strictEqual(args.scope, 'organization');
    assert.strictEqual(args.organizationId, 'acme');
    assert.strictEqual(args.maxSeats, 10);
    assert.strictEqual(args.billingInterval, 'monthly');
    assert.deepStrictEqual(args.featuresOverride, ['chat_basic']);
    assert.strictEqual(mailed[0].to, 'ops@acme.example');
    assert.strictEqual(res.body.emailDelivery.success, true);
});

test('a server licence is minted unbound, whatever organisation the body carries', async () => {
    const res = await grant({ scope: 'server', organizationId: null });
    assert.strictEqual(res.statusCode, 200);
    const args = touched.find((t) => t.what === 'issueAdminLicense').args[0];
    assert.strictEqual(args.scope, 'server');
    assert.strictEqual(args.organizationId, null);
});

test('an import with the organisation misspelled is refused, instead of landing in the blob\'s own', async () => {
    const res = await dispatch({ method: 'POST', url: '/import', body: { blob: 'beeflow-admin-v1.abc', organisationId: 'acme' } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

test('the grants view\'s import — blank organisation meaning "the blob\'s" — still imports', async () => {
    const res = await dispatch({ method: 'POST', url: '/import', body: { blob: 'beeflow-admin-v1.abc', organizationId: null } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched[0].args[1], { activatedBy: 'op1', organizationId: null });
});

test('the list takes its two filters and nothing else', async () => {
    let res = await dispatch({ method: 'GET', url: '/?includeInactive=true' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched[0].args[0], { organizationId: null, includeInactive: true });

    touched.length = 0;
    res = await dispatch({ method: 'GET', url: '/?organisationId=acme' });
    assert.strictEqual(res.statusCode, 400, 'a misspelled filter is not "every organisation"');
    res = await dispatch({ method: 'GET', url: '/?includeInactive=no' });
    assert.strictEqual(res.statusCode, 400, '"no" is not read as yes any more');
    assert.deepStrictEqual(touched, []);
});

test('revoke takes no body, or a reason; extend needs a date', async () => {
    let res = await dispatch({ method: 'POST', url: '/lic_1/revoke', body: undefined });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched[0].args[1], 'revoked_by:op1');

    touched.length = 0;
    res = await dispatch({ method: 'POST', url: '/lic_1/revoke', body: { reson: 'fraud' } });
    assert.strictEqual(res.statusCode, 400, 'a misspelled reason is not silently the default one');
    assert.deepStrictEqual(touched, []);

    res = await dispatch({ method: 'POST', url: '/lic_1/extend', body: { expiresAt: 'next year' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'expiresAt is a date, like 2027-12-31T23:59:59Z.');
    assert.deepStrictEqual(touched, []);

    res = await dispatch({ method: 'POST', url: '/lic_1/extend', body: { expiresAt: '2099-01-01T00:00:00Z' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched[0].args[1], '2099-01-01T00:00:00.000Z');
});
