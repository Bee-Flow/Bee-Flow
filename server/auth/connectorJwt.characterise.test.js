'use strict';
/**
 * Characterisation of connectorJwtMiddleware: pins EVERY exit path of the
 * middleware (what is sent, whether and how next() is called, what lands on
 * req) so a structural split cannot change authentication behaviour.
 *
 * Invariants asserted for every run (see `run`):
 *   - exactly one terminal action: either a response (res.status().json()) or
 *     next() (with or without an error), never both, never next() twice;
 *   - a success calls next() once with NO arguments.
 *
 * Quirks pinned on purpose (they are today's behaviour, not endorsements):
 *   - everything inside the try block, including a synchronous throw from
 *     next() itself, ends in 401 'Invalid connector token';
 *   - the session pre-checks sit OUTSIDE the try block, so a throw there
 *     rejects the returned promise (Express 5 forwards it).
 *
 * Run: cd server && node --test auth/connectorJwt.characterise.test.js
 */
process.env.NODE_ENV = 'test';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const configStore = require('../stores/configStore');
const userStore = require('../stores/userStore');
const encryption = require('./encryption');
const orgHealth = require('../services/orgHealth');
const log = require('../telemetry/log');
const signupGuards = require('./signupGuards');
const { HttpError } = require('../shared/httpErrors');

// signupGuards is destructured at require time inside connectorJwt: route it
// through a mutable implementation BEFORE loading the middleware.
let geoImpl = async () => ({ ok: true });
signupGuards.checkConnectorSignupAllowed = (...a) => geoImpl(...a);
const connectorBootstrap = require('./connectorBootstrap');
const connectorJwtMiddleware = require('./connectorJwt');

const KEY = 'tenant-secret-characterise';
const ORG = 'org1';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const NOW = Math.floor(Date.now() / 1000);
// Every connector mint carries `exp`, so the helper adds one; a payload with
// `exp: undefined` is the "no expiry" case.
function token(payload, { key = KEY, header = { alg: 'HS256', typ: 'JWT' } } = {}) {
    const head = `${b64(header)}.${b64({ exp: NOW + 300, ...payload })}`;
    return `${head}.${crypto.createHmac('sha256', key).update(head).digest('base64url')}`;
}
const goodPayload = (extra = {}) => ({ email: 'ann@acme.example', sub: 'ann', ...extra });

let rec; // recorded side effects
let uid = 0; // unique user ids: the encryption-key cache is process-wide

function reset() {
    rec = { problems: [], events: [], liveness: [], warns: [], infos: [], calls: [] };
    connectorJwtMiddleware.invalidateTenantKeyCache();
    geoImpl = async () => ({ ok: true });
    Object.assign(configStore, {
        listKeysWithPrefix: async () => [`connector_tenant_key_${ORG}`],
        getSecret: async () => KEY,
        getSecretFresh: async () => KEY,
    });
    Object.assign(userStore, {
        getUser: async () => null,
        getUserByEmail: async () => null,
        getOrganization: async () => ({ id: ORG, nc_instance_id: 'nc1', nc_onboarding_completed_at: 1, nc_sync_mode: 'mirror_all' }),
        createUserWithSeatCheck: async () => ({ created: true }),
        updateUser: async () => ({}),
        logAccessAudit: async () => {},
    });
    Object.assign(encryption, {
        getOrCreateSSOUserDEKCompat: async () => ({ encryptionKey: 'sso-key' }),
        getFallbackEncryptionKey: () => 'fallback-key',
    });
    orgHealth.problem = (code, opts) => { rec.problems.push({ code, opts }); };
    orgHealth.event = (code, opts) => { rec.events.push({ code, opts }); };
    orgHealth.touchLiveness = (...a) => { rec.liveness.push(a); };
    log.warn = (m) => { rec.warns.push(String(m)); };
    log.info = (m) => { rec.infos.push(String(m)); };
    connectorBootstrap.helpers.ensureOrgAdminUser = async () => null;
}
beforeEach(reset);

const sessionOf = (extra = {}) => ({ regenerate: (cb) => { rec.calls.push('regenerate'); cb(); }, ...extra });

function connectorReq(payload, { headers = {}, session, tok } = {}) {
    return {
        method: 'GET', url: '/x', ip: '9.9.9.9',
        headers: {
            'x-beeflow-source': 'nextcloud-connector',
            authorization: `Bearer ${tok || token(payload)}`,
            ...headers,
        },
        session: session || sessionOf(),
    };
}

/** Run the middleware; enforce the one-terminal-action invariant. */
async function run(req, { nextThrows = false } = {}) {
    const actions = [];
    const out = { statusCode: undefined, body: undefined };
    const res = {
        status(n) { actions.push('res.status'); out.statusCode = n; return res; },
        json(b) { actions.push('res.json'); out.body = b; return res; },
        setHeader() { return res; },
    };
    req.res = res;
    const next = (...args) => {
        actions.push('next');
        out.nextArgs = args;
        if (nextThrows && actions.filter((a) => a === 'next').length === 1) throw new Error('next exploded');
    };
    let ret;
    let rejected;
    try { ret = await connectorJwtMiddleware(req, res, next); } catch (e) { rejected = e; }
    out.actions = actions;
    out.rejected = rejected;
    out.ret = ret;
    out.responded = actions.includes('res.json');
    out.nextCalls = actions.filter((a) => a === 'next').length;
    if (!rejected && !nextThrows) {
        assert.equal((out.responded ? 1 : 0) + out.nextCalls, 1, `exactly one terminal action, got ${actions}`);
        assert.ok(!(out.responded && out.nextCalls), 'never both res.* and next()');
    }
    return out;
}
function assertNextOnce(out) {
    assert.equal(out.rejected, undefined);
    assert.deepEqual(out.actions, ['next']);
    assert.deepEqual(out.nextArgs, []);
}
function assertRejected(out, status, body) {
    assert.equal(out.rejected, undefined);
    assert.deepEqual(out.actions, ['res.status', 'res.json']);
    assert.equal(out.statusCode, status);
    assert.deepEqual(out.body, body);
}
const INVALID = { error: 'Invalid connector token' };
const problemCodes = () => rec.problems.map((p) => p.code);

