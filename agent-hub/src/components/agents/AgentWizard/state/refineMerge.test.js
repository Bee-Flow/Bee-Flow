// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildRefineContext, diffRefinedPlan, hasFreeInstruction, mergeRefinedPlan, personaFieldsOf } from './refineMerge';

const currentState = () => ({
    name: 'Support Bot',
    description: 'Helps with support',
    systemPrompt: 'Be helpful.',
    avatar: '🤖',
    model: 'tier:thinking',
    config: {
        enabledIntegrations: ['gmail', 'google-calendar'],
        attachedSkillIds: ['skill-1'],
        knowledge_base_ids: ['kb-1'],
        wizard: { capabilities: ['answer questions'] },
        memoryEnabled: true, // an unrelated config key that must survive
    },
});

describe('buildRefineContext', () => {
    it('carries the live curated config (model/apps/skills/kbs) and live description', () => {
        const ctx = buildRefineContext({
            name: 'Support Bot',
            description: 'live description',
            avatar: '🤖',
            systemPrompt: 'Be helpful.',
            capabilities: ['a'],
            model: 'tier:thinking',
            enabledIntegrations: ['gmail'],
            attachedSkills: [{ id: 'skill-1', name: 'Refunds' }],
            knowledge_base_ids: ['kb-1'],
        });
        expect(ctx.plan.description).toBe('live description');
        expect(ctx.plan.systemPrompt).toBe('Be helpful.');
        expect(ctx.current.model).toBe('tier:thinking');
        expect(ctx.current.enabledIntegrations).toEqual(['gmail']);
        expect(ctx.current.attachedSkills).toEqual([{ id: 'skill-1', name: 'Refunds' }]);
        expect(ctx.current.knowledge_base_ids).toEqual(['kb-1']);
    });

    it('stuurt de rol mee zodat een verfijning hem bijstelt in plaats van hem opnieuw te verzinnen', () => {
        const ctx = buildRefineContext({
            name: 'Support Bot',
            persona: {
                who: 'You are support.',
                tone: { chips: ['friendly'], text: '' },
                does: ['Answer questions'],
                doesNot: ['Never promise a refund.'],
                unknown: { mode: 'handoff', automationId: 'auto-1' },
                language: 'nl',
                mode: 'fields',
                freeText: '',
            },
        });
        expect(ctx.plan.persona).toEqual({
            who: 'You are support.',
            tone: { chips: ['friendly'], text: '' },
            does: ['Answer questions'],
            doesNot: ['Never promise a refund.'],
        });
        // De drie velden met gevolgen (een app, strenge kennis, een grant) en
        // de modus zijn niet van het model.
        expect(ctx.plan.persona.unknown).toBeUndefined();
        expect(ctx.plan.persona.mode).toBeUndefined();
    });

    it('laat het rolblok WEG als er geen rol is — een leeg blok is een bewering', () => {
        expect('persona' in buildRefineContext({ name: 'X' }).plan).toBe(false);
        expect('persona' in buildRefineContext({ name: 'X', persona: { mode: 'free', freeText: 'tekst' } }).plan).toBe(false);
    });
});

