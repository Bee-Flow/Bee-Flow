/**
 * Regression: single-entry bridge-grant writes must be ATOMIC.
 *
 * updateBridgeGrants() rewrites the whole bridge_grants column after reading
 * it. The studio AI grants several tools in one parallel tool-call burst, so
 * every call read the same `integrations` array, appended its own entry and the
 * last write won — the author was told five tools were granted and two landed
 * (observed live: vplan_whoami / vplan_get_collection / vplan_list_boards were
 * reported granted but never persisted, and the page 403'd on them).
 *
 * upsertBridgeGrantEntry / removeBridgeGrantEntry must therefore issue exactly
 * ONE statement: no read-then-write pair, so Postgres' row lock serialises
 * concurrent callers. This test stubs `../db` and asserts that contract; the
 * jsonb semantics themselves are exercised against a real Postgres.
 *
 * Run: node --test stores/webpageStore.bridgeGrantAtomic.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

// Stub ../db and ./storageStore before requiring the store, so nothing tries to
// reach a live database at import time.
const calls = [];
let nextRow = { bridge_grants: JSON.stringify({ ai: {}, automations: [], integrations: [{ tool: 'a' }] }) };

const dbPath = require.resolve('../db');
require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
        run: async (sql, params) => { calls.push({ kind: 'run', sql, params }); return { rowCount: 1 }; },
        getOne: async (sql, params) => { calls.push({ kind: 'getOne', sql, params }); return nextRow; },
        getAll: async (sql, params) => { calls.push({ kind: 'getAll', sql, params }); return []; },
        exec: async (sql) => { calls.push({ kind: 'exec', sql }); },
    },
};
const storagePath = require.resolve('./storageStore');
require.cache[storagePath] = {
    id: storagePath, filename: storagePath, loaded: true,
    exports: { putObject: async () => {}, getObject: async () => null, deleteObject: async () => {} },
};

const { upsertBridgeGrantEntry, removeBridgeGrantEntry } = require('./webpageStore');

function reset() { calls.length = 0; }
/** Statements the store issued that touch the webpages row (ignore schema init). */
function grantStatements() {
    return calls.filter(c => /UPDATE webpages/i.test(c.sql || ''));
}

test('upsert issues exactly one UPDATE — no read-then-write pair to lose', async () => {
    reset();
    const merged = await upsertBridgeGrantEntry('wp1', 'u1', 'integrations', { tool: 'vplan_whoami' });

    const stmts = grantStatements();
    assert.strictEqual(stmts.length, 1, `expected 1 UPDATE, got ${stmts.length}`);
    // A SELECT of bridge_grants before the UPDATE is exactly the lost-update shape.
    const readsBefore = calls.filter(c => /SELECT bridge_grants/i.test(c.sql || ''));
    assert.strictEqual(readsBefore.length, 0, 'must not read bridge_grants separately before writing');

    const { sql, params } = stmts[0];
    assert.match(sql, /jsonb_set/, 'writes via jsonb_set, not a whole-column replace');
    assert.match(sql, /WHERE id = \$1 AND user_id = \$2/, 'ownership is enforced in the same statement');
    assert.match(sql, /RETURNING bridge_grants/, 'returns the post-write state');
    assert.deepStrictEqual(params.slice(0, 3), ['wp1', 'u1', 'vplan_whoami']);
    assert.deepStrictEqual(JSON.parse(params[3]), { tool: 'vplan_whoami' });
    assert.ok(merged && Array.isArray(merged.integrations), 'returns normalized grants');
});

test('remove issues exactly one UPDATE and appends nothing', async () => {
    reset();
    await removeBridgeGrantEntry('wp1', 'u1', 'integrations', 'a');

    const stmts = grantStatements();
    assert.strictEqual(stmts.length, 1);
    assert.ok(!/jsonb_build_array/.test(stmts[0].sql), 'revoke must not append an entry');
    assert.deepStrictEqual(stmts[0].params, ['wp1', 'u1', 'a']);
});