// ── session pre-checks (outside the try block) ───────────────────────────────

test('authed session + existing non-connector user: next() once, session untouched, no JWT work', async () => {
    let lookedUp = false;
    userStore.getUser = async (id) => ({ id, role: 'user', orgRole: 'x', organizationId: 'o', provider: 'local' });
    userStore.getUserByEmail = async () => { lookedUp = true; return null; };
    const session = sessionOf({ isAuthenticated: true, user: { id: 'u1', orgRole: 'old', role: 'user', organizationId: 'o' }, isAdmin: false });
    const out = await run({ method: 'GET', url: '/x', headers: {}, session });
    assertNextOnce(out);
    assert.equal(session.user.orgRole, 'old', 'cookie-login sessions are not re-synced');
    assert.equal(lookedUp, false);
});

test('authed session + connector user: mutable identity fields re-synced from DB, next() once', async () => {
    userStore.getUser = async () => ({ id: 'u1', provider: 'nextcloud_connector', role: 'admin', orgRole: 'org_admin', organizationId: 'o2' });
    const session = sessionOf({ isAuthenticated: true, user: { id: 'u1', orgRole: 'old', role: 'user', organizationId: 'o1' }, isAdmin: false });
    const out = await run({ method: 'GET', url: '/x', headers: {}, session });
    assertNextOnce(out);
    assert.equal(session.user.orgRole, 'org_admin');
    assert.equal(session.user.role, 'admin');
    assert.equal(session.user.organizationId, 'o2');
    assert.equal(session.isAdmin, true);
});

test('authed session + connector header (non-connector provider): also re-synced; empty DB fields default', async () => {
    userStore.getUser = async () => ({ id: 'u1', provider: 'local' });
    const session = sessionOf({ isAuthenticated: true, user: { id: 'u1', orgRole: 'x', role: 'admin', organizationId: 'o1' }, isAdmin: true });
    const out = await run({ method: 'GET', url: '/x', headers: { 'x-beeflow-source': 'nextcloud-connector' }, session });
    assertNextOnce(out);
    assert.equal(session.user.orgRole, '');
    assert.equal(session.user.role, 'user');
    assert.equal(session.user.organizationId, 'o1', 'falls back to the session org');
    assert.equal(session.isAdmin, false);
});

test('authed session without user id is ignored: falls through to the header checks', async () => {
    let called = false;
    userStore.getUser = async () => { called = true; return null; };
    const out = await run({ method: 'GET', url: '/x', headers: {}, session: sessionOf({ isAuthenticated: true, user: {} }) });
    assertNextOnce(out);
    assert.equal(called, false);
});

test('stale session (user gone) + no connector header: regenerate, log, then next() once', async () => {
    const session = sessionOf({ isAuthenticated: true, user: { id: 'gone' } });
    const out = await run({ method: 'GET', url: '/x', headers: {}, session });
    assertNextOnce(out);
    assert.deepEqual(rec.calls, ['regenerate']);
    assert.deepEqual(rec.infos, ['[ConnectorJWT] Dropping stale session for missing user gone']);
});

test('getUser throwing is treated as "user missing": stale-session path, no rejection', async () => {
    userStore.getUser = async () => { throw new Error('db down'); };
    const session = sessionOf({ isAuthenticated: true, user: { id: 'u1' } });
    const out = await run({ method: 'GET', url: '/x', headers: {}, session });
    assertNextOnce(out);
    assert.deepEqual(rec.calls, ['regenerate']);
});

test('stale session + valid connector JWT: regenerate happens first, then JWT auth succeeds', async () => {
    const id = `u${++uid}`;
    userStore.getUserByEmail = async () => ({ id, email: 'ann@acme.example', organizationId: ORG });
    const session = sessionOf({ isAuthenticated: true, user: { id: 'gone' } });
    const out = await run(connectorReq(goodPayload(), { session }));
    assertNextOnce(out);
    assert.deepEqual(rec.calls, ['regenerate']);
    assert.equal(session.user.id, id);
});

test('regenerate throwing synchronously rejects the middleware promise (outside the try): no res, no next', async () => {
    const session = { isAuthenticated: true, user: { id: 'gone' }, regenerate: () => { throw new Error('store down'); } };
    const out = await run({ method: 'GET', url: '/x', headers: {}, session });
    assert.equal(out.rejected.message, 'store down');
    assert.deepEqual(out.actions, []);
});

test('next() throwing in the session pre-check rejects the promise', async () => {
    userStore.getUser = async () => ({ id: 'u1', provider: 'local' });
    const session = sessionOf({ isAuthenticated: true, user: { id: 'u1' } });
    const out = await run({ method: 'GET', url: '/x', headers: {}, session }, { nextThrows: true });
    assert.equal(out.rejected.message, 'next exploded');
    assert.deepEqual(out.actions, ['next']);
});

// ── fall-through exits (no response, next() once with no args) ───────────────

test('no connector marker header: next() once, nothing consulted', async () => {
    let touched = false;
    configStore.listKeysWithPrefix = async () => { touched = true; return []; };
    const req = connectorReq(goodPayload(), {});
    delete req.headers['x-beeflow-source'];
    assertNextOnce(await run(req));
    assert.equal(touched, false);
});

test('wrong marker value: next() once', async () => {
    assertNextOnce(await run(connectorReq(goodPayload(), { headers: { 'x-beeflow-source': 'other' } })));
});

test('missing Authorization: next() once', async () => {
    const req = connectorReq(goodPayload());
    delete req.headers.authorization;
    assertNextOnce(await run(req));
});

