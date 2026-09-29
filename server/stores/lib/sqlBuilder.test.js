/**
 * DB-free unit test for stores/lib/sqlBuilder.js (M6).
 * Run: cd server && node --test --test-force-exit --test-timeout=30000 stores/lib/sqlBuilder.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { buildUpdate } = require('./sqlBuilder');

test('quoted cols + WHERE id (userStore.dynamicUpdate shape)', () => {
    const r = buildUpdate({
        table: 'users',
        updates: { displayName: 'Al', role: 'admin' },
        columnMap: { displayName: 'display_name', role: 'role', avatar: 'avatar' },
        where: [{ col: 'id', value: 'u1' }],
        quoteCols: true,
    });
    assert.equal(r.sql, 'UPDATE users SET "display_name" = $1, "role" = $2 WHERE "id" = $3');
    assert.deepEqual(r.params, ['Al', 'admin', 'u1']);
});

test('unquoted cols + ::jsonb cast + composite WHERE + RETURNING (studio family)', () => {
    const r = buildUpdate({
        table: 'studio_app_datasets',
        updates: { rows: [{ x: 1 }], name: 'ds' },
        columnMap: { rows: { col: 'rows', cast: 'jsonb' }, name: 'name' },
        where: [{ col: 'app_id', value: 'a1' }, { col: 'owner_user_id', value: 'u1' }],
        extraSet: ['updated_at = NOW()'],
        returning: '*',
    });
    assert.equal(
        r.sql,
        'UPDATE studio_app_datasets SET rows = $1::jsonb, name = $2, updated_at = NOW() WHERE app_id = $3 AND owner_user_id = $4 RETURNING *',
    );
    assert.deepEqual(r.params, [[{ x: 1 }], 'ds', 'a1', 'u1']);
});

test('transform is applied to the value', () => {
    const r = buildUpdate({
        table: 't',
        updates: { tags: ['a', 'b'] },
        columnMap: { tags: { col: 'tags', transform: (v) => JSON.stringify(v) } },
        where: [{ col: 'id', value: 1 }],
    });
    assert.equal(r.sql, 'UPDATE t SET tags = $1 WHERE id = $2');
    assert.deepEqual(r.params, ['["a","b"]', 1]);
});

test('extraSet only appended when a real field changed', () => {
    const r = buildUpdate({
        table: 't',
        updates: { name: 'x' },
        columnMap: { name: 'name' },
        extraSet: ['updated_at = NOW()', 'version = version + 1'],
        where: [{ col: 'id', value: 1 }],
    });
    assert.equal(r.sql, 'UPDATE t SET name = $1, updated_at = NOW(), version = version + 1 WHERE id = $2');
});

test('returns null when no mapped column changed (caller early-returns)', () => {
    const r = buildUpdate({
        table: 't',
        updates: { unknown: 'x' },
        columnMap: { name: 'name' },
        extraSet: ['updated_at = NOW()'],
        where: [{ col: 'id', value: 1 }],
    });
    assert.equal(r, null);
});

test('[SEC] keys not in columnMap are ignored (no column injection)', () => {
    const r = buildUpdate({
        table: 't',
        updates: { name: 'ok', 'evil = 1; DROP TABLE t; --': 'x', isAdmin: true },
        columnMap: { name: 'name' }, // only `name` is allowed
        where: [{ col: 'id', value: 1 }],
    });
    assert.equal(r.sql, 'UPDATE t SET name = $1 WHERE id = $2');
    assert.deepEqual(r.params, ['ok', 1]);
});

test('startIdx offsets placeholder numbering', () => {
    const r = buildUpdate({
        table: 't', updates: { a: 1 }, columnMap: { a: 'a' },
        where: [{ col: 'id', value: 9 }], startIdx: 5,
    });
    assert.equal(r.sql, 'UPDATE t SET a = $5 WHERE id = $6');
});

test('a transform never runs for an absent key', () => {
    // The adopting stores put per-field validation and clamping in `transform`
    // (folders' cleanName, setScanState's null-vs-"null"). That is only safe
    // while an absent key skips its transform entirely.
    let calls = 0;
    const r = buildUpdate({
        table: 't',
        updates: { present: 1 },
        columnMap: {
            present: 'present',
            absent: { col: 'absent', transform: () => { calls += 1; return 'boom'; } },
        },
        where: [{ col: 'id', value: 1 }],
    });
    assert.equal(calls, 0);
    assert.equal(r.sql, 'UPDATE t SET present = $1 WHERE id = $2');
});

test('a transform that returns null writes a real SQL NULL', () => {
    // supportInboxStore.setScanState clears scan_result this way; JSON.stringify
    // would have stored the four characters "null" in a jsonb column instead.
    const r = buildUpdate({
        table: 'support_inboxes',
        updates: { result: null },
        columnMap: { result: { col: 'scan_result', cast: 'jsonb', transform: (v) => (v == null ? null : JSON.stringify(v)) } },
        where: [{ col: 'id', value: 'i1' }],
    });
    assert.equal(r.sql, 'UPDATE support_inboxes SET scan_result = $1::jsonb WHERE id = $2');
    assert.deepEqual(r.params, [null, 'i1']);
});

test('an empty where list leaves the statement unscoped', () => {
    // supportInboxStore appends its org predicate only when it has one, so the
    // no-predicate shape is what the caller gets when it passes nothing —
    // pinned here because a silently dropped WHERE would widen the write.
    const r = buildUpdate({ table: 't', updates: { a: 1 }, columnMap: { a: 'a' } });
    assert.equal(r.sql, 'UPDATE t SET a = $1');
    assert.deepEqual(r.params, [1]);
});
