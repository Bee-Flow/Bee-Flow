// @typecheck
/**
 * deleteUser reports an incomplete erasure instead of swallowing it (#338).
 *
 * Against a real Postgres (@electric-sql/pglite behind db.js): most of the
 * optional tables do not exist there, which is the "missing table is not a
 * failure" case. Pinned:
 *   - a failing step rejects with 500 erasure_incomplete naming the step, and
 *     the users row stays, so the same delete can be retried;
 *   - the retry, with the step healthy again, erases and removes the row;
 *   - a missing optional table does not make the erasure incomplete;
 *   - an unknown id is `false`, as before.
 *
 * Run: cd server && node --test stores/user/usersDelete.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../../testUtils/pglitePool');

const { close } = usePglitePool();
const users = require('./users');
const { initDB } = require('./schema');
const { resetErasurePortsForTests, registerErasurePorts } = require('./erasurePorts');
const db = require('../../db');

const stillThere = async (id) => !!(await db.getOne('SELECT id FROM users WHERE id = $1', [id]));

let notebooksDown = false;
before(async () => {
    await initDB();
    assert.strictEqual(await users.createUser({ id: 'leaver', username: 'leaver', passwordHash: '' }), true);
    resetErasurePortsForTests();
    registerErasurePorts({
        notebooks: {
            deleteAllForUser: async () => {
                if (notebooksDown) throw Object.assign(new Error('object storage unreachable'), { code: 'ECONNREFUSED' });
                return { notebooks: 0 };
            },
        },
        projects: { makeTeardown: () => ({ deleteProject: async () => true }) },
    });
});

after(async () => {
    resetErasurePortsForTests();
    await close();
});

test('a failing erasure step rejects with erasure_incomplete and keeps the account for a retry', async () => {
    notebooksDown = true;
    try {
        await assert.rejects(() => users.deleteUser('leaver'), (err) => {
            const e = /** @type {any} */ (err);
            assert.strictEqual(e.status, 500);
            assert.strictEqual(e.code, 'erasure_incomplete');
            assert.strictEqual(e.expose, true);
            assert.deepStrictEqual(e.details.failed, ['notebooks']);
            return true;
        });
    } finally { notebooksDown = false; }
    assert.strictEqual(await stillThere('leaver'), true, 'the row must stay so the delete can be retried');
});

test('the retry erases the rest and removes the account; missing optional tables are no failure', async () => {
    assert.strictEqual(await users.deleteUser('leaver'), true);
    assert.strictEqual(await stillThere('leaver'), false);
});

test('an unknown account is false, nothing is erased', async () => {
    assert.strictEqual(await users.deleteUser('nobody'), false);
});
