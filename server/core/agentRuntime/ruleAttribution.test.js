'use strict';

/**
 * De attributie-pass, en de vier weigeringen waar hij op staat.
 *
 *   1. Alleen `followed` wordt een chip. `not_applicable` is het normale
 *      antwoord op een verbodsregel en mag geen krediet worden; `not_followed`
 *      is een oordeel en hoort in de testset, niet naast het antwoord.
 *   2. De tekst van een chip is de bullet van de BOUWER, opgezocht op nummer.
 *      Een regel die het model verzint (index 9 van een lijst van 2) valt weg.
 *   3. Valt de pass om — geen model, een gooiende call, een timeout, een vorm
 *      die niet te lezen is — dan is er GEEN chip. Nooit één die "geen regel"
 *      beweert.
 *   4. De rol die gelezen wordt moet de rol zijn die draaide. Concept-bullets
 *      naast een gepubliceerd antwoord is een claim die niemand controleerde.
 *
 * Draaien: cd server && node --test core/agentRuntime/ruleAttribution.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const R = require('./ruleAttribution');

const PERSONA = { doesNot: ['Nooit een prijs noemen', 'Nooit medisch advies geven'] };
const DRAFT = { source: 'draft', runsDraft: true, publishedVersion: 2, agentRev: 5, unpublishedChanges: 3 };

/** Een pass met alles erop en eraan; elke test vervangt wat hij nodig heeft. */
function passDeps({ structured = { rules: [] }, throws = null, model = 'fast-1', usage = null } = {}) {
    const calls = { messages: null, tool: null, options: null, model: null, usage: [] };
    return {
        calls,
        deps: {
            resolveModelForTierName: async () => model,
            llmClient: {
                chatForcedTool: async (modelId, messages, toolDef, options) => {
                    calls.model = modelId;
                    calls.messages = messages;
                    calls.tool = toolDef;
                    calls.options = options;
                    if (throws) throw throws;
                    return { structured, usage };
                },
            },
            logUsage: async (row) => { calls.usage.push(row); },
        },
    };
}

// ── 1. Welke uitspraak een chip wordt ────────────────────────────────

test('alleen "followed" wordt een chip', () => {
    const parsed = R.parseAttribution({
        rules: [{ index: 1, verdict: 'followed' }, { index: 2, verdict: 'not_applicable' }],
    }, PERSONA.doesNot);
    assert.deepStrictEqual(R.followedFrom(parsed), [{ rule: 'Nooit een prijs noemen' }]);
});

test('BIJT — "not_applicable" geeft geen krediet', () => {
    // Een verbod is op de meeste vragen triviaal "gevolgd"; daar een chip voor
    // geven maakt de hele rij minder waard.
    const parsed = R.parseAttribution({ rules: [{ index: 1, verdict: 'not_applicable' }] }, PERSONA.doesNot);
    assert.deepStrictEqual(R.followedFrom(parsed), []);
});

test('BIJT — "not_followed" wordt geen chip, maar reist wel mee', () => {
    const parsed = R.parseAttribution({ rules: [{ index: 2, verdict: 'not_followed' }] }, PERSONA.doesNot);
    assert.deepStrictEqual(parsed, [{ index: 2, rule: 'Nooit medisch advies geven', verdict: 'not_followed' }]);
    assert.deepStrictEqual(R.followedFrom(parsed), []);
});

test('chips staan in de volgorde van de rol, niet in die van het model', () => {
    const parsed = R.parseAttribution({
        rules: [{ index: 2, verdict: 'followed' }, { index: 1, verdict: 'followed' }],
    }, PERSONA.doesNot);
    assert.deepStrictEqual(R.followedFrom(parsed).map(c => c.rule),
        ['Nooit een prijs noemen', 'Nooit medisch advies geven']);
});

// ── 2. De tekst komt van de bouwer ───────────────────────────────────

test('BIJT — een regel die niet bestaat valt weg', () => {
    for (const index of [0, 3, -1, 1.5, null, undefined, 'twee', '', NaN]) {
        assert.deepStrictEqual(
            R.parseAttribution({ rules: [{ index, verdict: 'followed' }] }, PERSONA.doesNot),
            [], `index ${String(index)} had moeten wegvallen`,
        );
    }
});

test('een gestringificeerd nummer is nog steeds een nummer', () => {
    const parsed = R.parseAttribution({ rules: [{ index: '2', verdict: 'followed' }] }, PERSONA.doesNot);
    assert.deepStrictEqual(parsed, [{ index: 2, rule: 'Nooit medisch advies geven', verdict: 'followed' }]);
});

