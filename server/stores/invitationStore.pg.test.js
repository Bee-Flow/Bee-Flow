// @typecheck
'use strict';
/**
 * The invitation store against a real database: the token column holds a
 * hash, a row from before the hashing is still found and rewritten, and a
 * token is claimed exactly once.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgliteDb, dbFacade } = require('../testUtils/pgliteDb');
const { createInvitationStore, hashToken } = require('./invitationStore');

const { pg, db } = pgliteDb();
const facade = dbFacade(db);
const store = createInvitationStore({
    db: {
        run: (sql, params) => db.query(sql, params),
        getOne: facade.getOne,
        getAll: facade.getAll,
        exec: (sql) => pg.exec(sql),
    },
});

before(() => store.initDB());
after(() => pg.close());

async function rowOf(id) {
    return (await pg.query('SELECT * FROM invitations WHERE id = $1', [id])).rows[0];
}

test('the row keeps the hash of the token the mail carries, and the token still resolves', async () => {
    const made = await store.createInvitation({ email: 'Ann@Example.test', organizationId: 'acme', invitedBy: 'root' });
    assert.ok(made);
    const row = await rowOf(made.id);
    assert.equal(row.token, hashToken(made.token));
    assert.notEqual(row.token, made.token);
    assert.equal(row.email, 'ann@example.test');
    const found = await store.getInvitationByToken(made.token);
    assert.equal(found.id, made.id);
    assert.equal(await store.getInvitationByToken(made.token.slice(1)), null);
    assert.equal(await store.getInvitationByToken(''), null);
});

test('a row written with the token in clear is found once and then holds the hash', async () => {
    await pg.query(
        `INSERT INTO invitations (id, email, organization_id, invited_by, role, token, status, expires_at)
         VALUES ('legacy', 'old@example.test', 'acme', 'root', 'user', 'plain-token-value', 'pending', NOW() + INTERVAL '1 day')`,
    );
    const found = await store.getInvitationByToken('plain-token-value');
    assert.equal(found.id, 'legacy');
    assert.equal((await rowOf('legacy')).token, hashToken('plain-token-value'));
    assert.equal((await store.getInvitationByToken('plain-token-value')).id, 'legacy');
});

test('a token is claimed exactly once; a released claim can be taken again', async () => {
    const made = await store.createInvitation({ email: 'bob@example.test', organizationId: 'acme', invitedBy: 'root' });
    assert.ok(made);
    const [first, second] = await Promise.all([store.markAccepted(made.token), store.markAccepted(made.token)]);
    assert.deepEqual([first, second].sort(), [false, true], 'one of two racing claims wins');
    assert.equal(await store.markAccepted(made.token), false);
    assert.equal(await store.getInvitationByToken(made.token), null, 'a claimed invitation no longer resolves');
    assert.equal(await store.releaseClaim(made.id), true);
    assert.equal((await store.getInvitationByToken(made.token)).id, made.id);
    assert.equal(await store.markAccepted(made.token), true);
    assert.equal(await store.releaseClaim('no-such-id'), false);
});
