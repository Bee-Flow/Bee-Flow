/**
 * Unit tests for the pure Firebird helpers.
 * Run: node --test integrations/firebirdQuery.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const q = require('./firebirdQuery');

test.afterEach(() => { delete process.env.FIREBIRD_MAX_ROWS; });

test('guardSql accepts selects, a trailing semicolon and semicolons inside literals', () => {
    assert.equal(q.guardSql('select * from klanten'), 'select * from klanten');
    assert.equal(q.guardSql('  SELECT 1 FROM RDB$DATABASE ;  \n'), 'SELECT 1 FROM RDB$DATABASE');
    assert.equal(q.guardSql("select 'a;b' from t;"), "select 'a;b' from t");
    assert.equal(q.guardSql("select 'it''s; fine' from t"), "select 'it''s; fine' from t");
    assert.ok(q.guardSql('with c as (select 1 as x from rdb$database) select x from c'));
    assert.ok(q.guardSql('select 1 /* note; */ from t -- trailing\n'));
});

test('guardSql does not mistake literals, identifiers or look-alike words for keywords', () => {
    assert.ok(q.guardSql("select 'please delete me' from t"));
    assert.ok(q.guardSql('select "UPDATE" from t'));
    assert.ok(q.guardSql('select created_at, updated_by from t'));
    assert.ok(q.guardSql("select q'[drop; table]' from t"));
});

test('guardSql rejects multiple statements', () => {
    assert.throws(() => q.guardSql('select 1 from t; select 2 from t'), /one SQL statement/);
    assert.throws(() => q.guardSql('select 1 from t;; delete from t'), /one SQL statement|read-only/);
});

test('guardSql rejects writes, schema changes and transaction control', () => {
    for (const sql of [
        'update t set a = 1',
        'delete from t',
        'insert into t values (1)',
        'execute block as begin end',
        'execute procedure p',
        'set transaction read write',
        'drop table t',
        'create table t (a int)',
        'commit',
        'merge into t using s on 1=1 when matched then delete',
    ]) {
        assert.throws(() => q.guardSql(sql), /SELECT|read-only/, sql);
    }
});

test('guardSql rejects keywords hidden behind comments and inside CTEs', () => {
    assert.throws(() => q.guardSql('/* */ delete from t'), /SELECT/);
    assert.throws(() => q.guardSql('-- x\ndelete from t'), /SELECT/);
    assert.throws(() => q.guardSql('select 1 from t /* ; */ ; delete from t'), /one SQL statement/);
    assert.throws(() => q.guardSql('with c as (select 1 from t) insert into t select * from c'), /INSERT/);
    assert.throws(() => q.guardSql('select * from t for update'), /UPDATE/);
    assert.throws(() => q.guardSql('select 1 from t where x in (select 1 from d) \n set  transaction'), /SET TRANSACTION|read-only/);
});

test('guardSql rejects empty, non-string, oversize and unterminated input', () => {
    assert.throws(() => q.guardSql(''), /required/);
    assert.throws(() => q.guardSql(' ; '), /required/);
    assert.throws(() => q.guardSql(undefined), /required/);
    assert.throws(() => q.guardSql(`select '${'a'.repeat(q.MAX_SQL_CHARS)}' from t`), /too long/);
    assert.throws(() => q.guardSql("select 'open from t"), /Unterminated/);
    assert.throws(() => q.guardSql('select 1 /* open'), /Unterminated/);
});

test('identifiers are validated, upper-cased and quoted unless the user quoted them', () => {
    assert.equal(q.quoteIdentifier('klanten'), '"KLANTEN"');
    assert.equal(q.quoteIdentifier('"Klanten"'), '"Klanten"');
    assert.equal(q.quoteIdentifier('  my_t$1 '), '"MY_T$1"');
    assert.equal(q.parseIdentifier('"Mixed_Case"'), 'Mixed_Case');
    for (const bad of ['', '1abc', 'a b', 'a;drop', 'a"b', '"a"b"', 'a-b', 'x'.repeat(64), undefined, 5]) {
        assert.throws(() => q.quoteIdentifier(bad), /Invalid table name/, String(bad));
    }
});

test('clampLimit: default, minimum, env maximum and 0 = unlimited', () => {
    assert.equal(q.clampLimit(undefined), 100);
    assert.equal(q.clampLimit('abc'), 100);
    assert.equal(q.clampLimit(0), 1);
    assert.equal(q.clampLimit(-5), 1);
    assert.equal(q.clampLimit(50), 50);
    assert.equal(q.clampLimit(5000), 1000);
    process.env.FIREBIRD_MAX_ROWS = '20';
    assert.equal(q.clampLimit(undefined), 20);
    assert.equal(q.clampLimit(500), 20);
    process.env.FIREBIRD_MAX_ROWS = '0';
    assert.equal(q.clampLimit(250000), 250000);
    assert.equal(q.clampLimit(undefined), 100);
});

