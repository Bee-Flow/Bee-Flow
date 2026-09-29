/**
 * M-02 (the instance that survived) — account enumeration on OPAQUE login start.
 *
 * A pentest closed the timing oracle on /auth/admin-login and reported the
 * finding fixed. It was, on that route. This one was never tested, and here
 * enumeration needed no measurement at all — the status code said it outright:
 *
 *     unknown username   -> 401 {"error":"Invalid credentials"}
 *     legacy (non-OPAQUE)-> 400 {"useLegacy":true}
 *     OPAQUE account     -> 200 {loginResponse, loginId, wrappedDEK}
 *
 * The handler's own comment said "Don't reveal whether user exists — use dummy
 * response / OPAQUE supports this via fake credentials". The dummy was never
 * written. These tests assert that all three now answer alike, in status, in
 * body SHAPE, and that authentication still fails for the two that should fail.
 *
 * Body shape matters as much as the status: returning wrappedDEK: null for an
 * absent account while a real one returns an object just moves the oracle one
 * field deeper.
 *
 * Run: cd server && node --test auth/opaqueRoutes.enumeration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const opaque = require('@serenity-kit/opaque');

// ── Fixtures ─────────────────────────────────────────────────────────
const fx = { users: [], failures: [], successes: [] };

const mw = (req, res, next) => next();

const MOCKS = {
    '../stores/userStore': {
        getUser: async (id) => {
            const u = fx.users.find((x) => x.id === id);
            return u ? { ...u } : null;
        },
        getUserByEmail: async (email) => {
            const u = fx.users.find((x) => x.email === email);
            return u ? { ...u } : null;
        },
    },
    './permissions': { requireAuth: mw },
    '../db': { getRedis: () => null },
    '../telemetry/metrics': { recordAuthEvent: () => { } },
    './establishSession': { establishSession: async () => { } },
    '../utils/perUserRateLimit': { perUserRateLimit: () => mw },
    // The real throttle is a separate unit with its own suite; here we only need
    // to see that this route calls it, and that failures land on the submitted
    // identifier rather than a resolved account.
    './loginThrottle': {
        checkLoginAllowed: async () => ({ allowed: true }),
        recordLoginFailure: async (req, id) => { fx.failures.push(id); return { delayMs: 0, locked: false }; },
        recordLoginSuccess: async (req, id) => { fx.successes.push(id); },
        padFailureResponse: async () => { },
        sleep: async () => { },
        denyLogin: (res) => res.status(429).json({ error: 'Too many attempts' }),
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:opaqueroutes-enum:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /auth[\\/]opaqueRoutes\.js$/.test(parent.filename) && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

process.env.OPAQUE_SERVER_SETUP = process.env.OPAQUE_SERVER_SETUP || '';
let router;
let loadError = null;
try {
    router = require('./opaqueRoutes');
} catch (err) {
    loadError = err;
}
Module._resolveFilename = originalResolve;

function dispatch({ method, url, body = {}, session }) {
    return new Promise((resolve, reject) => {
        const request = {
            method, url, body, query: {}, params: {}, headers: {},
            ip: '203.0.113.9',
            socket: { remoteAddress: '203.0.113.9' },
            session: { save: (cb) => cb && cb(null), ...session },
            get(name) { return this.headers[String(name).toLowerCase()]; },
        };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(request, res, (err) => reject(err || new Error(`fell through router: ${method} ${url}`)));
    });
}

const REAL_PASSWORD = 'Correct-Horse-Battery-42';

/** Register an account the way the browser does, so the fixture is a real record. */
function registerFixture(username, password) {
    const serverSetup = process.env.OPAQUE_SERVER_SETUP || global._opaqueServerSetup;
    const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({ password });
    const { registrationResponse } = opaque.server.createRegistrationResponse({
        serverSetup, userIdentifier: username, registrationRequest,
    });
    const { registrationRecord } = opaque.client.finishRegistration({
        clientRegistrationState, registrationResponse, password,
    });
    return registrationRecord;
}

function startLoginRequestFor(password) {
    return opaque.client.startLogin({ password });
}

test('the router loaded with its dependencies stubbed', async () => {
    assert.strictEqual(loadError, null, loadError && loadError.message);
    assert.strictEqual(typeof router, 'function');
    await opaque.ready;
});

