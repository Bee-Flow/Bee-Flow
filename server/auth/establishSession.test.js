/**
 * DB-free tests for establishSession (H11 — session-fixation fix).
 *
 * The fake session mimics express-session's contract: regenerate(cb) REPLACES
 * req.session with a fresh object (old keys gone), save(cb) persists. No
 * external dependencies — establishSession.js requires nothing.
 */

const test = require('node:test');
const assert = require('node:assert');

const { establishSession, suppressSessionPersistence } = require('./establishSession');

function makeReq(initial = {}, { regenErr = null, saveErr = null } = {}) {
    const calls = [];
    const req = {};
    const attach = (data) => {
        req.session = Object.assign({
            regenerate(cb) { calls.push('regenerate'); attach({}); setImmediate(() => cb(regenErr)); },
            save(cb) { calls.push('save'); setImmediate(() => cb(saveErr)); },
        }, data);
    };
    attach(initial);
    return { req, calls };
}

test('happy path: regenerate then save, canonical shape, user stored by identity', async () => {
    const { req, calls } = makeReq({ preAuthJunk: 'x' });
    const user = { id: 'u1', displayName: 'U' };
    await establishSession(req, { user, isAdmin: true });

    assert.deepStrictEqual(calls, ['regenerate', 'save']);
    assert.strictEqual(req.session.isAuthenticated, true);
    assert.strictEqual(req.session.user, user, 'user stored by identity — no cloning/normalizing');
    assert.strictEqual(req.session.isAdmin, true);
    assert.strictEqual('preAuthJunk' in req.session, false, 'non-preserved pre-auth keys wiped');
});

test('fixation wipe + whitelist: preserved keys survive, attacker keys do not', async () => {
    const { req } = makeReq({ oauthPopup: true, oauthPickupId: 'p1', attackerKey: 'evil' });
    await establishSession(req, {
        user: { id: 'u1' },
        preserve: ['oauthPopup', 'oauthPickupId'],
    });
    assert.strictEqual(req.session.oauthPopup, true);
    assert.strictEqual(req.session.oauthPickupId, 'p1');
    assert.strictEqual('attackerKey' in req.session, false);
});

test('undefined preserve keys are not created on the new session', async () => {
    const { req } = makeReq({});
    await establishSession(req, { user: { id: 'u1' }, preserve: ['nextcloudUid'] });
    assert.strictEqual('nextcloudUid' in req.session, false);
});

test('canonical shape wins over preserved keys', async () => {
    const { req } = makeReq({ isAuthenticated: 'stale', isAdmin: 'stale', user: { id: 'old' } });
    const user = { id: 'new' };
    await establishSession(req, {
        user,
        isAdmin: false,
        preserve: ['isAuthenticated', 'isAdmin', 'user'],
    });
    assert.strictEqual(req.session.isAuthenticated, true);
    assert.strictEqual(req.session.isAdmin, false);
    assert.strictEqual(req.session.user, user);
});

test('extra written verbatim, including explicit null', async () => {
    const { req } = makeReq({});
    await establishSession(req, {
        user: { id: 'u1' },
        extra: { encryptionKey: null, opaqueMode: true, pendingApproval: true },
    });
    assert.ok(Object.prototype.hasOwnProperty.call(req.session, 'encryptionKey'));
    assert.strictEqual(req.session.encryptionKey, null);
    assert.strictEqual(req.session.opaqueMode, true);
    assert.strictEqual(req.session.pendingApproval, true);
});

test('regenerate error rejects before save', async () => {
    const boom = new Error('store down');
    const { req, calls } = makeReq({}, { regenErr: boom });
    await assert.rejects(establishSession(req, { user: { id: 'u1' } }), boom);
    assert.deepStrictEqual(calls, ['regenerate']);
});

test('save error rejects; canonical shape still present in memory', async () => {
    const boom = new Error('save failed');
    const { req, calls } = makeReq({}, { saveErr: boom });
    await assert.rejects(establishSession(req, { user: { id: 'u1' } }), boom);
    assert.deepStrictEqual(calls, ['regenerate', 'save']);
    assert.strictEqual(req.session.isAuthenticated, true);
});

test('guard: missing session or regenerate/save rejects with the guard message', async () => {
    await assert.rejects(
        establishSession({ session: null }, { user: { id: 'u1' } }),
        /establishSession requires req\.session with regenerate\(\)\/save\(\)/,
    );
    await assert.rejects(
        establishSession({ session: { save() {} } }, { user: { id: 'u1' } }),
        /requires req\.session/,
    );
    await assert.rejects(
        establishSession({ session: { regenerate() {} } }, { user: { id: 'u1' } }),
        /requires req\.session/,
    );
});

test('isAdmin defaults to false; preserve/extra default empty', async () => {
    const { req } = makeReq({ leftover: 1 });
    await establishSession(req, { user: { id: 'u1' } });
    assert.strictEqual(req.session.isAdmin, false);
    assert.strictEqual('leftover' in req.session, false);
});

test('suppressSessionPersistence: the response never sets the session cookie, other cookies pass', () => {
    const headers = {};
    const res = { setHeader(name, value) { headers[name.toLowerCase()] = value; return this; } };
    const req = { session: {}, res };
    suppressSessionPersistence(req);

    // What express-session does at response time for a new, written session.
    res.setHeader('Set-Cookie', ['connect.sid=s%3Aabc.sig; Path=/; HttpOnly; SameSite=Lax']);
    assert.strictEqual(headers['set-cookie'], undefined, 'a header-authenticated response must not overwrite the browser session');

    res.setHeader('Set-Cookie', ['other=1; Path=/', 'connect.sid=s%3Axyz.sig; Path=/']);
    assert.deepStrictEqual(headers['set-cookie'], ['other=1; Path=/']);

    res.setHeader('Content-Type', 'application/json');
    assert.strictEqual(headers['content-type'], 'application/json');
});
