/**
 * What the MFA enrolment routes accept, and what they say when they refuse
 * (auth/mfaRoutes.js).
 *
 * Two silent fall-backs lived here. `/setup` read "start over" as
 * `!req.body?.force`, so EVERY truthy value minted a fresh secret — the string
 * "false" included — and somebody who had already scanned the QR code into
 * their authenticator lost it to a value that says not to; a mis-spelled key
 * did the opposite and quietly re-served the old secret to someone who had
 * asked to start again. And `/enable`, `/disable` and
 * `/recovery-codes/regenerate` all read `req.body?.code`, which both verifiers
 * answer "no" to — so a request that named no code at all was counted as a
 * WRONG CODE against the rate limiter. What this file pins:
 *
 *   - the 400 NAMES the field (`body.code`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the store is never reached, so a refused request costs no attempt.
 *
 * Run: cd server && node --test --test-force-exit auth/mfaRoutes.validation.test.js
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
const hit = (what) => (...args) => { touched.push({ what, args }); };

const MOCKS = {
    './permissions': { requireAuth: pass },
    './mfa': {
        generateSecret: () => { touched.push({ what: 'generateSecret', args: [] }); return 'FRESHSECRET'; },
        otpauthUrl: () => 'otpauth://x',
        qrDataUrl: async () => 'data:image/png;base64,x',
        verifyTotp: (s, code) => { touched.push({ what: 'verifyTotp', args: [code] }); return false; },
        consumeRecoveryCode: async (stored, code) => { touched.push({ what: 'consumeRecoveryCode', args: [code] }); return null; },
        decryptSecret: () => 'secret',
        encryptSecret: (v) => v,
        generateRecoveryCodes: async () => ({ plain: [], stored: '[]' }),
        remainingRecoveryCodes: () => 0,
    },
    '../stores/userStore': { getUser: async (id) => ({ id, mfa_enabled: 1, mfa_secret: 's', mfa_recovery_codes: '[]' }), updateUser: hit('updateUser') },
    '../utils/perUserRateLimit': { perUserRateLimit: () => pass },
    '../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:mfa-routes-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /auth[\\/]mfaRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./mfaRoutes');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {}, session }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, body, query, headers: {},
            session: session || { user: { id: 'u1', displayName: 'Bob' }, save(cb) { cb(); } }, get() { return undefined; },
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

/** Assert: refused with 400, the named field is in `details`, nothing touched. */
async function refuses(request, field) {
    const res = await dispatch(request);
    const what = `${request.method} ${request.url} ${JSON.stringify(request.body)}`;
    assert.strictEqual(res.statusCode, 400, what);
    assert.ok(res.body.details ? res.body.details.some((d) => d.path === field) : true,
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
}

test('force: "false" no longer throws away the secret it says to keep', async () => {
    // `!"false"` is false, so every truthy value used to mean "mint a new one".
    await refuses({ method: 'POST', url: '/setup', body: { force: 'false' } }, 'body.force');
});

test('a misspelled force is refused rather than re-serving the old secret', async () => {
    await refuses({ method: 'POST', url: '/setup', body: { forced: true } }, 'body');
});

test('a body with no code is refused in words, not counted as a wrong code', async () => {
    const res = await dispatch({ method: 'POST', url: '/recovery-codes/regenerate', body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Enter the code from your authenticator app, or one of your recovery codes.');
    assert.ok(res.body.details.some((d) => d.path === 'body.code'));
    assert.deepStrictEqual(touched, [], 'no attempt may be spent on a request that named no code');
});

test('a misspelled code key on disable is refused rather than burning an attempt', async () => {
    await refuses({ method: 'POST', url: '/disable', body: { cod: '123456' } }, 'body');
});

test('an assist request with no question is refused by name', async () => {
    await refuses({ method: 'POST', url: '/assist', body: {} }, 'body.question');
});

test('a misspelled history key is refused rather than dropping the conversation', async () => {
    await refuses({ method: 'POST', url: '/assist', body: { question: 'help', histroy: [] } }, 'body');
});