test('setup: three account shapes', async () => {
    await opaque.ready;
    // Touch the route once so getServerSetup() materialises the ephemeral setup
    // before the fixtures are built against it.
    await dispatch({ method: 'POST', url: '/login/start', body: { username: 'warm', startLoginRequest: startLoginRequestFor('x').startLoginRequest } });

    fx.users = [
        {
            id: 'opaque_user', email: 'opaque@acme.nl', kdfMode: 'opaque_v1',
            opaqueRecord: registerFixture('opaque_user', REAL_PASSWORD),
            wrappedDEK: JSON.stringify({ iv: 'aa'.repeat(12), authTag: 'bb'.repeat(16), data: 'cc'.repeat(32) }),
            recoveryWrappedDEK: JSON.stringify({ iv: 'dd'.repeat(12), authTag: 'ee'.repeat(16), data: 'ff'.repeat(32) }),
        },
        { id: 'legacy_user', email: 'legacy@acme.nl', kdfMode: 'argon2id', passwordHash: 'x' },
        // The shape the REAL store hands back. userStore.getUser/getUserByEmail
        // already run the envelope columns through parseJSON, so wrappedDEK is
        // an OBJECT here, never a JSON string. The string fixture above is a
        // test-only shape; keeping only that one hid a double-JSON.parse in the
        // handler which threw into a bare catch and left wrappedDEK null for
        // every genuine account.
        {
            id: 'opaque_parsed', email: 'parsed@acme.nl', kdfMode: 'opaque_v1',
            opaqueRecord: registerFixture('opaque_parsed', REAL_PASSWORD),
            wrappedDEK: { iv: '11'.repeat(12), authTag: '22'.repeat(16), data: '33'.repeat(32) },
            recoveryWrappedDEK: { iv: '44'.repeat(12), authTag: '55'.repeat(16), data: '66'.repeat(32) },
        },
    ];
    assert.strictEqual(fx.users.length, 3);
});

// ═══ The oracle ══════════════════════════════════════════════════════

test('unknown, legacy and OPAQUE accounts are indistinguishable at login/start', async () => {
    const probe = async (username) => {
        const { startLoginRequest } = startLoginRequestFor('some-guess');
        return dispatch({ method: 'POST', url: '/login/start', body: { username, startLoginRequest } });
    };

    const absent = await probe('no_such_person');
    const legacy = await probe('legacy_user');
    const real = await probe('opaque_user');

    for (const [label, res] of [['absent', absent], ['legacy', legacy], ['real', real]]) {
        assert.strictEqual(res.statusCode, 200, `${label} must not answer with its own status`);
        assert.ok(res.body.loginResponse, `${label} must carry a loginResponse`);
        assert.ok(res.body.loginId, `${label} must carry a loginId`);
    }

    // No field may be present for one shape and absent for another.
    const keys = (r) => Object.keys(r.body).sort().join(',');
    assert.strictEqual(keys(absent), keys(real));
    assert.strictEqual(keys(legacy), keys(real));

    // ...including the wrapped-DEK blob, whose sub-shape is also observable.
    const shape = (v) => (v === null ? 'null' : Object.keys(v).sort().join('+'));
    assert.strictEqual(shape(absent.body.wrappedDEK), shape(real.body.wrappedDEK));
    assert.strictEqual(shape(legacy.body.wrappedDEK), shape(real.body.wrappedDEK));

    // The lengths carry information too — a short filler would stand out.
    assert.strictEqual(absent.body.wrappedDEK.data.length, real.body.wrappedDEK.data.length);
    assert.strictEqual(absent.body.wrappedDEK.iv.length, real.body.wrappedDEK.iv.length);
    assert.strictEqual(absent.body.loginResponse.length, real.body.loginResponse.length);
});

test('the legacy hint that named an existing account is gone', async () => {
    const { startLoginRequest } = startLoginRequestFor('guess');
    const res = await dispatch({ method: 'POST', url: '/login/start', body: { username: 'legacy_user', startLoginRequest } });
    assert.strictEqual(res.body.useLegacy, undefined);
    assert.notStrictEqual(res.statusCode, 400);
});

test('the same absent username answers consistently across probes', async () => {
    const probe = async () => {
        const { startLoginRequest } = startLoginRequestFor('guess');
        const res = await dispatch({ method: 'POST', url: '/login/start', body: { username: 'ghost_a', startLoginRequest } });
        return res.body.wrappedDEK.data;
    };
    assert.strictEqual(await probe(), await probe(), 'a stable name must not look like a new account each time');
});

