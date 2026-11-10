'use strict';
/**
 * The Bee Flow user id of a Nextcloud account (utils/ncUserId.mts).
 *
 * Run: node --test server/utils/ncUserId.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { plainNcUserId, hashedNcUserId, resolveNcUserId, NC_USER_SLUG_MAX } = require('./ncUserId.mts');

const sha8 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8);

// The ids written out independently of the helper, one expression per place
// that creates a user: the sync, the sign-in, the pairing of the admin.
const syncId = (org, uid) => `nc_${org}_${String(uid || '').replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 40) || 'user'}`;
const signInId = (org, uid) => `nc_${org}_${uid.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 40)}`;
const adminId = (org, uid) => `nc_${org}_${String(uid || 'nc')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'nc'}`;

const UIDS = [
    // plain
    'ann', 'Ann', 'a', '0', 'bob42', 'john-doe', 'a-b-c', 'UPPER', 'MixedCase9', '-leading', 'trailing-',
    '3f2b8a1c-9d4e-4f6a-8b7c-1d2e3f4a5b6c', 'a'.repeat(40), '0123456789abcdef0123456789abcdef01234567',
    'john-doe-30f69670', 'deadbeef',
    // dotted, underscore, e-mail-like, with spaces
    'john.doe', 'j.r.r.tolkien', 'john_doe', '_x_', 'ann@acme.example', 'Ann.Lee@Acme.Example', 'Jan de Vries', ' padded ',
    "o'neil", 'ünïcödé', '@@@', '.', 'john--doe',
    // 64 characters
    'x'.repeat(64), `${'a'.repeat(40)}${'1'.repeat(24)}`, `${'long.name.'.repeat(6)}abcd`,
];

/** A store of user rows by id, with the lookup the resolver takes. */
function store(rows = []) {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const asked = [];
    return {
        byId,
        asked,
        deps: { getUser: async (id) => { asked.push(id); return byId.get(id) || null; } },
        /** Resolve and, when the id is free, create the row (what a caller does). */
        async add(orgId, ncUid, form) {
            const r = await resolveNcUserId({ orgId, ncUid, form }, this.deps);
            if (r.state === 'free') byId.set(r.id, { id: r.id, organizationId: orgId, nc_uid: ncUid });
            return r;
        },
    };
}

test('no row has the id: the id is the plain one, byte for byte, for every uid', async () => {
    assert.equal(UIDS.filter((u) => u.length === 64).length, 3);
    for (const uid of UIDS) {
        const s = store();
        assert.deepEqual(await resolveNcUserId({ orgId: 'acme', ncUid: uid }, s.deps), { state: 'free', id: syncId('acme', uid), user: null }, uid);
        assert.equal(syncId('acme', uid), signInId('acme', uid), uid);
        assert.deepEqual(s.asked, [syncId('acme', uid)], uid);
        assert.deepEqual(
            await resolveNcUserId({ orgId: 'acme', ncUid: uid, form: 'admin' }, store().deps),
            { state: 'free', id: adminId('acme', uid), user: null }, uid,
        );
    }
});

test('the plain id of some uids, written out', () => {
    assert.equal(plainNcUserId('org1', 'ann'), 'nc_org1_ann');
    assert.equal(plainNcUserId('org1', 'john.doe'), 'nc_org1_john-doe');
    assert.equal(plainNcUserId('org1', 'john_doe'), 'nc_org1_john-doe');
    assert.equal(plainNcUserId('org1', 'ann@acme.example'), 'nc_org1_ann-acme-example');
    assert.equal(plainNcUserId('org1', 'Jan de Vries'), 'nc_org1_Jan-de-Vries');
    assert.equal(plainNcUserId('org1', 'x'.repeat(64)), `nc_org1_${'x'.repeat(40)}`);
    assert.equal(plainNcUserId('org1', '.Root.Admin.', 'admin'), 'nc_org1_root-admin');
});

test('an empty uid takes the fallback of its form', () => {
    for (const empty of ['', null, undefined]) {
        assert.equal(plainNcUserId('org1', empty), syncId('org1', empty));
        assert.equal(plainNcUserId('org1', empty), 'nc_org1_user');
        assert.equal(plainNcUserId('org1', empty, 'admin'), adminId('org1', empty));
        assert.equal(plainNcUserId('org1', empty, 'admin'), 'nc_org1_nc');
    }
    assert.equal(plainNcUserId('org1', '@@@', 'admin'), 'nc_org1_nc');
});

