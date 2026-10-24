/**
 * Round trip through updateBridgeGrants: what goes in comes out.
 *
 * The column `bridge_grants` is rebuilt from a fixed key set on EVERY read and write
 * (normalizeBridgeGrants). A key that is not in that set is silently thrown away — so as long as
 * that set is not right, nothing the rest of W3 stores exists at all. This test pushes the whole
 * set through the real write and read path, including JSON serialisation.
 *
 * The pure shape tests (narrowing on unreadable input) are in stores/webpageStore.grants.test.js;
 * here it is about SURVIVING the round trip.
 *
 * Run: node --test --test-force-exit stores/webpage/bridgeGrants.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

// ── db stub: one in-memory column ─────────────────────────────────────
// Stub before requiring the store, so that nothing reaches a real database on import. The stub
// holds the column as a STRING, exactly as Postgres returns it, so the round trip also goes
// through JSON.parse.

let column = null;      // de opgeslagen bridge_grants (JSON-string of null)
let rowExists = true;
const OWNER = 'u1';

const dbPath = require.resolve('../../db');
require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
        exec: async () => {},
        run: async (sql, params) => {
            if (/UPDATE webpages SET bridge_grants = \$1/.test(sql)) {
                // Ownership sits in the WHERE of the real statement; the stub reproduces exactly that:
                // a foreign writer touches nothing.
                if (!rowExists || params[2] !== OWNER) return { rowCount: 0 };
                column = params[0];
                return { rowCount: 1 };
            }
            return { rowCount: 0 };
        },
        getOne: async (sql) => {
            if (/SELECT bridge_grants FROM webpages/.test(sql)) {
                return rowExists ? { bridge_grants: column } : undefined;
            }
            return undefined;
        },
        getAll: async () => [],
    },
};
const storagePath = require.resolve('../storageStore');
require.cache[storagePath] = {
    id: storagePath, filename: storagePath, loaded: true,
    exports: { putObject: async () => {}, getObject: async () => null, deleteObject: async () => {}, buildWebpageKey: () => 'k' },
};

const { getBridgeGrants, updateBridgeGrants, normalizeBridgeGrants, DEFAULT_BRIDGE_GRANTS } = require('./bridgeGrants');

function reset() { column = null; rowExists = true; }

// Alles wat een pagina kan krijgen, in één patch.
const FULL = {
    ai: {
        enabled: true, groundOnPage: false, defaultTier: 'balanced',
        publicEnabled: true, publicGroundOnPage: true, publicSpendCapUsd: 7, publicDefaultTier: 'fast',
    },
    automations: [{ automationId: 'aut_1', label: 'Nightly' }],
    integrations: [{ tool: 'gmail_send', fixedArgs: { to: 'x@example.com' }, label: 'Mail' }],
    tables: [
        { datatableId: 'tbl_1', mode: 'readwrite', columns: ['email', 'name'], publicColumns: ['name'] },
        { datatableId: 'tbl_2', mode: 'read', columns: ['status'], publicColumns: [] },
    ],
    agent: { agentId: 'agt_1' },
};

test('round trip — every kind survives the write and the read back', async () => {
    reset();
    const written = await updateBridgeGrants('wp1', OWNER, FULL);
    const back = await getBridgeGrants('wp1');

    assert.deepStrictEqual(back, written, 'lezen levert exact op wat schrijven teruggaf');

    // The two new kinds, field by field — this is the reason this step comes before the rest of W3.
    assert.deepStrictEqual(back.tables, [
        { datatableId: 'tbl_1', mode: 'readwrite', columns: ['email', 'name'], publicColumns: ['name'] },
        { datatableId: 'tbl_2', mode: 'read', columns: ['status'], publicColumns: [] },
    ]);
    assert.deepStrictEqual(back.agent, { agentId: 'agt_1' });

    // And the three old kinds have not secretly been broken.
    assert.deepStrictEqual(back.automations, [{ automationId: 'aut_1', label: 'Nightly' }]);
    assert.deepStrictEqual(back.integrations, [{ tool: 'gmail_send', fixedArgs: { to: 'x@example.com' }, label: 'Mail' }]);
    assert.strictEqual(back.ai.publicEnabled, true);
    assert.strictEqual(back.ai.publicSpendCapUsd, 7);

    // It really went through the column, not through an object reference.
    assert.strictEqual(typeof column, 'string');
    assert.deepStrictEqual(JSON.parse(column), written);
});

test('a partial patch leaves the kinds it does not name alone', async () => {
    reset();
    await updateBridgeGrants('wp1', OWNER, FULL);

    // Alleen ai aanpassen: tabellen en agent horen te blijven staan.
    const after = await updateBridgeGrants('wp1', OWNER, { ai: { enabled: false } });
    assert.strictEqual(after.ai.enabled, false);
    assert.strictEqual(after.tables.length, 2);
    assert.deepStrictEqual(after.agent, { agentId: 'agt_1' });

    // En alleen tables aanpassen laat de agent staan.
    const after2 = await updateBridgeGrants('wp1', OWNER, { tables: [] });
    assert.deepStrictEqual(after2.tables, []);
    assert.deepStrictEqual(after2.agent, { agentId: 'agt_1' });
});

test('agent: null clears, agent: undefined keeps', async () => {
    reset();
    await updateBridgeGrants('wp1', OWNER, FULL);

    const kept = await updateBridgeGrants('wp1', OWNER, { automations: [] });
    assert.deepStrictEqual(kept.agent, { agentId: 'agt_1' }, 'niet genoemd = ongemoeid');

    const cleared = await updateBridgeGrants('wp1', OWNER, { agent: null });
    assert.strictEqual(cleared.agent, null);
    assert.strictEqual((await getBridgeGrants('wp1')).agent, null);
});

test('narrowing happens on the way IN, so a read can never widen it', async () => {
    reset();
    await updateBridgeGrants('wp1', OWNER, {
        tables: [{
            datatableId: 'tbl_1',
            mode: 'write',                       // geen 'readwrite' → read
            columns: '*',                        // onleesbaar → lege lijst
            publicColumns: ['email', 'bsn'],     // niet in columns → weg
        }],
        agent: { agentId: 'agt_1', publicEnabled: true },
    });

    const back = await getBridgeGrants('wp1');
    assert.deepStrictEqual(back.tables, [
        { datatableId: 'tbl_1', mode: 'read', columns: [], publicColumns: [] },
    ]);
    assert.deepStrictEqual(back.agent, { agentId: 'agt_1' });
    // The narrowed shape really is stored THAT way in the column — a later reader that bypasses
    // the normaliser cannot get anything wider out of it.
    assert.ok(!column.includes('bsn'));
    assert.ok(!column.includes('readwrite'));
    assert.ok(!column.includes('publicEnabled":true'));
});

test('a column written before W3 reads back as "nothing granted"', async () => {
    reset();
    // How an existing row looks now: three keys, no tables/agent.
    column = JSON.stringify({ ai: { enabled: true }, automations: [], integrations: [] });

    const back = await getBridgeGrants('wp1');
    assert.deepStrictEqual(back.tables, [], 'ontbrekend is geen tabelbinding, niet "alle tabellen"');
    assert.strictEqual(back.agent, null);
    assert.deepStrictEqual(Object.keys(back).sort(), ['agent', 'ai', 'automations', 'integrations', 'tables']);
});

test('a write by someone who does not own the page changes nothing', async () => {
    reset();
    await updateBridgeGrants('wp1', OWNER, FULL);
    const before = column;

    const res = await updateBridgeGrants('wp1', 'someone-else', { tables: [{ datatableId: 'tbl_theirs', mode: 'readwrite' }] });
    assert.strictEqual(res, null, 'geen stille success');
    assert.strictEqual(column, before, 'de kolom is onaangeroerd');
    assert.ok(!JSON.stringify(await getBridgeGrants('wp1')).includes('tbl_theirs'));
});

test('the default shape a fresh page is created with grants nothing new', () => {
    // webpages.js writes DEFAULT_BRIDGE_GRANTS when cloning a page.
    assert.deepStrictEqual(DEFAULT_BRIDGE_GRANTS.tables, []);
    assert.strictEqual(DEFAULT_BRIDGE_GRANTS.agent, null);
});

test('the fallback shape in shared.js mirrors the normalizer, key for key', () => {
    // shared.js is a leaf module and cannot import bridgeGrants.js (that would be a cycle), so the
    // fallback for a row without a column is there as a literal. Exactly such a copy quietly drifts
    // away — hence this comparison with the real shape.
    const { mapWebpageRow } = require('./shared');
    const fallback = mapWebpageRow({ id: 'w', user_id: 'u', bridge_grants: null }).bridgeGrants;

    assert.deepStrictEqual(Object.keys(fallback).sort(), Object.keys(DEFAULT_BRIDGE_GRANTS).sort());
    assert.deepStrictEqual(fallback.tables, []);
    assert.strictEqual(fallback.agent, null);
    // And the fallback may never be wider than what the normaliser makes of it.
    const narrowed = normalizeBridgeGrants(fallback);
    assert.deepStrictEqual(narrowed.tables, []);
    assert.strictEqual(narrowed.agent, null);
});
