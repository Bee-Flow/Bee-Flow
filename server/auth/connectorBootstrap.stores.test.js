/**
 * The connector bootstrap routes against the real stores on a real Postgres
 * (@electric-sql/pglite behind db.js, testUtils/pglitePool.js): the router, the
 * connector/ modules, userStore and configStore are the real ones. Only the
 * capabilities round-trip is skipped (BEEFLOW_BOOTSTRAP_SKIP_VERIFY).
 *
 * The rules, each stated by a test below:
 *
 *   - the emailed code is sent to an administrator of the organisation, is
 *     accepted once, and links an organisation that has no Nextcloud;
 *   - the row id of a pairing code answers no key on the poll route;
 *   - an existing account that is not a member of the organisation stays as it
 *     is when a Nextcloud is connected.
 *
 * Run: cd server && node --test auth/connectorBootstrap.stores.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.BEEFLOW_BOOTSTRAP_SKIP_VERIFY = 'true';
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'bootstrap-stores-test-master-key-0123456789abcdef';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const { initDB } = require('../stores/user/schema');
const userStore = require('../stores/userStore');
const configStore = require('../stores/configStore');
const bootstrapRouter = require('./connectorBootstrap');
const { rotateTenantKey } = require('./connector/provisioning');

const KEY = (orgId) => `connector_tenant_key_${orgId}`;
const NC_URL = 'https://cloud.one.example';
const CODE = '424242';
let seq = 0;

before(async () => { await initDB(); });
after(close);
beforeEach(() => { process.env.BEEFLOW_CONNECTOR_PROVISIONING = 'pairing_only'; });

// Each request from its own address: the per-address request limits are not the subject here.
function dispatch(method, url, { headers = {}, body = {} } = {}) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, ip: `198.51.100.${(++seq % 250) + 1}`, body, query: {}, params: {}, headers,
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
        bootstrapRouter(req, res, (err) => reject(err || new Error(`fell through router: ${method} ${url}`)));
    });
}

const bootstrap = ({ instance, email, pairingCode, ncAdmins }) => dispatch('POST', '/connector/bootstrap', {
    body: ncAdmins ? { ncAdmins } : {},
    headers: {
        'x-beeflow-nc-instance-id': instance,
        'x-beeflow-nc-base-url': NC_URL,
        'x-beeflow-nc-admin-uid': 'ncadmin',
        'x-beeflow-nc-admin-email': email,
        ...(pairingCode ? { 'x-beeflow-pairing-code': pairingCode } : {}),
    },
});
const poll = (id) => dispatch('GET', `/connector/bootstrap/pending/${id}`);
const verify = (id, code) => dispatch('POST', `/connector/bootstrap/pending/${id}/verify`, { body: { code } });

/** A fresh organisation with an administrator and a member; ids and addresses are unique per call. */
async function organisation() {
    const n = ++seq;
    const id = `org-s${n}`;
    await pg.query(`INSERT INTO organizations (id, name) VALUES ($1, $2)`, [id, `Org ${n}`]);
    const admin = await account(`admin${n}@corp${n}.example`, id, 'org_admin');
    const member = await account(`member${n}@corp${n}.example`, id, 'member');
    return { id, admin, member, instance: `inst-s${n}`, domain: `corp${n}.example` };
}

async function account(email, organizationId, orgRole) {
    const id = `u-s${++seq}`;
    await pg.query(
        `INSERT INTO users (id, username, email, role, "orgRole", "organizationId", status) VALUES ($1, $2, $2, 'user', $3, $4, 'active')`,
        [id, email, orgRole, organizationId],
    );
    return { id, email };
}

const userRow = async (id) => (await pg.query(`SELECT "organizationId", "orgRole", nc_uid FROM users WHERE id = $1`, [id])).rows[0];
const instanceOf = async (orgId) => (await userStore.getOrganization(orgId)).nc_instance_id || null;

/** What removing an organisation's Nextcloud link does (ncBindingRoutes.js). */
async function unlink(orgId) {
    await userStore.updateOrganization(orgId, { ncInstanceId: null, ncBaseUrl: null, ncAdminUid: null, ncProvisionedAt: null, connectorCallbackUrl: null });
    await configStore.deleteConfig(KEY(orgId), { orgId, userId: 'test' });
}

function assertNoKey(res) {
    assert.equal('tenantKey' in res.body, false, JSON.stringify(res.body));
}

// ═══ The emailed code ═══

