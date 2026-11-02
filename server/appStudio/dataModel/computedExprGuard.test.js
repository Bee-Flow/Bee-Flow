'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computedExprShapeError } = require('./computedExprGuard');
const { validateDataModel } = require('./modelValidate');

const ok = (expr) => assert.equal(computedExprShapeError(expr), null, expr);
const refused = (expr, re) => {
    const err = computedExprShapeError(expr);
    assert.ok(err, `expected a refusal for ${expr}`);
    if (re) assert.match(err, re);
};

test('the expressions an app author writes pass', () => {
    ok('a + b');
    ok("'x'");
    ok('price * qty * (1 - discount / 100.0)');
    ok("CASE WHEN status = 'open' THEN 1 ELSE 0 END");
    ok("COALESCE(nickname, first_name || ' ' || last_name)");
    ok("rtrim(rtrim(CAST(amount AS TEXT),'0'),'.')");
    ok('CAST(x AS char(10))');
    ok("upper(substr(code, 1, 3)) || '-' || printf('%04d', seq)");
    ok("strftime('%Y', created_at)");
    ok('"quoted_col" IS NOT NULL AND total >= 1e3');
    ok("note LIKE '%it''s%'");
});

test('what is not an expression is refused', () => {
    refused('a + b)', /unbalanced/);
    refused('(a + b', /unbalanced/);
    refused("a) STORED, extra INT REFERENCES other.t(id) --", /unbalanced|unexpected character/);
    refused('other_schema.table_x', /unexpected character "\."/);
    refused('a; DROP TABLE t', /unexpected character ";"/);
    refused("a -- comment", /comment sequence/);
    refused('a /* c */ + 1', /comment sequence/);
    refused("'unterminated", /unterminated string/);
    refused('"bad name"', /not a plain column name/);
    refused('pg_sleep(10)', /function pg_sleep\(\) is not allowed/);
    refused('lo_import(1)', /not allowed/);
    refused('a $1', /unexpected character/);
});

test('validateDataModel reports a smuggled clause and keeps a plain expression', () => {
    const model = (expr) => ({
        modelVersion: 1,
        tables: [{
            id: 'tbl_1', key: 'orders', name: 'Orders',
            fields: [
                { id: 'fld_1', key: 'a', name: 'A', type: 'number' },
                { id: 'fld_2', key: 'total', name: 'Total', type: 'computed', computed: { expr, stored: true, type: 'number' } },
            ],
        }],
    });
    assert.deepEqual(validateDataModel(model('a * 2')).errors.filter((e) => /computed\.expr/.test(e)), []);
    const bad = validateDataModel(model('a) STORED, x INT REFERENCES s.t(id')).errors;
    assert.ok(bad.some((e) => /computed\.expr is not an expression/.test(e)), bad.join('\n'));
});
