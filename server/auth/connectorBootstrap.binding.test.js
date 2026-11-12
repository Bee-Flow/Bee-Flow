/**
 * Which organisation's tenant key a connector bootstrap may answer with.
 *
 * The rules, each stated by the tests below:
 *
 *   a. A pairing code links a Nextcloud only to the organisation it was issued
 *      for. When the instance id belongs to another organisation the bootstrap
 *      is refused (409 nc_instance_bound_elsewhere), the code stays unused and
 *      the answer carries no tenant key.
 *   b. The key of an organisation that is linked already is handed out again
 *      only to a bootstrap signed with that key, or to a pairing code issued
 *      for that organisation.
 *   c. Every path answers with the key of the organisation it linked: pairing
 *      code, signed bootstrap, open provisioning, emailed verification code.
 *      (An administrator's approval: ncBindingRoutes.pairingCodes.test.js.)
 *   d. The emailed code is sent to an administrator of the organisation it
 *      links, is accepted once and only after it was sent, and links an
 *      organisation that has no Nextcloud.
 *   e. The row id of a pending binding reads its status. It answers the key
 *      only for an approval, shortly after it, for the Nextcloud it approved.
 *   f. An existing account is made a Nextcloud admin of an organisation only
 *      when it is a member of that organisation.
 *
 * The router and the connector/ modules are the real ones. The store methods
 * they call are stubbed on the shared store objects (no module mocking) with a
 * small in-memory model in which, as in the database, an instance id belongs
 * to at most one organisation and an organisation has at most one instance id.
 * The store's own rules for the emailed code (ncBindings.js) are stated on a
 * real database in stores/user/ncBindings.verification.test.js.
 * The capabilities round-trip is skipped (BEEFLOW_BOOTSTRAP_SKIP_VERIFY): it
 * is the subject of connector/ncVerify.test.js.
 *
 * Run: cd server && node --test auth/connectorBootstrap.binding.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const { mock } = test;
const assert = require('node:assert/strict');

const realUserStore = require('../stores/userStore');
const realConfigStore = require('../stores/configStore');
const { orgHealth } = require('./connector/serviceDeps');
const { _setDepsForTests: setRebindProofDeps } = require('./connector/rebindProof');
const bootstrapRouter = require('./connectorBootstrap');
const { bindOrgToNcInstance } = require('./connector/instanceBinding');

// ── In-memory stores ─────────────────────────────────────────────────
const db = {
    orgs: new Map(),      // id -> organisation row
    pending: new Map(),   // id -> pending_nc_bindings row
    users: new Map(),     // id -> user
    secrets: new Map(),   // config key -> secret
    health: [],           // [kind, code-or-subject, opts]
    onConsume: null,      // runs after a pairing code is consumed
    failNextMint: false,  // the next new tenant key is not stored: the write throws
    seq: 0,
};

const ORG_COLUMNS = { ncInstanceId: 'nc_instance_id', ncBaseUrl: 'nc_base_url', ncAdminUid: 'nc_admin_uid', connectorCallbackUrl: 'connector_callback_url' };
const instanceHolder = (ncInstanceId) => [...db.orgs.values()].find(o => o.nc_instance_id === ncInstanceId) || null;
const copy = (o) => (o ? { ...o } : null);

const userStore = {
    getOrganization: async (id) => copy(db.orgs.get(id)),
    getOrganizationByNcInstanceId: async (id) => copy(id ? instanceHolder(id) : null),
    updateOrganization: async (id, patch) => {
        const org = db.orgs.get(id);
        if (!org) return false;
        for (const [k, v] of Object.entries(patch)) org[ORG_COLUMNS[k] || k] = v;
        return true;
    },
    claimNcInstanceForOrganization: async (id, ncInstanceId) => {
        const org = db.orgs.get(id);
        const holder = instanceHolder(ncInstanceId);
        if (!org || (holder && holder.id !== id)) return false;
        if (org.nc_instance_id && org.nc_instance_id !== ncInstanceId) return false;
        org.nc_instance_id = ncInstanceId;
        return true;
    },
    createOrganization: async (o) => {
        if (db.orgs.has(o.id) || (o.ncInstanceId && instanceHolder(o.ncInstanceId))) return false;
        db.orgs.set(o.id, { id: o.id, name: o.name, nc_instance_id: o.ncInstanceId, nc_base_url: o.ncBaseUrl });
        return true;
    },
    findUnboundOrgByEmailDomain: async (domain) => copy([...db.orgs.values()].find(o => o.domain === domain && !o.nc_instance_id)),

    getPendingBindingByPairingCode: async (code) => copy([...db.pending.values()].find(r => r.pairingCode === code && r.status === 'pending')),
    consumePairingCode: async (id, data) => {
        const row = db.pending.get(id);
        if (!row || row.status !== 'pending') return false;
        Object.assign(row, data, { status: 'approved' });
        if (db.onConsume) db.onConsume();
        return true;
    },
    countActivePendingNcVerificationsForOrg: async () => 0,
    createPendingNcVerification: async (data, { code }) => {
        const row = { ...data, id: `pv${++db.seq}`, status: 'pending', hasVerification: true, emailedCode: code, codeSent: false, expiresAt: new Date(Date.now() + 900_000).toISOString() };
        db.pending.set(row.id, row);
        return copy(row);
    },
    // As the store: a code is checked against a pending row, once it was sent.
    verifyPendingNcCode: async (id, code) => {
        const row = db.pending.get(id);
        if (!row) return { status: 'not_found' };
        if (row.status !== 'pending') return { status: 'expired' };
        return row.codeSent && row.emailedCode === code ? { status: 'ok', row: copy(row) } : { status: 'invalid', attemptsLeft: 4 };
    },
    getPendingNcBinding: async (id) => copy(db.pending.get(id)),
    markPendingNcBindingApproved: async (id) => { const row = db.pending.get(id); row.status = 'approved'; row.approvedAt = new Date().toISOString(); },
    expirePendingNcBindings: async () => 0,

    getUserByEmail: async (email) => copy([...db.users.values()].find(u => u.email === email)),
    getUser: async (id) => copy(db.users.get(id)),
    getUserByNcUid: async (orgId, ncUid) => copy([...db.users.values()].find(u => u.organizationId === orgId && (u.ncUid || u.nc_uid) === ncUid)),
    updateUser: async (id, patch) => { Object.assign(db.users.get(id), patch); return true; },
    createUserWithSeatCheck: async (u) => { db.users.set(u.id, { ...u }); return { created: true }; },

    getDefaultNcPlan: async () => null,
    getOrgSubscription: async () => ({ plan_id: 'plan' }),
    logAccessAudit: async () => { },
};

const configStore = {
    getConfig: async () => null,
    getSecret: async (k) => db.secrets.get(k) || null,
    setSecretIfAbsent: async (k, v) => {
        if (db.failNextMint) { db.failNextMint = false; throw new Error('the key store did not answer'); }
        if (!db.secrets.has(k)) db.secrets.set(k, v);
        return db.secrets.get(k);
    },
};

// A request "signed" for an organisation: the header carries that
// organisation's key. The real check (the HMAC) is connectorSig.test.js.
async function verifyConnectorSig(req) {
    const org = instanceHolder(req.headers['x-beeflow-nc-instance-id']);
    return org && req.headers['x-beeflow-sig'] === `signed-with:${db.secrets.get(KEY(org.id))}` ? copy(org) : null;
}

test.beforeEach(() => {
    for (const [name, impl] of Object.entries(userStore)) mock.method(realUserStore, name, impl);
    for (const [name, impl] of Object.entries(configStore)) mock.method(realConfigStore, name, impl);
    for (const kind of ['problem', 'event', 'resolve', 'touchLiveness']) {
        mock.method(orgHealth, kind, (subject, opts) => { db.health.push([kind, subject, opts]); return Promise.resolve(); });
    }
    setRebindProofDeps({ verifyConnectorSig });
    for (const m of [db.orgs, db.pending, db.users, db.secrets]) m.clear();
    db.health = [];
    db.onConsume = null;
    db.failNextMint = false;
    process.env.BEEFLOW_BOOTSTRAP_SKIP_VERIFY = 'true';
    process.env.BEEFLOW_CONNECTOR_PROVISIONING = 'pairing_only';
});
test.afterEach(() => {
    mock.restoreAll();
    setRebindProofDeps();
    delete process.env.BEEFLOW_BOOTSTRAP_SKIP_VERIFY;
    delete process.env.BEEFLOW_CONNECTOR_PROVISIONING;
});

// ── Fixtures ─────────────────────────────────────────────────────────
const KEY = (orgId) => `connector_tenant_key_${orgId}`;
const INSTANCE = 'inst-1';
const NC_URL = 'https://cloud.one.example';

/** An organisation; `instance` links it and gives it a tenant key. */
function org(id, { instance = null, domain = null } = {}) {
    db.orgs.set(id, { id, name: `Org ${id}`, nc_instance_id: instance, nc_base_url: instance ? NC_URL : null, domain });
    if (instance) db.secrets.set(KEY(id), `key-of-${id}`);
    return db.orgs.get(id);
}

