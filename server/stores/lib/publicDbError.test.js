/**
 * Error text shown to page authors and pages: SQL errors pass, file-system
 * and path text does not.
 *
 * Run: node --test stores/lib/publicDbError.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { publicDbErrorMessage, GENERIC_MESSAGE } = require('./publicDbError');

function sqliteError(message, code = 'SQLITE_ERROR') {
    return Object.assign(new Error(message), { code });
}

test('SQL errors and our own refusals pass through', () => {
    assert.strictEqual(publicDbErrorMessage(sqliteError('no such table: t')), 'no such table: t');
    assert.strictEqual(publicDbErrorMessage(sqliteError('UNIQUE constraint failed: t.a', 'SQLITE_CONSTRAINT_UNIQUE')), 'UNIQUE constraint failed: t.a');
    assert.strictEqual(publicDbErrorMessage(new Error('This statement is not allowed in a page database')), 'This statement is not allowed in a page database');
    assert.strictEqual(publicDbErrorMessage(new Error('sql must be a non-empty string')), 'sql must be a non-empty string');
});

test('file-system errors and path text become a generic message', () => {
    const tmp = '/tmp/beeflow-webpage-dbs/abc.db';
    for (const err of [
        Object.assign(new Error(`ENOENT: no such file or directory, open '${tmp}'`), { code: 'ENOENT' }),
        Object.assign(new Error('permission denied'), { code: 'EACCES' }),
        new Error(`unable to open ${tmp}`),
        new Error('C:\\Users\\x\\work\\abc.db failed'),
        sqliteError(`disk I/O error at ${tmp}`),
    ]) {
        const out = publicDbErrorMessage(err);
        assert.strictEqual(out, GENERIC_MESSAGE);
        assert.ok(!out.includes('/tmp') && !out.includes('abc'));
    }
});
