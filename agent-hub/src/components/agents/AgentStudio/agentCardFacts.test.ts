// @vitest-environment node
/**
 * The facts behind the agent card (A5 part C).
 *
 * What is pinned here is not "the sum adds up" but the three places where this kind of screen always loses:
 *   - EMPTY is not UNREADABLE. A config that could not be read gives `null`, because 0 is a claim — and the dotted "no knowledge base" row hangs on that 0.
 *   - UNKNOWN is neither MAY-NOT nor MAY. `/agents/system` supplies no `can_edit`, and `can_edit === false` as the only test let such a row keep its bin.
 *   - "no category" is a claim about the agent. A category id that we could not place therefore does NOT belong with it.
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
import { stub } from '@/test/mocks';

const CATS = [{ id: 'c1', name: 'Sales' }, { id: 'c2', name: 'Support' }];

describe('configOf', () => {
    it('neemt het geparseerde object dat /agents/all levert', () => {
        expect(configOf({ config: { a: 1 } })).toEqual({ a: 1 });
    });

    it('parseert een string nog wel, maar onleesbaar blijft null', () => {
        expect(configOf({ config: '{"a":1}' })).toEqual({ a: 1 });
        expect(configOf({ config: '<html>' })).toBeNull();
        expect(configOf({ config: '[1,2]' })).toBeNull(); // an array is not a config
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

    it('zonder automation-curatie is het getal een ONDERGRENS, geen totaal', () => {
        // core/integrations/integrationTools.js only curates when `config.tools` CARRIES the key `automations`; if it is missing, the agent gets EVERY agent-callable automation of the asker plus every Step published in the chat. "1 tool" was the opposite of the truth there.
        const counts = countsOf({ config: { enabledIntegrations: ['gmail'] } });
        expect(counts.tools).toBe(1);
        expect(counts.toolsAtLeast).toBe(true);
    });

    it('een LEGE automation-sectie is wél curatie — de aanwezigheid van de sleutel is de keuze', () => {
        // Mirror of `_curatedAutomations`: `hasOwnProperty('automations')`, not the content. "Everything unticked" yields not a single automation.
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
        // The header of the file ("empty is not unreadable") so far applied only to the WHOLE config. The server makes that distinction too, on the same input: agentGrounding.tablesAxis gives `null` there.
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
        expect(editVerdict(stub<Parameters<typeof editVerdict>[0]>({ can_edit: null }))).toBe(EDIT.UNKNOWN);
        expect(editVerdict(null)).toBe(EDIT.UNKNOWN);
    });
});

// `warnsNoKnowledge` no longer exists: the rule "answers from memory" lives on the server (core/agentRuntime/agentGrounding.js) and is read by this screen in one place — ./cardFooter.js. A fallback on `counts.knowledge === 0` made a second implementation of it, and that one already disagreed with Studio's start screen about a config that could not be read. See cardFooter.test.js.

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
        expect(chips.reduce((n, c) => n + c.count!, 0)).toBe(3);
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
        // A category that we cannot place. It does NOT belong with "no category" — categoryChipsOf does not count it there either, and if this filter did, the chip would contradict its own list.
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
        // The chip does not count it (categoryChipsOf excludes UNKNOWN), so if the grid did show it here the chip would say "No category 1" above two cards.
        const rows = filterAgents(AGENTS, { categoryId: NO_CATEGORY, categories: CATS });
        expect(rows.map(a => a.id)).not.toContain('d');
        const chip = categoryChipsOf(AGENTS, CATS).find(c => c.id === NO_CATEGORY);
        expect(chip!.count).toBe(rows.length);
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