/** An account; `orgId` null: an account without an organisation. */
function account(email, orgId, orgRole = 'member') {
    const user = { id: `u${++db.seq}`, email, organizationId: orgId, orgRole, status: 'active' };
    db.users.set(user.id, user);
    return user;
}
const adminOf = (orgId, email = 'admin@one.example') => account(email, orgId, 'org_admin');

/** The store's send (resend, retarget): the row's code went to `email`. */
function codeSentTo(pendingId, email) {
    const row = db.pending.get(pendingId);
    Object.assign(row, { codeSent: true, verificationEmail: email, ncAdminEmail: email });
    return row;
}

/** What removing an organisation's Nextcloud link leaves: no instance id, no key. */
function unlink(orgId) {
    Object.assign(db.orgs.get(orgId), { nc_instance_id: null, nc_base_url: null, connector_callback_url: null });
    db.secrets.delete(KEY(orgId));
}

/** A pairing code an administrator of `orgId` generated. */
function pairingCodeFor(orgId) {
    const row = { id: `pc${++db.seq}`, orgId, pairingCode: `CODE-${db.seq}`, hasPairingCode: true, status: 'pending' };
    db.pending.set(row.id, row);
    return row;
}

// Each request from its own address: the per-address request limits are not the subject here.
function dispatch(router, method, url, { headers = {}, body = {} } = {}) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, ip: `192.0.2.${(++db.seq % 250) + 1}`, body, query: {}, params: {}, headers,
            session: {},
            get(name) { return this.headers[String(name).toLowerCase()]; },
        };
        const res = {
            statusCode: 200,
            headers: {},
            setHeader(k, v) { this.headers[k] = v; },
            getHeader(k) { return this.headers[k]; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
        };
        router(req, res, (err) => reject(err || new Error(`fell through router: ${method} ${url}`)));
    });
}

