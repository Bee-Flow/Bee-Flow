// @typecheck
/**
 * withConfigGroup against a fake client: the advisory lock comes first, every
 * read/write uses the same client, COMMIT ends it, and a throw rolls back with
 * no cache invalidation.
 *
 * Run: node --test stores/configStoreGroup.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { createWithConfigGroup } = require('./configStoreGroup');

function harness() {
    const log = [];
    const written = [];
    const rows = new Map([['a', JSON.stringify({ n: 1 })]]);
    const client = {
        async query(sql, params) {
            log.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
            if (/SELECT value/.test(sql)) return { rows: rows.has(params[0]) ? [{ value: rows.get(params[0]) }] : [] };
            if (/SELECT key/.test(sql)) return { rows: [...rows.keys()].map((key) => ({ key })) };
            if (/INSERT INTO config/.test(sql)) rows.set(params[0], params[1]);
            return { rows: [] };
        },
    };
    const withTransaction = async (fn) => {
        log.push('BEGIN');
        try {
            const out = await fn(client);
            log.push('COMMIT');
            return out;
        } catch (e) {
            log.push('ROLLBACK');
            throw e;
        }
    };
    const withConfigGroup = createWithConfigGroup({
        initDB: async () => { log.push('init'); },
        withTransaction,
        onWritten: (key) => written.push(key),
    });
    return { log, written, rows, withConfigGroup };
}

test('lock first, reads and writes on the same client, COMMIT, then invalidation', async () => {
    const h = harness();
    const out = await h.withConfigGroup('lock-key', async (io) => {
        const before = await io.get('a');
        await io.set('b', { n: 2 });
        await io.keysLike('%');
        return before;
    });
    assert.deepStrictEqual(out, { n: 1 });
    assert.deepStrictEqual(h.log, [
        'init', 'BEGIN', 'SELECT pg_advisory_xact_lock(hashtext($1))', 'SELECT value FROM',
        'INSERT INTO config', 'SELECT key FROM', 'COMMIT',
    ]);
    assert.deepStrictEqual(h.written, ['b']);
});

test('a throw rolls back and invalidates nothing', async () => {
    const h = harness();
    await assert.rejects(() => h.withConfigGroup('lock-key', async (io) => {
        await io.set('b', { n: 2 });
        throw new Error('boom');
    }), /boom/);
    assert.strictEqual(h.log.at(-1), 'ROLLBACK');
    assert.ok(!h.log.includes('COMMIT'));
    assert.deepStrictEqual(h.written, []);
});
