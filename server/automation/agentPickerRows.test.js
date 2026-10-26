// @typecheck
/**
 * The agent picker of the AI step (R2, part C).
 *
 * Two things are fixed here, and the second is the most important:
 *
 *   1. an agent that you may NOT choose IS listed, with the reason. Silently leaving it out is the fault that
 *      this module exists to prevent;
 *   2. the reason is explanation and never a second judgement. `canUse` comes from `mayAutomationUseAgent` —
 *      the same function as the save check — and the last test below runs both over the same table of cases,
 *      so that a reason that would broaden is a red test and not a silent grant.
 *
 * Run: cd server && node --test --test-reporter=tap automation/agentPickerRows.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { agentPickerRows, explainRefusal, AGENT_PICKER_REASONS } = require('./agentPickerRows');
const { mayAutomationUseAgent } = require('../core/automationModel/agentCatalog');

const VIEWER = { userId: 'u1', orgId: 'org1', groups: ['g1'] };

// Two publication facts, because they are two switches: `is_published` puts the agent in the library,
// `published_version > 0` determines whether `getForRuntime` serves the published config instead of the live draft.
const agent = (over = {}) => ({
    id: 'agt_1',
    name: 'Helper',
    description: 'Helps',
    owner_id: 'u2',
    organization_id: 'org1',
    is_published: true,
    published_version: 2,
    shared_groups: [],
    ...over,
});

const rowFor = (/** @type {Record<string, unknown>} */ over, viewer = VIEWER) => agentPickerRows([agent(over)], viewer)[0];

test('een agent zonder gepubliceerde versie staat in de lijst, met de reden', () => {
    const row = rowFor({ id: 'agt_draft', name: 'Draft bot', is_published: false });
    assert.ok(row, 'de rij mag NIET ontbreken — dat is precies de stille weglating die dit voorkomt');
    assert.strictEqual(row.canUse, false);
    assert.strictEqual(row.reason, 'not_published');
    assert.strictEqual(row.name, 'Draft bot');
});

test('je eigen concept-agent mag je wel inzetten', () => {
    const row = rowFor({ owner_id: 'u1', is_published: false });
    assert.strictEqual(row.canUse, true);
    assert.strictEqual(row.reason, null, 'een kiesbare rij draagt geen reden');
});

test('een agent van een andere organisatie: zichtbaar, niet kiesbaar', () => {
    const row = rowFor({ organization_id: 'org2' });
    assert.strictEqual(row.canUse, false);
    assert.strictEqual(row.reason, 'other_org');
});

test('een org-agent tegenover een vrager zonder organisatie is ook "andere organisatie"', () => {
    const row = rowFor({}, { userId: 'u1', orgId: null, groups: [] });
    assert.strictEqual(row.canUse, false);
    assert.strictEqual(row.reason, 'other_org');
});

test('gedeeld met groepen waar de vrager niet in zit', () => {
    const row = rowFor({ shared_groups: ['g9'] });
    assert.strictEqual(row.canUse, false);
    assert.strictEqual(row.reason, 'not_shared');
});

test('gedeeld met een groep waar de vrager WEL in zit', () => {
    const row = rowFor({ shared_groups: ['g1', 'g9'] });
    assert.strictEqual(row.canUse, true);
    assert.strictEqual(row.reason, null);
});

test('een onleesbare groepenlijst is geen groepenlijst — onbekend versmalt', () => {
    // `shared_groups` is expected to be an array; if something else comes in, then `mayAutomationUseAgent`
    // reads that as "shared with nobody in particular" and the organisation rule remains the gate. Pinned
    // because the row comes from the database and a JSON parse can fail there.
    const row = rowFor({ shared_groups: 'g1' });
    assert.strictEqual(row.canUse, true, 'de org-regel geldt nog steeds; alleen de groepsversmalling valt weg');
});

test('systeemagents zijn geen keuze en staan niet in de lijst', () => {
    const rows = agentPickerRows([
        agent({ id: 'agt_sys', owner_id: 'system', is_published: false }),
        agent({ id: 'agt_swarm', owner_id: 'swarm' }),
        agent({ id: 'agt_real' }),
    ], VIEWER);
    assert.deepStrictEqual(rows.map(r => r.id), ['agt_real']);
});

test('ontdubbelt op id — de EERSTE rij wint (de eigen-agents-lijst staat vooraan)', () => {
    const rows = agentPickerRows([
        agent({ id: 'agt_1', owner_id: 'u1', is_published: false, name: 'Concept' }),
        agent({ id: 'agt_1', owner_id: 'u1', is_published: true, name: 'Gepubliceerd' }),
    ], VIEWER);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].name, 'Concept');
});