/** POST /connector/bootstrap as the connector of the Nextcloud that reports `instance`. */
function bootstrap({ instance = INSTANCE, pairingCode, signedWith, email = 'admin@one.example', ncAdmins } = {}) {
    return dispatch(bootstrapRouter, 'POST', '/connector/bootstrap', {
        body: ncAdmins ? { ncAdmins } : {},
        headers: {
            'x-beeflow-nc-instance-id': instance,
            'x-beeflow-nc-base-url': NC_URL,
            'x-beeflow-nc-admin-uid': 'admin',
            'x-beeflow-nc-admin-email': email,
            ...(pairingCode ? { 'x-beeflow-pairing-code': pairingCode } : {}),
            ...(signedWith ? { 'x-beeflow-sig': `signed-with:${signedWith}` } : {}),
        },
    });
}

const poll = (pendingId) => dispatch(bootstrapRouter, 'GET', `/connector/bootstrap/pending/${pendingId}`);
const verify = (pendingId, code) => dispatch(bootstrapRouter, 'POST', `/connector/bootstrap/pending/${pendingId}/verify`, { body: { code } });

/** The answer carries no tenant key: no such field, and no stored key anywhere in it. */
function assertNoKey(res) {
    assert.equal('tenantKey' in res.body, false);
    const text = JSON.stringify(res.body);
    for (const secret of db.secrets.values()) assert.equal(text.includes(secret), false);
}