describe('mergeRefinedPlan — preserve & patch', () => {
    const opts = {
        availableIntegrationIds: ['gmail', 'google-calendar', 'google-drive'],
        selectableTierKeys: ['fast', 'thinking'],
    };

    it('a tone-only refine keeps curated apps, model, skills and KBs', () => {
        const current = currentState();
        // AI returns only a new systemPrompt; omits apps/model/skills/kbs.
        const updated = { name: 'Support Bot', systemPrompt: 'Be warm and helpful.' };
        const preserved = {
            model: 'tier:thinking',
            enabledIntegrations: ['gmail', 'google-calendar'],
            attachedSkillIds: ['skill-1'],
            knowledge_base_ids: ['kb-1'],
        };
        const merged = mergeRefinedPlan(current, updated, preserved, opts);

        expect(merged.systemPrompt).toBe('Be warm and helpful.');       // patched
        expect(merged.model).toBe('tier:thinking');                     // preserved
        expect(merged.config.enabledIntegrations).toEqual(['gmail', 'google-calendar']); // preserved
        expect(merged.config.attachedSkillIds).toEqual(['skill-1']);    // preserved
        expect(merged.config.knowledge_base_ids).toEqual(['kb-1']);     // preserved
        expect(merged.config.memoryEnabled).toBe(true);                 // unrelated key survives
    });

    it('never blanks the model, and applies a NEW selectable tier when asked', () => {
        const current = currentState();
        const merged = mergeRefinedPlan(current, { model: 'fast' }, {}, opts);
        expect(merged.model).toBe('tier:fast');
        // non-selectable tier is ignored, current kept
        const merged2 = mergeRefinedPlan(current, { model: 'nonexistent' }, {}, opts);
        expect(merged2.model).toBe('tier:thinking');
        // absent model → keep current
        const merged3 = mergeRefinedPlan(current, {}, {}, opts);
        expect(merged3.model).toBe('tier:thinking');
    });

    it('unions skills — existing survive and new resolved ids are added, none dropped', () => {
        const current = currentState();
        const merged = mergeRefinedPlan(current, { skills: [] }, {}, {
            ...opts,
            resolvedSkillIds: ['skill-1', 'skill-2'],
        });
        expect(merged.config.attachedSkillIds).toEqual(['skill-1', 'skill-2']);
    });

    it('replaces apps only with a non-empty AI array; an empty array preserves', () => {
        const current = currentState();
        // AI adds drive + removes calendar (non-empty) → replace
        const merged = mergeRefinedPlan(current, { enabledIntegrations: ['gmail', 'google-drive'] }, {}, opts);
        expect(merged.config.enabledIntegrations).toEqual(['gmail', 'google-drive']);
        // AI returns empty → preserve curated
        const merged2 = mergeRefinedPlan(current, { enabledIntegrations: [] }, {}, opts);
        expect(merged2.config.enabledIntegrations).toEqual(['gmail', 'google-calendar']);
        // AI returns an unknown id → filtered out
        const merged3 = mergeRefinedPlan(current, { enabledIntegrations: ['gmail', 'bogus'] }, {}, opts);
        expect(merged3.config.enabledIntegrations).toEqual(['gmail']);
    });

    it('patches systemPrompt only when non-blank; preserves on blank/absent', () => {
        const current = currentState();
        expect(mergeRefinedPlan(current, { systemPrompt: '   ' }, {}, opts).systemPrompt).toBe('Be helpful.');
        expect(mergeRefinedPlan(current, {}, {}, opts).systemPrompt).toBe('Be helpful.');
        expect(mergeRefinedPlan(current, { systemPrompt: 'New.' }, {}, opts).systemPrompt).toBe('New.');
    });

    it('preserves knowledge_base_ids when the AI omits or empties them', () => {
        const current = currentState();
        expect(mergeRefinedPlan(current, {}, {}, opts).config.knowledge_base_ids).toEqual(['kb-1']);
        expect(mergeRefinedPlan(current, { knowledge_base_ids: [] }, {}, opts).config.knowledge_base_ids).toEqual(['kb-1']);
        expect(mergeRefinedPlan(current, { knowledge_base_ids: ['kb-2'] }, {}, opts).config.knowledge_base_ids).toEqual(['kb-2']);
    });
});