test('a sign-in without a uid builds the id from the e-mail address', async () => {
    const r = await resolveNcUserId({ orgId: 'org1', ncUid: null, source: 'ann@acme.example' }, store().deps);
    assert.deepEqual(r, { state: 'free', id: signInId('org1', 'ann@acme.example'), user: null });
});

test('john.doe then john_doe in one organisation are two users', async () => {
    const s = store();
    const dotted = await s.add('org1', 'john.doe');
    const underscored = await s.add('org1', 'john_doe');
    const dashed = await s.add('org1', 'john-doe');
    assert.deepEqual(dotted, { state: 'free', id: 'nc_org1_john-doe', user: null });
    assert.deepEqual(underscored, { state: 'free', id: `nc_org1_john-doe-${sha8('john_doe')}`, user: null });
    assert.deepEqual(dashed, { state: 'free', id: `nc_org1_john-doe-${sha8('john-doe')}`, user: null });
    assert.equal(s.byId.size, 3);
    assert.deepEqual([...s.byId.values()].map((u) => u.nc_uid), ['john.doe', 'john_doe', 'john-doe']);
});

test('two 64-character uids that share their first 40 characters are two users', async () => {
    const a = `${'a'.repeat(40)}${'1'.repeat(24)}`;
    const b = `${'a'.repeat(40)}${'2'.repeat(24)}`;
    const s = store();
    assert.equal((await s.add('org1', a)).id, `nc_org1_${'a'.repeat(40)}`);
    assert.equal((await s.add('org1', b)).id, `nc_org1_${'a'.repeat(31)}-${sha8(b)}`);
    assert.equal(s.byId.size, 2);
});

test('the same uid in two organisations: each gets its plain id', async () => {
    const s = store();
    assert.deepEqual(await s.add('org1', 'john.doe'), { state: 'free', id: 'nc_org1_john-doe', user: null });
    assert.deepEqual(await s.add('org2', 'john.doe'), { state: 'free', id: 'nc_org2_john-doe', user: null });
    assert.deepEqual(await s.add('org2', 'ann'), { state: 'free', id: 'nc_org2_ann', user: null });
});

test('a row with the plain id and the same Nextcloud uid is that user: no other id is chosen', async () => {
    for (const row of [
        { id: 'nc_org1_john-doe', organizationId: 'org1', nc_uid: 'john.doe' },
        { id: 'nc_org1_john-doe', organizationId: 'org1', ncUid: 'john.doe' },
    ]) {
        const s = store([row]);
        assert.deepEqual(await s.add('org1', 'john.doe'), { state: 'own', id: 'nc_org1_john-doe', user: row });
        assert.deepEqual(s.asked, ['nc_org1_john-doe']);
        assert.equal(s.byId.size, 1);
    }
});

test('a row with the plain id that is no Nextcloud account, or one of another organisation, is another account', async () => {
    const expected = { state: 'free', id: `nc_org1_john-doe-${sha8('john.doe')}`, user: null };
    for (const row of [
        { id: 'nc_org1_john-doe', organizationId: 'org1' },
        { id: 'nc_org1_john-doe', organizationId: 'org1', nc_uid: null },
        { id: 'nc_org1_john-doe', organizationId: 'org1', nc_uid: 'John.Doe' },
        { id: 'nc_org1_john-doe', organizationId: 'org9', nc_uid: 'john.doe' },
        { id: 'nc_org1_john-doe', nc_uid: 'john.doe' },
    ]) {
        assert.deepEqual(await resolveNcUserId({ orgId: 'org1', ncUid: 'john.doe' }, store([row]).deps), expected, JSON.stringify(row));
    }
    // A sign-in without a uid is never the account of a row.
    const row = { id: 'nc_org1_ann-acme-example', organizationId: 'org1', nc_uid: 'ann@acme.example' };
    const r = await resolveNcUserId({ orgId: 'org1', ncUid: '', source: 'ann@acme.example' }, store([row]).deps);
    assert.deepEqual(r, { state: 'free', id: `nc_org1_ann-acme-example-${sha8('ann@acme.example')}`, user: null });
});

