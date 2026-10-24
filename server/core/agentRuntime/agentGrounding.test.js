/**
 * What an agent is grounded on — the rule behind three readers.
 *
 * This function is the ONLY place where it is determined when an agent "answers from memory".
 * Studio's "Needs attention" turns it into an attention point, GET /agents/all attaches it as
 * `grounding` to each row, the footer of the overview renders it, and
 * `personaPrompt.applyPersonaToConfig` states the narrower half of the same question via
 * `hasKnowledgeSource`. What is tested here is therefore what those screens say, and they
 * cannot disagree about the same agent.
 *
 * Three values per axis, and the third carries the weight: `null` = not readable.
 * Every test below that stands on `null` stands on the difference between "this agent has
 * no knowledge base" (a claim with an obligation attached) and "I could not read its wiring"
 * (that is not).
 *
 * Run: cd server && node --test --test-reporter=tap core/agentRuntime/agentGrounding.test.js
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
    // core/agentRuntime/knowledgeSearch.js does `agent.config?.knowledge_base_ids
    // || []` and has no camelCase branch. A row that carries only `knowledgeBaseIds`
    // yields zero searched knowledge bases there, so counting it here would call an agent
    // "grounded" that searches nothing on every turn.
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
    // Checked in the source: toolStackAssembly.js passes the agent config on to
    // getIntegrationTools, which reads only `config.tools` from it. Which apps
    // an agent gets hangs on `enabled_apps_user_<id>` plus AUTO_ENABLED_APPS
    // (where 'agent-search' is listed) plus `searchAvailable`. And the R4 backfill
    // in stores/agent/initSchema.js set 'agent-search' on EVERY older row. An axis
    // on this would lie in both directions.
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
    // `strictKnowledge` becomes in contextBuilder.js a CRITICAL OPERATIONAL
    // CONSTRAINT that enforces refusals as soon as there are no KNOWLEDGE BASE RESULTS,
    // and that section is built by knowledgeSearch.js only from
    // config.knowledge_base_ids. A table agent that counted here would therefore refuse
    // EVERYTHING — including questions about its own table.
    assert.strictEqual(hasKnowledgeSource({ knowledge_base_ids: ['kb1'] }), true);
    assert.strictEqual(hasKnowledgeSource({ tools: { datatables: { t1: {} } } }), false);
    assert.strictEqual(hasKnowledgeSource({ knowledgeBaseIds: ['kb1'] }), false);
});

test('een onleesbare config is voor de kennispoort AFWEZIG, nooit aanwezig', () => {
    // Unknown narrows, and narrowing here means: do not switch the flag on.
    assert.strictEqual(hasKnowledgeSource({ knowledge_base_ids: 'kb1' }), false);
    assert.strictEqual(hasKnowledgeSource('niet te lezen'), false);
    assert.strictEqual(hasKnowledgeSource(null), false);
});
