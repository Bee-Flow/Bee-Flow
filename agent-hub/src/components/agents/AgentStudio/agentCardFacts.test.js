// @vitest-environment node
/**
 * De feiten achter de agentkaart (A5 deel C).
 *
 * Wat hier gepind wordt is niet "de optelling klopt" maar de drie plekken waar
 * dit soort schermen het altijd verliezen:
 *   - LEEG is niet ONLEESBAAR. Een config die niet gelezen kon worden geeft
 *     `null`, want 0 is een bewering — en op die 0 hangt de gestippelde
 *     "geen kennisbank"-rij.
 *   - ONBEKEND is niet MAG-NIET en niet MAG-WEL. `/agents/system` levert geen
 *     `can_edit`, en `can_edit === false` als enige test liet zo'n rij zijn
 *     prullenbak houden.
 *   - "zonder categorie" is een bewering over de agent. Een categorie-id dat
 *     we niet konden thuisbrengen hoort daar dus NIET bij.
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/components/agents/AgentStudio/agentCardFacts.test.js
 */
import { describe, it, expect } from 'vitest';
import {
    CATEGORY,
    EDIT,
    NO_CATEGORY,
    categoryChipsOf,
    categoryOf,
    configOf,
    countsOf,
    editVerdict,
    filterAgents,
} from './agentCardFacts';

const CATS = [{ id: 'c1', name: 'Sales' }, { id: 'c2', name: 'Support' }];

describe('configOf', () => {
    it('neemt het geparseerde object dat /agents/all levert', () => {
        expect(configOf({ config: { a: 1 } })).toEqual({ a: 1 });
    });

    it('parseert een string nog wel, maar onleesbaar blijft null', () => {
        expect(configOf({ config: '{"a":1}' })).toEqual({ a: 1 });
        expect(configOf({ config: '<html>' })).toBeNull();
        expect(configOf({ config: '[1,2]' })).toBeNull(); // een array is geen config
    });

    it('geen config in de rij ⇒ null, niet {}', () => {
        expect(configOf({ name: 'x' })).toBeNull();
        expect(configOf({ config: null })).toBeNull();
        expect(configOf(null)).toBeNull();
    });
});