test('a row without a stored uid and with the account\'s e-mail address is that user, where the caller gives the address', async () => {
    const account = { orgId: 'org1', ncUid: 'john.doe', email: 'John.Doe@acme.example' };
    const hashed = { state: 'free', id: `nc_org1_john-doe-${sha8('john.doe')}`, user: null };
    for (const row of [
        { id: 'nc_org1_john-doe', organizationId: 'org1', nc_uid: null, email: 'john.doe@acme.example' },
        { id: 'nc_org1_john-doe', organizationId: 'org1', email: ' John.Doe@Acme.Example ' },
    ]) {
        assert.deepEqual(await resolveNcUserId(account, store([row]).deps), { state: 'own', id: 'nc_org1_john-doe', user: row }, JSON.stringify(row));
        // Without the address the row says nothing about this account.
        assert.deepEqual(await resolveNcUserId({ orgId: 'org1', ncUid: 'john.doe' }, store([row]).deps), hashed);
    }
    // Another address, no address, another organisation, or a stored uid of its own: another account.
    for (const row of [
        { id: 'nc_org1_john-doe', organizationId: 'org1', nc_uid: null, email: 'jane@acme.example' },
        { id: 'nc_org1_john-doe', organizationId: 'org1', nc_uid: null },
        { id: 'nc_org1_john-doe', organizationId: 'org1', nc_uid: null, email: '' },
        { id: 'nc_org1_john-doe', organizationId: 'org9', nc_uid: null, email: 'john.doe@acme.example' },
        { id: 'nc_org1_john-doe', organizationId: 'org1', nc_uid: 'john_doe', email: 'john.doe@acme.example' },
    ]) {
        assert.deepEqual(await resolveNcUserId(account, store([row]).deps), hashed, JSON.stringify(row));
    }
    assert.deepEqual(await resolveNcUserId({ ...account, email: '' }, store([{ id: 'nc_org1_john-doe', organizationId: 'org1', email: '' }]).deps), hashed);
});

test('the id with a hash: own when its row is this account, taken when it is another one', async () => {
    const plain = { id: 'nc_org1_john-doe', organizationId: 'org1', nc_uid: 'john.doe' };
    const hashedId = `nc_org1_john-doe-${sha8('john_doe')}`;
    const mine = { id: hashedId, organizationId: 'org1', nc_uid: 'john_doe' };
    assert.deepEqual(await resolveNcUserId({ orgId: 'org1', ncUid: 'john_doe' }, store([plain, mine]).deps), { state: 'own', id: hashedId, user: mine });
    // A uid that is spelled like that id holds it: the answer says so.
    const other = { id: hashedId, organizationId: 'org1', nc_uid: `john-doe-${sha8('john_doe')}` };
    const s = store([plain, other]);
    assert.deepEqual(await resolveNcUserId({ orgId: 'org1', ncUid: 'john_doe' }, s.deps), { state: 'taken', id: hashedId, user: other });
    assert.deepEqual(s.asked, ['nc_org1_john-doe', hashedId]);
});

test('the id with a hash is at most 40 characters of letters, digits and dashes, and the same every time', () => {
    for (const uid of UIDS) {
        for (const form of ['member', 'admin']) {
            const id = hashedNcUserId('o', uid, form);
            const slug = id.slice('nc_o_'.length);
            assert.ok(slug.length >= 8 && slug.length <= NC_USER_SLUG_MAX, `${uid} -> ${slug}`);
            assert.match(slug, /^([a-zA-Z0-9-]+-)?[0-9a-f]{8}$/, `${uid} -> ${slug}`);
            assert.ok(slug.endsWith(sha8(uid)), `${uid} -> ${slug}`);
            assert.equal(hashedNcUserId('o', uid, form), id);
            assert.notEqual(id, plainNcUserId('o', uid, form));
        }
    }
    assert.equal(hashedNcUserId('org1', 'x'.repeat(64)), `nc_org1_${'x'.repeat(31)}-${sha8('x'.repeat(64))}`);
    // A uid of other characters only: the hash alone.
    assert.equal(hashedNcUserId('org1', '@@@'), `nc_org1_${sha8('@@@')}`);
    assert.equal(hashedNcUserId('org1', 'Root.Admin', 'admin'), `nc_org1_root-admin-${sha8('Root.Admin')}`);
});