test('sorteert op naam en houdt de zichtbaarheid erbij', () => {
    const rows = agentPickerRows([
        agent({ id: 'b', name: 'Zebra' }),
        agent({ id: 'a', name: 'Alpaca', organization_id: null, owner_id: 'u1' }),
    ], VIEWER);
    assert.deepStrictEqual(rows.map(r => r.name), ['Alpaca', 'Zebra']);
    assert.deepStrictEqual(rows.map(r => r.scope), ['personal', 'org']);
});

test('rommel in de lijst wordt overgeslagen, niet als agent geteld', () => {
    const rows = agentPickerRows([null, 'agt_x', { name: 'geen id' }, agent({ id: 'ok' })], VIEWER);
    assert.deepStrictEqual(rows.map(r => r.id), ['ok']);
});

test('de reden is uitleg, nooit een tweede oordeel', () => {
    // The same table from both sides. `canUse` MUST come from `mayAutomationUseAgent` and the reason may
    // change nothing about that: a row is choosable then and only then when no reason is attached to it.
    const cases = [
        {},
        { is_published: false },
        { owner_id: 'u1', is_published: false },
        { organization_id: 'org2' },
        { organization_id: null },
        { shared_groups: ['g9'] },
        { shared_groups: ['g1'] },
        { owner_id: 'u1', organization_id: 'org2', is_published: false },
        // De split: in de bibliotheek, nooit een versie gepubliceerd.
        { published_version: 0 },
        { runtimeSource: 'live' },
        { owner_id: 'u1', published_version: 0 },
    ];
    for (const viewer of [VIEWER, { userId: 'u1', orgId: null, groups: [] }, { userId: null, orgId: 'org1', groups: [] }]) {
        for (const over of cases) {
            const a = agent(over);
            const row = agentPickerRows([a], viewer)[0];
            const verdict = mayAutomationUseAgent(a, viewer) === true;
            assert.strictEqual(row.canUse, verdict,
                `canUse liep uit de pas met mayAutomationUseAgent voor ${JSON.stringify(over)} / ${JSON.stringify(viewer)}`);
            assert.strictEqual(row.reason === null, verdict,
                `een reden hoort te ontbreken als en alleen als de agent kiesbaar is (${JSON.stringify(over)})`);
            if (row.reason !== null) {
                assert.ok(AGENT_PICKER_REASONS.includes(row.reason), `onbekende reden: ${row.reason}`);
            }
        }
    }
});

test('explainRefusal valt terug op "unavailable" en nooit op "dan mag het wel"', () => {
    // A case that touches none of the three rules (the refusal came from somewhere else). The vague sentence
    // is then the honest answer.
    assert.strictEqual(explainRefusal(null, VIEWER), 'unavailable');
    assert.strictEqual(explainRefusal(agent({ owner_id: 'u1' }), VIEWER), 'unavailable');
});

test('gedeeld zonder gepubliceerde VERSIE draagt dezelfde raad: publiceer hem', () => {
    // The publish switch is on, but a version was never published — `getForRuntime` then serves the owner's
    // live draft, and an unwatched automation of someone else may not run on that (automation/agentCatalog.js:
    // servesPublishedConfig). The row remains VISIBLE, because leaving it out sends someone looking for a bug
    // instead of to the publish button.
    const row = rowFor({ published_version: 0 });
    assert.ok(row);
    assert.strictEqual(row.canUse, false);
    assert.strictEqual(row.reason, 'not_published');
});

test('een rij die zelf zegt dat hij zijn klad serveert is ook niet kiesbaar', () => {
    // `getPublishedAgentsForUser` levert de rijen door `projectRuntime` heen,
    // dus die dragen `runtimeSource`. Dat antwoord wint van de kolom.
    const row = rowFor({ runtimeSource: 'live', published_version: 9 });
    assert.strictEqual(row.canUse, false);
    assert.strictEqual(row.reason, 'not_published');
    assert.strictEqual(rowFor({ runtimeSource: 'published', published_version: 0 }).canUse, true);
});

test('mijn EIGEN ongepubliceerde agent blijft van mij', () => {
    // De eigenaarstak komt eerst: je eigen klad is geen deel-vraag.
    assert.strictEqual(rowFor({ owner_id: 'u1', published_version: 0 }).canUse, true);
});
