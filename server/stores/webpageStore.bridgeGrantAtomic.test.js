// @typecheck
/**
 * Single-entry bridge-grant writes are ATOMIC, against a real Postgres
 * (PGlite behind db.js's pool, testUtils/pglitePool.js).
 *
 * The studio AI grants several tools in one parallel tool-call burst. A write
 * that read the `integrations` array, appended its entry and wrote the whole
 * column back would let the last write win: the author is told five tools were
 * granted and two land. upsertBridgeGrantEntry / removeBridgeGrantEntry write
 * through one jsonb statement, so a burst of them all lands; ownership sits in
 * the same statement, so a caller who does not own the page changes nothing.
 *
 * Run: cd server && node --test stores/webpageStore.bridgeGrantAtomic.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const { upsertBridgeGrantEntry, removeBridgeGrantEntry } = require('./webpageStore');
const { initDB } = require('./webpage/schema');

test.before(async () => {
    await initDB();
});
test.after(close);

let seq = 0;
/** A fresh page owned by u1, optionally with a stored bridge_grants value. */
async function page(grants) {
    seq += 1;
    const id = `wp${seq}`;
    await pg.query('INSERT INTO webpages (id, user_id) VALUES ($1, $2)', [id, 'u1']);
    if (grants) await pg.query('UPDATE webpages SET bridge_grants = $2::jsonb WHERE id = $1', [id, JSON.stringify(grants)]);
    return id;
}

/** The stored column, parsed. */
async function stored(id) {
    const { rows } = await pg.query('SELECT bridge_grants FROM webpages WHERE id = $1', [id]);
    const v = rows[0].bridge_grants;
    return typeof v === 'string' ? JSON.parse(v) : v;
}

test('a parallel burst of grants all lands: none is lost to another write', async () => {
    const id = await page();
    const tools = ['vplan_whoami', 'vplan_get_collection', 'vplan_list_boards', 'vplan_list_cards', 'vplan_get_card'];
    const results = await Promise.all(tools.map((tool) => upsertBridgeGrantEntry(id, 'u1', 'integrations', { tool })));
    assert.ok(results.every((r) => r && Array.isArray(r.integrations)), 'each call returns the normalized grants');
    assert.deepStrictEqual((await stored(id)).integrations.map((e) => e.tool).sort(), [...tools].sort());
});

test('upsert returns the post-write state and replaces an entry with the same id', async () => {
    const id = await page({ ai: {}, automations: [], integrations: [{ tool: 'a' }] });
    const merged = await upsertBridgeGrantEntry(id, 'u1', 'integrations', { tool: 'vplan_whoami' });
    assert.deepStrictEqual(merged.integrations.map((e) => e.tool), ['a', 'vplan_whoami']);
    await upsertBridgeGrantEntry(id, 'u1', 'integrations', { tool: 'vplan_whoami', label: 'Who' });
    assert.deepStrictEqual((await stored(id)).integrations, [{ tool: 'a' }, { tool: 'vplan_whoami', label: 'Who' }]);
});

test('remove takes out exactly that entry and appends nothing', async () => {
    const id = await page({ ai: {}, automations: [], integrations: [{ tool: 'a' }, { tool: 'b' }] });
    const after = await removeBridgeGrantEntry(id, 'u1', 'integrations', 'a');
    assert.deepStrictEqual(after.integrations, [{ tool: 'b' }]);
    assert.deepStrictEqual((await stored(id)).integrations, [{ tool: 'b' }]);
    const again = await removeBridgeGrantEntry(id, 'u1', 'integrations', 'a');
    assert.deepStrictEqual(again.integrations, [{ tool: 'b' }], 'removing something absent is a no-op success');
});

test('automations are keyed on their own id field', async () => {
    const id = await page();
    await upsertBridgeGrantEntry(id, 'u1', 'automations', { automationId: 'auto-9', label: 'Nightly' });
    await upsertBridgeGrantEntry(id, 'u1', 'automations', { automationId: 'auto-9', label: 'Hourly' });
    await upsertBridgeGrantEntry(id, 'u1', 'automations', { automationId: 'auto-10', label: 'Weekly' });
    const g = await stored(id);
    assert.deepStrictEqual(g.automations, [
        { automationId: 'auto-9', label: 'Hourly' },
        { automationId: 'auto-10', label: 'Weekly' },
    ]);
    assert.deepStrictEqual(g.integrations, [], 'the other lists are untouched');
});