test('different absent usernames do not share a wrapped-DEK blob', async () => {
    const probe = async (username) => {
        const { startLoginRequest } = startLoginRequestFor('guess');
        const res = await dispatch({ method: 'POST', url: '/login/start', body: { username, startLoginRequest } });
        return res.body.wrappedDEK.data;
    };
    assert.notStrictEqual(await probe('ghost_b'), await probe('ghost_c'));
});

// ═══ Authentication must still fail ══════════════════════════════════

test('an absent account cannot complete login', async () => {
    fx.failures.length = 0;
    const { clientLoginState, startLoginRequest } = startLoginRequestFor(REAL_PASSWORD);
    const start = await dispatch({ method: 'POST', url: '/login/start', body: { username: 'no_such_person', startLoginRequest } });

    // The client cannot even finish against a credential nobody holds; whatever
    // it manages to send must be refused.
    const finished = opaque.client.finishLogin({
        clientLoginState, loginResponse: start.body.loginResponse, password: REAL_PASSWORD,
    });
    const res = await dispatch({
        method: 'POST', url: '/login/finish',
        body: { loginId: start.body.loginId, finishLoginRequest: finished ? finished.finishLoginRequest : 'x' },
    });
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.body.error, 'Invalid credentials');
    assert.deepStrictEqual(fx.failures, ['no_such_person'], 'counted against the submitted identifier');
});

test('a wrong password on a real account fails identically', async () => {
    fx.failures.length = 0;
    const { clientLoginState, startLoginRequest } = startLoginRequestFor('wrong-password');
    const start = await dispatch({ method: 'POST', url: '/login/start', body: { username: 'opaque_user', startLoginRequest } });
    const finished = opaque.client.finishLogin({
        clientLoginState, loginResponse: start.body.loginResponse, password: 'wrong-password',
    });
    const res = await dispatch({
        method: 'POST', url: '/login/finish',
        body: { loginId: start.body.loginId, finishLoginRequest: finished ? finished.finishLoginRequest : 'x' },
    });
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.body.error, 'Invalid credentials');
    assert.deepStrictEqual(fx.failures, ['opaque_user']);
});

