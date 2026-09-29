/**
 * normalizeBridgeGrants — public-AI field defaults + clamps.
 * Run: node --test stores/webpageStore.grants.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { normalizeBridgeGrants } = require('./webpageStore');

test('public AI fields default OFF and safe', () => {
    const g = normalizeBridgeGrants(null);
    assert.strictEqual(g.ai.publicEnabled, false);
    assert.strictEqual(g.ai.publicGroundOnPage, false);
    assert.strictEqual(g.ai.publicDefaultTier, 'fast');
    assert.ok(g.ai.publicSpendCapUsd >= 0);
});

test('in-app ai.enabled stays permissive but public stays opt-in', () => {
    const g = normalizeBridgeGrants({ ai: {} });
    assert.strictEqual(g.ai.enabled, true);        // in-app default on
    assert.strictEqual(g.ai.publicEnabled, false); // public default off
});

test('publicEnabled only true when explicitly true', () => {
    assert.strictEqual(normalizeBridgeGrants({ ai: { publicEnabled: 'yes' } }).ai.publicEnabled, false);
    assert.strictEqual(normalizeBridgeGrants({ ai: { publicEnabled: 1 } }).ai.publicEnabled, false);
    assert.strictEqual(normalizeBridgeGrants({ ai: { publicEnabled: true } }).ai.publicEnabled, true);
});

test('spend cap is clamped to the platform max and rejects junk', () => {
    assert.strictEqual(normalizeBridgeGrants({ ai: { publicSpendCapUsd: 999 } }).ai.publicSpendCapUsd, 50);
    assert.strictEqual(normalizeBridgeGrants({ ai: { publicSpendCapUsd: 5 } }).ai.publicSpendCapUsd, 5);
    // Non-numeric falls back to the default (not NaN).
    const d = normalizeBridgeGrants({ ai: { publicSpendCapUsd: 'lots' } }).ai.publicSpendCapUsd;
    assert.ok(Number.isFinite(d));
});

// ── W3: tabelbindingen + Agent-blok ──────────────────────────────────
//
// De kolom wordt bij ELKE lees- en schrijfbeurt uit een vaste sleutelset
// herbouwd, dus een sleutel die de normalizer niet kent bestaat simpelweg
// niet. Deze tests bewaken die set én de richting: onbekend versmalt.

test('the rebuilt column has exactly the five known kinds', () => {
    assert.deepStrictEqual(
        Object.keys(normalizeBridgeGrants(null)).sort(),
        ['agent', 'ai', 'automations', 'integrations', 'tables'],
    );
    // Een zesde soort bestaat pas als de normalizer hem kent.
    assert.strictEqual(normalizeBridgeGrants({ webhooks: [{ url: 'x' }] }).webhooks, undefined);
});

test('tables and agent start at nothing, not at everything', () => {
    const g = normalizeBridgeGrants(null);
    assert.deepStrictEqual(g.tables, []);
    assert.strictEqual(g.agent, null);
});

test('a table binding without a usable datatableId is dropped', () => {
    const g = normalizeBridgeGrants({
        tables: [
            null, 'tbl_a', 42, [], {},
            { datatableId: '' }, { datatableId: '   ' }, { datatableId: 123 },
            { tableId: 'tbl_wrong_key', mode: 'readwrite' },
            { datatableId: 'tbl_ok' },
        ],
    });
    assert.deepStrictEqual(g.tables, [
        { datatableId: 'tbl_ok', mode: 'read', columns: [], publicColumns: [] },
    ]);
});

test('BITE 1 — an unreadable mode is read, never readwrite', () => {
    const modeOf = (mode) => normalizeBridgeGrants({ tables: [{ datatableId: 't', mode }] }).tables[0].mode;
    for (const junk of [undefined, null, '', 'write', 'ReadWrite', 'READWRITE', 'rw',
        'readwrite ', 'delete_everything', true, 1, {}, ['readwrite']]) {
        assert.strictEqual(modeOf(junk), 'read', `mode ${JSON.stringify(junk)} must narrow to read`);
    }
    // Precies één waarde verbreedt.
    assert.strictEqual(modeOf('readwrite'), 'readwrite');
    // En een ontbrekend mode-veld ook.
    assert.strictEqual(normalizeBridgeGrants({ tables: [{ datatableId: 't' }] }).tables[0].mode, 'read');
});

test('BITE 2 — unreadable columns are the EMPTY list, never "all"', () => {
    const colsOf = (columns) => normalizeBridgeGrants({ tables: [{ datatableId: 't', columns }] }).tables[0].columns;
    for (const junk of [undefined, null, '', '*', 'all', 'email,name', true, 1, {}, { email: true }]) {
        assert.deepStrictEqual(colsOf(junk), [], `columns ${JSON.stringify(junk)} must narrow to []`);
    }
    // Binnen een echte lijst overleeft alleen bruikbare kolomtekst, ontdubbeld.
    assert.deepStrictEqual(colsOf(['email', 'email', ' name ', '', '   ', null, 7, {}, ['x']]),
        ['email', 'name']);
});

test('BITE 3 — publicColumns can never be wider than columns', () => {
    const pub = (columns, publicColumns) =>
        normalizeBridgeGrants({ tables: [{ datatableId: 't', columns, publicColumns }] }).tables[0].publicColumns;

    // Een publieke kolom die de binding zelf niet leest, bestaat niet.
    assert.deepStrictEqual(pub(['email'], ['email', 'bsn', 'salary']), ['email']);
    // Geen columns => geen publicColumns, hoe hard het bestand ook aandringt.
    assert.deepStrictEqual(pub([], ['email', 'bsn']), []);
    assert.deepStrictEqual(pub(undefined, ['email']), []);
    assert.deepStrictEqual(pub('*', ['email']), []);
    // En de lijst zelf wordt net zo hard gefilterd als `columns`.
    assert.deepStrictEqual(pub(['email', 'name'], ['name', 'name', null, 3, ' email ']), ['name', 'email']);
});

test('two bindings for the same table collapse to one — the last wins', () => {
    // Anders hangt "welke geldt?" af van .find() versus .filter(), en dan
    // wint soms de ruimste van de twee.
    const g = normalizeBridgeGrants({
        tables: [
            { datatableId: 't', mode: 'readwrite', columns: ['a', 'b'] },
            { datatableId: 't', mode: 'read', columns: ['a'] },
            { datatableId: 'u', mode: 'read' },
        ],
    });
    assert.strictEqual(g.tables.length, 2);
    assert.deepStrictEqual(g.tables[0], { datatableId: 't', mode: 'read', columns: ['a'], publicColumns: [] });
    assert.strictEqual(g.tables[1].datatableId, 'u');
});

test('the agent grant is one id or nothing', () => {
    for (const junk of [undefined, null, '', 'agt_1', 42, [], [{ agentId: 'agt_1' }],
        {}, { agentId: '' }, { agentId: '  ' }, { agentId: 42 }, { agentId: null }]) {
        assert.strictEqual(normalizeBridgeGrants({ agent: junk }).agent, null,
            `agent ${JSON.stringify(junk)} must narrow to null`);
    }
    assert.deepStrictEqual(normalizeBridgeGrants({ agent: { agentId: ' agt_1 ' } }).agent, { agentId: 'agt_1' });
});

test('the agent grant has no public twin to switch on', () => {
    // ai.ask staat bewust niet in de anonieme bridge. Zolang dat zo is, mag er
    // geen opgeslagen vorm bestaan waarin "publieke agent" aan kan staan.
    const g = normalizeBridgeGrants({
        agent: { agentId: 'agt_1', publicEnabled: true, publicAgentId: 'agt_2', enabled: true },
    });
    assert.deepStrictEqual(g.agent, { agentId: 'agt_1' });
    assert.ok(!JSON.stringify(g.agent).includes('public'));
});