test('BIJT — de chip citeert de bullet, niet wat het model erbij typt', () => {
    const parsed = R.parseAttribution({
        rules: [{ index: 1, verdict: 'followed', rule: 'Ik heb netjes de prijs van klant De Vries weggelaten' }],
    }, PERSONA.doesNot);
    assert.deepStrictEqual(R.followedFrom(parsed), [{ rule: 'Nooit een prijs noemen' }]);
});

test('een uitspraak buiten de woordenlijst telt niet als "misschien"', () => {
    for (const verdict of ['ok', 'true', '', null, 'FOLLOWED', undefined]) {
        assert.deepStrictEqual(R.parseAttribution({ rules: [{ index: 1, verdict }] }, PERSONA.doesNot), []);
    }
});

test('twee uitspraken over dezelfde regel zijn één regel', () => {
    const parsed = R.parseAttribution({
        rules: [{ index: 1, verdict: 'followed' }, { index: 1, verdict: 'not_followed' }],
    }, PERSONA.doesNot);
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].verdict, 'followed');
});

test('een onleesbare vorm levert niets, en gooit niet', () => {
    for (const structured of [null, undefined, 'ja', 42, [], { rules: 'alles goed' }, {}]) {
        assert.deepStrictEqual(R.parseAttribution(structured, PERSONA.doesNot), []);
    }
});

// ── De regels die de pass ziet ───────────────────────────────────────

test('rulesFrom knipt, ontdubbelt en begrenst', () => {
    assert.deepStrictEqual(R.rulesFrom({ doesNot: ['  a  ', 'a', '', 42, null, 'b'] }), ['a', 'b']);
    assert.strictEqual(R.rulesFrom({ doesNot: Array.from({ length: 40 }, (_, i) => `r${i}`) }).length, R.LIMITS.rules);
    assert.strictEqual(R.rulesFrom({ doesNot: ['x'.repeat(500)] })[0].length, R.LIMITS.rule);
    for (const persona of [null, undefined, {}, { doesNot: 'geen prijzen' }, { doesNot: [] }]) {
        assert.deepStrictEqual(R.rulesFrom(persona), []);
    }
});

// ── 4. De rol moet de rol zijn die draaide ───────────────────────────

test('BIJT — een gepubliceerde agent met onuitgegeven wijzigingen wordt niet geattribueerd', () => {
    // De testchat draait het concept, dus daar hoort de concept-rol bij.
    assert.strictEqual(R.personaRanWith({ source: 'draft', runsDraft: true, unpublishedChanges: 3 }), true);
    assert.strictEqual(R.personaRanWith({ source: 'live', unpublishedChanges: 0 }), true);
    // Gepubliceerd én ongewijzigd is hetzelfde bestand; gepubliceerd én
    // vooruitgelopen concept is de claim die R2 weigerde.
    assert.strictEqual(R.personaRanWith({ source: 'published', unpublishedChanges: 0 }), true);
    assert.strictEqual(R.personaRanWith({ source: 'published', unpublishedChanges: 1 }), false);
});

test('onbekend versmalt: geen leesbare versie-informatie is geen pass', () => {
    for (const info of [null, undefined, {}, 'live', { source: 'unknown' }, { source: 'published' },
        { source: 'unknown', runsDraft: false }, { source: 'published', unpublishedChanges: 'nul' }]) {
        assert.strictEqual(R.personaRanWith(info), false, `${JSON.stringify(info)} had nee moeten zijn`);
    }
});

// ── De geldkraan ─────────────────────────────────────────────────────

test('BIJT — buiten testmodus belt de pass niet, wat de call-site ook doorgeeft', async () => {
    // De productiechat betaalt hier niets. Dat hangt aan deze vlag, niet aan de
    // plek van een `if` in een route.
    //
    // De deps zouden een chip OPLEVEREN als ze werden aangeroepen — deps die
    // gooien zouden hetzelfde `null` geven en dan bewijst de test niets over
    // de poort.
    for (const testChat of [undefined, false, null, 'true', 1, {}]) {
        const { deps, calls } = passDeps({ structured: { rules: [{ index: 1, verdict: 'followed' }] } });
        const out = await R.attributeTurn(
            { testChat, persona: PERSONA, configInfo: DRAFT, answer: 'Dat zeg ik niet.' }, deps,
        );
        assert.strictEqual(out, null, `testChat=${String(testChat)} had geen pass mogen zijn`);
        assert.strictEqual(calls.model, null, 'er had niets gebeld mogen worden');
    }
});

// ── De prompt ────────────────────────────────────────────────────────