test('the written entry is normalized: junk fields never reach the column', async () => {
    const id = await page();
    await upsertBridgeGrantEntry(id, 'u1', 'integrations', {
        tool: 'vplan_list_cards', fixedArgs: { limit: 10 }, label: 'Cards', evil: 'dropped',
    });
    assert.deepStrictEqual((await stored(id)).integrations, [
        { tool: 'vplan_list_cards', fixedArgs: { limit: 10 }, label: 'Cards' },
    ]);
});

test('unknown list names and missing ids are rejected and the column stays as it was', async () => {
    const id = await page({ ai: {}, automations: [], integrations: [{ tool: 'a' }] });
    const before = await stored(id);
    await assert.rejects(() => upsertBridgeGrantEntry(id, 'u1', 'ai', { tool: 'x' }), /unknown list/);
    await assert.rejects(() => upsertBridgeGrantEntry(id, 'u1', 'integrations', {}), /tool is required/);
    await assert.rejects(() => removeBridgeGrantEntry(id, 'u1', 'integrations', ''), /id is required/);
    await assert.rejects(() => removeBridgeGrantEntry(id, 'u1', 'nope', 'x'), /unknown list/);
    assert.deepStrictEqual(await stored(id), before);
});

test('a page the caller does not own yields null and keeps its grants', async () => {
    const id = await page({ ai: {}, automations: [], integrations: [{ tool: 'a' }] });
    const before = await stored(id);
    assert.strictEqual(await upsertBridgeGrantEntry(id, 'someone-else', 'integrations', { tool: 'x' }), null);
    assert.strictEqual(await removeBridgeGrantEntry(id, 'someone-else', 'integrations', 'a'), null);
    assert.strictEqual(await upsertBridgeGrantEntry('wp-missing', 'u1', 'integrations', { tool: 'x' }), null);
    assert.deepStrictEqual(await stored(id), before);
});

test('table bindings take the same atomic path, keyed on datatableId', async () => {
    // The Data tab switches tables on one at a time; two switches at once must not lose each other.
    const id = await page();
    await Promise.all([
        upsertBridgeGrantEntry(id, 'u1', 'tables', { datatableId: 'tbl_1', mode: 'readwrite', columns: ['email', 'name'], publicColumns: ['name'] }),
        upsertBridgeGrantEntry(id, 'u1', 'tables', { datatableId: 'tbl_2', mode: 'read', columns: ['title'] }),
    ]);
    const tables = (await stored(id)).tables.sort((a, b) => a.datatableId.localeCompare(b.datatableId));
    assert.deepStrictEqual(tables[0], { datatableId: 'tbl_1', mode: 'readwrite', columns: ['email', 'name'], publicColumns: ['name'] });
    assert.strictEqual(tables[1].datatableId, 'tbl_2');
    await removeBridgeGrantEntry(id, 'u1', 'tables', 'tbl_1');
    assert.deepStrictEqual((await stored(id)).tables.map((t) => t.datatableId), ['tbl_2']);
});

test('the single-entry path narrows exactly like the whole-column path', async () => {
    // 'write' becomes read, and a public column outside `columns` does not fetch the column.
    const id = await page();
    await upsertBridgeGrantEntry(id, 'u1', 'tables', {
        datatableId: 'tbl_1', mode: 'write', columns: '*', publicColumns: ['bsn'], evil: 'dropped',
    });
    assert.deepStrictEqual((await stored(id)).tables, [{ datatableId: 'tbl_1', mode: 'read', columns: [], publicColumns: [] }]);
});

test('a table binding without a datatableId never reaches the column', async () => {
    const id = await page();
    const before = await stored(id);
    await assert.rejects(() => upsertBridgeGrantEntry(id, 'u1', 'tables', { tableId: 'tbl_1' }), /datatableId is required/);
    await assert.rejects(() => removeBridgeGrantEntry(id, 'u1', 'tables', ''), /id is required/);
    assert.deepStrictEqual(await stored(id), before);
});