describe('countsOf', () => {
    it('telt kennis, skills en tools uit de config', () => {
        const counts = countsOf({
            config: {
                knowledge_base_ids: ['kb1', 'kb2'],
                attachedSkillIds: ['s1'],
                enabledIntegrations: ['gmail', 'agent-search'],
                tools: {
                    automations: { a1: { confirm: 'ask' } },
                    datatables: { t1: { scope: 'own' }, t2: {} },
                },
            },
        });
        expect(counts).toEqual({ readable: true, knowledge: 2, skills: 1, tools: 5, toolsAtLeast: false });
    });

    it('zonder routine-curatie is het getal een ONDERGRENS, geen totaal', () => {
        // core/integrations/integrationTools.js cureert alleen als
        // `config.tools` de sleutel `automations` DRAAGT; ontbreekt hij, dan
        // krijgt de agent élke agent-callable routine van de vrager plus elke
        // in de chat gepubliceerde Step. "1 tool" was daar het omgekeerde van
        // de waarheid.
        const counts = countsOf({ config: { enabledIntegrations: ['gmail'] } });
        expect(counts.tools).toBe(1);
        expect(counts.toolsAtLeast).toBe(true);
    });

    it('een LEGE routine-sectie is wél curatie — de aanwezigheid van de sleutel is de keuze', () => {
        // Spiegel van `_curatedAutomations`: `hasOwnProperty('automations')`,
        // niet de inhoud. "Alles uitgevinkt" levert geen enkele routine op.
        const counts = countsOf({ config: { enabledIntegrations: ['gmail'], tools: { automations: {} } } });
        expect(counts.tools).toBe(1);
        expect(counts.toolsAtLeast).toBe(false);
    });

    it('leest ook de camelCase-schrijfwijze van de kennisbanken', () => {
        expect(countsOf({ config: { knowledgeBaseIds: ['kb1', 'kb2', 'kb3'] } }).knowledge).toBe(3);
    });

    it('telt een id maar één keer, en negeert wat geen id is', () => {
        const counts = countsOf({
            config: { knowledge_base_ids: ['kb1', 'kb1', '', null, 7], attachedSkillIds: ['s1', 's1'] },
        });
        expect(counts.knowledge).toBe(1);
        expect(counts.skills).toBe(1);
    });

    it('een lege config is een GEMETEN nul — maar de tools-nul is een ondergrens', () => {
        expect(countsOf({ config: {} }))
            .toEqual({ readable: true, knowledge: 0, skills: 0, tools: 0, toolsAtLeast: true });
    });

    it('een onleesbare config geeft null, NOOIT nul', () => {
        const counts = countsOf({ name: 'x' });
        expect(counts.readable).toBe(false);
        expect(counts.knowledge).toBeNull();
        expect(counts.skills).toBeNull();
        expect(counts.tools).toBeNull();
    });

    it('een `tools` die geen object is is ONLEESBAAR, geen gemeten nul', () => {
        // De kop van het bestand ("leeg is niet onleesbaar") gold tot nu toe
        // alleen voor de héle config. De server maakt dat onderscheid wél op
        // dezelfde invoer: agentGrounding.tablesAxis geeft daar `null`.
        const counts = countsOf({ config: { tools: 'kapot', enabledIntegrations: ['gmail'] } });
        expect(counts.readable).toBe(true);
        expect(counts.tools).toBeNull();
        expect(counts.toolsAtLeast).toBe(false);
        expect(counts.knowledge).toBe(0);
    });

    it('een ontbrekende `tools` is wél gemeten — die sectie is er gewoon niet', () => {
        expect(countsOf({ config: { tools: null, enabledIntegrations: ['gmail'] } }).tools).toBe(1);
    });
});

describe('editVerdict — onbekend versmalt', () => {
    it('alleen een expliciete boolean is een antwoord', () => {
        expect(editVerdict({ can_edit: true })).toBe(EDIT.YES);
        expect(editVerdict({ can_edit: false })).toBe(EDIT.NO);
    });

    it('een rij zonder can_edit (/agents/system) is ONBEKEND, niet "mag wel"', () => {
        expect(editVerdict({ id: 'sys-1' })).toBe(EDIT.UNKNOWN);
        expect(editVerdict({ can_edit: null })).toBe(EDIT.UNKNOWN);
        expect(editVerdict(null)).toBe(EDIT.UNKNOWN);
    });
});

// `warnsNoKnowledge` bestaat niet meer: de regel "antwoordt uit het hoofd"
// staat op de server (core/agentRuntime/agentGrounding.js) en wordt door dit
// scherm op één plek gelezen — ./cardFooter.js. Een terugval op
// `counts.knowledge === 0` maakte er een tweede implementatie van, en die was
// het al oneens met Studio's Start-scherm over een config die niet te lezen
// was. Zie cardFooter.test.js.

describe('categoryOf', () => {
    it('geen category_id ⇒ NONE', () => {
        expect(categoryOf({ id: 'a' }, CATS).state).toBe(CATEGORY.NONE);
    });

    it('een bekend id ⇒ de naam', () => {
        expect(categoryOf({ category_id: 'c1' }, CATS)).toEqual({ state: CATEGORY.NAMED, id: 'c1', name: 'Sales' });
    });

    it('een id dat we niet kunnen thuisbrengen is UNKNOWN, niet "zonder categorie"', () => {
        expect(categoryOf({ category_id: 'weg' }, CATS).state).toBe(CATEGORY.UNKNOWN);
        expect(categoryOf({ category_id: 'c1' }, []).state).toBe(CATEGORY.UNKNOWN);
    });
});

