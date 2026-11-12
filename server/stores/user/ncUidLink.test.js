/**
 * The Nextcloud uid written by a link (ncUidLink.mts, setNcUidIfUnchanged),
 * against a real Postgres (@electric-sql/pglite behind db.js,
 * testUtils/pglitePool.js) with the real schema; nothing mocked.
 *
 *   - written once: only while the stored uid is the one the link names;
 *   - never on a user of another organisation;
 *   - never a uid another user of the organisation holds.
 *
 * Run: cd server && node --test stores/user/ncUidLink.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const { initDB } = require('./schema');
const { setNcUidIfUnchanged } = require('./ncUidLink.mts');

before(async () => {
    await initDB();
    for (const id of ['org-link-a', 'org-link-b']) {
        await pg.query(`INSERT INTO organizations (id, name) VALUES ($1, $2)`, [id, id]);
    }
    const users = [
        ['u-link-1', 'org-link-a', null],
        ['u-link-2', 'org-link-a', 'held'],
        ['u-link-3', 'org-link-b', null],
    ];
    for (const [id, org, uid] of users) {
        await pg.query(`INSERT INTO users (id, username, email, "organizationId", nc_uid) VALUES ($1, $1, $2, $3, $4)`, [id, `${id}@example.org`, org, uid]);
    }
});
after(close);

const uidOf = async (id) => (await pg.query(`SELECT nc_uid FROM users WHERE id = $1`, [id])).rows[0].nc_uid;

test('a user without a uid gets it once; the same link again writes nothing', async () => {
    assert.equal(await setNcUidIfUnchanged('u-link-1', 'org-link-a', 'ann', ''), true);
    assert.equal(await uidOf('u-link-1'), 'ann');
    assert.equal(await setNcUidIfUnchanged('u-link-1', 'org-link-a', 'ann', ''), false);
    assert.equal(await setNcUidIfUnchanged('u-link-1', 'org-link-a', 'bea', ''), false);
    assert.equal(await uidOf('u-link-1'), 'ann');
});

test('a link issued for the stored uid replaces it', async () => {
    assert.equal(await setNcUidIfUnchanged('u-link-1', 'org-link-a', 'ann2', 'ann'), true);
    assert.equal(await uidOf('u-link-1'), 'ann2');
});

test('a uid another user of the organisation holds is not written', async () => {
    assert.equal(await setNcUidIfUnchanged('u-link-1', 'org-link-a', 'held', 'ann2'), false);
    assert.equal(await uidOf('u-link-1'), 'ann2');
    assert.equal(await uidOf('u-link-2'), 'held');
});

test('the organisation must be the user\'s own; another organisation\'s holder does not stand in the way', async () => {
    assert.equal(await setNcUidIfUnchanged('u-link-3', 'org-link-a', 'cee', ''), false);
    assert.equal(await uidOf('u-link-3'), null);
    assert.equal(await setNcUidIfUnchanged('u-link-3', 'org-link-b', 'held', ''), true);
    assert.equal(await uidOf('u-link-3'), 'held');
});

test('an empty user, organisation or uid writes nothing', async () => {
    assert.equal(await setNcUidIfUnchanged('', 'org-link-a', 'x', ''), false);
    assert.equal(await setNcUidIfUnchanged('u-link-1', '', 'x', 'ann2'), false);
    assert.equal(await setNcUidIfUnchanged('u-link-1', 'org-link-a', '', 'ann2'), false);
});