const problems = () => db.health.filter(h => h[0] === 'problem');

// ═══ a. A pairing code links a Nextcloud only to the organisation it was issued for ═══

test('a pairing code for one organisation does not link a Nextcloud that belongs to another: 409, the code stays unused, no key', async () => {
    org('org-a');
    org('org-b', { instance: INSTANCE });
    const code = pairingCodeFor('org-a');

    const res = await bootstrap({ pairingCode: code.pairingCode });

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'nc_instance_bound_elsewhere');
    assert.equal(typeof res.body.remediation, 'string');
    assertNoKey(res);
    assert.equal('organizationId' in res.body, false);
    assert.equal(db.pending.get(code.id).status, 'pending');
    assert.equal(db.orgs.get('org-a').nc_instance_id, null);
    assert.equal(db.orgs.get('org-b').nc_instance_id, INSTANCE);
    assert.equal(db.secrets.has(KEY('org-a')), false);
    assert.equal(db.users.size, 0);
});

test('that refusal is recorded for the organisation the code was issued for, with the instance id and nothing personal', async () => {
    org('org-a');
    org('org-b', { instance: INSTANCE });

    await bootstrap({ pairingCode: pairingCodeFor('org-a').pairingCode });

    assert.deepEqual(problems(), [['problem', 'bootstrap.instance_bound_elsewhere', {
        orgId: 'org-a', source: 'connectorBootstrap', meta: { ncInstanceId: INSTANCE, reason: 'pairing_code' },
    }]]);
    assert.equal(db.health.some(h => h[0] === 'event'), false);
});

test('the refused code is still good for a Nextcloud that belongs to no organisation', async () => {
    org('org-a');
    org('org-b', { instance: INSTANCE });
    const code = pairingCodeFor('org-a');
    assert.equal((await bootstrap({ pairingCode: code.pairingCode })).statusCode, 409);

    const res = await bootstrap({ instance: 'inst-2', pairingCode: code.pairingCode });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.organizationId, 'org-a');
    assert.equal(db.orgs.get('org-a').nc_instance_id, 'inst-2');
});

test('an instance id that another organisation links while the code is redeemed: 409, no key', async () => {
    org('org-a');
    org('org-b');
    db.secrets.set(KEY('org-b'), 'key-of-org-b');
    db.onConsume = () => { db.orgs.get('org-b').nc_instance_id = INSTANCE; };

    const res = await bootstrap({ pairingCode: pairingCodeFor('org-a').pairingCode });

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'nc_instance_bound_elsewhere');
    assertNoKey(res);
    assert.equal(db.orgs.get('org-a').nc_instance_id, null);
    assert.equal(db.users.size, 0);
});

test('binding answers with the organisation it was asked to bind, or throws', async () => {
    const a = org('org-a');
    org('org-b', { instance: INSTANCE });
    const params = { ncInstanceId: INSTANCE, ncBaseUrl: NC_URL, ncAdminUid: 'admin' };

    await assert.rejects(bindOrgToNcInstance(a, params), { code: 'nc_instance_bound_elsewhere', statusCode: 409 });
    assert.equal(db.orgs.get('org-a').nc_instance_id, null);

    const bound = await bindOrgToNcInstance(a, { ...params, ncInstanceId: 'inst-2' });
    assert.equal(bound.id, 'org-a');
    assert.equal(bound.nc_instance_id, 'inst-2');
});

// ═══ b. The key of a linked organisation: only to a signed bootstrap or to its own pairing code ═══