test('non-Bearer Authorization: next() once', async () => {
    assertNextOnce(await run(connectorReq(goodPayload(), { headers: { authorization: 'Basic abc' } })));
});

test('"Bearer" without a space / empty token: next() once', async () => {
    assertNextOnce(await run(connectorReq(goodPayload(), { headers: { authorization: 'Bearer' } })));
    assertNextOnce(await run(connectorReq(goodPayload(), { headers: { authorization: 'Bearer    ' } })));
});

test('malformed token shape (2 segments / bad chars / 4 segments): next() once and no tenant lookup', async () => {
    let touched = false;
    configStore.listKeysWithPrefix = async () => { touched = true; return []; };
    for (const t of ['a.b', 'a.b.c.d', 'a b.c.d', 'a.b.c!', 'not-a-jwt']) {
        assertNextOnce(await run(connectorReq(goodPayload(), { headers: { authorization: `Bearer ${t}` } })));
    }
    assert.equal(touched, false);
});

test('scheme is case-insensitive and the capitalised header key is honoured', async () => {
    const id = `u${++uid}`;
    userStore.getUserByEmail = async () => ({ id, email: 'ann@acme.example', organizationId: ORG });
    const req = connectorReq(goodPayload(), { tok: 'x' });
    delete req.headers.authorization;
    req.headers.Authorization = `BEARER   ${token(goodPayload())}  `;
    const out = await run(req);
    assertNextOnce(out);
    assert.equal(req.session.user.id, id);
});

// ── rejections from token verification ───────────────────────────────────────

const NO_TENANT = { error: 'Connector token rejected: no matching tenant key' };

test('wrong signature / expired / not-yet-valid / wrong iss / wrong aud / alg none: 401 no matching tenant key, domain attributed', async () => {
    const cases = {
        wrongKey: token(goodPayload(), { key: 'other' }),
        expired: token(goodPayload({ exp: NOW - 10 })),
        nbf: token(goodPayload({ nbf: NOW + 600 })),
        iss: token(goodPayload({ iss: 'attacker' })),
        aud: token(goodPayload({ aud: 'evil.example' })),
        algNone: token(goodPayload(), { header: { alg: 'none', typ: 'JWT' } }),
        rs256: token(goodPayload(), { header: { alg: 'RS256', typ: 'JWT' } }),
    };
    for (const [name, tok] of Object.entries(cases)) {
        rec.problems.length = 0;
        const req = connectorReq(null, { tok });
        const out = await run(req);
        assertRejected(out, 401, NO_TENANT);
        assert.equal(rec.problems.length, 1, name);
        assert.equal(rec.problems[0].code, 'auth.no_matching_tenant_key', name);
        assert.equal(rec.problems[0].opts.subjectKey, 'domain:acme.example', name);
        assert.equal(rec.problems[0].opts.source, 'connectorJwt');
        assert.equal(rec.problems[0].opts.req, req);
        assert.deepEqual(rec.problems[0].opts.meta, { emailDomain: 'acme.example', unverified: true, reason: 'no_matching_tenant_key' });
        assert.equal(rec.liveness.length, 0);
    }
});

test('no tenant keys at all / token without email claim domain: subjectKey "unknown"', async () => {
    configStore.listKeysWithPrefix = async () => [];
    const out = await run(connectorReq({ sub: 'x' }));
    assertRejected(out, 401, NO_TENANT);
    assert.equal(rec.problems[0].opts.subjectKey, 'unknown');
    assert.equal(rec.problems[0].opts.meta.emailDomain, null);
});

test('tenant key only found through the fresh (cache-bypass) pass still authenticates', async () => {
    configStore.getSecret = async () => 'stale-key';
    const id = `u${++uid}`;
    userStore.getUserByEmail = async () => ({ id, email: 'ann@acme.example', organizationId: ORG });
    assertNextOnce(await run(connectorReq(goodPayload())));
});

test('missing email claim: 400, auth.missing_email, no user lookup', async () => {
    let looked = false;
    userStore.getUserByEmail = async () => { looked = true; return null; };
    const out = await run(connectorReq({ sub: 'ann', email: '' }));
    assertRejected(out, 400, { error: 'Connector token missing email claim' });
    assert.deepEqual(problemCodes(), ['auth.missing_email']);
    assert.deepEqual(rec.problems[0].opts.meta, { sub: 'ann', reason: 'jwt_missing_email_claim' });
    assert.equal(rec.problems[0].opts.orgId, ORG);
    assert.equal(looked, false);
});

// ── provisioning gates (user not found) ──────────────────────────────────────

test('unknown user, org missing: 403 Connector tenant has no organization', async () => {
    userStore.getOrganization = async () => null;
    assertRejected(await run(connectorReq(goodPayload())), 403, { error: 'Connector tenant has no organization' });
    assert.deepEqual(problemCodes(), []);
});

test('unknown user, onboarding not completed: 403 NC_ONBOARDING_PENDING', async () => {
    userStore.getOrganization = async () => ({ id: ORG, nc_instance_id: 'nc1', nc_onboarding_completed_at: null });
    const out = await run(connectorReq(goodPayload()));
    assertRejected(out, 403, {
        error: 'Setup in progress — your organization administrator is finalising the Bee Flow setup. Please refresh in a few minutes.',
        code: 'NC_ONBOARDING_PENDING',
    });
    assert.deepEqual(problemCodes(), ['auth.blocked_onboarding_pending']);
    assert.deepEqual(rec.problems[0].opts.meta, { reason: 'nc_onboarding_not_completed' });
});

test('unknown user, manual sync mode: 403 invite message', async () => {
    userStore.getOrganization = async () => ({ id: ORG, nc_sync_mode: 'manual' });
    const out = await run(connectorReq(goodPayload()));
    assertRejected(out, 403, { error: 'Your Nextcloud account is not provisioned in Bee Flow yet. Ask your Bee Flow administrator to invite you.' });
    assert.deepEqual(problemCodes(), ['auth.blocked_manual_mode']);
    assert.deepEqual(rec.problems[0].opts.meta, { reason: 'nc_sync_mode_manual' });
});

