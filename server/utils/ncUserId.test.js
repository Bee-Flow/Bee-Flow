'use strict';
/**
 * The Bee Flow user id of a Nextcloud account (utils/ncUserId.mts).
 *
 * Run: node --test server/utils/ncUserId.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { ncUserId, ncUserSlug, NC_USER_SLUG_MAX } = require('./ncUserId.mts');

const sha8 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8);

// The id of a plain uid, written out independently of the helper: the uid
// itself behind the organisation prefix.
const PLAIN_UIDS = [
    'ann', 'Ann', 'a', '0', 'bob42', 'john-doe', 'a-b-c', 'UPPER', 'MixedCase9',
    '-leading', 'trailing-',
    // An LDAP UUID (36 characters) and a uid of exactly 40.
    '3f2b8a1c-9d4e-4f6a-8b7c-1d2e3f4a5b6c',
    'a'.repeat(40),
    '0123456789abcdef0123456789abcdef01234567',
];

test('a plain uid (letters, digits, dashes, at most 40) is its own id', () => {
    for (const uid of PLAIN_UIDS) {
        assert.equal(ncUserId('org1', uid), `nc_org1_${uid}`, uid);
        assert.equal(ncUserSlug(uid), uid, uid);
        // No hash is added: the slug is exactly as long as the uid.
        assert.equal(ncUserSlug(uid).length, uid.length, uid);
    }
});

test('a plain uid gets the id that replacing other characters and cutting to 40 gives', () => {
    const plainFormula = (org, uid) => `nc_${org}_${uid.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 40)}`;
    for (const uid of PLAIN_UIDS) assert.equal(ncUserId('acme', uid), plainFormula('acme', uid), uid);
});

test('uids that differ only in punctuation get different ids', () => {
    const dotted = ncUserId('org1', 'john.doe');
    const underscored = ncUserId('org1', 'john_doe');
    const dashed = ncUserId('org1', 'john-doe');
    assert.equal(dotted, `nc_org1_john-doe-${sha8('john.doe')}`);
    assert.equal(underscored, `nc_org1_john-doe-${sha8('john_doe')}`);
    assert.equal(dashed, 'nc_org1_john-doe');
    assert.equal(new Set([dotted, underscored, dashed]).size, 3);
    // A run of dashes is one dash in the slug, so that uid gets a hash too.
    assert.equal(ncUserId('org1', 'john--doe'), `nc_org1_john-doe-${sha8('john--doe')}`);
});

test('two 64-character uids that share their first 40 characters get different ids', () => {
    const a = `${'a'.repeat(40)}${'1'.repeat(24)}`;
    const b = `${'a'.repeat(40)}${'2'.repeat(24)}`;
    assert.equal(a.length, 64);
    const idA = ncUserId('org1', a);
    const idB = ncUserId('org1', b);
    assert.notEqual(idA, idB);
    assert.equal(idA, `nc_org1_${'a'.repeat(31)}-${sha8(a)}`);
    assert.equal(idB, `nc_org1_${'a'.repeat(31)}-${sha8(b)}`);
});

test('a slug is never longer than 40 characters and holds only letters, digits and dashes', () => {
    const uids = [
        ...PLAIN_UIDS, 'john.doe', 'ann@example.org', "o'neil", 'a b', 'ünïcödé', '@@@', '.', 'x'.repeat(41),
        'x'.repeat(64), `${'long.name.'.repeat(6)}@example.org`, `${'-'.repeat(35)}.tail`,
    ];
    for (const uid of uids) {
        const slug = ncUserSlug(uid);
        assert.ok(slug.length > 0 && slug.length <= NC_USER_SLUG_MAX, `${uid} -> ${slug}`);
        assert.match(slug, /^[a-zA-Z0-9-]+$/, `${uid} -> ${slug}`);
    }
});

test('a uid of other characters only is the hash alone', () => {
    assert.equal(ncUserSlug('@@@'), sha8('@@@'));
    assert.equal(ncUserSlug('ü'), sha8('ü'));
});

test('the id is the same every time and belongs to one organisation', () => {
    assert.equal(ncUserId('org1', 'john.doe'), ncUserId('org1', 'john.doe'));
    assert.notEqual(ncUserId('org1', 'john.doe'), ncUserId('org2', 'john.doe'));
    assert.ok(ncUserId('org2', 'ann').startsWith('nc_org2_'));
});

test('an e-mail address as source gets a hash', () => {
    assert.equal(ncUserId('org1', 'ann@acme.example'), `nc_org1_ann-acme-example-${sha8('ann@acme.example')}`);
});

test('lowercase folds the uid first; folding alone adds no hash', () => {
    assert.equal(ncUserId('org1', 'Admin', { lowercase: true }), 'nc_org1_admin');
    assert.equal(ncUserId('org1', 'Root.Admin', { lowercase: true }), `nc_org1_root-admin-${sha8('root.admin')}`);
});

test('an empty uid takes the fallback', () => {
    assert.equal(ncUserId('org1', ''), 'nc_org1_user');
    assert.equal(ncUserId('org1', null), 'nc_org1_user');
    assert.equal(ncUserId('org1', undefined, { fallback: 'nc' }), 'nc_org1_nc');
});

test('a plain uid is never the slug of another uid: one that ends like a hashed slug gets a hash too', () => {
    const dotted = ncUserId('org1', 'john.doe');
    const lookalike = `john-doe-${sha8('john.doe')}`;
    assert.equal(dotted, `nc_org1_${lookalike}`);
    assert.equal(ncUserId('org1', lookalike), `nc_org1_${lookalike}-${sha8(lookalike)}`);
    assert.notEqual(ncUserId('org1', lookalike), dotted);
    // The hash alone (a uid of other characters only) and a uid that is 8 hex characters.
    const bare = sha8('@@@');
    assert.equal(ncUserId('org1', '@@@'), `nc_org1_${bare}`);
    assert.equal(ncUserId('org1', bare), `nc_org1_${bare}-${sha8(bare)}`);
    // A long look-alike still fits in 40 characters.
    const long = `${'a'.repeat(31)}-deadbeef`;
    assert.equal(long.length, 40);
    assert.equal(ncUserSlug(long), `${'a'.repeat(31)}-${sha8(long)}`);
    // Upper-case hex and a longer last part are no hash tail.
    assert.equal(ncUserSlug('john-doe-30F69670'), 'john-doe-30F69670');
    assert.equal(ncUserSlug('john-doe-30f696701'), 'john-doe-30f696701');
});
