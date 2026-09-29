/**
 * Waar een agent op gegrond is — de regel achter drie lezers.
 *
 * Deze functie is de ENIGE plek waar staat wanneer een agent "uit het hoofd
 * antwoordt". Studio's "Vraagt aandacht" maakt er een aandachtspunt van,
 * GET /agents/all hangt hem als `grounding` aan elke rij, de kaartvoet van
 * het overzicht rendert hem, en `personaPrompt.applyPersonaToConfig` stelt via
 * `hasKnowledgeSource` de smallere helft van dezelfde vraag. Wat hier getest
 * wordt is dus wat die schermen zeggen, en dat ze het over dezelfde agent niet
 * oneens kunnen zijn.
 *
 * Drie waarden per as, en de derde draagt het gewicht: `null` = niet te lezen.
 * Elke test hieronder die op `null` staat, staat op het verschil tussen "deze
 * agent heeft geen kennisbank" (een bewering met een opdracht eraan vast) en
 * "ik kon zijn bedrading niet lezen" (dat niet).
 *
 * Draaien: cd server && node --test --test-reporter=tap core/agentRuntime/agentGrounding.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { groundedOn, groundingVerdict, groundingOf, hasKnowledgeSource } = require('./agentGrounding');

// ── de twee assen ───────────────────────────────────────────────────────────

test('een kennisbank maakt hem gegrond', () => {
    assert.deepStrictEqual(groundedOn({ knowledge_base_ids: ['kb1'] }),
        { kb: true, tables: false });
});

test('de camelCase-spelling is GEEN bron — knowledgeSearch leest hem niet', () => {
    // core/agentRuntime/knowledgeSearch.js doet `agent.config?.knowledge_base_ids
    // || []` en kent geen camelCase-tak. Een rij die alleen `knowledgeBaseIds`
    // draagt levert daar nul doorzochte kennisbanken op, dus hem hier meetellen
    // zou een agent "gegrond" noemen die elke beurt niets doorzoekt.
    assert.deepStrictEqual(groundedOn({ knowledgeBaseIds: ['kb1'] }),
        { kb: false, tables: false });
    assert.strictEqual(groundedOn({ knowledge_base_ids: [], knowledgeBaseIds: ['kb1'] }).kb, false);
});

test('een lege lijst is GEKEKEN-en-er-is-er-geen, geen onbekende', () => {
    assert.strictEqual(groundedOn({ knowledge_base_ids: [] }).kb, false);
    assert.strictEqual(groundedOn({ knowledge_base_ids: [null, ''] }).kb, false,
        'lege ids tellen niet mee');
    assert.strictEqual(groundedOn({ knowledge_base_ids: ['   '] }).kb, false,
        'alleen spaties is geen kennisbank-id');
});

test('een tabelgrant is óók een bron — die telde vroeger niet mee', () => {
    assert.deepStrictEqual(groundedOn({ tools: { datatables: { t1: { scope: 'own' } } } }),
        { kb: false, tables: true });
});

test('websearch is GEEN as — het veld dat hem zou aanzetten stuurt niets', () => {
    // Nagegaan in de bron: toolStackAssembly.js geeft de agentconfig door aan
    // getIntegrationTools, dat er alleen `config.tools` uit leest. Welke apps
    // een agent krijgt hangt aan `enabled_apps_user_<id>` plus AUTO_ENABLED_APPS
    // (waar 'agent-search' in staat) plus `searchAvailable`. En de R4-backfill
    // in stores/agent/initSchema.js heeft 'agent-search' in ELKE oudere rij
    // gezet. Een as hierop zou in beide richtingen liegen.
    assert.deepStrictEqual(groundedOn({ enabledIntegrations: ['gmail', 'agent-search'] }),
        { kb: false, tables: false });
    assert.strictEqual(groundingVerdict(groundedOn({ enabledIntegrations: ['agent-search'] })),
        'ungrounded', 'een vlaggetje dat niets aanzet maakt hem niet gegrond');
});

test('een sleutel die er niet staat is geen bron — en ook geen gat', () => {
    assert.deepStrictEqual(groundedOn({}), { kb: false, tables: false });
    assert.deepStrictEqual(groundedOn({ tools: null, knowledge_base_ids: null }),
        { kb: false, tables: false });
});

// ── onleesbaar ≠ leeg ───────────────────────────────────────────────────────

test('een lijst die geen lijst is, is NIET TE LEZEN', () => {
    assert.strictEqual(groundedOn({ knowledge_base_ids: 'kb1' }).kb, null);
    assert.strictEqual(groundedOn({ knowledge_base_ids: { 0: 'kb1' } }).kb, null);
});

test('een onleesbare tools-sectie is op beide niveaus een gat', () => {
    assert.strictEqual(groundedOn({ tools: 'everything' }).tables, null);
    assert.strictEqual(groundedOn({ tools: [] }).tables, null);
    assert.strictEqual(groundedOn({ tools: { datatables: 'all' } }).tables, null);
    assert.strictEqual(groundedOn({ tools: { datatables: [] } }).tables, null);
    assert.strictEqual(groundedOn({ tools: {} }).tables, false, 'geen sectie = geen grant');
    assert.strictEqual(groundedOn({ tools: { datatables: {} } }).tables, false);
});

test('een config die zelf geen object is levert gaten op, geen nullen', () => {
    for (const junk of [null, undefined, 'config', 7, [], '{"knowledge_base_ids":["kb1"]}']) {
        assert.deepStrictEqual(groundedOn(junk), { kb: null, tables: null },
            `config ${JSON.stringify(junk)}`);
    }
});

test('een prototype-sleutel is geen tabelgrant', () => {
    // JSON.parse('{"__proto__":{}}') levert een EIGEN sleutel op; zonder de
    // zeef zou zo'n config als "gegrond op een tabel" lezen terwijl de runtime
    // (toolPolicy.js) er niets mee doet.
    const config = JSON.parse('{"tools":{"datatables":{"__proto__":{"scope":"all"}}}}');
    assert.strictEqual(groundedOn(config).tables, false);
});

// ── het oordeel ─────────────────────────────────────────────────────────────

test('één harde bron maakt hem gegrond, ook naast een as die niemand kon lezen', () => {
    assert.strictEqual(groundingVerdict({ kb: true, tables: null }), 'grounded');
    assert.strictEqual(groundingVerdict({ kb: null, tables: true }), 'grounded');
});

test('alles leeg en alles gelezen: ongegrond', () => {
    assert.strictEqual(groundingVerdict({ kb: false, tables: false }), 'ungrounded');
});

test('één onleesbare as haalt het oordeel weg — dat is de hele reden', () => {
    assert.strictEqual(groundingVerdict({ kb: null, tables: false }), null);
    assert.strictEqual(groundingVerdict({ kb: false, tables: null }), null);
    assert.strictEqual(groundingVerdict(undefined), null, 'geen assen is geen oordeel');
});

test('groundingOf is de vorm die over de API reist', () => {
    assert.deepStrictEqual(groundingOf({ knowledge_base_ids: [] }),
        { kb: false, tables: false, verdict: 'ungrounded' });
    assert.deepStrictEqual(groundingOf('niet te lezen'),
        { kb: null, tables: null, verdict: null });
});

// ── de smallere helft: de kennispoort van personaPrompt ─────────────────────

test('hasKnowledgeSource is de KB-as alleen — een tabel is er geen', () => {
    // `strictKnowledge` wordt in contextBuilder.js een CRITICAL OPERATIONAL
    // CONSTRAINT die weigeren afdwingt zodra er geen KNOWLEDGE BASE RESULTS
    // staan, en die sectie bouwt knowledgeSearch.js alleen uit
    // config.knowledge_base_ids. Een tabel-agent die hier meetelde zou dus
    // ALLES gaan weigeren — ook vragen over zijn eigen tabel.
    assert.strictEqual(hasKnowledgeSource({ knowledge_base_ids: ['kb1'] }), true);
    assert.strictEqual(hasKnowledgeSource({ tools: { datatables: { t1: {} } } }), false);
    assert.strictEqual(hasKnowledgeSource({ knowledgeBaseIds: ['kb1'] }), false);
});

test('een onleesbare config is voor de kennispoort AFWEZIG, nooit aanwezig', () => {
    // Onbekend versmalt, en versmallen is hier: de vlag niet aanzetten.
    assert.strictEqual(hasKnowledgeSource({ knowledge_base_ids: 'kb1' }), false);
    assert.strictEqual(hasKnowledgeSource('niet te lezen'), false);
    assert.strictEqual(hasKnowledgeSource(null), false);
});