test('typeName maps Firebird catalog values to readable types', () => {
    const t = (o) => q.typeName(o);
    assert.equal(t({ FIELD_TYPE: 8 }), 'INTEGER');
    assert.equal(t({ FIELD_TYPE: 7 }), 'SMALLINT');
    assert.equal(t({ FIELD_TYPE: 16 }), 'BIGINT');
    assert.equal(t({ FIELD_TYPE: 37, CHAR_LENGTH: 50, FIELD_LENGTH: 200 }), 'VARCHAR(50)');
    assert.equal(t({ FIELD_TYPE: 14, CHAR_LENGTH: null, FIELD_LENGTH: 10 }), 'CHAR(10)');
    assert.equal(t({ FIELD_TYPE: 8, SUB_TYPE: 1, SCALE: -2, PRECISION: 9 }), 'NUMERIC(9,2)');
    assert.equal(t({ FIELD_TYPE: 16, SUB_TYPE: 1, SCALE: -2, PRECISION: 15 }), 'NUMERIC(15,2)');
    assert.equal(t({ FIELD_TYPE: 16, SUB_TYPE: 2, SCALE: -4, PRECISION: 18 }), 'DECIMAL(18,4)');
    assert.equal(t({ FIELD_TYPE: 16, SUB_TYPE: 0, SCALE: -3 }), 'NUMERIC(18,3)');
    assert.equal(t({ FIELD_TYPE: 12 }), 'DATE');
    assert.equal(t({ FIELD_TYPE: 13 }), 'TIME');
    assert.equal(t({ FIELD_TYPE: 35 }), 'TIMESTAMP');
    assert.equal(t({ FIELD_TYPE: 27 }), 'DOUBLE PRECISION');
    assert.equal(t({ FIELD_TYPE: 10 }), 'FLOAT');
    assert.equal(t({ FIELD_TYPE: 23 }), 'BOOLEAN');
    assert.equal(t({ FIELD_TYPE: 261, SUB_TYPE: 1 }), 'BLOB TEXT');
    assert.equal(t({ FIELD_TYPE: 261, SUB_TYPE: 0 }), 'BLOB');
    assert.equal(t({ FIELD_TYPE: 999 }), 'UNKNOWN(999)');
});

test('serialiseValue: dates, blobs, long text, padding and numbers', () => {
    assert.equal(q.serialiseValue(new Date('2026-01-02T03:04:05.000Z')), '2026-01-02T03:04:05.000Z');
    assert.equal(q.serialiseValue(new Date('nope')), null);
    assert.equal(q.serialiseValue(Buffer.alloc(12)), '<blob 12 bytes>');
    assert.equal(q.serialiseValue(null), null);
    assert.equal(q.serialiseValue(undefined), null);
    assert.equal(q.serialiseValue('abc   '), 'abc');
    assert.equal(q.serialiseValue(12.5), 12.5);
    assert.equal(q.serialiseValue(true), true);
    assert.equal(q.serialiseValue(10n), 10);
    assert.equal(q.serialiseValue(2n ** 70n), (2n ** 70n).toString());
    assert.equal(q.serialiseValue(() => {}), '<blob>');
    const long = q.serialiseValue('x'.repeat(5000));
    assert.equal(long.length, 2001);
    assert.ok(long.endsWith('…'));
});

test('serialiseRow trims padded keys', () => {
    assert.deepEqual(q.serialiseRow({ 'NAME     ': 'a  ', ID: 1 }), { NAME: 'a', ID: 1 });
});

test('truncateRows keeps whole rows within the char budget', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ i, pad: 'y'.repeat(100) }));
    const out = q.truncateRows(rows, 1000);
    assert.equal(out.truncated, true);
    assert.ok(out.rows.length > 0 && out.rows.length < 40);
    assert.ok(JSON.stringify(out.rows).length <= 1000);
    assert.deepEqual(q.truncateRows(rows.slice(0, 2)), { rows: rows.slice(0, 2), truncated: false });
    assert.deepEqual(q.truncateRows([{ big: 'z'.repeat(50) }], 10), { rows: [], truncated: true });
});

test('metadata statements only look at user objects and bind the table name', () => {
    assert.match(q.listTablesSql(false), /RDB\$SYSTEM_FLAG/);
    assert.match(q.listTablesSql(true), /CONTAINING \?/);
    assert.doesNotMatch(q.listTablesSql(false), /\?/);
    for (const sql of [q.COLUMNS_SQL, q.PRIMARY_KEY_SQL, q.FOREIGN_KEYS_SQL]) {
        assert.equal(sql.split('?').length - 1, 1);
        assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE)\b/);
    }
    assert.match(q.COLUMNS_SQL, /RDB\$RELATION_FIELDS/);
    assert.match(q.FOREIGN_KEYS_SQL, /RDB\$REF_CONSTRAINTS/);
});
