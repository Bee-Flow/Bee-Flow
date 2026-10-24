// @typecheck
/**
 * deleteUser / deleteOrganization resolve BOTH erasure ports before the first
 * write. With the ports unregistered the call rejects and the user row (and the
 * organisation's members) are still there: no half-erased account.
 *
 * Run: cd server && node --test stores/user/users.erasurePorts.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../../testUtils/pglitePool');

const { close } = usePglitePool();
const users = require('./users');
const organizations = require('./organizations');
const { initDB } = require('./schema');
const { resetErasurePortsForTests, registerErasurePorts } = require('./erasurePorts');
const db = require('../../db');

before(async () => {
    await initDB();
    await organizations.createOrganization({ id: 'org1', name: 'Acme' }, { autoGrantTrial: false });
    for (const id of ['alice', 'bob']) {
        assert.strictEqual(await users.createUser({ id, username: id, passwordHash: '', organizationId: 'org1', orgRole: 'member' }), true);
    }
});

after(close);

const stillThere = async (id) => !!(await db.getOne('SELECT id FROM users WHERE id = $1', [id]));

test('deleteUser with an unregistered port rejects before any write', async () => {
    resetErasurePortsForTests();
    await assert.rejects(() => users.deleteUser('alice'), /Erasure port 'notebooks' is not registered/);
    assert.strictEqual(await stillThere('alice'), true);

    // Notebooks registered, projects not: still refused before the DELETE.
    registerErasurePorts({ notebooks: { deleteAllForUser: async () => ({ notebooks: 0 }) } });
    await assert.rejects(() => users.deleteUser('alice'), /Erasure port 'projects' is not registered/);
    assert.strictEqual(await stillThere('alice'), true);
    resetErasurePortsForTests();
});

test('deleteOrganization with an unregistered port rejects before any member is touched', async () => {
    resetErasurePortsForTests();
    await assert.rejects(() => organizations.deleteOrganization('org1'), /not registered/);
    assert.strictEqual(await stillThere('alice'), true);
    assert.strictEqual(await stillThere('bob'), true);
});
