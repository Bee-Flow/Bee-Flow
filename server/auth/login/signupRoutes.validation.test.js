/**
 * What /signup accepts, and what it says when it refuses
 * (auth/login/signupRoutes.js).
 *
 * The body is handed WHOLE to accountProvisioning.normalizeSignupIntent, which
 * reads every key it cares about by name — so a key nobody reads was accepted,
 * answered with a created account, and thrown away. A mis-typed `newOrgName`
 * is the one that costs: the signup silently becomes a CONSUMER account on
 * cloud instead of founding the organisation the person filled a whole wizard
 * step in for, and the password is held to the member minimum rather than the
 * administrative one. What this file pins:
 *
 *   - the 400 NAMES the field (`body.username`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the store is never reached, so a refused signup creates nothing.
 *
 * `orgDetails` and `privacyShield` are deliberately left open — they are
 * wizard payloads consumed field-by-field (and sanitised) downstream, and this
 * route does not own either shape.
 *
 * Run: cd server && node --test --test-force-exit auth/login/signupRoutes.validation.test.js
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
    '../../stores/userStore': {
        createUserWithSeatCheck: async (u) => { touched.push({ what: 'createUserWithSeatCheck', args: [u] }); return { ok: true }; },
        SeatCapExceededError: class SeatCapExceededError extends Error {},
    },
    '../../stores/invitationStore': { getInvitationByToken: async () => null },
    '../accountProvisioning': {
        SignupError: class SignupError extends Error {},
        normalizeSignupIntent: (src) => { touched.push({ what: 'normalizeSignupIntent', args: [src] }); return { accountType: 'consumer' }; },
        prepareAccountPlacement: async () => ({ organizationId: null, status: 'active', needsVerification: false, groups: [], orgRole: '' }),
        finalizeAccount: async () => {},
        assertUserCreated: () => {},
        notifyOrganisationAlreadyExists: async () => false,
    },
    '../passwordPolicy': { validatePasswordAsync: async () => ({ ok: true }) },
    '../signupCaptcha': { verifyCaptcha: async () => ({ ok: true }) },
    '../encryption': { getOrCreateUserDEKCompat: async () => ({ encryptionKey: 'k' }) },
    '../establishSession': { establishSession: async () => {} },
    '../authRateLimits': { signupIpLimiter: pass, signupTargetLimiter: pass },
    '../../utils/htmlSanitizer': { sanitizePlainText: (v) => (v === undefined || v === null ? '' : String(v).replace(/<[^>]*>/g, '').trim()) },
    '../../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
    'bcryptjs': { hash: async () => 'hash' },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:signup-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /login[\\/]signupRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./signupRoutes');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {}, session }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: session || { save(cb) { cb(); } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            set() { return this; }, setHeader() {}, cookie() { return this; },
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

/** Assert: refused with 400, the named field is in `details`, nothing touched. */
async function refuses(request, field) {
    const res = await dispatch(request);
    const what = `${request.method} ${request.url} ${JSON.stringify(request.body)}`;
    assert.strictEqual(res.statusCode, 400, what);
    assert.strictEqual(res.body.code, 'invalid_request', what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
}

test('a signup with no password is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/signup', body: { username: 'bob' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Username and password are required');
    assert.ok(res.body.details.some((d) => d.path === 'body.password'));
    assert.deepStrictEqual(touched, []);
});

test('a misspelled org name is refused instead of creating a personal account', async () => {
    await refuses({
        method: 'POST', url: '/signup',
        body: { username: 'bob', password: 'pw', newOrgNam: 'Acme' },
    }, 'body');
});

test('a numeric username is refused by name instead of becoming the account id', async () => {
    await refuses({ method: 'POST', url: '/signup', body: { username: 42, password: 'pw' } }, 'body.username');
});

test('the wizard body the SPA actually sends is still accepted whole', async () => {
    const res = await dispatch({
        method: 'POST', url: '/signup',
        body: {
            username: 'bob', password: 'pw', displayName: 'Bob B', firstName: 'Bob', lastName: 'B',
            email: 'bob@example.test', locale: 'nl', selectedPlanId: null,
            newOrgName: 'Acme', orgDetails: { tagline: 't', privacyShield: { enabled: true } },
        },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(touched.some((t) => t.what === 'createUserWithSeatCheck'));
});
