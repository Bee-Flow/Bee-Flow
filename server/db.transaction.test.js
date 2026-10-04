/**
 * Unit — db.js transaction + store-init helpers (H1). DB-free: exercises the
 * client-injectable core (_runTransaction), the query instrumentation wrapper
 * (_instrumentClient) and the memoized init factory (makeStoreInit) with fakes.
 * Run: node --test db.transaction.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { _runTransaction, _instrumentClient, makeStoreInit, isSqlStateError } = require('./db');

function fakeClient() {
    const calls = [];
    let released = 0;
    return {
        calls,
        get released() { return released; },
        query: (sql) => { calls.push(sql); return Promise.resolve({ rows: [] }); },
        release: () => { released += 1; },
    };
}

test('_runTransaction commits and returns the callback value', async () => {
    const c = fakeClient();
    const result = await _runTransaction(c, async (client) => {
        await client.query('UPDATE t SET x=1');
        return 42;
    });
    assert.strictEqual(result, 42);
    assert.deepStrictEqual(c.calls, ['BEGIN', 'UPDATE t SET x=1', 'COMMIT']);
    assert.strictEqual(c.released, 1, 'client released exactly once');
});

test('_runTransaction rolls back and rethrows on callback error', async () => {
    const c = fakeClient();
    const boom = new Error('boom');
    await assert.rejects(
        () => _runTransaction(c, async () => { throw boom; }),
        (e) => e === boom,
    );
    assert.deepStrictEqual(c.calls, ['BEGIN', 'ROLLBACK']);
    assert.strictEqual(c.released, 1, 'client released even on error');
});

test('_runTransaction releases even when COMMIT throws', async () => {
    const c = fakeClient();
    c.query = (sql) => {
        c.calls.push(sql);
        if (sql === 'COMMIT') return Promise.reject(new Error('commit failed'));
        return Promise.resolve({ rows: [] });
    };
    await assert.rejects(() => _runTransaction(c, async () => {}));
    assert.strictEqual(c.released, 1);
    assert.ok(c.calls.includes('ROLLBACK'), 'attempts ROLLBACK after failed COMMIT');
});

test('_runTransaction swallows a failing ROLLBACK but keeps the original error', async () => {
    const c = fakeClient();
    const original = new Error('original');
    c.query = (sql) => {
        c.calls.push(sql);
        if (sql === 'ROLLBACK') return Promise.reject(new Error('rollback failed too'));
        if (sql === 'BEGIN') return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [] });
    };
    await assert.rejects(
        () => _runTransaction(c, async () => { throw original; }),
        (e) => e === original,   // the callback error wins, not the rollback error
    );
    assert.strictEqual(c.released, 1);
});

test('_instrumentClient times string queries and passes submittables through untouched', async () => {
    const cursor = { submit() {} };
    const fake = {
        query: (sql) => (typeof sql === 'string' ? Promise.resolve({ rows: [{ ok: 1 }] }) : sql),
        release: () => {},
    };
    _instrumentClient(fake);

    const res = await fake.query('SELECT 1', []);
    assert.deepStrictEqual(res.rows, [{ ok: 1 }], 'string query resolves to rows');

    const back = fake.query(cursor);
    assert.strictEqual(back, cursor, 'submittable returned as-is, not wrapped in a promise');
});

// The three tests below pin the contract that keeps a pooled connection usable
// after a transaction. Breaking any of them does not fail a request — it hangs
// it for ever, with the statement already committed and nothing logged.

test('_instrumentClient forwards the callback form (the shape pg-pool itself uses)', async () => {
    // pg-pool's Pool.query calls client.query(text, values, callback). A
    // wrapper declared (sql, params) drops that callback, pg takes the promise
    // path instead, and the pool waits for a callback that will never come.
    const fake = {
        query: (sql, params, cb) => {
            if (typeof cb === 'function') { cb(null, { rows: [{ n: 7 }] }); return undefined; }
            return Promise.resolve({ rows: [] });
        },
        release: () => {},
    };
    _instrumentClient(fake);

    const rows = await new Promise((resolve, reject) => {
        fake.query('SELECT 7 AS n', [], (err, res) => (err ? reject(err) : resolve(res.rows)));
    });
    assert.deepStrictEqual(rows, [{ n: 7 }], 'the callback fired with the result');
});

test('_instrumentClient hands the client back unmodified on release', () => {
    // The client belongs to the pool, not to us: a wrapper still installed
    // after release() follows the connection to its next borrower.
    const proto = {
        query() { return Promise.resolve({ rows: [] }); },
        release() { this.released = true; },
    };
    const fake = Object.create(proto);
    _instrumentClient(fake);

    assert.ok(Object.prototype.hasOwnProperty.call(fake, 'query'), 'wrapped during the checkout');
    fake.release();
    assert.strictEqual(Object.prototype.hasOwnProperty.call(fake, 'query'), false,
        'own query deleted, so the prototype method comes back — not a bound copy');
    assert.strictEqual(fake.query, proto.query);
    assert.strictEqual(fake.released, true, 'the real release still ran');
});

test('_instrumentClient does not stack a second wrapper on the same checkout', () => {
    const fake = { query: () => Promise.resolve({ rows: [] }), release: () => {} };
    _instrumentClient(fake);
    const once = fake.query;
    _instrumentClient(fake);
    assert.strictEqual(fake.query, once, 'second call is a no-op while still wrapped');
});

test('makeStoreInit runs schemaFn exactly once across concurrent + repeat calls', async () => {
    let runs = 0;
    const init = makeStoreInit('TestStore', async () => { runs += 1; });
    await Promise.all([init(), init(), init()]);
    await init();
    assert.strictEqual(runs, 1, 'schema created once despite 4 calls');
});

test('makeStoreInit clears the memo on failure so the next call retries', async () => {
    let attempts = 0;
    const init = makeStoreInit('FlakyStore', async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('DB not ready');
    });
    await assert.rejects(() => init(), /DB not ready/);
    await init();   // retry succeeds
    assert.strictEqual(attempts, 2, 'retried after the first failure');
});

// --- isSqlStateError ---------------------------------------------------
// Capability probes cache their answer, so misreading "never reached the
// database" as "the database said no" is what silently disabled pgvector for
// a whole process lifetime after a boot-time pool timeout.

// Shape pg gives a server-sent error: SQLSTATE plus the parsed ErrorResponse
// fields. `severity` is the half that libuv errors can never have.
const dbError = (code) => Object.assign(new Error('nope'), {
    code, severity: 'ERROR', file: 'extension.c', automation: 'CreateExtension',
});

test('isSqlStateError: true for a Postgres SQLSTATE rejection', () => {
    for (const code of ['42P01', '58P01', '42501', '0A000']) {
        assert.strictEqual(isSqlStateError(dbError(code)), true, code);
    }
});

test('isSqlStateError: false when the database was never reached', () => {
    // pg pool timeout — an Error with no code at all.
    assert.strictEqual(isSqlStateError(new Error('Connection terminated due to connection timeout')), false);
    // libuv socket failures. EPIPE is the trap: five uppercase characters, so
    // it passes a SQLSTATE-shaped regex and only `severity` rules it out.
    for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE']) {
        assert.strictEqual(isSqlStateError(Object.assign(new Error('sock'), { code })), false, code);
    }
});

test('isSqlStateError: false for non-errors and non-string codes', () => {
    assert.strictEqual(isSqlStateError(undefined), false);
    assert.strictEqual(isSqlStateError(null), false);
    assert.strictEqual(isSqlStateError({}), false);
    assert.strictEqual(isSqlStateError(Object.assign(new Error('x'), { code: 42501, severity: 'ERROR' })), false);
});