test('unknown user, geo-blocked: status/error/code come from the guard; logged + problem', async () => {
    let gotReq;
    geoImpl = async (r) => { gotReq = r; return { ok: false, status: 451, error: 'geo no', code: 'GEO', country: 'XX' }; };
    const req = connectorReq(goodPayload());
    const out = await run(req);
    assertRejected(out, 451, { error: 'geo no', code: 'GEO' });
    assert.equal(gotReq, req);
    assert.deepEqual(problemCodes(), ['auth.blocked_geo']);
    assert.deepEqual(rec.problems[0].opts.meta, { country: 'XX', reason: 'geo_policy' });
    // The address itself is not logged (privacy): a length and a hash stand in for it.
    assert.ok(rec.infos.some((m) => /Geo-blocked auto-provision for <\d+ chars, #[0-9a-f]{6}> \(org=org1, country=XX\)/.test(m)));
    assert.ok(!rec.infos.some((m) => m.includes('ann@acme.example')));
});

test('geo guard without country: meta.country null, log says unknown', async () => {
    geoImpl = async () => ({ ok: false, status: 403, error: 'e', code: 'c' });
    await run(connectorReq(goodPayload()));
    assert.equal(rec.problems[0].opts.meta.country, null);
    assert.ok(rec.infos.some((m) => m.includes('country=unknown')));
});

test('geo guard throwing: 401 Invalid connector token (inside the try)', async () => {
    geoImpl = async () => { throw new Error('geo down'); };
    assertRejected(await run(connectorReq(goodPayload())), 401, INVALID);
    assert.ok(rec.warns.includes('[ConnectorJWT] Auth failed for GET /x: geo down'));
});

test('seat cap: 403 seat_cap_exceeded + problem', async () => {
    userStore.createUserWithSeatCheck = async () => ({ created: false, reason: 'seat_cap' });
    const out = await run(connectorReq(goodPayload()));
    assertRejected(out, 403, {
        error: 'Your organization has reached its user seat limit. Ask your Bee Flow administrator to upgrade.',
        code: 'seat_cap_exceeded',
    });
    assert.deepEqual(problemCodes(), ['auth.blocked_seat_cap']);
    assert.deepEqual(rec.problems[0].opts.meta, { reason: 'seat_cap_exceeded' });
});

test('provision failure: next(HttpError 500 provision_failed), NO response, problem + warn', async () => {
    userStore.createUserWithSeatCheck = async () => ({ created: false, reason: 'db_error' });
    const out = await run(connectorReq(goodPayload()));
    assert.deepEqual(out.actions, ['next']);
    assert.equal(out.nextArgs.length, 1);
    const err = out.nextArgs[0];
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 500);
    assert.equal(err.code, 'provision_failed');
    assert.equal(err.message, 'Failed to provision user');
    assert.deepEqual(problemCodes(), ['auth.provision_failed']);
    assert.deepEqual(rec.problems[0].opts.meta, { reason: 'db_error' });
    assert.ok(rec.warns.some((m) => m.startsWith('[ConnectorJWT] auto-provision failed userId=nc_org1_ann reason=db_error')));
});

test('provision failure without reason: meta.reason "unknown"', async () => {
    userStore.createUserWithSeatCheck = async () => ({ created: false });
    await run(connectorReq(goodPayload()));
    assert.equal(rec.problems[0].opts.meta.reason, 'unknown');
});

test('createUserWithSeatCheck throwing: 401 Invalid connector token', async () => {
    userStore.createUserWithSeatCheck = async () => { throw new Error('boom'); };
    assertRejected(await run(connectorReq(goodPayload())), 401, INVALID);
});

test('auto-provision (active): created with pinned fields, session built, one next()', async () => {
    let created;
    userStore.createUserWithSeatCheck = async (u, opts) => { created = { u, opts }; return { created: true }; };
    userStore.getUser = async (id) => ({ id, email: 'ann@acme.example', displayName: 'Ann', role: 'user', orgRole: 'agent_editor', organizationId: ORG, nc_uid: 'ann', provider: 'nextcloud_connector' });
    const req = connectorReq(goodPayload({ name: 'Ann' }));
    const out = await run(req);
    assertNextOnce(out);
    assert.deepEqual(created, {
        u: {
            id: 'nc_org1_ann', username: 'ann@acme.example', email: 'ann@acme.example', displayName: 'Ann',
            role: 'user', orgRole: 'agent_editor', organizationId: ORG, ncUid: 'ann',
            provider: 'nextcloud_connector', autoProvisioned: true, status: 'active',
        },
        opts: { strict: false },
    });
    assert.deepEqual(rec.events.map((e) => e.code), ['auth.user_auto_provisioned']);
    assert.deepEqual(rec.events[0].opts.meta, { userId: 'nc_org1_ann', status: 'active' });
    assert.equal(rec.events[0].opts.actorKind, 'connector');
    assert.ok(rec.infos.includes('[ConnectorJWT] Auto-provisioned user nc_org1_ann (org=org1, status=active)'));
    assert.equal(req.session.isAuthenticated, true);
});

test('auto-provision: default org role honours a valid org override, ignores an invalid one; uid from email when no sub', async () => {
    const seen = [];
    userStore.createUserWithSeatCheck = async (u) => { seen.push(u); return { created: true }; };
    userStore.getUser = async (id) => ({ id, email: 'a@b.c', organizationId: ORG });
    userStore.getOrganization = async () => ({ id: ORG, nc_new_user_default_org_role: 'org_admin' });
    await run(connectorReq({ email: 'a@b.c' }));
    userStore.getOrganization = async () => ({ id: ORG, nc_new_user_default_org_role: 'not-a-role' });
    await run(connectorReq({ email: 'a@b.c' }));
    assert.equal(seen[0].orgRole, 'org_admin');
    assert.equal(seen[1].orgRole, 'agent_editor');
    assert.equal(seen[0].id, 'nc_org1_a-b-c');
    assert.equal(seen[0].ncUid, null);
    assert.equal(seen[0].displayName, 'a@b.c');
});

test('X-Beeflow-NC-Uid header is only used when the signed sub is absent', async () => {
    const seen = [];
    userStore.createUserWithSeatCheck = async (u) => { seen.push(u); return { created: true }; };
    userStore.getUser = async (id) => ({ id, email: 'a@b.c', organizationId: ORG });
    await run(connectorReq({ email: 'a@b.c' }, { headers: { 'x-beeflow-nc-uid': 'hdr' } }));
    await run(connectorReq({ email: 'a@b.c', sub: 'signed' }, { headers: { 'x-beeflow-nc-uid': 'hdr' } }));
    assert.equal(seen[0].ncUid, 'hdr');
    assert.equal(seen[1].ncUid, 'signed');
});

test('auto-provision (pending): 403 approval message, problem, async admin notification + audit seed', async () => {
    const audits = [];
    userStore.createUserWithSeatCheck = async () => ({ created: true });
    userStore.getUser = async (id) => ({ id, email: 'ann@acme.example', status: 'pending', organizationId: ORG });
    userStore.logAccessAudit = async (...a) => { audits.push(a); };
    userStore.getOrganization = async () => ({ id: ORG, nc_new_user_default_status: 'pending' });
    const out = await run(connectorReq(goodPayload()));
    assertRejected(out, 403, { error: 'Your account has been created in Bee Flow but requires admin approval. Please contact your organization administrator.' });
    assert.deepEqual(problemCodes(), ['auth.blocked_pending_approval']);
    assert.deepEqual(rec.problems[0].opts.meta, { lastUserId: 'nc_org1_ann', reason: 'auto_provisioned_pending' });
    assert.deepEqual(rec.events.map((e) => e.opts.meta.status), ['pending']);
    assert.equal(rec.liveness.length, 0);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(audits, [['nc_user_autoprovisioned_pending', 'user', 'nc_org1_ann', 'system:connector_jwt', null, { orgId: ORG, status: 'pending' }, ORG]]);
});

test('auto-provision: user vanishes after create (getUser null) -> TypeError caught -> 401', async () => {
    userStore.getUser = async () => null;
    assertRejected(await run(connectorReq(goodPayload())), 401, INVALID);
});

// ── admin carve-out ──────────────────────────────────────────────────────────

test('nc_admin claim: ensureOrgAdminUser called with pinned args; its user skips the gates and authenticates', async () => {
    let args;
    const adminUser = { id: `adm${++uid}`, email: 'ann@acme.example', role: 'user', orgRole: 'org_admin', organizationId: ORG };
    connectorBootstrap.helpers.ensureOrgAdminUser = async (...a) => { args = a; return adminUser; };
    userStore.getOrganization = async () => ({ id: ORG, nc_instance_id: 'nc1', nc_onboarding_completed_at: null, nc_sync_mode: 'manual' });
    const req = connectorReq(goodPayload({ nc_admin: true, name: 'Ann A' }));
    assertNextOnce(await run(req));
    assert.equal(args[0].id, ORG);
    assert.deepEqual(args[1], { ncAdminEmail: 'ann@acme.example', ncAdminUid: 'ann', ncAdminDisplayName: 'Ann A' });
    assert.equal(req.session.user.id, adminUser.id);
    assert.ok(rec.infos.some((m) => m.includes(`Re-ensured org-admin ${adminUser.id} for org org1`)));
});

test('org nc_admin_uid matching the signed sub also takes the carve-out', async () => {
    let called = 0;
    const adminUser = { id: `adm${++uid}`, email: 'ann@acme.example', organizationId: ORG };
    connectorBootstrap.helpers.ensureOrgAdminUser = async () => { called++; return adminUser; };
    userStore.getOrganization = async () => ({ id: ORG, nc_admin_uid: 'ann', nc_instance_id: 'nc1', nc_onboarding_completed_at: null });
    assertNextOnce(await run(connectorReq(goodPayload())));
    assert.equal(called, 1);
});

test('carve-out admin whose row is pending: 403 Account is pending admin approval, no next()', async () => {
    const adminUser = { id: `adm${++uid}`, email: 'ann@acme.example', organizationId: ORG, status: 'pending' };
    connectorBootstrap.helpers.ensureOrgAdminUser = async () => adminUser;
    const req = connectorReq(goodPayload({ nc_admin: true }));
    assertRejected(await run(req), 403, { error: 'Account is pending admin approval' });
    assert.equal(req.session.isAuthenticated, undefined);
    assert.deepEqual(rec.problems[0].opts.meta, { lastUserId: adminUser.id, reason: 'existing_user_pending' });
});

test('carve-out users skip the cross-tenant check (deliberate, today\'s behaviour)', async () => {
    const adminUser = { id: `adm${++uid}`, email: 'ann@acme.example', organizationId: 'otherOrg' };
    connectorBootstrap.helpers.ensureOrgAdminUser = async () => adminUser;
    const req = connectorReq(goodPayload({ nc_admin: true }));
    assertNextOnce(await run(req));
    assert.equal(req.session.user.organizationId, 'otherOrg');
    assert.ok(!problemCodes().includes('auth.blocked_org_mismatch'));
});

test('carve-out: ensureOrgAdminUser returning null falls into the onboarding gate (403)', async () => {
    userStore.getOrganization = async () => ({ id: ORG, nc_instance_id: 'nc1', nc_onboarding_completed_at: null });
    const out = await run(connectorReq(goodPayload({ nc_admin: true })));
    assert.equal(out.statusCode, 403);
    assert.equal(out.body.code, 'NC_ONBOARDING_PENDING');
});

test('carve-out: ensureOrgAdminUser throwing is warned and swallowed, the gates still apply', async () => {
    connectorBootstrap.helpers.ensureOrgAdminUser = async () => { throw new Error('ensure failed'); };
    userStore.getOrganization = async () => ({ id: ORG, nc_sync_mode: 'manual' });
    const out = await run(connectorReq(goodPayload({ nc_admin: true })));
    assert.equal(out.statusCode, 403);
    assert.ok(rec.warns.includes('[ConnectorJWT] ensureOrgAdminUser failed for org org1: ensure failed'));
});

test('nc_admin must be exactly true (truthy string does not carve out)', async () => {
    let called = 0;
    connectorBootstrap.helpers.ensureOrgAdminUser = async () => { called++; return null; };
    userStore.getOrganization = async () => ({ id: ORG, nc_sync_mode: 'manual' });
    await run(connectorReq(goodPayload({ nc_admin: 'true' })));
    assert.equal(called, 0);
});

// ── existing user ────────────────────────────────────────────────────────────

test('existing user bound to ANOTHER org: 403 NC_ORG_MISMATCH, no session mutation, no next', async () => {
    userStore.getUserByEmail = async () => ({ id: 'u9', email: 'ann@acme.example', organizationId: 'otherOrg' });
    const req = connectorReq(goodPayload());
    const out = await run(req);
    assert.equal(out.statusCode, 403);
    assert.equal(out.body.code, 'NC_ORG_MISMATCH');
    assert.match(out.body.error, /^This Nextcloud is connected to a different Bee Flow organisation/);
    assert.deepEqual(problemCodes(), ['auth.blocked_org_mismatch']);
    assert.deepEqual(rec.problems[0].opts.meta, { userOrgId: 'otherOrg', reason: 'user_bound_to_other_org' });
    assert.ok(rec.warns.includes("[ConnectorJWT] Cross-tenant rejection: user u9 (org=otherOrg) presented org=org1's key (user_bound_to_other_org)"));
    assert.equal(req.session.isAuthenticated, undefined);
    assert.equal(rec.liveness.length, 0);
});

test('existing pending user: 403 Account is pending admin approval', async () => {
    userStore.getUserByEmail = async () => ({ id: 'u9', email: 'ann@acme.example', organizationId: ORG, status: 'pending' });
    const req = connectorReq(goodPayload());
    assertRejected(await run(req), 403, { error: 'Account is pending admin approval' });
    assert.deepEqual(rec.problems[0].opts.meta, { lastUserId: 'u9', reason: 'existing_user_pending' });
    assert.equal(req.session.isAuthenticated, undefined);
});

test('existing suspended user: 403 Account is not active', async () => {
    userStore.getUserByEmail = async () => ({ id: 'u9', email: 'ann@acme.example', organizationId: ORG, status: 'suspended' });
    const req = connectorReq(goodPayload());
    assertRejected(await run(req), 403, { error: 'Account is not active' });
    assert.deepEqual(rec.problems[0].opts.meta, { lastUserId: 'u9', reason: 'existing_user_suspended' });
    assert.equal(req.session.isAuthenticated, undefined);
});

test('getUserByEmail throwing: 401 Invalid connector token + warn with method/url/message', async () => {
    userStore.getUserByEmail = async () => { throw new Error('db gone'); };
    assertRejected(await run(connectorReq(goodPayload())), 401, INVALID);
    assert.deepEqual(rec.warns, ['[ConnectorJWT] Auth failed for GET /x: db gone']);
});

test('tenant lookup throwing (list / getSecret): 401 Invalid connector token', async () => {
    configStore.listKeysWithPrefix = async () => { throw new Error('list down'); };
    assertRejected(await run(connectorReq(goodPayload())), 401, INVALID);
    reset();
    configStore.getSecret = async () => { throw new Error('secret down'); };
    assertRejected(await run(connectorReq(goodPayload())), 401, INVALID);
});

test('org-health recorder throwing inside the try: 401 (pins that orgHealth must never throw)', async () => {
    orgHealth.problem = () => { throw new Error('health down'); };
    assertRejected(await run(connectorReq({ sub: 'x', email: '' })), 401, INVALID);
});

test('existing user bound to NO org: 403 NC_ORG_MISMATCH, the row is not written, no session', async () => {
    const id = `u${++uid}`;
    const updates = [];
    userStore.getUserByEmail = async () => ({ id, email: 'ann@acme.example' });
    userStore.updateUser = async (...a) => { updates.push(a); };
    const req = connectorReq(goodPayload());
    const out = await run(req);
    assert.equal(out.statusCode, 403);
    assert.equal(out.body.code, 'NC_ORG_MISMATCH');
    assert.match(out.body.error, /not a member of the organisation this Nextcloud is connected to/);
    assert.deepEqual(updates, [], 'no org pointer is written for a user the key does not vouch for');
    assert.deepEqual(rec.problems[0].opts.meta, { userOrgId: null, reason: 'user_not_bound_to_org' });
    assert.equal(req.session.isAuthenticated, undefined);
    assert.equal(rec.liveness.length, 0);
});

test('existing platform admin in this org: 403 NC_ORG_MISMATCH, no session', async () => {
    const id = `u${++uid}`;
    userStore.getUserByEmail = async () => ({ id, email: 'ann@acme.example', organizationId: ORG, role: 'admin' });
    const req = connectorReq(goodPayload());
    const out = await run(req);
    assert.equal(out.statusCode, 403);
    assert.equal(out.body.code, 'NC_ORG_MISMATCH');
    assert.deepEqual(rec.problems[0].opts.meta, { userOrgId: ORG, reason: 'platform_admin_account' });
    assert.equal(req.session.isAuthenticated, undefined);
});

test('existing member of this org (any provider): authenticated, one next()', async () => {
    const id = `u${++uid}`;
    userStore.getUserByEmail = async () => ({ id, email: 'ann@acme.example', organizationId: ORG, provider: 'local', role: 'user' });
    const req = connectorReq(goodPayload());
    assertNextOnce(await run(req));
    assert.equal(req.session.user.organizationId, ORG);
    assert.equal(req.session.isAdmin, false);
});

test('token without exp, or with an exp further ahead than the ceiling: 401 no matching tenant key', async () => {
    userStore.getUserByEmail = async () => ({ id: 'u9', email: 'ann@acme.example', organizationId: ORG });
    const noExp = connectorReq({}, { tok: token(goodPayload({ exp: undefined })) });
    assertRejected(await run(noExp), 401, { error: 'Connector token rejected: no matching tenant key' });
    const longLived = connectorReq(goodPayload({ exp: NOW + 24 * 3600 }));
    assertRejected(await run(longLived), 401, { error: 'Connector token rejected: no matching tenant key' });
});

test('data-anomaly log: connector user under an org without nc_instance_id warns; lookup failure is swallowed', async () => {
    const id = `u${++uid}`;
    userStore.getUserByEmail = async () => ({ id, email: 'ann@acme.example', organizationId: ORG, provider: 'nextcloud_connector', nc_uid: 'ann' });
    userStore.getOrganization = async () => ({ id: ORG, nc_instance_id: null });
    assertNextOnce(await run(connectorReq(goodPayload())));
    assert.ok(rec.warns.some((m) => m.includes(`Data anomaly: user ${id} has provider=nextcloud_connector but org ${ORG} has no nc_instance_id`)));
    reset();
    const id2 = `u${++uid}`;
    userStore.getUserByEmail = async () => ({ id: id2, email: 'ann@acme.example', organizationId: ORG, provider: 'nextcloud_connector', nc_uid: 'ann' });
    userStore.getOrganization = async () => { throw new Error('org lookup'); };
    assertNextOnce(await run(connectorReq(goodPayload())));
    assert.equal(rec.warns.filter((m) => m.includes('Data anomaly')).length, 0);
});

test('stale nc_uid is repaired only when the email matches; failure is warned and swallowed', async () => {
    const id = `u${++uid}`;
    const updates = [];
    const user = { id, email: 'ann@acme.example', organizationId: ORG, nc_uid: 'old' };
    userStore.getUserByEmail = async () => user;
    userStore.updateUser = async (...a) => { updates.push(a); };
    const req = connectorReq(goodPayload());
    assertNextOnce(await run(req));
    assert.deepEqual(updates, [[id, { ncUid: 'ann' }]]);
    assert.equal(req.session.user.ncUid, 'ann');
    assert.equal(req.session.connectorNcUid, 'ann');
    assert.ok(rec.warns.includes(`[ConnectorJWT] Repaired stale nc_uid for user ${id}: old → ann`));

    reset();
    const id2 = `u${++uid}`;
    userStore.getUserByEmail = async () => ({ id: id2, email: 'other@acme.example', organizationId: ORG, nc_uid: 'old' });
    userStore.updateUser = async () => { updates.push('no'); };
    updates.length = 0;
    const req2 = connectorReq(goodPayload()); // payload email differs from stored email
    assertNextOnce(await run(req2));
    assert.deepEqual(updates, []);
    assert.equal(req2.session.user.ncUid, 'old', 'stored uid wins');

    reset();
    const id3 = `u${++uid}`;
    userStore.getUserByEmail = async () => ({ id: id3, email: 'ann@acme.example', organizationId: ORG, nc_uid: 'old' });
    userStore.updateUser = async () => { throw new Error('nope'); };
    assertNextOnce(await run(connectorReq(goodPayload())));
    assert.ok(rec.warns.includes(`[ConnectorJWT] Failed to repair nc_uid for ${id3}: nope`));
});

// ── success path ─────────────────────────────────────────────────────────────

test('success: session shape, connectorAuth, persistence suppressed, liveness touched, next() once with no args', async () => {
    const id = `u${++uid}`;
    // An org admin, not a platform admin: the tenant key never yields a
    // platform-admin session (see crossTenantGate), so isAdmin is false here.
    userStore.getUserByEmail = async () => ({ id, email: 'ann@acme.example', role: 'user', orgRole: 'org_admin', organizationId: ORG, nc_uid: 'ann', provider: 'nextcloud_connector' });
    userStore.getOrganization = async () => ({ id: ORG, nc_instance_id: 'nc1' });
    const req = connectorReq(goodPayload());
    const out = await run(req);
    assertNextOnce(out);
    assert.equal(out.ret, undefined);
    const s = req.session;
    assert.equal(s.isAuthenticated, true);
    assert.deepEqual(s.user, { id, email: 'ann@acme.example', displayName: id, role: 'user', orgRole: 'org_admin', organizationId: ORG, ncUid: 'ann', provider: 'nextcloud_connector' });
    assert.equal(s.isAdmin, false);
    assert.equal(s.connectorOrgId, ORG);
    assert.equal(s.connectorNcUid, 'ann');
    assert.equal(s.encryptionKey, 'sso-key');
    assert.deepEqual(req.connectorAuth, { orgId: ORG, ncUid: 'ann' });
    let saved = false;
    assert.equal(s.save(() => { saved = true; }), s);
    assert.equal(saved, true, 'save() is a callback-invoking no-op');
    assert.equal(req.res._bfNoSessionCookie, true);
    assert.deepEqual(rec.liveness, [[ORG, 'authOk']]);
    assert.deepEqual(rec.problems, []);
});

test('success: defaults for a sparse user row (role user, empty orgRole, provider connector, session org)', async () => {
    const id = `u${++uid}`;
    userStore.getUserByEmail = async () => ({ id, email: 'ann@acme.example', organizationId: ORG });
    const req = connectorReq(goodPayload());
    assertNextOnce(await run(req));
    assert.equal(req.session.user.role, 'user');
    assert.equal(req.session.user.orgRole, '');
    assert.equal(req.session.user.provider, 'nextcloud_connector');
    assert.equal(req.session.user.ncUid, 'ann', 'falls back to the signed sub');
    assert.equal(req.session.isAdmin, false);
});

test('encryption key: SSO key preferred; fallback derivation when SSO gives none; none at all -> no key; cached per user', async () => {
    const id = `u${++uid}`;
    let ssoCalls = 0;
    userStore.getUserByEmail = async () => ({ id, email: 'ann@acme.example', organizationId: ORG });
    encryption.getOrCreateSSOUserDEKCompat = async (...a) => { ssoCalls++; assert.deepEqual(a, [id, true]); return { encryptionKey: 'k1' }; };
    const r1 = connectorReq(goodPayload());
    assertNextOnce(await run(r1));
    const r2 = connectorReq(goodPayload());
    assertNextOnce(await run(r2));
    assert.equal(r1.session.encryptionKey, 'k1');
    assert.equal(r2.session.encryptionKey, 'k1');
    assert.equal(ssoCalls, 1, 'second request is served from the cache');

    const savedMaster = process.env.MASTER_ENCRYPTION_KEY;
    try {
        const id2 = `u${++uid}`;
        userStore.getUserByEmail = async () => ({ id: id2, email: 'ann@acme.example', organizationId: ORG });
        encryption.getOrCreateSSOUserDEKCompat = async () => ({});
        process.env.MASTER_ENCRYPTION_KEY = 'm';
        const r3 = connectorReq(goodPayload());
        assertNextOnce(await run(r3));
        assert.equal(r3.session.encryptionKey, 'fallback-key');

        const id3 = `u${++uid}`;
        userStore.getUserByEmail = async () => ({ id: id3, email: 'ann@acme.example', organizationId: ORG });
        delete process.env.MASTER_ENCRYPTION_KEY;
        const r4 = connectorReq(goodPayload());
        assertNextOnce(await run(r4));
        assert.equal('encryptionKey' in r4.session, false);
    } finally {
        if (savedMaster === undefined) delete process.env.MASTER_ENCRYPTION_KEY; else process.env.MASTER_ENCRYPTION_KEY = savedMaster;
    }
});

test('encryption derivation throwing: warn + auth.encryption_key_failed problem, request STILL authenticates without a key', async () => {
    const id = `u${++uid}`;
    userStore.getUserByEmail = async () => ({ id, email: 'ann@acme.example', organizationId: ORG });
    encryption.getOrCreateSSOUserDEKCompat = async () => { throw new Error('kms down'); };
    const req = connectorReq(goodPayload());
    assertNextOnce(await run(req));
    assert.equal('encryptionKey' in req.session, false);
    assert.equal(req.session.isAuthenticated, true);
    assert.deepEqual(problemCodes(), ['auth.encryption_key_failed']);
    assert.deepEqual(rec.problems[0].opts.meta, { userId: id, reason: 'derivation_failed' });
    assert.ok(rec.warns.includes(`[ConnectorJWT] EncryptionKey derivation failed for user ${id}: kms down`));
    assert.deepEqual(rec.liveness, [[ORG, 'authOk']]);
});

test('touchLiveness throwing: session is already populated but the response is 401 and next() is NOT called', async () => {
    const id = `u${++uid}`;
    userStore.getUserByEmail = async () => ({ id, email: 'ann@acme.example', organizationId: ORG });
    orgHealth.touchLiveness = () => { throw new Error('liveness down'); };
    const req = connectorReq(goodPayload());
    assertRejected(await run(req), 401, INVALID);
    assert.equal(req.session.isAuthenticated, true);
});

test('next() throwing synchronously on success: caught by the try, next stays called once, then 401 is sent', async () => {
    const id = `u${++uid}`;
    userStore.getUserByEmail = async () => ({ id, email: 'ann@acme.example', organizationId: ORG });
    const out = await run(connectorReq(goodPayload()), { nextThrows: true });
    assert.equal(out.rejected, undefined);
    assert.deepEqual(out.actions, ['next', 'res.status', 'res.json']);
    assert.equal(out.statusCode, 401);
    assert.deepEqual(out.body, INVALID);
    assert.equal(out.nextCalls, 1);
});

test('next(err) path: a throw from next(HttpError) is also turned into 401', async () => {
    userStore.createUserWithSeatCheck = async () => ({ created: false, reason: 'x' });
    const out = await run(connectorReq(goodPayload()), { nextThrows: true });
    assert.deepEqual(out.actions, ['next', 'res.status', 'res.json']);
    assert.equal(out.statusCode, 401);
    assert.equal(out.nextArgs[0].code, 'provision_failed');
});

// ── fail-closed guards of the orchestrator (split-specific) ─────────────────

test('an unknown outcome kind from the last phase is 401, never next()', async (t) => {
    const phases = require('./connectorJwtPhases');
    const orig = phases.establishConnectorSession;
    t.after(() => { phases.establishConnectorSession = orig; });
    phases.establishConnectorSession = async () => ({ kind: 'weird' });
    const id = `u${++uid}`;
    userStore.getUserByEmail = async () => ({ id, email: 'ann@acme.example', organizationId: ORG });
    assertRejected(await run(connectorReq(goodPayload())), 401, INVALID);
});

test('a gate that returns ok() without an authenticated session is 401, never next()', async (t) => {
    const phases = require('./connectorJwtPhases');
    const orig = phases.pendingApprovalGate;
    t.after(() => { phases.pendingApprovalGate = orig; });
    phases.pendingApprovalGate = () => ({ kind: 'ok', user: null });
    const id = `u${++uid}`;
    userStore.getUserByEmail = async () => ({ id, email: 'ann@acme.example', organizationId: ORG });
    const req = connectorReq(goodPayload());
    assertRejected(await run(req), 401, INVALID);
    assert.equal(req.session.isAuthenticated, undefined);
});