describe('mergeRefinedPlan — persona (A1c)', () => {
    const opts = {
        availableIntegrationIds: ['gmail', 'google-calendar', 'google-drive'],
        selectableTierKeys: ['fast', 'thinking'],
    };
    const withPersona = () => ({
        ...currentState(),
        persona: {
            who: 'Helps with support',
            tone: { chips: ['friendly'], text: '' },
            does: ['answer questions'],
            doesNot: ['promise refunds'],
            unknown: { mode: 'web', automationId: null },
            language: 'nl',
            mode: 'fields',
            freeText: '',
        },
    });

    it('a refine that does not touch the prompt leaves the persona exactly as it was', () => {
        const current = withPersona();
        const merged = mergeRefinedPlan(current, { name: 'Support Bot' }, {}, opts);
        expect(merged.systemPrompt).toBe('Be helpful.');
        expect(merged.persona).toBe(current.persona);
    });

    it('an agent without a persona keeps having none — the PUT then omits the field', () => {
        const merged = mergeRefinedPlan(currentState(), { name: 'Support Bot' }, {}, opts);
        expect(merged.persona).toBeUndefined();
    });

    it('a refined PROMPT takes the persona to free mode over it — fields may not outrank it', () => {
        // Persona is the source the server renders the prompt from. Leaving the
        // old fields in place would render them straight back over the text the
        // refine just produced.
        const current = withPersona();
        const merged = mergeRefinedPlan(current, { systemPrompt: 'Be warm and helpful.', capabilities: ['answer faster'], description: 'Helps faster' }, {}, opts);
        expect(merged.persona.mode).toBe('free');
        expect(merged.persona.freeText).toBe('Be warm and helpful.');
        expect(merged.persona.does).toEqual(['answer faster']);
        expect(merged.persona.who).toBe('Helps faster');
        // Settings the refine said nothing about are carried, not reset.
        expect(merged.persona.unknown).toEqual({ mode: 'web', automationId: null });
        expect(merged.persona.language).toBe('nl');
        expect(merged.persona.doesNot).toEqual(['promise refunds']);
    });

    it('een persona die NIET GELEZEN kon worden laat de kolom met rust', () => {
        // De lijstroute strippt `persona` (agentCrud._stripPersona), dus alles
        // hangt aan de extra `GET /agents/:id?draft=1` — en die kan 403'en. Op
        // dat antwoord bouwde deze functie een verse persona in VRIJE modus over
        // een agent die in de kolom `{mode:'fields', unknown:{mode:'handoff',
        // automationId:'auto-1'}, language:'nl'}` kan hebben staan: de
        // doorgeef-automation en de taalregel stil weg, en de vijf rolkaarten
        // alleen-lezen. `undefined` laat de PUT het veld weg.
        const merged = mergeRefinedPlan(currentState(), { systemPrompt: 'Be warm.' }, {}, opts);
        expect(merged.persona).toBeUndefined();
        expect(merged.systemPrompt).toBe('Be warm.');
    });

    it('…maar een agent die nog GEEN rij heeft krijgt er wél een', () => {
        // `noStoredPersona` is het enige antwoord dat zegt "er staat niets in de
        // kolom". Zonder die uitzondering zou de eerste verfijning van een verse
        // agent nooit een persona schrijven en bleef de Rol-tab alleen-lezen.
        const fresh = { ...currentState(), noStoredPersona: true };
        const merged = mergeRefinedPlan(fresh, { systemPrompt: 'Be warm.' }, {}, opts);
        expect(merged.persona).toEqual({
            who: 'Helps with support',
            does: ['answer questions'],
            mode: 'free',
            freeText: 'Be warm.',
        });
    });

    it('een verfijning kan een regel ook WEGHALEN als het plan een rolblok draagt', () => {
        // "Absent/leeg ⇒ behouden" was ongevaarlijk toen het prompt de bron was.
        // Nu de velden de bron zijn, betekende het dat de eigenaar "je mág
        // voortaan over terugbetalingen praten" kon vragen, het model de regel
        // netjes uit `doesNot` én uit het prompt haalde, en de server hem
        // daarna gewoon terugrendeerde uit de bewaarde `doesNot`.
        const merged = mergeRefinedPlan(withPersona(), {
            systemPrompt: 'Be warm and helpful.',
            persona: { who: 'Support', tone: { chips: [], text: '' }, does: ['answer'], doesNot: [] },
        }, {}, opts);
        expect(merged.persona.doesNot).toEqual([]);
        expect(merged.persona.does).toEqual(['answer']);
        expect(merged.persona.tone).toEqual({ chips: [], text: '' });
        // De instellingen die het plan niet noemt reizen nog steeds mee.
        expect(merged.persona.unknown).toEqual({ mode: 'web', automationId: null });
        expect(merged.persona.language).toBe('nl');
    });

    it('draagt het plan GEEN rolblok, dan geldt "behouden" nog steeds', () => {
        const merged = mergeRefinedPlan(withPersona(), { systemPrompt: 'Be warm and helpful.' }, {}, opts);
        expect(merged.persona.doesNot).toEqual(['promise refunds']);
    });
});

