/**
 * The structured role (A1c): normalisation, rendering, the read projection that
 * stands in for a migration, and the config fold.
 *
 * Everything here is pure — the module has no requires — so there is no
 * harness. What the tests are FOR is the set of one-way rules the rest of the
 * stage leans on: an unreadable field narrows, an empty persona never erases a
 * prompt, and the fold only ever adds.
 *
 * Run: cd server && node --test --test-force-exit core/agentRuntime/personaPrompt.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    UNKNOWN_MODES,
    LIMITS,
    WEB_SEARCH_APP_ID,
    emptyPersona,
    languageNameOf,
    normalisePersona,
    personaOf,
    renderSystemPrompt,
    renderedPromptFor,
    applyPersonaToConfig,
} = require('./personaPrompt');

const FIELDS = {
    who: 'You are the support agent for Acme.',
    tone: { chips: ['friendly', 'concise'], text: 'Keep answers under five lines.' },
    does: ['Answer product questions', 'Point at the right manual'],
    doesNot: ['Give legal advice'],
    unknown: { mode: 'honest' },
    language: 'nl',
    mode: 'fields',
};

// ── normalisePersona: total, and narrowing ──────────────────────────

test('anything unreadable normalises to the empty persona instead of throwing', () => {
    for (const junk of [undefined, null, 'not json', 42, [], true, () => {}, NaN]) {
        const { persona } = normalisePersona(junk);
        assert.deepStrictEqual(persona, emptyPersona(), `${String(junk)} must clamp to the empty persona`);
    }
});

test('an unknown-mode nobody can read lands on "honest", never on web or handoff', () => {
    // 'web' switches an app on and 'handoff' hands a routine to the model.
    // A typo may not reach either of them.
    for (const bad of ['web ', 'WEB', 'search', true, 1, null, {}]) {
        const { persona } = normalisePersona({ unknown: { mode: bad } });
        assert.strictEqual(persona.unknown.mode, 'honest', `${JSON.stringify(bad)} must not widen`);
    }
    // …and the three real ones do survive, or the guard above would be a wall.
    for (const good of UNKNOWN_MODES) {
        const { persona } = normalisePersona({ unknown: { mode: good, automationId: 'auto-1' } });
        assert.strictEqual(persona.unknown.mode, good);
    }
});

test('an automationId only survives on the handoff mode', () => {
    const { persona } = normalisePersona({ unknown: { mode: 'web', automationId: 'auto-1' } });
    assert.strictEqual(persona.unknown.automationId, null,
        'a routine id parked on a non-handoff persona is a grant waiting for a mode flip');
});

test('a language we cannot name is dropped, and says so', () => {
    const { persona, warnings } = normalisePersona({ language: 'klingon' });
    assert.strictEqual(persona.language, null);
    assert.ok(warnings.some(w => /language/.test(w)));
    assert.strictEqual(normalisePersona({ language: 'nl-NL' }).persona.language, 'nl-NL');
});

test('text fields are bounded, de-duplicated and stripped of control characters', () => {
    const { persona } = normalisePersona({
        who: 'x'.repeat(LIMITS.who + 500),
        does: [' Answer  ', 'answer', 'Second', ...Array.from({ length: 40 }, (_, i) => `bullet ${i}`)],
        tone: { chips: Array.from({ length: 30 }, (_, i) => `chip${i}`), text: 'ok\u0000\u0007fine' },
    });
    assert.strictEqual(persona.who.length, LIMITS.who);
    assert.strictEqual(persona.does.length, LIMITS.bullets);
    assert.deepStrictEqual(persona.does.slice(0, 2), ['Answer', 'Second'], 'case-insensitive de-dup, whitespace collapsed');
    assert.strictEqual(persona.tone.chips.length, LIMITS.chips);
    assert.strictEqual(persona.tone.text, 'okfine');
});

test('fields mode DROPS freeText — one truth per mode', () => {
    const { persona } = normalisePersona({ ...FIELDS, freeText: 'a rule the owner thinks they deleted' });
    assert.strictEqual(persona.freeText, '');
    // …and free mode keeps BOTH: the text is the truth, the fields describe it.
    const free = normalisePersona({ ...FIELDS, mode: 'free', freeText: 'the real prompt' }).persona;
    assert.strictEqual(free.freeText, 'the real prompt');
    assert.deepStrictEqual(free.does, FIELDS.does);
});

test('normalisePersona never shares state between calls', () => {
    const a = normalisePersona({ does: ['one'] }).persona;
    const b = normalisePersona(null).persona;
    a.does.push('two');
    assert.deepStrictEqual(b.does, [], 'emptyPersona must hand out a fresh object every time');
});

// ── personaOf: the migration that is a read, not a write ────────────

test('a row without a persona column reads back as free mode over its own prompt', () => {
    const persona = personaOf({ id: 'a1', persona: null, system_prompt: 'You are helpful.' });
    assert.strictEqual(persona.mode, 'free');
    assert.strictEqual(persona.freeText, 'You are helpful.');
});

test('free mode with an empty box still shows the live prompt', () => {
    const persona = personaOf({ persona: { mode: 'free', freeText: '' }, system_prompt: 'stored prompt' });
    assert.strictEqual(persona.freeText, 'stored prompt');
});

test('a stored fields persona is NOT overwritten by the row prompt', () => {
    const persona = personaOf({ persona: FIELDS, system_prompt: 'the generated text' });
    assert.strictEqual(persona.mode, 'fields');
    assert.strictEqual(persona.freeText, '', 'the prompt is the OUTPUT here, not a second source');
    assert.strictEqual(persona.who, FIELDS.who);
});

test('a persona column stored as a JSON string is read, not ignored', () => {
    const persona = personaOf({ persona: JSON.stringify(FIELDS), system_prompt: 'x' });
    assert.strictEqual(persona.who, FIELDS.who);
});

// ── renderSystemPrompt ──────────────────────────────────────────────

test('the rendered prompt carries every field that was filled in', () => {
    const out = renderSystemPrompt(FIELDS);
    assert.match(out, /^You are the support agent for Acme\./);
    assert.match(out, /Tone: friendly, concise\. Keep answers under five lines\./);
    assert.match(out, /What you do:\n- Answer product questions\n- Point at the right manual/);
    assert.match(out, /What you never do:\n- Give legal advice/);
    assert.match(out, /say so plainly/);
    assert.match(out, /Always write your replies in Dutch/);
});

test('free mode renders the free text verbatim', () => {
    assert.strictEqual(renderSystemPrompt({ mode: 'free', freeText: 'line one\nline two' }), 'line one\nline two');
});

test('a hand-off without a VERIFIED routine renders the honest line, never a promise', () => {
    const persona = { ...FIELDS, unknown: { mode: 'handoff', automationId: 'auto-1' } };
    const unverified = renderSystemPrompt(persona);
    assert.match(unverified, /say so plainly/);
    assert.ok(!/hand it over with/.test(unverified),
        'telling the model to use an action it was never given is an instruction to hallucinate one');

    const verified = renderSystemPrompt(persona, { handoffLabel: 'automation_auto_1' });
    assert.match(verified, /hand it over with the "automation_auto_1" action/);
});

test('an empty persona renders to nothing — and renderedPromptFor says "not my decision"', () => {
    assert.strictEqual(renderSystemPrompt({ mode: 'fields' }), '');
    assert.strictEqual(renderedPromptFor({ mode: 'fields' }), null,
        'an empty persona object arriving on a PUT must never be what erases an agent\'s instructions');
    assert.strictEqual(renderedPromptFor({ mode: 'free', freeText: '   ' }), null);
    assert.strictEqual(renderedPromptFor(FIELDS), renderSystemPrompt(FIELDS));
});

test('the DEFAULT unknown line and the language line never ship on their own', () => {
    // Otherwise "I filled in no fields" becomes an instruction set nobody wrote.
    // 'honest' is what an untouched persona normalises to, so it proves nothing.
    assert.strictEqual(renderSystemPrompt({ mode: 'fields', unknown: { mode: 'honest' }, language: 'nl' }), '');
    assert.strictEqual(renderSystemPrompt({ mode: 'fields', language: 'nl' }), '');
    assert.strictEqual(renderedPromptFor({ mode: 'fields', language: 'nl' }), null);
});

test('an explicit unknown CHOICE is content — the card promises it reaches the prompt', () => {
    // De Rol-kaart zegt bij "Hand it to a person": "It starts a routine you
    // pick and tells the user the question was handed over." Zonder deze tak
    // kreeg zo'n agent wel de routine-grant (applyPersonaToConfig) en een pil
    // met de routinenaam, maar geen woord instructie die de routine noemde.
    const handoff = { mode: 'fields', unknown: { mode: 'handoff', automationId: 'auto-1' } };
    const rendered = renderSystemPrompt(handoff, { handoffLabel: 'automation_auto_1' });
    assert.match(rendered, /hand it over with the "automation_auto_1" action/);
    assert.strictEqual(renderedPromptFor(handoff, { handoffLabel: 'automation_auto_1' }), rendered);

    // Same for "search the web": the save asks for the app, so the prompt has
    // to say what the agent should do with it.
    assert.match(renderSystemPrompt({ mode: 'fields', unknown: { mode: 'web' } }), /search the web for it/);

    // A hand-off the caller could not verify still falls back to the honest
    // line — but it is still a choice, so it still ships.
    assert.match(renderSystemPrompt(handoff), /say so plainly/);
});

test('languageNameOf refuses what it cannot name', () => {
    assert.strictEqual(languageNameOf('nl'), 'Dutch');
    assert.strictEqual(languageNameOf('NL-be'), 'Dutch');
    assert.strictEqual(languageNameOf(''), null);
    assert.strictEqual(languageNameOf('nederlands'), null);
    assert.strictEqual(languageNameOf(42), null);
});

// ── applyPersonaToConfig: additive, in all three directions ─────────

test('"say I do not know" switches strict knowledge ON for an agent that HAS knowledge', () => {
    const { config, warnings } = applyPersonaToConfig(
        { strictKnowledge: false, knowledge_base_ids: ['kb1'] },
        { ...FIELDS, unknown: { mode: 'honest' } },
    );
    assert.strictEqual(config.strictKnowledge, true);
    assert.strictEqual(warnings.length, 1);
});

test('a datatable grant is NOT knowledge for this flag — strict mode cannot see it', () => {
    // A table is a real source (agentGrounding counts it), but strictKnowledge
    // is not about sources in general: contextBuilder turns it into "refuse
    // unless the KNOWLEDGE BASE RESULTS section answers it", and
    // knowledgeSearch builds that section from config.knowledge_base_ids only.
    // Switching it on for a table-only agent would make it refuse the very
    // questions its table can answer.
    const before = { strictKnowledge: false, tools: { datatables: { 'tbl-1': { columns: ['a'] } } } };
    const { config, warnings } = applyPersonaToConfig(before, { ...FIELDS, unknown: { mode: 'honest' } });
    assert.strictEqual(config, before);
    assert.deepStrictEqual(warnings, []);
});

test('"say I do not know" does NOT switch strict knowledge on when there is no knowledge', () => {
    // strictKnowledge is not a gentler honesty setting: contextBuilder turns it
    // into "refuse unless the KNOWLEDGE BASE RESULTS section answers it", and an
    // agent with nothing linked never has one. Switching it on there would not
    // make the agent honest, it would make it answer nothing — and that is
    // exactly the agent the wizard creates (fields, honest, no KB yet).
    for (const before of [
        { strictKnowledge: false },
        { strictKnowledge: false, knowledge_base_ids: [] },
        { strictKnowledge: false, knowledge_base_ids: ['   '] },
        { strictKnowledge: false, tools: { datatables: {} } },
        { strictKnowledge: false, knowledge_base_ids: 'unreadable' },
        // Onbekend versmalt: een config die niet te lezen is mag nooit het
        // ding zijn dat een agent stilletjes op weigeren zet.
        { strictKnowledge: false, tools: 'unreadable' },
    ]) {
        const { config, warnings } = applyPersonaToConfig(before, { ...FIELDS, unknown: { mode: 'honest' } });
        assert.strictEqual(config, before, `${JSON.stringify(before)} has nothing to be strict about`);
        assert.deepStrictEqual(warnings, [],
            'nothing the owner asked for went missing — the honest LINE still ships — so this may not nag on every save');
    }
});

test('the camelCase spelling is NOT knowledge either — nothing searches it', () => {
    // knowledgeSearch.js reads `agent.config?.knowledge_base_ids` and has no
    // camelCase branch, so a row carrying only `knowledgeBaseIds` searches zero
    // knowledge bases every turn. Counting it here would flip such an agent to
    // refusing everything.
    const before = { strictKnowledge: false, knowledgeBaseIds: ['kb1'] };
    const { config } = applyPersonaToConfig(before, { ...FIELDS, unknown: { mode: 'honest' } });
    assert.strictEqual(config, before);
});

test('…and no persona mode ever switches strict knowledge OFF', () => {
    for (const mode of UNKNOWN_MODES) {
        const { config } = applyPersonaToConfig({ strictKnowledge: true, enabledIntegrations: [] }, { ...FIELDS, unknown: { mode, automationId: 'a' } });
        assert.strictEqual(config.strictKnowledge, true,
            `${mode} must not clear a restriction the owner set in the other editor`);
    }
});

test('"search the web" appends the app and touches nothing else', () => {
    const before = { enabledIntegrations: ['gmail'], knowledge_base_ids: ['kb1'] };
    const { config } = applyPersonaToConfig(before, { ...FIELDS, unknown: { mode: 'web' } });
    assert.deepStrictEqual(config.enabledIntegrations, ['gmail', WEB_SEARCH_APP_ID]);
    assert.deepStrictEqual(config.knowledge_base_ids, ['kb1']);
    assert.deepStrictEqual(before.enabledIntegrations, ['gmail'], 'the input config is not mutated');
});

test('"search the web" does not CREATE the app list — that would read as "every other app off"', () => {
    const { config, warnings } = applyPersonaToConfig({ knowledge_base_ids: [] }, { ...FIELDS, unknown: { mode: 'web' } });
    assert.ok(!('enabledIntegrations' in config));
    assert.ok(warnings.some(w => w.includes(WEB_SEARCH_APP_ID)));
});

test('a hand-off grant is written ONLY for a routine the caller verified', () => {
    const persona = { ...FIELDS, unknown: { mode: 'handoff', automationId: 'auto-1' } };

    const unverified = applyPersonaToConfig({ enabledIntegrations: [] }, persona, {});
    assert.strictEqual(unverified.config.tools, undefined,
        'no verification, no grant — this module cannot check, so it never assumes');

    const verified = applyPersonaToConfig({ enabledIntegrations: [] }, persona, { handoffAutomationId: 'auto-1' });
    assert.deepStrictEqual(verified.config.tools.automations, { 'auto-1': { confirm: 'ask' } },
        'nothing here knows what the routine DOES, so it asks');
});

test('an existing hand-off grant is left exactly as the owner set it', () => {
    const before = { tools: { automations: { 'auto-1': { confirm: 'direct' } }, gmail: { actions: ['gmail_search'] } } };
    const { config, warnings } = applyPersonaToConfig(before, { ...FIELDS, unknown: { mode: 'handoff', automationId: 'auto-1' } }, { handoffAutomationId: 'auto-1' });
    assert.strictEqual(config, before, 'nothing changed, so nothing was copied');
    assert.deepStrictEqual(warnings, []);
});

test('a free-mode persona has no config side effects at all', () => {
    const before = { strictKnowledge: false, enabledIntegrations: [] };
    const { config, warnings } = applyPersonaToConfig(before, { ...FIELDS, mode: 'free', freeText: 'text', unknown: { mode: 'honest' } });
    assert.strictEqual(config, before);
    assert.deepStrictEqual(warnings, []);
});

test('a config that is not an object comes back untouched', () => {
    for (const junk of [undefined, null, 'x', 7, []]) {
        assert.strictEqual(applyPersonaToConfig(junk, FIELDS).config, junk);
    }
});