test('de regels gaan genummerd de prompt in, en het antwoord staat afgebakend', () => {
    const [system, user] = R.buildAttributionMessages({
        rules: PERSONA.doesNot, question: 'Wat kost dit?', answer: 'Dat mag ik niet zeggen.',
    });
    assert.match(system.content, /never invent a rule/i);
    assert.match(user.content, /1\. Nooit een prijs noemen/);
    assert.match(user.content, /2\. Nooit medisch advies geven/);
    assert.match(user.content, /<answer>\nDat mag ik niet zeggen\.\n<\/answer>/);
});

test('een lang antwoord houdt zijn staart — daar zit de uitglijder', () => {
    const answer = `${'a'.repeat(R.LIMITS.answer * 2)}EINDE`;
    const [, user] = R.buildAttributionMessages({ rules: ['r'], answer });
    assert.ok(user.content.includes('EINDE'), 'de staart hoort mee te gaan');
    assert.ok(user.content.includes('[trimmed]'));
    assert.ok(user.content.length < answer.length);
});

test('de tool vraagt om nummers en een gesloten woordenlijst, niet om proza', () => {
    const props = R.ATTRIBUTION_TOOL.function.parameters.properties.rules.items.properties;
    assert.deepStrictEqual(Object.keys(props).sort(), ['index', 'verdict']);
    assert.deepStrictEqual(props.verdict.enum, [...R.VERDICTS]);
});

// ── 3. Valt de pass om, dan is er geen chip ──────────────────────────

test('de hele pass, van rol tot chip', async () => {
    const { deps, calls } = passDeps({ structured: { rules: [{ index: 1, verdict: 'followed' }] }, usage: { prompt_tokens: 12 } });
    const out = await R.attributeTurn({
        testChat: true, persona: PERSONA, configInfo: DRAFT, answer: 'Daar zeg ik niets over.', question: 'Wat kost dit?',
        orgId: 'org-1', userId: 'u-1',
    }, deps);
    assert.deepStrictEqual(out, { rules: [{ rule: 'Nooit een prijs noemen' }] });
    assert.strictEqual(calls.model, 'fast-1');
    assert.strictEqual(calls.options.temperature, 0);
    // Geboekt op een eigen source, zodat een testchat de chatkosten niet vervuilt.
    assert.strictEqual(calls.usage.length, 1);
    assert.strictEqual(calls.usage[0].modelId, 'fast-1');
});

test('BIJT — een gooiende call geeft geen chip', async () => {
    const { deps } = passDeps({ throws: new Error('provider down') });
    assert.strictEqual(await R.attributeTurn({ testChat: true, persona: PERSONA, configInfo: DRAFT, answer: 'x' }, deps), null);
});

test('BIJT — een model dat niet op te zoeken is geeft geen chip', async () => {
    const boom = { resolveModelForTierName: async () => { throw new Error('config unreadable'); }, llmClient: { chatForcedTool: async () => { throw new Error('had niet gebeld mogen worden'); } } };
    assert.strictEqual(await R.attributeTurn({ testChat: true, persona: PERSONA, configInfo: DRAFT, answer: 'x' }, boom), null);
    const none = { resolveModelForTierName: async () => null, llmClient: { chatForcedTool: async () => { throw new Error('had niet gebeld mogen worden'); } } };
    assert.strictEqual(await R.attributeTurn({ testChat: true, persona: PERSONA, configInfo: DRAFT, answer: 'x' }, none), null);
});

test('BIJT — een pass die niets vond geeft geen chip, niet een lege bewering', async () => {
    const { deps } = passDeps({ structured: { rules: [{ index: 1, verdict: 'not_applicable' }] } });
    assert.strictEqual(await R.attributeTurn({ testChat: true, persona: PERSONA, configInfo: DRAFT, answer: 'x' }, deps), null);
});

test('BIJT — een timeout geeft geen chip', async (t) => {
    const deps = {
        resolveModelForTierName: async () => 'fast-1',
        llmClient: { chatForcedTool: () => new Promise(() => {}) },
        logUsage: async () => {},
    };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = R.attributeTurn({ testChat: true, persona: PERSONA, configInfo: DRAFT, answer: 'x' }, deps);
    // Eerst de modelresolutie laten landen: vóór dat punt bestaat de timer nog
    // niet, en een tick op een lege klok laat de test daarna eeuwig hangen.
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(R.LIMITS.timeoutMs + 1);
    assert.strictEqual(await p, null);
});

