/**
 * Unit tests for the Firebird driver wrapper, against a fake driver (no sockets).
 * Run: node --test integrations/firebirdClient.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { runQuery, mapFirebirdError, _setDriverForTests } = require('./firebirdClient');

const PASSWORD = 'pw-Zx9!secret-4471';
const CREDS = { host: 'db.internal', port: 3050, database: '/data/main.fdb', user: 'READER', password: PASSWORD, charset: 'WIN1252' };
const ISOLATION = ['read_committed', 'no_rec_version'];

/**
 * Fake node-firebird: records attach options, transaction options, every statement and the
 * lifecycle; `scripted` is rows, an Error, or a function (sql, params) => rows | Error.
 */
function makeDriver(scripted, { attachError, commitError } = {}) {
    const rec = { attach: [], tx: [], statements: [], events: [] };
    const driver = {
        ISOLATION_READ_COMMITTED_READ_ONLY: ISOLATION,
        attachAsync: async (options) => {
            rec.attach.push(options);
            if (attachError) throw attachError;
            return {
                transactionAsync: async (txOptions) => {
                    rec.tx.push(txOptions);
                    return {
                        sequentiallyAsync: async (sql, params, on, options) => {
                            rec.statements.push({ sql, params, options });
                            const out = typeof scripted === 'function' ? scripted(sql, params) : scripted;
                            if (out instanceof Error) throw out;
                            let i = 0;
                            for (const row of out) await on(row, i++);
                        },
                        commitAsync: async () => { rec.events.push('commit'); if (commitError) throw commitError; },
                        rollbackAsync: async () => { rec.events.push('rollback'); },
                    };
                },
                detachAsync: async () => { rec.events.push('detach'); },
            };
        },
    };
    return { driver, rec };
}

test.afterEach(() => { _setDriverForTests(null); delete process.env.FIREBIRD_STATEMENT_TIMEOUT_MS; });

test('attaches with the credential options and runs in a read-only transaction', async () => {
    const { driver, rec } = makeDriver([{ A: 1 }]);
    _setDriverForTests(driver);
    const out = await runQuery(CREDS, 'select a from t where b = ?', ['x'], { limit: 10, timeoutMs: 1234 });
    assert.deepEqual(out, { rows: [{ A: 1 }], columns: ['A'], truncated: false });
    assert.equal(rec.attach.length, 1);
    assert.deepEqual(
        { host: rec.attach[0].host, port: rec.attach[0].port, database: rec.attach[0].database, user: rec.attach[0].user, encoding: rec.attach[0].encoding },
        { host: 'db.internal', port: 3050, database: '/data/main.fdb', user: 'READER', encoding: 'WIN1252' },
    );
    assert.equal(rec.attach[0].blobAsText, true);
    assert.equal(rec.attach[0].lowercase_keys, false);
    assert.equal(rec.attach[0].connectTimeout, 10000);
    assert.deepEqual(rec.tx, [{ isolation: ISOLATION, readOnly: true }]);
    assert.deepEqual(rec.statements, [{ sql: 'select a from t where b = ?', params: ['x'], options: { timeout: 1234 } }]);
    assert.deepEqual(rec.events, ['commit', 'detach']);
});

test('the statement timeout comes from the environment at call time', async () => {
    const { driver, rec } = makeDriver([]);
    _setDriverForTests(driver);
    process.env.FIREBIRD_STATEMENT_TIMEOUT_MS = '777';
    await runQuery(CREDS, 'select 1 from t', []);
    assert.equal(rec.statements[0].options.timeout, 777);
});

test('streams limit + 1 rows: the extra row sets truncated and is dropped', async () => {
    const { driver, rec } = makeDriver(Array.from({ length: 50 }, (_, i) => ({ N: i })));
    _setDriverForTests(driver);
    const out = await runQuery(CREDS, 'select n from t', [], { limit: 3 });
    assert.equal(out.truncated, true);
    assert.deepEqual(out.rows.map(r => r.N), [0, 1, 2]);
    assert.deepEqual(rec.events, ['commit', 'detach']);
});

test('exactly limit rows is not truncated; no limit reads everything', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ N: i }));
    _setDriverForTests(makeDriver(rows).driver);
    assert.equal((await runQuery(CREDS, 's', [], { limit: 5 })).truncated, false);
    const all = await runQuery(CREDS, 's', []);
    assert.equal(all.rows.length, 5);
});

test('rows are serialised and column names trimmed', async () => {
    _setDriverForTests(makeDriver([{ 'NAME  ': 'x   ', D: new Date('2026-05-06T00:00:00Z'), B: Buffer.alloc(3) }]).driver);
    const out = await runQuery(CREDS, 's', []);
    assert.deepEqual(out.rows[0], { NAME: 'x', D: '2026-05-06T00:00:00.000Z', B: '<blob 3 bytes>' });
    assert.deepEqual(out.columns, ['NAME', 'D', 'B']);
});

test('detaches after a statement error and the message never holds the password', async () => {
    const err = Object.assign(new Error(`Dynamic SQL Error near ${PASSWORD}`), { gdscode: 335544569 });
    const { driver, rec } = makeDriver(err);
    _setDriverForTests(driver);
    await assert.rejects(runQuery(CREDS, 's', []), (e) => {
        assert.doesNotMatch(e.message, new RegExp(PASSWORD.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&')));
        assert.match(e.message, /GDS 335544569/);
        return true;
    });
    assert.deepEqual(rec.events, ['commit', 'detach']);
});

test('a failing commit falls back to rollback and still detaches', async () => {
    const { driver, rec } = makeDriver([{ A: 1 }], { commitError: new Error('boom') });
    _setDriverForTests(driver);
    await runQuery(CREDS, 's', []);
    assert.deepEqual(rec.events, ['commit', 'rollback', 'detach']);
});

test('attach failures: wrong login, unavailable database, network error', async () => {
    const cases = [
        [Object.assign(new Error('Your user name and password are not defined'), { gdscode: 335544472 }), /Login to db\.internal:3050 failed.*335544472/],
        [Object.assign(new Error('I/O error'), { gdscode: 335544375 }), /Database unavailable at db\.internal:3050.*335544375/],
        [Object.assign(new Error('Connection rejected'), { gdscode: 335544421 }), /Database unavailable at db\.internal:3050.*335544421/],
        [Object.assign(new Error(`connect ECONNREFUSED 10.0.0.5:3050 ${PASSWORD}`), { code: 'ECONNREFUSED' }), /Could not connect to db\.internal:3050 \(ECONNREFUSED\)/],
        [new Error('something else'), /Could not connect to db\.internal:3050: something else/],
    ];
    for (const [attachError, pattern] of cases) {
        const { driver, rec } = makeDriver([], { attachError });
        _setDriverForTests(driver);
        await assert.rejects(runQuery(CREDS, 's', []), (e) => {
            assert.match(e.message, pattern);
            assert.ok(!e.message.includes(PASSWORD));
            return true;
        });
        assert.deepEqual(rec.events, [], 'nothing to detach when the attach failed');
    }
});

test('mapFirebirdError tolerates odd input and caps the length', () => {
    assert.match(mapFirebirdError(undefined, CREDS), /unknown error/);
    assert.match(mapFirebirdError('text', CREDS), /unknown error/);
    const long = mapFirebirdError(new Error('m'.repeat(2000)), CREDS);
    assert.ok(long.length < 400);
    assert.equal(mapFirebirdError(new Error('a\n  b'), CREDS), 'Firebird error: a b');
});