// ── A3: de wizard schrijft de eerste versie naar de VELDEN ──────────
//
// De wizard maakt eerst een lege agent (`POST /agents` met systemPrompt: '')
// en geeft de ene zin dan aan de verfijn-rail. Dat is de "eerste versie", en
// vanaf A3 is de rol een VELD, geen prozablok — anders staan de vijf kaarten
// van de Rol-tab bij vrijwel elke agent alleen-lezen.
describe('mergeRefinedPlan — de eerste versie uit één zin', () => {
    const opts = {
        availableIntegrationIds: ['gmail'],
        selectableTierKeys: ['fast', 'thinking'],
    };
    // De agent zoals de wizard hem net aanmaakte: geen prompt, en nog geen RIJ.
    // `noStoredPersona` zegt dat er niets in de kolom staat om te beschermen —
    // iets anders dan een persona die we niet KONDEN lezen (die krijgt hieronder
    // zijn eigen tests, en die laat de kolom met rust).
    const freshAgent = () => ({
        name: 'Untitled',
        description: '',
        systemPrompt: '',
        avatar: '🤖',
        model: '',
        config: { enabledIntegrations: [], attachedSkillIds: [], knowledge_base_ids: [] },
        noStoredPersona: true,
    });
    const planWithRole = () => ({
        name: 'Invoice desk',
        description: 'Answers invoice questions',
        systemPrompt: 'You are the invoice desk. Be brief.',
        capabilities: ['Answer invoice questions'],
        persona: {
            who: 'You are the invoice desk for Acme customers.',
            tone: { chips: ['friendly', 'concise'], text: 'Two paragraphs at most.' },
            does: ['Look the invoice up before answering.'],
            doesNot: ['Never promise a refund.'],
        },
    });

    it('schrijft de rol van het plan naar de velden, niet naar de vrije tekst', () => {
        const merged = mergeRefinedPlan(freshAgent(), planWithRole(), {}, opts);
        expect(merged.persona.mode).toBe('fields');
        expect(merged.persona.freeText).toBe('');
        expect(merged.persona.who).toBe('You are the invoice desk for Acme customers.');
        expect(merged.persona.tone).toEqual({ chips: ['friendly', 'concise'], text: 'Two paragraphs at most.' });
        expect(merged.persona.does).toEqual(['Look the invoice up before answering.']);
        expect(merged.persona.doesNot).toEqual(['Never promise a refund.']);
    });

    it('laat een agent die AL een vrije instructie heeft in vrije modus staan', () => {
        // De harde belofte: wie zijn instructie zelf schrijft, vindt hem na een
        // verfijning niet vervangen door vijf velden.
        const current = { ...freshAgent(), systemPrompt: 'Ik heb dit zelf getypt.' };
        const merged = mergeRefinedPlan(current, planWithRole(), {}, opts);
        expect(merged.persona.mode).toBe('free');
        expect(merged.persona.freeText).toBe('You are the invoice desk. Be brief.');
        // De velden BESCHRIJVEN die tekst wel — dat is wat vrije modus betekent.
        expect(merged.persona.who).toBe('You are the invoice desk for Acme customers.');
    });

    it('…ook als die instructie alleen in de persona staat en niet in systemPrompt', () => {
        const current = {
            ...freshAgent(),
            persona: { mode: 'free', freeText: 'Ik heb dit zelf getypt.', who: '', does: [] },
        };
        expect(mergeRefinedPlan(current, planWithRole(), {}, opts).persona.mode).toBe('free');
    });

    it('houdt een agent die al in veldmodus staat in veldmodus', () => {
        const current = {
            ...freshAgent(),
            // In veldmodus is systemPrompt de RENDERING van de velden, geen
            // eigen tekst — dus er is niets van iemand om te beschermen.
            systemPrompt: 'You are support.\n\nWhat you do:\n- Answer questions',
            persona: { mode: 'fields', freeText: '', who: 'You are support.', does: ['Answer questions'] },
        };
        const merged = mergeRefinedPlan(current, planWithRole(), {}, opts);
        expect(merged.persona.mode).toBe('fields');
    });

    it('valt terug op vrije modus als het plan geen rol draagt', () => {
        // Een oudere server, of een model dat het blok oversloeg. Dan is de
        // prozatekst het enige dat er is, en die mag niet weggegooid worden
        // voor velden die uit description + capabilities geraden zijn.
        const plan = planWithRole();
        delete plan.persona;
        const merged = mergeRefinedPlan(freshAgent(), plan, {}, opts);
        expect(merged.persona.mode).toBe('free');
        expect(merged.persona.freeText).toBe('You are the invoice desk. Be brief.');
    });

    it('een leeg rolblok is geen rol', () => {
        const plan = planWithRole();
        plan.persona = { who: '  ', tone: { chips: [], text: '' }, does: [], doesNot: [] };
        expect(mergeRefinedPlan(freshAgent(), plan, {}, opts).persona.mode).toBe('free');
    });
});

describe('hasFreeInstruction', () => {
    it('leest de persona eerst en het prompt als terugval', () => {
        expect(hasFreeInstruction({})).toBe(false);
        expect(hasFreeInstruction({ systemPrompt: '   ' })).toBe(false);
        expect(hasFreeInstruction({ systemPrompt: 'iets' })).toBe(true);
        expect(hasFreeInstruction({ persona: { mode: 'free', freeText: 'iets' } })).toBe(true);
        expect(hasFreeInstruction({ persona: { mode: 'free', freeText: '' }, systemPrompt: '' })).toBe(false);
        // Veldmodus: het prompt is de rendering van de velden, geen eigen tekst.
        expect(hasFreeInstruction({ persona: { mode: 'fields' }, systemPrompt: 'gerenderd' })).toBe(false);
        // Onbekende persona + tekst in het prompt ⇒ de smalle lezing: die tekst
        // is van iemand tot het tegendeel blijkt.
        expect(hasFreeInstruction({ persona: undefined, systemPrompt: 'tekst' })).toBe(true);
        expect(hasFreeInstruction({ persona: 'rommel', systemPrompt: 'tekst' })).toBe(true);
    });
});