test('BIJT — zonder regels, zonder antwoord of met de verkeerde versie belt de pass niet eens', async () => {
    // Deps die zouden SLAGEN: een poort die openstaat moet zichtbaar worden als
    // een chip, niet wegvallen in een catch die toch al `null` teruggeeft.
    const cases = [
        ['geen regels', { persona: { doesNot: [] }, configInfo: DRAFT, answer: 'x' }],
        ['geen antwoord', { persona: PERSONA, configInfo: DRAFT, answer: '   ' }],
        ['ander concept dan wat draaide', { persona: PERSONA, configInfo: { source: 'published', unpublishedChanges: 3 }, answer: 'x' }],
        ['onleesbare versie', { persona: PERSONA, configInfo: { source: 'unknown' }, answer: 'x' }],
    ];
    for (const [label, args] of cases) {
        const { deps, calls } = passDeps({ structured: { rules: [{ index: 1, verdict: 'followed' }] } });
        assert.strictEqual(await R.attributeTurn({ testChat: true, ...args }, deps), null, label);
        assert.strictEqual(calls.model, null, `${label}: er had niets gebeld mogen worden`);
    }
});

// ── De rol die draaide is de rol die GERENDERD is ────────────────────

test('BIJT — in vrije modus staan de bullets er alleen als beschrijving, dus geen regels', () => {
    // `renderSystemPrompt` doet `if (p.mode === 'free') return p.freeText;` —
    // de bullets bereiken de systeemprompt dan nooit. Een chip "Regel gevolgd:
    // …" zou daar krediet geven voor het volgen van een instructie die het
    // model niet gekregen heeft. Twee routes komen hier: de knop "Open as free
    // instruction" in de Rol-tab, en routes/agents/crud.js die een persona
    // ZELF naar vrij duwt zodra een client de prompt bewerkt.
    const { renderSystemPrompt } = require('./personaPrompt');
    const free = {
        mode: 'free',
        freeText: 'Je bent de supportbot van Acme. Antwoord kort.',
        does: ['Altijd de openingstijden noemen'],
        doesNot: ['Nooit een prijs noemen', 'Nooit medisch advies geven'],
    };
    assert.ok(!renderSystemPrompt(free).includes('Nooit een prijs noemen'),
        'aanname van deze test: de bullets halen de prompt niet in vrije modus');
    assert.deepStrictEqual(R.rulesFrom(free), []);

    // Dezelfde bullets in veldenmodus zijn wél instructies, en dus wél regels.
    const fields = { mode: 'fields', who: 'Supportbot', doesNot: free.doesNot };
    assert.ok(renderSystemPrompt(fields).includes('Nooit een prijs noemen'));
    assert.deepStrictEqual(R.rulesFrom(fields), free.doesNot);
});

test('een persona zonder modus is de oude veldenvorm, en houdt zijn regels', () => {
    assert.deepStrictEqual(R.rulesFrom({ doesNot: ['Nooit schelden'] }), ['Nooit schelden']);
    // Legacy: `personaOf` maakt van een NULL-kolom `{mode:'free'}` over de
    // prompt, en die heeft per definitie geen bullets.
    assert.deepStrictEqual(R.rulesFrom(null), []);
    assert.deepStrictEqual(R.rulesFrom({ mode: 'onzin', doesNot: ['x'] }), ['x'],
        'een onleesbare modus landt via de normaliser op velden');
});

test('BIJT — de pass belt niet voor een rol die alleen als beschrijving bestaat', async () => {
    const { deps, calls } = passDeps({ structured: { rules: [{ index: 1, verdict: 'followed' }] } });
    const out = await R.attributeTurn({
        testChat: true,
        persona: { mode: 'free', freeText: 'Wees aardig.', doesNot: ['Nooit een prijs noemen'] },
        configInfo: DRAFT,
        answer: 'Wij zijn open van 9 tot 17.',
    }, deps);
    assert.strictEqual(out, null);
    assert.strictEqual(calls.model, null, 'er had niets gebeld mogen worden');
});

test('BIJT — "nul ongepubliceerde wijzigingen" moet een GETAL nul zijn', () => {
    // `Number(null)`, `Number('')`, `Number(false)` en `Number([])` zijn
    // allemaal 0, en die passeerden de poort die juist bestaat om
    // concept-bullets naast een gepubliceerd antwoord te weigeren.
    for (const v of [null, '', false, [], undefined, 'nul', {}, NaN]) {
        assert.strictEqual(
            R.personaRanWith({ source: 'published', unpublishedChanges: v }), false,
            `unpublishedChanges: ${JSON.stringify(v)}`,
        );
    }
    assert.strictEqual(R.personaRanWith({ source: 'published', unpublishedChanges: 0 }), true);
    assert.strictEqual(R.personaRanWith({ source: 'published', unpublishedChanges: 1 }), false);
});