test('first link with a pairing code: the Nextcloud is linked to the code\'s organisation and gets that organisation\'s key', async () => {
    org('org-a');
    org('org-b', { instance: 'inst-other' });
    const code = pairingCodeFor('org-a');

    const res = await bootstrap({ pairingCode: code.pairingCode });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.code, 'pairing_code_redeemed');
    assert.equal(res.body.organizationId, 'org-a');
    assert.equal(res.body.tenantKey, db.secrets.get(KEY('org-a')));
    assert.notEqual(res.body.tenantKey, 'key-of-org-b');
    assert.equal(db.orgs.get('org-a').nc_instance_id, INSTANCE);
    assert.equal(db.pending.get(code.id).status, 'approved');

    const again = await bootstrap({ instance: 'inst-3', pairingCode: code.pairingCode });
    assert.equal(again.statusCode, 401);
    assert.equal(again.body.code, 'pairing_code_invalid');
});

test('a Nextcloud that lost its key links again to its own organisation with a fresh code issued for that organisation', async () => {
    org('org-a', { instance: INSTANCE });

    const res = await bootstrap({ pairingCode: pairingCodeFor('org-a').pairingCode });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.organizationId, 'org-a');
    assert.equal(res.body.tenantKey, 'key-of-org-a');
    assert.equal(db.orgs.get('org-a').nc_instance_id, INSTANCE);
});

test('a bootstrap signed with the organisation\'s tenant key gets that key again', async () => {
    org('org-a', { instance: INSTANCE });

    const res = await bootstrap({ signedWith: 'key-of-org-a' });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.code, 'returning_bind');
    assert.equal(res.body.organizationId, 'org-a');
    assert.equal(res.body.tenantKey, 'key-of-org-a');
});

test('without that signature or such a code, a bootstrap for a linked instance id gets no key, in either provisioning mode', async () => {
    for (const mode of ['pairing_only', 'open']) {
        process.env.BEEFLOW_CONNECTOR_PROVISIONING = mode;
        org('org-a', { instance: INSTANCE, domain: 'one.example' });
        for (const signedWith of [undefined, 'key-of-another-org']) {
            const res = await bootstrap({ signedWith });
            assert.equal(res.statusCode, 403, mode);
            assert.equal(res.body.code, 'NC_REBIND_PROOF_REQUIRED');
            assertNoKey(res);
        }
    }
    assert.equal(db.orgs.size, 1);
});

test('a pairing code for a linked organisation does not move it to another Nextcloud', async () => {
    org('org-a', { instance: INSTANCE });
    const code = pairingCodeFor('org-a');

    const res = await bootstrap({ instance: 'inst-2', pairingCode: code.pairingCode });

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'pairing_code_org_already_bound');
    assertNoKey(res);
    assert.equal(db.pending.get(code.id).status, 'pending');
});

// ═══ c. Every other path answers with the key of the organisation it linked ═══

test('open provisioning, unknown Nextcloud: a new organisation with a key of its own', async () => {
    process.env.BEEFLOW_CONNECTOR_PROVISIONING = 'open';
    org('org-b', { instance: 'inst-other' });

    const res = await bootstrap({ email: 'admin@unknown.example' });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.code, 'fresh_org');
    assert.equal(res.body.isNew, true);
    assert.notEqual(res.body.organizationId, 'org-b');
    assert.equal(db.orgs.get(res.body.organizationId).nc_instance_id, INSTANCE);
    assert.equal(res.body.tenantKey, db.secrets.get(KEY(res.body.organizationId)));
    assert.notEqual(res.body.tenantKey, 'key-of-org-b');
});

test('pairing-only provisioning, unknown Nextcloud without a code: refused, no key', async () => {
    org('org-b', { instance: 'inst-other' });

    const res = await bootstrap({ email: 'admin@unknown.example' });

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'pairing_required');
    assertNoKey(res);
});

