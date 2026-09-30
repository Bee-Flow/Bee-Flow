/**
 * Voiceprint route authorization.
 *
 * A voiceprint is GDPR Art. 9 biometric data, so the guarantees here are not
 * "nice defaults" — they are the lawful-basis of the feature:
 *
 *   1. Only the owner can create one. This is enforced by SHAPE: no route
 *      accepts a target user id for a write. A route-table assertion below
 *      fails the build if anyone ever adds one.
 *   2. Nobody, at any privilege level, can read a template through the API.
 *   3. Enrollment is refused without explicit consent, and refused entirely
 *      unless pyannoteAI is the active transcription provider.
 *
 * Drives the REAL Express router with require-cache-stubbed collaborators and a
 * stubbed req/res dispatch harness — no DB, no network. The multipart tests at
 * the end use a real listener on 127.0.0.1, because multer needs a request
 * stream.
 *
 * The enrollment limiter is real and allows 8 attempts per user per hour, so
 * tests that post to /me beyond the first few use a user of their own.
 *
 * Run: cd server && node --test routes/voiceprints.authz.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const fx = {
    users: {},
    available: { available: true, reason: null, provider: 'pyannote' },
    orgAdmin: false,
    stored: null,
    deleted: [],
    enrolled: [],
    consentRows: [],
    createResult: { voiceprint: 'VEVNUExBVEU=', jobId: 'j1', durationSeconds: 25, model: 'precision-3' },
    createError: null,
};

stub('../stores/userStore', {
    getUser: async (id) => fx.users[id] || null,
    recordConsentAcceptance: async (row) => { fx.consentRows.push(row); },
    getOptionalConsents: async () => ({}),
    setOptionalConsents: async () => {},
    logAccessAudit: async () => {},
});

stub('../stores/voiceprintStore', {
    DEFAULT_PROVIDER: 'pyannote',
    getVoiceprintForUser: async () => fx.stored,
    markPending: async () => fx.stored,
    markFailed: async () => {},
    upsertVoiceprint: async (args) => { fx.enrolled.push(args); return { ...fx.stored, status: 'ready' }; },
    listOrgVoiceprintMeta: async () => [{ id: 'vp_1', userId: 'u1', displayName: 'Tom Smit', createdAt: 'x', lastMatchedAt: null }],
    countOrgCoverage: async () => ({ enrolled: 1, members: 4 }),
    deleteVoiceprintForUser: async (userId) => { fx.deleted.push(userId); return true; },
});

stub('../core/voice/voiceprintClient', {
    LIMITS: { minSeconds: 12, targetSeconds: 25, maxSeconds: 28 },
    isVoiceprintAvailable: async () => fx.available,
    createVoiceprint: async () => { if (fx.createError) throw fx.createError; return fx.createResult; },
    mapEnrollError: (err) => ({ code: err.code || 'enroll_failed', status: 400 }),
    displayNameFor: (r) => r.displayName,
});

stub('../auth/permissions', {
    requireAuth: (req, res, next) => next(),
    isOrgAdminForOrg: async () => fx.orgAdmin,
    resolveUserOrgIds: async () => new Set(['org-1']),
});
stub('../auth/consentGuards', { auditClientIp: () => '203.0.113.9' });

const router = require('./voiceprints');
// A schema refusal travels as an error to the terminal handler, so the
// harness answers one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ method = 'GET', url, user = 'u1', body, file }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, query: {}, headers: {}, ip: '203.0.113.9',
            session: user ? { isAuthenticated: true, user: { id: user } } : null,
            body: body || {},
            file,
            originalUrl: url,
            get(name) { return this.headers[String(name).toLowerCase()]; },
        };
        const res = {
            statusCode: 200, headers: {}, body: undefined,
            set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
            setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through router: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => {
    fx.users = { u1: { id: 'u1', email: 'u1@x.nl', organizationId: 'org-1' }, u2: { id: 'u2', email: 'u2@x.nl', organizationId: 'org-1' } };
    fx.available = { available: true, reason: null, provider: 'pyannote' };
    fx.orgAdmin = false;
    fx.stored = { id: 'vp_1', userId: 'u1', status: 'ready', createdAt: 'x' };
    fx.deleted.length = 0;
    fx.enrolled.length = 0;
    fx.consentRows.length = 0;
    fx.createError = null;
});

// ═══ 1. Only the owner can ever create a voiceprint ══════════════════

test('NO ROUTE ACCEPTS A TARGET USER ID FOR A WRITE', () => {
    // The structural guarantee behind the Art. 9(2)(a) consent basis. If this
    // fails, someone added a route that can enrol on another person's behalf —
    // that must never exist, whatever the caller's privilege.
    const writes = router.stack
        .filter(l => l.route && (l.route.methods.post || l.route.methods.put || l.route.methods.patch))
        .map(l => l.route.path);
    for (const p of writes) {
        assert.ok(!/:userId|:user|:id/.test(p), `write route "${p}" takes a user parameter`);
    }
    assert.deepStrictEqual(writes, ['/me'], 'the only write surface is the caller\'s own profile');
});

test('a body-supplied user id is refused outright, and nothing is enrolled', async () => {
    // It used to be ignored (the SESSION user was enrolled); the strict
    // schema now says so instead of leaving the caller to guess.
    const res = await dispatch({
        method: 'POST', url: '/me', user: 'u1',
        body: { consent: 'true', userId: 'u2', user_id: 'u2' },  // attacker-supplied
        file: { buffer: Buffer.from('audio'), originalname: 'r.webm' },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /userId|user_id/);
    assert.strictEqual(fx.enrolled.length, 0, 'the body must not be able to redirect the enrollment');
});

test('enrollment always writes to the SESSION user', async () => {
    const res = await dispatch({
        method: 'POST', url: '/me', user: 'u1',
        body: { consent: 'true' },
        file: { buffer: Buffer.from('audio'), originalname: 'r.webm' },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fx.enrolled[0].userId, 'u1');
});

test('deletion always targets the SESSION user, and a body naming another is refused', async () => {
    const refused = await dispatch({ method: 'DELETE', url: '/me', user: 'u1', body: { userId: 'u2' } });
    assert.strictEqual(refused.statusCode, 400);
    assert.deepStrictEqual(fx.deleted, []);

    await dispatch({ method: 'DELETE', url: '/me', user: 'u1' });
    assert.deepStrictEqual(fx.deleted, ['u1']);
});

// ═══ 2. Consent + availability gates ════════════════════════════════

test('enrollment without explicit consent is refused', async () => {
    const res = await dispatch({
        method: 'POST', url: '/me',
        body: {},   // no consent
        file: { buffer: Buffer.from('audio'), originalname: 'r.webm' },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'consent_required');
    assert.strictEqual(fx.enrolled.length, 0, 'nothing stored');
});

test('enrollment is refused when pyannoteAI is not the active provider', async () => {
    fx.available = { available: false, reason: 'provider_not_pyannote', provider: 'voxtral' };
    const res = await dispatch({
        method: 'POST', url: '/me',
        body: { consent: 'true' },
        file: { buffer: Buffer.from('audio'), originalname: 'r.webm' },
    });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'provider_not_pyannote');
    assert.strictEqual(fx.enrolled.length, 0);
});

test('a successful enrollment records consent in the ledger', async () => {
    await dispatch({
        method: 'POST', url: '/me',
        body: { consent: 'true' },
        file: { buffer: Buffer.from('audio'), originalname: 'r.webm' },
    });
    assert.strictEqual(fx.consentRows.length, 1);
    assert.strictEqual(fx.consentRows[0].docId, 'voiceprint_biometric');
    assert.strictEqual(fx.consentRows[0].method, 'consent_grant');
});

test('deleting a voiceprint also records the consent withdrawal', async () => {
    await dispatch({ method: 'DELETE', url: '/me' });
    assert.strictEqual(fx.consentRows.at(-1).method, 'consent_withdraw');
});

test('availability hides everything when the feature is unusable', async () => {
    fx.available = { available: false, reason: 'no_organization', provider: 'pyannote' };
    const res = await dispatch({ url: '/availability' });
    assert.strictEqual(res.body.available, false);
    assert.strictEqual(res.body.voiceprint, null, 'no status is leaked when the section will not render');
});

// ═══ 3. Org admins may revoke, never read or create ══════════════════

test('a plain member cannot revoke a colleague\'s voiceprint', async () => {
    fx.orgAdmin = false;
    const res = await dispatch({ method: 'DELETE', url: '/org/org-1/user/u2' });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(fx.deleted.length, 0);
});

test('an org admin can revoke (offboarding / erasure request)', async () => {
    fx.orgAdmin = true;
    const res = await dispatch({ method: 'DELETE', url: '/org/org-1/user/u2' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.deleted, ['u2']);
});

test('an org admin cannot revoke someone outside the organisation', async () => {
    fx.orgAdmin = true;
    fx.users.outsider = { id: 'outsider', organizationId: 'org-2' };
    const res = await dispatch({ method: 'DELETE', url: '/org/org-1/user/outsider' });
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(fx.deleted.length, 0);
});

test('a plain member sees coverage counts but not who enrolled', async () => {
    fx.orgAdmin = false;
    const res = await dispatch({ url: '/org/org-1/coverage' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.enrolled, 1);
    assert.strictEqual(res.body.enrolledUsers, null);
});

test('an org admin sees the enrolled roster — names and dates only', async () => {
    fx.orgAdmin = true;
    const res = await dispatch({ url: '/org/org-1/coverage' });
    assert.strictEqual(res.body.enrolledUsers.length, 1);
    assert.deepStrictEqual(Object.keys(res.body.enrolledUsers[0]).sort(), ['createdAt', 'lastMatchedAt', 'name', 'userId']);
});

// ═══ 4. The template never leaves the server ════════════════════════

test('NO endpoint ever returns a voiceprint template', async () => {
    fx.orgAdmin = true;
    fx.stored = { id: 'vp_1', userId: 'u1', status: 'ready', createdAt: 'x' };
    const responses = await Promise.all([
        dispatch({ url: '/availability' }),
        dispatch({ url: '/me' }),
        dispatch({ url: '/org/org-1/coverage' }),
        dispatch({
            method: 'POST', url: '/me', body: { consent: 'true' },
            file: { buffer: Buffer.from('audio'), originalname: 'r.webm' },
        }),
    ]);
    for (const res of responses) {
        const json = JSON.stringify(res.body || {});
        assert.ok(!json.includes('VEVNUExBVEU='), 'a template leaked into a response');
        assert.ok(!json.includes('voiceprint_enc'), 'the encrypted column leaked into a response');
    }
});

// ═══ 5. The enrollment form's fields ════════════════════════════════

test('the modal\'s own fields are accepted, and the language is kept whole', async () => {
    fx.users.u3 = { id: 'u3', email: 'u3@x.nl', organizationId: 'org-1' };
    const res = await dispatch({
        method: 'POST', url: '/me', user: 'u3',
        body: { consent: 'true', language: 'zh-Hant-TW', duration_seconds: '24' },
        file: { buffer: Buffer.from('audio'), originalname: 'r.webm' },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fx.enrolled[0].language, 'zh-Hant-TW', 'it was cut to "zh-Hant-"');
});

test('a misspelled language field is refused, not dropped', async () => {
    fx.users.u4 = { id: 'u4', email: 'u4@x.nl', organizationId: 'org-1' };
    const res = await dispatch({
        method: 'POST', url: '/me', user: 'u4',
        body: { consent: 'true', languge: 'en' },
        file: { buffer: Buffer.from('audio'), originalname: 'r.webm' },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /languge/);
    assert.strictEqual(fx.enrolled.length, 0);
});

// ═══ 6. A refused upload is a refusal, not a 500 ═══════════════════

const http = require('node:http');
const express = require('express');

async function withServer(userId, fn) {
    fx.users[userId] = { id: userId, email: `${userId}@x.nl`, organizationId: 'org-1' };
    const app = express();
    app.use((req, _res, next) => { req.session = { isAuthenticated: true, user: { id: userId } }; next(); });
    app.use('/api/voiceprints', router);
    app.use(terminalErrorHandler);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        return await fn(`http://127.0.0.1:${server.address().port}/api/voiceprints`);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

test('a file of the wrong type is a 400 with a code, not a 500', async () => {
    await withServer('u5', async (base) => {
        const fd = new FormData();
        fd.append('consent', 'true');
        fd.append('audio', new Blob(['hello'], { type: 'text/plain' }), 'notes.txt');
        const r = await fetch(`${base}/me`, { method: 'POST', body: fd });
        assert.strictEqual(r.status, 400);
        assert.strictEqual((await r.json()).code, 'bad_upload');
    });
    assert.strictEqual(fx.enrolled.length, 0);
});

test('a recording over the limit is a 413 with a code, not a 500', async () => {
    await withServer('u6', async (base) => {
        const fd = new FormData();
        fd.append('consent', 'true');
        fd.append('audio', new Blob([Buffer.alloc(15 * 1024 * 1024 + 1)], { type: 'audio/webm' }), 'r.webm');
        const r = await fetch(`${base}/me`, { method: 'POST', body: fd });
        assert.strictEqual(r.status, 413);
        assert.strictEqual((await r.json()).code, 'recording_too_large');
    });
    assert.strictEqual(fx.enrolled.length, 0);
});

test('a real multipart enrollment with the modal\'s fields goes through', async () => {
    await withServer('u7', async (base) => {
        const fd = new FormData();
        fd.append('audio', new Blob(['audio'], { type: 'audio/webm' }), 'recording.webm');
        fd.append('consent', 'true');
        fd.append('language', 'nl');
        fd.append('duration_seconds', '25');
        const r = await fetch(`${base}/me`, { method: 'POST', body: fd });
        assert.strictEqual(r.status, 200);
    });
    assert.strictEqual(fx.enrolled[0].userId, 'u7');
    assert.strictEqual(fx.enrolled[0].language, 'nl');
});
