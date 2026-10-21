'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { run } = require('./testKit');

const SALT = 'a-long-random-secret-value-1234';
const DATA = [
    { email: 'Person1@example.test', name: 'Person One', score: 4 },
    { email: ' person1@example.test ', name: 'person one', score: 5 },
    { email: '', name: ' ', score: 6 },
];
const op = (extra = {}) => ({ op: 'pseudonymise', columns: ['email', 'name'], saltVar: 'PSEUDO_SALT', ...extra });
const state = { vars: { PSEUDO_SALT: SALT } };

test('pseudonymise is deterministic, ignores case and spaces, and drops the source columns', async () => {
    const { rows, keys } = await run([op()], DATA, { runState: state });
    assert.deepEqual(keys, ['score', 'pseudonym']);
    assert.equal(rows[0].pseudonym, rows[1].pseudonym);
    assert.match(rows[0].pseudonym, /^[0-9a-f]{16}$/);
    const expected = crypto.createHash('sha256').update(`${SALT}\u0000person1@example.test\u001fperson one`).digest('hex').slice(0, 16);
    assert.equal(rows[0].pseudonym, expected);
});

test('pseudonymise gives null when every value is blank', async () => {
    const { rows } = await run([op()], DATA, { runState: state });
    assert.equal(rows[2].pseudonym, null);
});

test('pseudonymise keepColumns, dropColumns, output name and length', async () => {
    const { rows, keys } = await run([op({ keepColumns: true, dropColumns: ['score'], output: 'code', length: 24 })], DATA, { runState: state });
    assert.deepEqual(keys, ['email', 'name', 'code']);
    assert.equal(rows[0].code.length, 24);
});

test('pseudonymise without a usable secret fails and never prints it', async () => {
    const short = { vars: { PSEUDO_SALT: 'too-short' } };
    for (const runState of [short, { vars: {} }]) {
        await assert.rejects(run([op()], DATA, { runState }), (e) => {
            assert.equal(e.errorClass, 'table_salt_missing');
            assert.match(e.message, /PSEUDO_SALT/);
            assert.ok(!e.message.includes('too-short'));
            return true;
        });
    }
});

test('pseudonymise in preview uses a fixed secret and warns', async () => {
    const { rows, result } = await run([op()], DATA, { mode: 'preview' });
    assert.ok(rows[0].pseudonym);
    assert.ok(result.warningCodes.includes('preview_salt'));
});

test('pseudonymise: a different secret gives different codes', async () => {
    const a = await run([op()], DATA, { runState: state });
    const b = await run([op()], DATA, { runState: { vars: { PSEUDO_SALT: 'another-long-random-secret-9' } } });
    assert.notEqual(a.rows[0].pseudonym, b.rows[0].pseudonym);
});