describe('categoryChipsOf', () => {
    const AGENTS = [
        { id: 'a', category_id: 'c1' },
        { id: 'b', category_id: 'c1' },
        { id: 'c' },
        { id: 'd', category_id: 'weg' },
    ];

    it('alleen categorieën die echt een agent hebben, in lijstvolgorde', () => {
        const chips = categoryChipsOf(AGENTS, CATS);
        expect(chips.map(c => c.id)).toEqual(['c1', NO_CATEGORY]);
        expect(chips[0]).toEqual({ id: 'c1', name: 'Sales', count: 2 });
    });

    it('de agent met een onleesbare categorie zit in GEEN enkele chip', () => {
        const chips = categoryChipsOf(AGENTS, CATS);
        // 2 in Sales + 1 zonder categorie = 3; de vierde hoort nergens.
        expect(chips.reduce((n, c) => n + c.count, 0)).toBe(3);
    });

    it('zonder ook maar één benoemde categorie is er niets om tegen te filteren', () => {
        expect(categoryChipsOf([{ id: 'a' }, { id: 'b' }], CATS)).toEqual([]);
        expect(categoryChipsOf(AGENTS, [])).toEqual([]);
    });
});

describe('filterAgents', () => {
    const AGENTS = [
        { id: 'a', name: 'Helpdesk', description: 'answers tickets', category_id: 'c1' },
        { id: 'b', name: 'Planner', description: '', category_id: 'c2' },
        { id: 'c', name: 'Scratch', description: '' },
        // Een categorie die we niet kunnen thuisbrengen. Hij hoort NIET bij
        // "zonder categorie" — categoryChipsOf telt hem daar ook niet mee, en
        // als deze filter dat wél deed sprak de chip zijn eigen lijst tegen.
        { id: 'd', name: 'Orphan', description: '', category_id: 'weg' },
    ];

    it('zonder chip en zonder zoekterm blijft alles staan', () => {
        expect(filterAgents(AGENTS, { categories: CATS })).toHaveLength(4);
    });

    it('een chip versmalt tot die categorie', () => {
        expect(filterAgents(AGENTS, { categoryId: 'c1', categories: CATS }).map(a => a.id)).toEqual(['a']);
    });

    it('"zonder categorie" pakt alleen agents zonder category_id', () => {
        expect(filterAgents(AGENTS, { categoryId: NO_CATEGORY, categories: CATS }).map(a => a.id)).toEqual(['c']);
    });

    it('een agent met een ONLEESBARE categorie hoort niet bij "zonder categorie"', () => {
        // De chip telt hem niet mee (categoryChipsOf sluit UNKNOWN uit), dus
        // als het raster hem hier wél toonde zou de chip "No category 1" zeggen
        // boven twee kaarten.
        const rows = filterAgents(AGENTS, { categoryId: NO_CATEGORY, categories: CATS });
        expect(rows.map(a => a.id)).not.toContain('d');
        const chip = categoryChipsOf(AGENTS, CATS).find(c => c.id === NO_CATEGORY);
        expect(chip.count).toBe(rows.length);
    });

    it('zoeken kijkt naar naam, omschrijving én categorienaam', () => {
        expect(filterAgents(AGENTS, { query: 'help', categories: CATS }).map(a => a.id)).toEqual(['a']);
        expect(filterAgents(AGENTS, { query: 'tickets', categories: CATS }).map(a => a.id)).toEqual(['a']);
        expect(filterAgents(AGENTS, { query: 'support', categories: CATS }).map(a => a.id)).toEqual(['b']);
        expect(filterAgents(AGENTS, { query: 'niets', categories: CATS })).toEqual([]);
    });

    it('chip en zoekterm werken samen', () => {
        expect(filterAgents(AGENTS, { categoryId: 'c1', query: 'planner', categories: CATS })).toEqual([]);
    });
});