test('the real password still logs in, and clears the failure counter', async () => {
    fx.successes.length = 0;
    const { clientLoginState, startLoginRequest } = startLoginRequestFor(REAL_PASSWORD);
    const start = await dispatch({ method: 'POST', url: '/login/start', body: { username: 'opaque_user', startLoginRequest } });
    const finished = opaque.client.finishLogin({
        clientLoginState, loginResponse: start.body.loginResponse, password: REAL_PASSWORD,
    });
    assert.ok(finished, 'the genuine password must complete the handshake');
    const res = await dispatch({
        method: 'POST', url: '/login/finish',
        body: { loginId: start.body.loginId, finishLoginRequest: finished.finishLoginRequest },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.user.id, 'opaque_user');
    assert.deepStrictEqual(fx.successes, ['opaque_user']);
});

test('the real account still receives its own wrapped DEK', async () => {
    const { startLoginRequest } = startLoginRequestFor(REAL_PASSWORD);
    const start = await dispatch({ method: 'POST', url: '/login/start', body: { username: 'opaque_user', startLoginRequest } });
    assert.strictEqual(start.body.wrappedDEK.data, 'cc'.repeat(32), 'the genuine blob, not a fake');
});

test('an account whose envelope the store already parsed still receives its DEK', async () => {
    // Regression: the handler did JSON.parse() on a value userStore had ALREADY
    // parsed, which throws into a bare catch and leaves the field null. Two
    // consequences, both live: the client never unwraps its DEK (encrypted
    // conversations unreadable), and `wrappedDEK: null` for a real OPAQUE
    // account next to a well-formed fake blob for an absent one is exactly the
    // enumeration oracle the rest of this file exists to close.
    const { startLoginRequest } = startLoginRequestFor(REAL_PASSWORD);
    const start = await dispatch({ method: 'POST', url: '/login/start', body: { username: 'opaque_parsed', startLoginRequest } });
    assert.deepStrictEqual(start.body.wrappedDEK, { iv: '11'.repeat(12), authTag: '22'.repeat(16), data: '33'.repeat(32) });
    assert.deepStrictEqual(start.body.recoveryWrappedDEK, { iv: '44'.repeat(12), authTag: '55'.repeat(16), data: '66'.repeat(32) });
});

test('a parsed-envelope account is indistinguishable from an absent one at login/start', async () => {
    const probe = async (username) => {
        const { startLoginRequest } = startLoginRequestFor('some-guess');
        return dispatch({ method: 'POST', url: '/login/start', body: { username, startLoginRequest } });
    };
    const absent = await probe('no_such_person_2');
    const real = await probe('opaque_parsed');
    const shape = (v) => (v === null ? 'null' : Object.keys(v).sort().join('+'));
    assert.strictEqual(shape(real.body.wrappedDEK), shape(absent.body.wrappedDEK),
        'a real OPAQUE account must not answer null where an absent name answers a blob');
});

test('the SSO PIN login start also survives an already-parsed envelope', async () => {
    const { startLoginRequest } = startLoginRequestFor(REAL_PASSWORD);
    const res = await dispatch({
        method: 'POST', url: '/pin/login/start',
        body: { startLoginRequest },
        session: { user: { id: 'opaque_parsed' } },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.wrappedDEK, { iv: '11'.repeat(12), authTag: '22'.repeat(16), data: '33'.repeat(32) });
});

// ═══ An unreadable OPAQUE_SERVER_SETUP ═══════════════════════════════
//
// On dev and prod the configured setup could not be deserialized by the
// library, so every start route died inside the protocol (a 500 on
// registration). They now answer one 503 from the readiness gate — which
// must not become an oracle of its own: same answer for every account shape,
// decided before any lookup, and not counted as a failed login.

test('an unreadable setup answers 503 opaque_setup_invalid for every account shape, before any lookup', async () => {
    const setupCheck = require('./opaqueSetup');
    const store = MOCKS['../stores/userStore'];
    const realGetUser = store.getUser;
    const realGetUserByEmail = store.getUserByEmail;
    const lookups = [];
    store.getUser = async (id) => { lookups.push(id); return realGetUser(id); };
    store.getUserByEmail = async (email) => { lookups.push(email); return realGetUserByEmail(email); };
    const original = process.env.OPAQUE_SERVER_SETUP;
    const quiet = { error() { } };
    const probe = async (username) => {
        const { startLoginRequest } = startLoginRequestFor('some-guess');
        return dispatch({ method: 'POST', url: '/login/start', body: { username, startLoginRequest } });
    };
    fx.failures.length = 0;
    try {
        process.env.OPAQUE_SERVER_SETUP = 'A'.repeat(192);
        const status = await setupCheck.validateServerSetup({ opaqueLib: opaque, log: quiet });
        assert.strictEqual(status.valid, false);

        const expected = { error: 'OPAQUE is not available on this server', code: 'opaque_setup_invalid' };
        for (const username of ['no_such_person', 'legacy_user', 'opaque_user', 'opaque@acme.nl']) {
            const res = await probe(username);
            assert.strictEqual(res.statusCode, 503, `${username} must get the server's answer, not its own`);
            assert.deepStrictEqual(res.body, expected);
        }
        assert.deepStrictEqual(lookups, [], 'the 503 must be decided before any account lookup');
        assert.deepStrictEqual(fx.failures, [], 'a server misconfiguration is not a failed login');

        const session = { user: { id: 'opaque_user' } };
        for (const [url, body] of [
            ['/register/start', { registrationRequest: 'req' }],
            ['/pin/register/start', { registrationRequest: 'req' }],
            ['/pin/login/start', { startLoginRequest: 'req' }],
        ]) {
            const res = await dispatch({ method: 'POST', url, body, session });
            assert.strictEqual(res.statusCode, 503, `${url} must not fail inside the protocol`);
            assert.deepStrictEqual(res.body, expected);
        }
    } finally {
        store.getUser = realGetUser;
        store.getUserByEmail = realGetUserByEmail;
        if (original === undefined) delete process.env.OPAQUE_SERVER_SETUP;
        else process.env.OPAQUE_SERVER_SETUP = original;
        await setupCheck.validateServerSetup({ opaqueLib: opaque, log: quiet });
    }

    const recovered = await probe('opaque_user');
    assert.strictEqual(recovered.statusCode, 200, 'a readable setup opens the routes again');
});
