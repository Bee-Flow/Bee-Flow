// @typecheck
/**
 * withConfigGroup against a real Postgres (PGlite, testUtils/pgliteDb.js, with
 * the real transaction): the advisory lock on the group's key is held while the
 * work runs, every read and write goes through the same transaction, COMMIT
 * makes them visible and then busts the written keys' caches, and a throw rolls
 * back with no cache invalidation.
 *
 * Run: cd server && node --test stores/configStoreGroup.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { pgliteDb } = require('../testUtils/pgliteDb');
const { createWithConfigGroup } = require('./configStoreGroup');

const { pg, db } = pgliteDb();

test.before(async () => {
    await pg.exec(`CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
        INSERT INTO config (key, value) VALUES ('a', '{"n":1}')`);
});
test.after(() => pg.close());

function harness() {
    const written = [];
    let inits = 0;
    /** @type {any} */
    let client = null;
    const withConfigGroup = createWithConfigGroup({
        initDB: async () => { inits += 1; },
        // PGlite is one session: a read while the group runs goes through the group's own client.
        withTransaction: (fn) => db.tx((c) => { client = c; return fn(c); }),
        onWritten: (key) => written.push(key),
    });
    return { written, inits: () => inits, withConfigGroup, client: () => client };
}
const valueOf = async (key) => (await pg.query('SELECT value FROM config WHERE key = $1', [key])).rows[0]?.value;

test('reads and writes run under the lock, COMMIT lands them, then the written keys are invalidated', async () => {
    const h = harness();
    const out = await h.withConfigGroup('lock-key', async (io) => {
        const locks = await io.keysLike('%');
        const before = await io.get('a');
        await io.set('b', { n: 2 });
        assert.deepStrictEqual(await io.get('b'), { n: 2 }, 'the write is visible inside the group');
        assert.deepStrictEqual(h.written, [], 'no invalidation before COMMIT');
        return { before, locks };
    });
    assert.deepStrictEqual(out.before, { n: 1 });
    assert.deepStrictEqual(out.locks.sort(), ['a']);
    assert.strictEqual(await valueOf('b'), '{"n":2}');
    assert.deepStrictEqual(h.written, ['b']);
    assert.strictEqual(h.inits(), 1);
});

test('the advisory lock on the key is held while the work runs', async () => {
    const h = harness();
    const held = await h.withConfigGroup('lock-key', async () => {
        const { rows } = await h.client().query("SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted");
        return rows[0].n;
    });
    assert.strictEqual(held, 1);
});

test('a throw rolls back and invalidates nothing', async () => {
    const h = harness();
    await assert.rejects(() => h.withConfigGroup('lock-key', async (io) => {
        await io.set('c', { n: 3 });
        throw new Error('boom');
    }), /boom/);
    assert.strictEqual(await valueOf('c'), undefined, 'the write is rolled back');
    assert.deepStrictEqual(h.written, []);
});