test('e-mail match: the bootstrap answers with no key; the code sent to an administrator links the Nextcloud to that organisation and answers with its key', async () => {
    process.env.BEEFLOW_CONNECTOR_PROVISIONING = 'open';
    org('org-a', { domain: 'one.example' });
    org('org-b', { instance: 'inst-other' });
    adminOf('org-a');

    const started = await bootstrap();
    assert.equal(started.statusCode, 202);
    assert.equal(started.body.code, 'email_verification_required');
    assertNoKey(started);
    assert.equal(db.orgs.get('org-a').nc_instance_id, null);

    const row = codeSentTo(started.body.pendingId, 'admin@one.example');
    assert.equal((await poll(row.id)).statusCode, 404);

    const wrong = await verify(row.id, row.emailedCode === '000000' ? '111111' : '000000');
    assert.equal(wrong.statusCode, 400);
    assertNoKey(wrong);

    const res = await verify(row.id, row.emailedCode);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.organizationId, 'org-a');
    assert.equal(res.body.tenantKey, db.secrets.get(KEY('org-a')));
    assert.equal(db.orgs.get('org-a').nc_instance_id, INSTANCE);
});

test('the emailed code does not link a Nextcloud that another organisation linked in the meantime: 409, no key', async () => {
    org('org-a', { domain: 'one.example' });
    org('org-b');
    const admin = adminOf('org-a');
    const started = await bootstrap();
    const row = codeSentTo(started.body.pendingId, admin.email);
    db.orgs.get('org-b').nc_instance_id = INSTANCE;
    db.secrets.set(KEY('org-b'), 'key-of-org-b');

    const res = await verify(row.id, row.emailedCode);

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'nc_instance_bound_elsewhere');
    assertNoKey(res);
    assert.equal(db.orgs.get('org-a').nc_instance_id, null);
    assert.equal(db.secrets.has(KEY('org-a')), false);
    assert.equal(db.pending.get(row.id).status, 'pending');
    assert.deepEqual(problems().at(-1), ['problem', 'bootstrap.instance_bound_elsewhere', {
        orgId: 'org-a', source: 'connectorBootstrap', meta: { ncInstanceId: INSTANCE, reason: 'email_verification' },
    }]);
});

// ═══ d. The emailed code: to an administrator, once, after it was sent, for an organisation without a Nextcloud ═══

/** Organisation org-a with an administrator, and a pending verification for INSTANCE. */
async function pendingVerification() {
    org('org-a', { domain: 'one.example' });
    const admin = adminOf('org-a');
    const started = await bootstrap();
    assert.equal(started.statusCode, 202);
    return { admin, pendingId: started.body.pendingId, row: db.pending.get(started.body.pendingId) };
}

test('a code is accepted only after it was sent', async () => {
    const { row } = await pendingVerification();

    const res = await verify(row.id, row.emailedCode);

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'invalid_code');
    assertNoKey(res);
    assert.equal(db.orgs.get('org-a').nc_instance_id, null);
});

test('the emailed code is accepted once: entered again it answers 410 and no key', async () => {
    const { admin, row } = await pendingVerification();
    codeSentTo(row.id, admin.email);
    assert.equal((await verify(row.id, row.emailedCode)).statusCode, 200);

    for (const code of [row.emailedCode, row.emailedCode === '000000' ? '111111' : '000000']) {
        const res = await verify(row.id, code);
        assert.equal(res.statusCode, 410);
        assert.equal(res.body.code, 'expired');
        assertNoKey(res);
    }
});

test('after the organisation\'s Nextcloud link is removed, a code that was used answers 410, links nothing and creates no key', async () => {
    const { admin, row } = await pendingVerification();
    codeSentTo(row.id, admin.email);
    assert.equal((await verify(row.id, row.emailedCode)).statusCode, 200);
    unlink('org-a');

    const res = await verify(row.id, row.emailedCode);

    assert.equal(res.statusCode, 410);
    assertNoKey(res);
    assert.equal(db.orgs.get('org-a').nc_instance_id, null);
    assert.equal(db.secrets.has(KEY('org-a')), false);
});

