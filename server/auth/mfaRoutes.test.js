/**
 * BFSF-274 — route tests for /auth/mfa/* hardening.
 *
 * Pins: idempotent /setup (same secret within TTL, force/TTL mint fresh,
 * serverTime for drift diagnostics), /enable reading both session shapes,
 * /recovery-codes/regenerate accepting recovery codes (was TOTP-only),
 * distinct mfa_secret_unreadable error, and the /assist endpoint's secret
 * redaction (the AI must never see on-screen MFA material).
 *
 * Deps of mfaRoutes.js are stubbed via the Module resolve hook (same harness
 * as routes/agents/crud.authz.test.js). ./mfa is stubbed with controllable
 * verdicts — the real crypto is covered by auth/mfa.test.js.
 *
 * Run: cd server && node --test auth/mfaRoutes.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── Mutable fixtures ─────────────────────────────────────────────────
const fx = {
    user: { mfa_enabled: true, mfa_secret: 'sealed', mfa_recovery_codes: '[]', passwordHash: 'h' },
    decrypted: 'PLAINSECRET',   // mfa.decryptSecret result (null = unreadable)
    totpOk: false,              // mfa.verifyTotp verdict
    recoveryOk: false,          // mfa.consumeRecoveryCode verdict
    updates: [],                // userStore.updateUser spy
    securityKeys: [],           // userStore.listSecurityKeys result
    keysRemovedFor: [],         // userStore.deleteAllSecurityKeys spy
    secretCounter: 0,
    aiCalls: [],                // recorded aiAgent conversations
    aiAnswer: 'Install Google Authenticator or 1Password.',
};

const mw = (req, res, next) => next();

const MOCKS = {
    '../stores/userStore': {
        getUser: async () => fx.user,
        updateUser: async (id, updates) => { fx.updates.push({ id, updates }); return true; },
        createUser: async () => {},
        listSecurityKeys: async () => fx.securityKeys,
        deleteAllSecurityKeys: async (id) => { fx.keysRemovedFor.push(id); return fx.securityKeys.length; },
    },
    './permissions': { requireAuth: mw, loadConfig: async () => ({ admin: { passwordHash: 'x', username: 'admin' } }) },
    './mfa': {
        generateSecret: () => `SECRET${++fx.secretCounter}`,
        otpauthUrl: (secret) => `otpauth://totp/x?secret=${secret}`,
        qrDataUrl: async () => 'data:image/png;base64,QR',
        verifyTotp: (secret, _code) => !!secret && fx.totpOk,
        decryptSecret: () => fx.decrypted,
        encryptSecret: (v) => `enc:${v}`,
        consumeRecoveryCode: async () => (fx.recoveryOk ? [{ hash: 'h', usedAt: 'now' }] : null),
        generateRecoveryCodes: async () => ({ plain: ['aaaa-bbbb'], stored: [{ hash: 'h', usedAt: null }] }),
        remainingRecoveryCodes: () => 5,
    },
    '../utils/perUserRateLimit': { perUserRateLimit: () => mw },
    // Lazy requires inside POST /assist. llmClient.chat is the TOOL-LESS
    // seam — the assist endpoint must never go through aiAgent._chatLoop
    // (which always attaches component SYSTEM_TOOLS).
    '../core/aiAgent': {
        getAIConfig: async () => ({ model: 'test-model' }),
    },
    '../core/llm/llmClient': {
        chat: async (modelId, messages, options) => {
            fx.aiCalls.push({
                modelId,
                history: messages.filter(m => m.role !== 'system'),
                context: { systemPrompt: messages.find(m => m.role === 'system')?.content || '' },
                options,
            });
            return { content: fx.aiAnswer };
        },
    },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:mfaroutes:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /auth[\\/]mfaRoutes\.js$/.test(parent.filename) && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./mfaRoutes');

test.after(() => { Module._resolveFilename = originalResolve; });

function resetFx() {
    fx.user = { mfa_enabled: true, mfa_secret: 'sealed', mfa_recovery_codes: '[]', passwordHash: 'h' };
    fx.decrypted = 'PLAINSECRET';
    fx.totpOk = false;
    fx.recoveryOk = false;
    fx.updates.length = 0;
    fx.aiCalls.length = 0;
    fx.securityKeys = [];
    fx.keysRemovedFor.length = 0;
}

function makeSession() {
    return {
        user: { id: 'u1', displayName: 'User One' },
        save(cb) { if (cb) cb(); },
    };
}

function dispatch({ method = 'POST', url, body = {}, session }) {
    return new Promise((resolve, reject) => {
        const request = {
            method,
            url,
            body,
            headers: {},
            session,
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

// ═══ /setup idempotence ═════════════════════════════════════════════

test('/setup returns the SAME secret within the TTL (remount-safe) + serverTime', async () => {
    resetFx();
    const session = makeSession();
    const r1 = await dispatch({ url: '/setup', session });
    const r2 = await dispatch({ url: '/setup', session });
    assert.strictEqual(r1.statusCode, 200);
    assert.strictEqual(r1.body.secret, r2.body.secret, 'second call reuses the pending secret');
    assert.ok(typeof r1.body.serverTime === 'number', 'serverTime exposed for drift diagnostics');
});

test('/setup with force:true mints a fresh secret; expired TTL also re-mints', async () => {
    resetFx();
    const session = makeSession();
    const r1 = await dispatch({ url: '/setup', session });
    const r2 = await dispatch({ url: '/setup', body: { force: true }, session });
    assert.notStrictEqual(r1.body.secret, r2.body.secret, 'force mints fresh');

    session.mfaSetupSecret = { secret: r2.body.secret, mintedAt: Date.now() - 11 * 60_000 };
    const r3 = await dispatch({ url: '/setup', session });
    assert.notStrictEqual(r3.body.secret, r2.body.secret, 'stale (>10 min) secret re-mints');
});

test('/enable reads both the new {secret,mintedAt} shape and the legacy string shape', async () => {
    resetFx();
    fx.totpOk = true;
    fx.user = { ...fx.user, mfa_enabled: false };

    const s1 = makeSession();
    s1.mfaSetupSecret = { secret: 'NEWSHAPE', mintedAt: Date.now() };
    const r1 = await dispatch({ url: '/enable', body: { code: '123456' }, session: s1 });
    assert.strictEqual(r1.statusCode, 200);
    assert.ok(Array.isArray(r1.body.recoveryCodes), 'recovery codes issued');

    const s2 = makeSession();
    s2.mfaSetupSecret = 'LEGACYSTRING'; // pre-deploy in-flight session
    const r2 = await dispatch({ url: '/enable', body: { code: '123456' }, session: s2 });
    assert.strictEqual(r2.statusCode, 200, 'legacy string shape still enables');
});

// ═══ regenerate: recovery-code fallback + unreadable secret ═════════

test('/recovery-codes/regenerate accepts a recovery code (was TOTP-only)', async () => {
    resetFx();
    fx.totpOk = false;
    fx.recoveryOk = true;
    const res = await dispatch({ url: '/recovery-codes/regenerate', body: { code: 'aaaa-bbbb' }, session: makeSession() });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.recoveryCodes, ['aaaa-bbbb']);
    assert.ok(fx.updates.some(u => u.updates.mfaRecoveryCodes), 'new set persisted');
});

test('/recovery-codes/regenerate still works with a TOTP code, rejects garbage with invalid_code', async () => {
    resetFx();
    fx.totpOk = true;
    let res = await dispatch({ url: '/recovery-codes/regenerate', body: { code: '123456' }, session: makeSession() });
    assert.strictEqual(res.statusCode, 200);

    resetFx();
    res = await dispatch({ url: '/recovery-codes/regenerate', body: { code: '000000' }, session: makeSession() });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'invalid_code');
});

test('undecryptable secret surfaces mfa_secret_unreadable, not a generic invalid code', async () => {
    resetFx();
    fx.decrypted = null; // key rotation bricked the stored secret
    const res = await dispatch({ url: '/recovery-codes/regenerate', body: { code: '123456' }, session: makeSession() });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'mfa_secret_unreadable');

    // A recovery code STILL works even with an unreadable TOTP secret.
    resetFx();
    fx.decrypted = null;
    fx.recoveryOk = true;
    const ok = await dispatch({ url: '/recovery-codes/regenerate', body: { code: 'aaaa-bbbb' }, session: makeSession() });
    assert.strictEqual(ok.statusCode, 200, 'recovery path unaffected by unreadable secret');
});

test('/disable accepts a recovery code and reports unreadable secrets distinctly', async () => {
    resetFx();
    fx.recoveryOk = true;
    let res = await dispatch({ url: '/disable', body: { code: 'aaaa-bbbb' }, session: makeSession() });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(fx.updates.some(u => u.updates.mfaEnabled === false), 'MFA cleared');
    assert.deepStrictEqual(fx.keysRemovedFor, ['u1'], 'turning 2FA off removes the security keys with it');

    resetFx();
    fx.decrypted = null;
    res = await dispatch({ url: '/disable', body: { code: '123456' }, session: makeSession() });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'mfa_secret_unreadable');
});

test('/disable with a wrong code removes nothing, security keys included', async () => {
    resetFx();
    fx.securityKeys = [{ id: 'k1' }];
    const res = await dispatch({ url: '/disable', body: { code: '000000' }, session: makeSession() });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(fx.keysRemovedFor, []);
});

test('/status names the factors: app, keys, and where the keys work', async () => {
    resetFx();
    fx.securityKeys = [{ id: 'k1', rpId: 'beeflow.nl' }, { id: 'k2', rpId: 'beeflow.nl' }];
    let res = await dispatch({ method: 'GET', url: '/status', session: makeSession() });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.securityKeys, 2);
    assert.strictEqual(res.body.totpEnabled, true);
    assert.deepStrictEqual(res.body.securityKeyRpIds, ['beeflow.nl']);

    fx.user.mfa_secret = null; // security keys only
    res = await dispatch({ method: 'GET', url: '/status', session: makeSession() });
    assert.strictEqual(res.body.enabled, true);
    assert.strictEqual(res.body.totpEnabled, false);
});

// ═══ Accounts that sign in with security keys only ══════════════════

test('/enable while 2FA is already on needs proof of an existing factor', async () => {
    resetFx();
    fx.totpOk = true;
    const session = makeSession();
    session.mfaSetupSecret = { secret: 'NEWSECRET', mintedAt: Date.now() };
    let res = await dispatch({ url: '/enable', body: { code: '123456' }, session });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'proof_required');
    assert.ok(!fx.updates.some(u => u.updates.mfaSecret), 'no authenticator was stored without proof');

    res = await dispatch({ url: '/enable', body: { code: '123456', proof: { code: '654321' } }, session });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(fx.updates.some(u => u.updates.mfaSecret === 'enc:NEWSECRET'));
});

test('/enable on an account without 2FA needs no proof: the forced first setup', async () => {
    resetFx();
    fx.user = { mfa_enabled: false, mfa_secret: null, mfa_recovery_codes: null };
    fx.totpOk = true;
    const session = makeSession();
    session.mfaSetupSecret = { secret: 'FIRST', mintedAt: Date.now() };
    const res = await dispatch({ url: '/enable', body: { code: '123456' }, session });
    assert.strictEqual(res.statusCode, 200);
});

test('a key-only account that types a wrong code hears "invalid", not "unreadable"', async () => {
    resetFx();
    fx.user.mfa_secret = null;
    fx.decrypted = null;
    const res = await dispatch({ url: '/disable', body: { code: 'zzzz-zzzz' }, session: makeSession() });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'invalid_code');
});

test('/disable without any proof is refused in words', async () => {
    resetFx();
    // This harness has no error handler: a validation refusal arrives as the
    // HttpError the terminal handler would have turned into a 400.
    await assert.rejects(
        dispatch({ url: '/disable', body: {}, session: makeSession() }),
        (err) => err.status === 400 && err.code === 'invalid_request',
    );
    assert.deepStrictEqual(fx.keysRemovedFor, []);
});

// ═══ /assist: the AI never sees MFA material ════════════════════════

test('/assist answers questions and redacts secret-shaped input before the model', async () => {
    resetFx();
    const res = await dispatch({
        url: '/assist',
        body: {
            question: 'My key JBSWY3DPEHPK3PXPJBSWY3DP is rejected, otpauth://totp/x?secret=ABC — which app do I need?',
            history: [{ role: 'assistant', content: 'Hi!' }],
        },
        session: makeSession(),
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.answer, fx.aiAnswer);
    assert.strictEqual(fx.aiCalls.length, 1);
    const sent = JSON.stringify(fx.aiCalls[0].history);
    assert.ok(!sent.includes('JBSWY3DPEHPK3PXP'), 'base32 setup key never reaches the model');
    assert.ok(!sent.includes('otpauth://'), 'otpauth URI never reaches the model');
    assert.ok(sent.includes('[redacted]'), 'redaction marker present');
    assert.ok(sent.includes('which app do I need?'), 'the actual question survives');
    // The system prompt forbids asking for secrets.
    assert.ok(/NEVER ask the user to share/i.test(fx.aiCalls[0].context.systemPrompt));
});

test('/assist requires a question and fails soft when the model is unavailable', async () => {
    resetFx();
    let res = await dispatch({ url: '/assist', body: { question: '   ' }, session: makeSession() });
    assert.strictEqual(res.statusCode, 400);

    resetFx();
    fx.aiAnswer = null; // model returned nothing
    res = await dispatch({ url: '/assist', body: { question: 'help' }, session: makeSession() });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.code, 'assist_unavailable');
});
