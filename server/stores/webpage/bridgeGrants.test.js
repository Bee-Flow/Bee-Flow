/**
 * Round-trip door updateBridgeGrants: wat erin gaat, komt eruit.
 *
 * De kolom `bridge_grants` wordt bij ELKE lees- en schrijfbeurt uit een vaste
 * sleutelset herbouwd (normalizeBridgeGrants). Een sleutel die daar niet in
 * staat wordt stil weggegooid — dus zolang die set niet klopt, bestaat alles
 * wat de rest van W3 opslaat simpelweg niet. Deze test zet de hele set door de
 * echte schrijf- en leesweg heen, inclusief JSON-serialisatie.
 *
 * De pure vormtests (versmallen bij onleesbare invoer) staan in
 * stores/webpageStore.grants.test.js; hier gaat het om het BEWAARD BLIJVEN.
 *
 * Run: node --test --test-force-exit stores/webpage/bridgeGrants.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

// ── db-stub: één in-memory kolom ─────────────────────────────────────
// Stub vóór het requiren van de store, zodat er bij import niets naar een
// echte database reikt. De stub houdt de kolom vast als STRING, precies zoals
// Postgres hem teruggeeft, zodat de round-trip ook door JSON.parse loopt.

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
                // Eigendom zit in de WHERE van het echte statement; de stub
                // bootst precies dat na: een vreemde schrijver raakt niets.
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

    // De twee nieuwe soorten, veld voor veld — dit is de reden dat deze stap
    // vóór de rest van W3 komt.
    assert.deepStrictEqual(back.tables, [
        { datatableId: 'tbl_1', mode: 'readwrite', columns: ['email', 'name'], publicColumns: ['name'] },
        { datatableId: 'tbl_2', mode: 'read', columns: ['status'], publicColumns: [] },
    ]);
    assert.deepStrictEqual(back.agent, { agentId: 'agt_1' });

    // En de drie oude soorten zijn niet stiekem gesneuveld.
    assert.deepStrictEqual(back.automations, [{ automationId: 'aut_1', label: 'Nightly' }]);
    assert.deepStrictEqual(back.integrations, [{ tool: 'gmail_send', fixedArgs: { to: 'x@example.com' }, label: 'Mail' }]);
    assert.strictEqual(back.ai.publicEnabled, true);
    assert.strictEqual(back.ai.publicSpendCapUsd, 7);

    // Het is echt door de kolom heen gegaan, niet door een object-referentie.
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
    // De versmalde vorm staat ook ECHT zo in de kolom — een latere lezer die
    // de normalizer omzeilt kan er niets ruimers uit halen.
    assert.ok(!column.includes('bsn'));
    assert.ok(!column.includes('readwrite'));
    assert.ok(!column.includes('publicEnabled":true'));
});

test('a column written before W3 reads back as "nothing granted"', async () => {
    reset();
    // Zoals een bestaande rij er nu uitziet: drie sleutels, geen tables/agent.
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
    // webpages.js schrijft DEFAULT_BRIDGE_GRANTS bij het klonen van een pagina.
    assert.deepStrictEqual(DEFAULT_BRIDGE_GRANTS.tables, []);
    assert.strictEqual(DEFAULT_BRIDGE_GRANTS.agent, null);
});

test('the fallback shape in shared.js mirrors the normalizer, key for key', () => {
    // shared.js is een leaf-module en kan bridgeGrants.js niet importeren (dat
    // zou een cyclus zijn), dus de terugval voor een rij zonder kolom staat
    // daar als literal. Precies zo'n kopie drift stilletjes weg — vandaar deze
    // vergelijking met de echte vorm.
    const { mapWebpageRow } = require('./shared');
    const fallback = mapWebpageRow({ id: 'w', user_id: 'u', bridge_grants: null }).bridgeGrants;

    assert.deepStrictEqual(Object.keys(fallback).sort(), Object.keys(DEFAULT_BRIDGE_GRANTS).sort());
    assert.deepStrictEqual(fallback.tables, []);
    assert.strictEqual(fallback.agent, null);
    // En de terugval mag nooit ruimer zijn dan wat de normalizer ervan maakt.
    const narrowed = normalizeBridgeGrants(fallback);
    assert.deepStrictEqual(narrowed.tables, []);
    assert.strictEqual(narrowed.agent, null);
});