test('automations use their own id field', async () => {
    reset();
    await upsertBridgeGrantEntry('wp1', 'u1', 'automations', { automationId: 'auto-9', label: 'Nightly' });

    const { sql, params } = grantStatements()[0];
    assert.match(sql, /'\{automations\}'/, 'targets the automations list');
    assert.match(sql, /e->>'automationId'/, 'de-duplicates on automationId');
    assert.strictEqual(params[2], 'auto-9');
    assert.deepStrictEqual(JSON.parse(params[3]), { automationId: 'auto-9', label: 'Nightly' });
});

test('the written entry is normalized — junk fields never reach the column', async () => {
    reset();
    await upsertBridgeGrantEntry('wp1', 'u1', 'integrations', {
        tool: 'vplan_list_cards',
        fixedArgs: { limit: 10 },
        label: 'Cards',
        evil: 'dropped',
    });
    assert.deepStrictEqual(JSON.parse(grantStatements()[0].params[3]), {
        tool: 'vplan_list_cards', fixedArgs: { limit: 10 }, label: 'Cards',
    });
});

test('unknown list names and missing ids are rejected before touching the DB', async () => {
    reset();
    await assert.rejects(() => upsertBridgeGrantEntry('wp1', 'u1', 'ai', { tool: 'x' }), /unknown list/);
    await assert.rejects(() => upsertBridgeGrantEntry('wp1', 'u1', 'integrations', {}), /tool is required/);
    await assert.rejects(() => removeBridgeGrantEntry('wp1', 'u1', 'integrations', ''), /id is required/);
    await assert.rejects(() => removeBridgeGrantEntry('wp1', 'u1', 'nope', 'x'), /unknown list/);
    assert.strictEqual(grantStatements().length, 0, 'no statement is issued for invalid input');
});

test('a page the caller does not own yields null, not a silent success', async () => {
    reset();
    nextRow = undefined; // UPDATE ... RETURNING matched no row
    const merged = await upsertBridgeGrantEntry('wp1', 'someone-else', 'integrations', { tool: 'x' });
    assert.strictEqual(merged, null);
    nextRow = { bridge_grants: JSON.stringify({ ai: {}, automations: [], integrations: [] }) };
});

test('table bindings use the same atomic path, keyed on datatableId', async () => {
    // De Data-tab schakelt tabellen één voor één aan; twee gelijktijdige
    // schakelaars mogen elkaar niet verliezen zoals de tool-grants dat deden.
    reset();
    await upsertBridgeGrantEntry('wp1', 'u1', 'tables', {
        datatableId: 'tbl_1', mode: 'readwrite', columns: ['email', 'name'], publicColumns: ['name'],
    });

    const stmts = grantStatements();
    assert.strictEqual(stmts.length, 1);
    const { sql, params } = stmts[0];
    assert.match(sql, /'\{tables\}'/, 'targets the tables list');
    assert.match(sql, /e->>'datatableId'/, 'de-duplicates on datatableId');
    assert.strictEqual(params[2], 'tbl_1');
    assert.deepStrictEqual(JSON.parse(params[3]), {
        datatableId: 'tbl_1', mode: 'readwrite', columns: ['email', 'name'], publicColumns: ['name'],
    });
});

test('the single-entry path narrows exactly like the whole-column path', async () => {
    // Eén ingang minder om te vergeten: de atomaire schrijver haalt zijn entry
    // door dezelfde normalizer, dus 'write' wordt hier ook read en een publieke
    // kolom buiten `columns` haalt de kolom niet.
    reset();
    await upsertBridgeGrantEntry('wp1', 'u1', 'tables', {
        datatableId: 'tbl_1', mode: 'write', columns: '*', publicColumns: ['bsn'], evil: 'dropped',
    });
    assert.deepStrictEqual(JSON.parse(grantStatements()[0].params[3]), {
        datatableId: 'tbl_1', mode: 'read', columns: [], publicColumns: [],
    });
});

test('a table binding without a datatableId never reaches the DB', async () => {
    reset();
    await assert.rejects(() => upsertBridgeGrantEntry('wp1', 'u1', 'tables', { tableId: 'tbl_1' }), /datatableId is required/);
    await assert.rejects(() => removeBridgeGrantEntry('wp1', 'u1', 'tables', ''), /id is required/);
    assert.strictEqual(grantStatements().length, 0);
});