test('for an organisation that has a Nextcloud the emailed code answers 409, no key, and the text names the pairing code', async () => {
    const { admin, row } = await pendingVerification();
    codeSentTo(row.id, admin.email);
    Object.assign(db.orgs.get('org-a'), { nc_instance_id: INSTANCE });
    db.secrets.set(KEY('org-a'), 'key-of-org-a');

    const res = await verify(row.id, row.emailedCode);

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'already_bound');
    assert.match(res.body.error, /pairing code/);
    assertNoKey(res);
    assert.equal(db.pending.get(row.id).status, 'pending');
});

test('a code on a row addressed to someone who is not an administrator of the organisation: 403, no key, nothing linked', async () => {
    const outsiders = {
        'a member without the administrator role': () => account('member@one.example', 'org-a'),
        'an address at the organisation\'s domain without an account': () => ({ email: 'it@one.example' }),
        'an administrator of another organisation': () => { org('org-c'); return adminOf('org-c', 'admin@three.example'); },
    };
    for (const [who, make] of Object.entries(outsiders)) {
        db.orgs.clear(); db.pending.clear(); db.users.clear(); db.secrets.clear();
        const { row } = await pendingVerification();
        const before = JSON.stringify([...db.users.values()]);
        codeSentTo(row.id, make().email);
        const usersBefore = db.users.size;

        const res = await verify(row.id, row.emailedCode);

        assert.equal(res.statusCode, 403, who);
        assert.equal(res.body.code, 'email_not_in_org', who);
        assertNoKey(res);
        assert.equal(db.orgs.get('org-a').nc_instance_id, null, who);
        assert.equal(db.secrets.has(KEY('org-a')), false, who);
        assert.equal(db.users.size, usersBefore, who);
        assert.equal(JSON.stringify([...db.users.values()].slice(0, 1)), JSON.stringify(JSON.parse(before).slice(0, 1)), who);
    }
});

test('a step that fails before the link leaves the organisation without a Nextcloud, and the same code works again', async () => {
    const { admin, row } = await pendingVerification();
    codeSentTo(row.id, admin.email);
    db.failNextMint = true;

    await assert.rejects(verify(row.id, row.emailedCode), /key store/);
    assert.equal(db.orgs.get('org-a').nc_instance_id, null);
    assert.equal(db.pending.get(row.id).status, 'pending');

    const res = await verify(row.id, row.emailedCode);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.tenantKey, db.secrets.get(KEY('org-a')));
    assert.equal(db.orgs.get('org-a').nc_instance_id, INSTANCE);
    assert.equal(db.pending.get(row.id).status, 'approved');
});

// ═══ e. The row id of a pending binding ═══

test('the row id of a redeemed pairing code answers 404 on the poll route, and no key', async () => {
    org('org-a');
    const code = pairingCodeFor('org-a');
    assert.equal((await bootstrap({ pairingCode: code.pairingCode })).statusCode, 200);
    assert.equal(db.pending.get(code.id).status, 'approved');

    const res = await poll(code.id);

    assert.equal(res.statusCode, 404);
    assertNoKey(res);
});

/** An approval row (no pairing code, no emailed code) an administrator of `orgId` approved. */
function approvedRow(orgId, { instance = INSTANCE, minutesAgo = 0 } = {}) {
    const row = { id: `ap${++db.seq}`, orgId, ncInstanceId: instance, status: 'approved', approvedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString() };
    db.pending.set(row.id, row);
    return row;
}

test('an approval answers the key on the poll route shortly after it, for the Nextcloud it approved', async () => {
    org('org-a', { instance: INSTANCE });

    const res = await poll(approvedRow('org-a').id);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.organizationId, 'org-a');
    assert.equal(res.body.tenantKey, 'key-of-org-a');
});

