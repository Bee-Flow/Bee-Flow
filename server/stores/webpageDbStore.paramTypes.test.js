/**
 * webpageDbStore.normalizeParams — boolean bind regression (BE-P2.1).
 *
 * better-sqlite3 only binds numbers/strings/bigints/buffers/null; a raw JS
 * boolean throws `TypeError: SQLite3 can only bind ...` at bind time. Any
 * api/*.js author (or the AI writing one) reaching for `params: [true]` would
 * hit this.
 *
 * The primary tests exercise `_normalizeParams` directly — pure logic, no
 * native binding involved. The end-to-end tests additionally drive it through
 * the real query/exec/batch entry points against a throwaway local SQLite
 * file, but SKIP (not fail) when the native `better-sqlite3` binding can't
 * load — this repo's better-sqlite3 build is Node-22-ABI-pinned (see
 * server/CLAUDE.md), the same constraint documented for isolated-vm, so a
 * Node 24 dev box legitimately can't exercise it and that isn't a real bug.
 *
 * Run: node --test stores/webpageDbStore.paramTypes.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const webpageDbStore = require('./webpageDbStore');

// ── Pure normalizeParams tests (no native module involved) ──────────

test('_normalizeParams coerces true to 1 and false to 0', () => {
    assert.deepStrictEqual(webpageDbStore._normalizeParams([true, false]), [1, 0]);
});

test('_normalizeParams passes through strings, numbers, bigints, null/undefined', () => {
    assert.deepStrictEqual(
        webpageDbStore._normalizeParams(['x', 1, 2n, null, undefined]),
        ['x', 1, 2n, null, null],
    );
});

test('_normalizeParams JSON-stringifies plain objects/arrays', () => {
    assert.deepStrictEqual(
        webpageDbStore._normalizeParams([{ a: 1 }, [1, 2]]),
        [JSON.stringify({ a: 1 }), JSON.stringify([1, 2])],
    );
});

test('_normalizeParams returns [] for undefined/null params', () => {
    assert.deepStrictEqual(webpageDbStore._normalizeParams(undefined), []);
    assert.deepStrictEqual(webpageDbStore._normalizeParams(null), []);
});

// ── End-to-end via the real query/exec/batch entry points ───────────

const USER_ID = 'test-user-param-types';
function freshWebpageId() {
    return `test-wp-param-types-${crypto.randomBytes(6).toString('hex')}`;
}

// Probe once whether the native binding is usable in this environment;
// individual tests skip cleanly instead of failing on ERR_DLOPEN_FAILED.
let sqliteUsable = true;
let probeError = null;
test('(setup) probe better-sqlite3 native binding availability', async () => {
    const webpageId = freshWebpageId();
    try {
        await webpageDbStore.exec(USER_ID, webpageId, 'SELECT 1');
    } catch (err) {
        sqliteUsable = false;
        probeError = err;
    } finally {
        await webpageDbStore.invalidate(webpageId);
    }
});

test('exec() accepts a boolean param without throwing', async (t) => {
    if (!sqliteUsable) return t.skip(`better-sqlite3 native binding unavailable in this environment: ${probeError?.message}`);
    const webpageId = freshWebpageId();
    t.after(() => webpageDbStore.invalidate(webpageId));

    await webpageDbStore.exec(USER_ID, webpageId, 'CREATE TABLE t (id INTEGER PRIMARY KEY, flag INTEGER)');
    const result = await webpageDbStore.exec(USER_ID, webpageId, 'INSERT INTO t (flag) VALUES (?)', [true]);
    assert.strictEqual(result.changes, 1);

    const { rows } = await webpageDbStore.query(USER_ID, webpageId, 'SELECT flag FROM t WHERE id = ?', [result.lastInsertRowid]);
    assert.strictEqual(rows[0].flag, 1, 'true must coerce to 1');
});

test('exec() coerces false to 0', async (t) => {
    if (!sqliteUsable) return t.skip(`better-sqlite3 native binding unavailable in this environment: ${probeError?.message}`);
    const webpageId = freshWebpageId();
    t.after(() => webpageDbStore.invalidate(webpageId));

    await webpageDbStore.exec(USER_ID, webpageId, 'CREATE TABLE t (id INTEGER PRIMARY KEY, flag INTEGER)');
    await webpageDbStore.exec(USER_ID, webpageId, 'INSERT INTO t (id, flag) VALUES (1, ?)', [false]);

    const { rows } = await webpageDbStore.query(USER_ID, webpageId, 'SELECT flag FROM t WHERE id = 1');
    assert.strictEqual(rows[0].flag, 0, 'false must coerce to 0');
});

test('batch() also coerces boolean params', async (t) => {
    if (!sqliteUsable) return t.skip(`better-sqlite3 native binding unavailable in this environment: ${probeError?.message}`);
    const webpageId = freshWebpageId();
    t.after(() => webpageDbStore.invalidate(webpageId));

    await webpageDbStore.exec(USER_ID, webpageId, 'CREATE TABLE t (id INTEGER PRIMARY KEY, flag INTEGER)');
    await webpageDbStore.batch(USER_ID, webpageId, [
        { sql: 'INSERT INTO t (id, flag) VALUES (?, ?)', params: [1, true] },
        { sql: 'INSERT INTO t (id, flag) VALUES (?, ?)', params: [2, false] },
    ]);

    const { rows } = await webpageDbStore.query(USER_ID, webpageId, 'SELECT id, flag FROM t ORDER BY id');
    assert.deepStrictEqual(rows, [{ id: 1, flag: 1 }, { id: 2, flag: 0 }]);
});