test('the code sent to an administrator links the organisation; entered again, also after the link is removed, it answers no key', async () => {
    const o = await organisation();
    const started = await bootstrap({ instance: o.instance, email: o.admin.email });
    assert.equal(started.statusCode, 202);
    assertNoKey(started);
    const id = started.body.pendingId;

    // Not sent yet: the stored code is not accepted.
    assertNoKey(await verify(id, CODE));
    assert.equal((await userStore.retargetNcVerification(id, { email: o.admin.email, uid: 'ncadmin', code: CODE })).status, 'ok');

    const linked = await verify(id, CODE);
    assert.equal(linked.statusCode, 200);
    assert.equal(linked.body.organizationId, o.id);
    assert.equal(linked.body.tenantKey, await configStore.getSecret(KEY(o.id)));
    assert.equal(await instanceOf(o.id), o.instance);

    for (const code of [CODE, '000000']) {
        const again = await verify(id, code);
        assert.equal(again.statusCode, 410);
        assertNoKey(again);
    }

    await unlink(o.id);
    await pg.query(`UPDATE pending_nc_bindings SET expires_at = NOW() - INTERVAL '30 days' WHERE id = $1`, [id]);
    const afterUnlink = await verify(id, CODE);
    assert.equal(afterUnlink.statusCode, 410);
    assertNoKey(afterUnlink);
    assert.equal(await instanceOf(o.id), null);
    assert.equal(await configStore.getSecret(KEY(o.id)), null);
});

test('a member who is not an administrator gets no code and no key, and keeps the role', async () => {
    const o = await organisation();
    const started = await bootstrap({ instance: o.instance, email: o.member.email });
    assert.equal(started.statusCode, 202);
    const id = started.body.pendingId;

    // The answer is the one an administrator gets; no code is made or mailed,
    // and the address on the row stays.
    for (const email of [o.member.email, `it@${o.domain}`]) {
        const retarget = await dispatch('POST', `/connector/bootstrap/pending/${id}/retarget`, { body: { email, uid: 'x' } });
        assert.equal(retarget.statusCode, 200);
        assert.deepEqual(Object.keys(retarget.body).sort(), ['expiresAt', 'maskedEmail', 'ok']);
    }
    const resend = await dispatch('POST', `/connector/bootstrap/pending/${id}/resend`);
    assert.equal(resend.statusCode, 200);
    const after = (await pg.query(`SELECT verification_code_sends AS n, verification_email AS e FROM pending_nc_bindings WHERE id = $1`, [id])).rows[0];
    assert.equal(after.n, 3, 'each request used the row\'s send budget');
    assert.equal(after.e, o.member.email);
    assert.equal((await userStore.verifyPendingNcCode(id, CODE)).status, 'invalid', 'no code that was sent');

    // Even with a code on the row, the row's address has to be an administrator's.
    assert.equal((await userStore.retargetNcVerification(id, { email: o.member.email, uid: 'x', code: CODE })).status, 'ok');
    const res = await verify(id, CODE);
    assert.equal(res.statusCode, 403);
    assertNoKey(res);
    assert.equal(await instanceOf(o.id), null);
    assert.equal((await userRow(o.member.id)).orgRole, 'member');
    assert.equal(await configStore.getSecret(KEY(o.id)), null);
});

// ═══ The row id of a pairing code ═══

test('the row id of a redeemed pairing code answers 404 on the poll route, also after the key was rotated', async () => {
    const o = await organisation();
    const code = await userStore.createOrgPairingCode(o.id, { mintedByUserId: o.admin.id });
    assert.equal((await poll(code.id)).statusCode, 404);

    const redeemed = await bootstrap({ instance: o.instance, email: o.admin.email, pairingCode: code.pairingCode });
    assert.equal(redeemed.statusCode, 200);
    assert.equal(redeemed.body.organizationId, o.id);
    await rotateTenantKey(o.id);

    const res = await poll(code.id);
    assert.equal(res.statusCode, 404);
    assertNoKey(res);
});

// ═══ Existing accounts ═══

test('open provisioning with the address of an account without an organisation: 409, no organisation, the account as it was', async () => {
    process.env.BEEFLOW_CONNECTOR_PROVISIONING = 'open';
    const n = ++seq;
    const solo = await account(`solo${n}@mail.example`, null, '');
    const second = await account(`second${n}@mail.example`, null, '');
    const instance = `inst-open-${n}`;

    const refused = await bootstrap({ instance, email: solo.email });
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.body.code, 'admin_email_conflict');
    assertNoKey(refused);
    assert.equal(await userStore.getOrganizationByNcInstanceId(instance), null);

    const created = await bootstrap({
        instance, email: `fresh${n}@unknown${n}.example`, ncAdmins: [{ uid: 'y', email: second.email }],
    });
    assert.equal(created.statusCode, 200);
    assert.equal(created.body.code, 'fresh_org');
    // A new organisation writes its webhook signing key in the background; let that finish before the database closes.
    for (let i = 0; i < 500 && !(await configStore.getSecret(`org_webhook_signing_key_${created.body.organizationId}`)); i++) {
        await new Promise((r) => setImmediate(r));
    }
    for (const u of [solo, second]) {
        assert.deepEqual(await userRow(u.id), { organizationId: null, orgRole: '', nc_uid: null });
    }
});
