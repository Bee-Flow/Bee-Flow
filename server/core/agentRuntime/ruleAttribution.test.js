'use strict';

/**
 * The attribution pass, and the four refusals it stands on.
 *
 *   1. Only `followed` becomes a chip. `not_applicable` is the normal answer to a prohibition
 *      rule and must not earn credit; `not_followed` is a judgment and belongs in the test set,
 *      not next to the answer.
 *   2. The text of a chip is the BUILDER's bullet, looked up by number. A rule that the model
 *      invents (index 9 of a list of 2) is dropped.
 *   3. If the pass falls over — no model, a throwing call, a timeout, a shape that cannot be
 *      read — then there is NO chip. Never one that claims "no rule".
 *   4. The role that is read must be the role that ran. Draft bullets next to a published answer
 *      is a claim that nobody checked.
 *
 * Run: cd server && node --test core/agentRuntime/ruleAttribution.test.js
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

// ── 1. Which verdict becomes a chip ────────────────────────────────

test('alleen "followed" wordt een chip', () => {
    const parsed = R.parseAttribution({
        rules: [{ index: 1, verdict: 'followed' }, { index: 2, verdict: 'not_applicable' }],
    }, PERSONA.doesNot);
    assert.deepStrictEqual(R.followedFrom(parsed), [{ rule: 'Nooit een prijs noemen' }]);
});

test('BIJT — "not_applicable" geeft geen krediet', () => {
    // A prohibition is trivially "followed" on most questions; giving a chip for that
    // makes the whole row worth less.
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

// ── 4. The role must be the role that ran ───────────────────────────

test('BIJT — een gepubliceerde agent met onuitgegeven wijzigingen wordt niet geattribueerd', () => {
    // The testchat runs the draft, so the draft role belongs there.
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
    // The production chat pays nothing here. That hangs on this flag, not on the
    // place of an `if` in a route.
    //
    // The deps would PRODUCE a chip if they were called — deps that throw would give the same
    // `null` and then the test proves nothing about the gate.
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

// ── 3. If the pass falls over, there is no chip ──────────────────────

test('de hele pass, van rol tot chip', async () => {
    const { deps, calls } = passDeps({ structured: { rules: [{ index: 1, verdict: 'followed' }] }, usage: { prompt_tokens: 12 } });
    const out = await R.attributeTurn({
        testChat: true, persona: PERSONA, configInfo: DRAFT, answer: 'Daar zeg ik niets over.', question: 'Wat kost dit?',
        orgId: 'org-1', userId: 'u-1',
    }, deps);
    assert.deepStrictEqual(out, { rules: [{ rule: 'Nooit een prijs noemen' }] });
    assert.strictEqual(calls.model, 'fast-1');
    assert.strictEqual(calls.options.temperature, 0);
    // Booked under its own source, so that a testchat does not pollute the chat costs.
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
    // First let the model resolution land: before that point the timer does not yet exist, and a
    // tick on an empty clock would leave the test hanging forever afterwards.
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(R.LIMITS.timeoutMs + 1);
    assert.strictEqual(await p, null);
});

test('BIJT — zonder regels, zonder antwoord of met de verkeerde versie belt de pass niet eens', async () => {
    // Deps that would SUCCEED: a gate that is open must become visible as a chip, not disappear in a
    // catch that already gives `null` anyway.
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
    // `renderSystemPrompt` does `if (p.mode === 'free') return p.freeText;` —
    // the bullets then never reach the system prompt. A chip "Rule followed:
    // …" would give credit there for following an instruction that the
    // model never received. Two routes lead here: the button "Open as free
    // instruction" in the Role tab, and routes/agents/crud.js that pushes a persona
    // to free ITSELF as soon as a client edits the prompt.
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
    // Legacy: `personaOf` turns a NULL column into `{mode:'free'}` over the
    // prompt, and that has by definition no bullets.
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
    // `Number(null)`, `Number('')`, `Number(false)` and `Number([])` are
    // all 0, and they passed the gate that exists precisely to refuse
    // draft bullets next to a published answer.
    for (const v of [null, '', false, [], undefined, 'nul', {}, NaN]) {
        assert.strictEqual(
            R.personaRanWith({ source: 'published', unpublishedChanges: v }), false,
            `unpublishedChanges: ${JSON.stringify(v)}`,
        );
    }
    assert.strictEqual(R.personaRanWith({ source: 'published', unpublishedChanges: 0 }), true);
    assert.strictEqual(R.personaRanWith({ source: 'published', unpublishedChanges: 1 }), false);
});