describe('personaFieldsOf', () => {
    it('geeft de vier beschrijvende velden, en null voor wat geen rol is', () => {
        expect(personaFieldsOf(null)).toBeNull();
        expect(personaFieldsOf('x')).toBeNull();
        expect(personaFieldsOf([])).toBeNull();
        expect(personaFieldsOf({})).toBeNull();
        expect(personaFieldsOf({ who: '  ', does: ['  '] })).toBeNull();
        expect(personaFieldsOf({ mode: 'free', freeText: 'tekst' })).toBeNull();

        expect(personaFieldsOf({
            who: ' You are support. ',
            tone: { chips: [' friendly ', ''], text: ' kort ' },
            does: ['a', '  '],
            doesNot: [],
            unknown: { mode: 'handoff', automationId: 'auto-1' },
            language: 'nl',
            mode: 'free',
            freeText: 'niet meesturen',
        })).toEqual({
            who: 'You are support.',
            tone: { chips: ['friendly'], text: 'kort' },
            does: ['a'],
            doesNot: [],
        });
    });
});

describe('diffRefinedPlan — wat de verfijning feitelijk deed', () => {
    const merge = (updated, preserved = {}, opts = {}) => mergeRefinedPlan(
        currentState(), updated, preserved,
        { availableIntegrationIds: ['gmail', 'google-calendar', 'slack'], selectableTierKeys: ['fast', 'thinking'], ...opts },
    );

    it('een verfijning die niets veranderde levert een LEGE lijst — geen "Gedaan" over niets', () => {
        // Precies het geval waarin het model de bestaande tekst terugkopieert.
        const before = currentState();
        expect(diffRefinedPlan(before, merge({}))).toEqual([]);
    });

    it('noemt de herschreven instructies', () => {
        const changes = diffRefinedPlan(currentState(), merge({ systemPrompt: 'Be brief.' }));
        expect(changes).toEqual([{ field: 'systemPrompt' }]);
    });

    it('telt toegevoegde apps als één regel met een aantal, niet als losse zinnen', () => {
        const after = merge({ enabledIntegrations: ['gmail', 'google-calendar', 'slack'] });
        expect(diffRefinedPlan(currentState(), after))
            .toEqual([{ field: 'apps', direction: 'added', count: 1, ids: ['slack'] }]);
    });

    it('meldt een verwijdering apart van een toevoeging', () => {
        const after = merge({ enabledIntegrations: ['gmail', 'slack'] });
        expect(diffRefinedPlan(currentState(), after)).toEqual([
            { field: 'apps', direction: 'added', count: 1, ids: ['slack'] },
            { field: 'apps', direction: 'removed', count: 1, ids: ['google-calendar'] },
        ]);
    });

    it('noemt nieuwe skills en kennisbanken elk op hun eigen regel', () => {
        const after = merge({ knowledge_base_ids: ['kb-1', 'kb-2'] }, {}, { resolvedSkillIds: ['skill-1', 'skill-2'] });
        expect(diffRefinedPlan(currentState(), after)).toEqual([
            { field: 'skills', direction: 'added', count: 1, ids: ['skill-2'] },
            { field: 'knowledge', direction: 'added', count: 1, ids: ['kb-2'] },
        ]);
    });

    it('zwijgt over de persona — die volgt de instructies en zou dubbel tellen', () => {
        const after = mergeRefinedPlan(
            { ...currentState(), noStoredPersona: true }, { systemPrompt: 'Be brief.' }, {},
            { availableIntegrationIds: ['gmail', 'google-calendar', 'slack'], selectableTierKeys: ['fast', 'thinking'] },
        );
        expect(after.persona.freeText).toBe('Be brief.');
        expect(diffRefinedPlan(currentState(), after).map(c => c.field)).toEqual(['systemPrompt']);
    });

    it('leest een ontbrekende config als leeg in plaats van te klappen', () => {
        expect(diffRefinedPlan({}, {})).toEqual([]);
        expect(diffRefinedPlan({}, { config: { enabledIntegrations: ['gmail'] } }))
            .toEqual([{ field: 'apps', direction: 'added', count: 1, ids: ['gmail'] }]);
    });
});