test('the poll route answers 410 and no key: long after the approval, for another Nextcloud, for an organisation without one', async () => {
    org('org-a', { instance: INSTANCE });
    org('org-u');
    const rows = [
        approvedRow('org-a', { minutesAgo: 11 }),
        approvedRow('org-a', { minutesAgo: 60 * 24 * 30 }),
        approvedRow('org-a', { instance: 'inst-2' }),
        approvedRow('org-u'),
        { ...approvedRow('org-a'), approvedAt: null },
    ];
    db.pending.set(rows[4].id, rows[4]);

    for (const row of rows) {
        const res = await poll(row.id);
        assert.equal(res.statusCode, 410, row.id);
        assertNoKey(res);
    }
    assert.equal(db.secrets.has(KEY('org-u')), false);
});

// ═══ An organisation has one Nextcloud ═══

test('binding an organisation that has another instance id throws, and its link stays', async () => {
    const a = org('org-a', { instance: INSTANCE });

    await assert.rejects(
        bindOrgToNcInstance({ ...a, nc_instance_id: null }, { ncInstanceId: 'inst-2', ncBaseUrl: NC_URL, ncAdminUid: 'admin' }),
        { code: 'org_linked_to_other_instance', statusCode: 409 },
    );
    assert.equal(db.orgs.get('org-a').nc_instance_id, INSTANCE);
    assert.equal(db.orgs.get('org-a').nc_base_url, NC_URL);
});

test('an organisation that gets a Nextcloud while a pairing code for another one is redeemed keeps it: 409, no key', async () => {
    org('org-a');
    db.onConsume = () => { db.orgs.get('org-a').nc_instance_id = 'inst-first'; db.secrets.set(KEY('org-a'), 'key-of-org-a'); };

    const res = await bootstrap({ instance: 'inst-2', pairingCode: pairingCodeFor('org-a').pairingCode });

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'pairing_code_org_already_bound');
    assertNoKey(res);
    assert.equal(db.orgs.get('org-a').nc_instance_id, 'inst-first');
});

// ═══ f. An existing account and the Nextcloud admins of an organisation ═══

test('open provisioning with the address of an existing account: 409, no organisation, no key, the account as it was', async () => {
    process.env.BEEFLOW_CONNECTOR_PROVISIONING = 'open';
    org('org-b', { instance: 'inst-other' });
    const accounts = [account('solo@mail.example', null), account('member@two.example', 'org-b')];

    for (const existing of accounts) {
        const before = JSON.stringify(existing);
        const res = await bootstrap({ email: existing.email });

        assert.equal(res.statusCode, 409);
        assert.equal(res.body.code, 'admin_email_conflict');
        assertNoKey(res);
        assert.equal(db.orgs.size, 1);
        assert.equal(instanceHolder(INSTANCE), null);
        assert.equal(JSON.stringify(db.users.get(existing.id)), before);
    }
});

test('open provisioning: further Nextcloud admins that are existing accounts elsewhere stay as they were', async () => {
    process.env.BEEFLOW_CONNECTOR_PROVISIONING = 'open';
    org('org-b', { instance: 'inst-other' });
    const solo = account('solo@mail.example', null);
    const other = account('member@two.example', 'org-b');
    const before = JSON.stringify([solo, other]);

    const res = await bootstrap({
        email: 'admin@unknown.example',
        ncAdmins: [{ uid: 'second', email: solo.email }, { uid: 'third', email: other.email }, { uid: 'fourth', email: 'new@unknown.example' }],
    });

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.stringify([db.users.get(solo.id), db.users.get(other.id)]), before);
    const created = [...db.users.values()].filter(u => u.organizationId === res.body.organizationId).map(u => u.email).sort();
    assert.deepEqual(created, ['admin@unknown.example', 'new@unknown.example']);
});

test('a pairing code links the Nextcloud when its admin address is an account without an organisation, and that account stays as it was', async () => {
    org('org-a');
    const solo = account('admin@one.example', null);
    const before = JSON.stringify(solo);

    const res = await bootstrap({ pairingCode: pairingCodeFor('org-a').pairingCode });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.organizationId, 'org-a');
    assert.equal(db.orgs.get('org-a').nc_instance_id, INSTANCE);
    assert.equal(JSON.stringify(db.users.get(solo.id)), before);
});
