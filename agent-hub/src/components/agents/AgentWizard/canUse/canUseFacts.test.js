// @vitest-environment node
/**
 * canUseFacts — de feiten achter de tab "Kan gebruiken" (A2 stap 2).
 *
 * Wat hier vastgepind wordt, is telkens hetzelfde onderscheid: LEEG en
 * ONLEESBAAR zijn twee antwoorden, en alleen het eerste mag als "de agent
 * heeft dit niet" gelezen worden.
 *
 * Run: cd agent-hub && npx vitest run src/components/agents/AgentWizard/canUse/canUseFacts.test.js
 */
import { describe, it, expect } from 'vitest';
import {
    READ, MAX_DATATABLE_GRANTS, anyFailed, countOrNull, datatableColumnsOf,
    datatableGrantsOf, datatableRows, isTrulyEmpty, knowledgeBaseRows,
    otherAgentUsers, skillRows,
} from './canUseFacts';

describe('countOrNull — een teller is een gemeten getal of niets', () => {
    it('accepteert alleen eindige, niet-negatieve getallen', () => {
        expect(countOrNull(42)).toBe(42);
        expect(countOrNull('7')).toBe(7);
        expect(countOrNull(0)).toBe(0);
        expect(countOrNull(null)).toBeNull();
        expect(countOrNull(undefined)).toBeNull();
        expect(countOrNull(-1)).toBeNull();
        expect(countOrNull(NaN)).toBeNull();
        expect(countOrNull('veel')).toBeNull();
    });
});

describe('knowledgeBaseRows', () => {
    const KBS = [
        { id: 'kb1', name: 'Quote terms', document_count: 42, last_content_at: '2026-09-06T10:00:00Z' },
        { id: 'kb2', name: 'Handbook', documentCount: 3, lastContentAt: null },
    ];

    it('leest de tellers in beide spellingen', () => {
        const rows = knowledgeBaseRows({ ids: ['kb1', 'kb2'], kbs: KBS, state: READ.OK });
        expect(rows[0]).toMatchObject({ name: 'Quote terms', documentCount: 42, lastContentAt: '2026-09-06T10:00:00Z', readable: true });
        expect(rows[1]).toMatchObject({ name: 'Handbook', documentCount: 3, lastContentAt: null, readable: true });
    });

    it('houdt een gekoppelde kennisbank die de lijst niet kent — als onleesbaar, niet als weg', () => {
        const rows = knowledgeBaseRows({ ids: ['kb1', 'kb-onbekend'], kbs: KBS, state: READ.OK });
        expect(rows).toHaveLength(2);
        expect(rows[1]).toMatchObject({ id: 'kb-onbekend', name: null, readable: false });
    });

    it('maakt van een mislukte lezing geen lege lijst: elke koppeling blijft, zonder naam', () => {
        const rows = knowledgeBaseRows({ ids: ['kb1', 'kb2'], kbs: null, state: READ.ERROR });
        expect(rows).toHaveLength(2);
        expect(rows.every(r => r.readable === false)).toBe(true);
        expect(rows.every(r => r.documentCount === null)).toBe(true);
    });

    it('verzint geen 0 documenten voor een kennisbank zonder teller', () => {
        const rows = knowledgeBaseRows({ ids: ['kb3'], kbs: [{ id: 'kb3', name: 'Leeg' }], state: READ.OK });
        expect(rows[0].documentCount).toBeNull();
    });

    it('ontdubbelt en negeert rommel in de id-lijst', () => {
        const rows = knowledgeBaseRows({ ids: ['kb1', 'kb1', '', null, 7], kbs: KBS, state: READ.OK });
        expect(rows.map(r => r.id)).toEqual(['kb1']);
    });
});

describe('datatableColumnsOf / datatableGrantsOf — de smalle kant wint', () => {
    it("'*' en afwezig betekenen elke kolom; onleesbaar betekent geen enkele", () => {
        expect(datatableColumnsOf('*')).toBe('*');
        expect(datatableColumnsOf(undefined)).toBe('*');
        expect(datatableColumnsOf(null)).toBe('*');
        expect(datatableColumnsOf('naam')).toEqual([]);
        expect(datatableColumnsOf(42)).toEqual([]);
        expect(datatableColumnsOf(['a', 'a', '', 'b'])).toEqual(['a', 'b']);
    });

    it('een onbekende scope versmalt naar "own"', () => {
        const { grants } = datatableGrantsOf({ datatables: { t1: { scope: 'everything', columns: '*' } } });
        expect(grants[0]).toEqual({ id: 't1', scope: 'own', columns: '*' });
    });

    it('een grant die geen object is blijft staan maar levert niets', () => {
        const { grants } = datatableGrantsOf({ datatables: { t1: 'ja' } });
        expect(grants[0]).toEqual({ id: 't1', scope: 'own', columns: [] });
    });

    it('telt boven de runtime-bovengrens niet mee en zegt hoeveel', () => {
        const many = {};
        for (let i = 0; i < MAX_DATATABLE_GRANTS + 3; i++) many[`t${i}`] = { scope: 'all', columns: '*' };
        const { grants, truncated } = datatableGrantsOf({ datatables: many });
        expect(grants).toHaveLength(MAX_DATATABLE_GRANTS);
        expect(truncated).toBe(3);
    });

    it('negeert prototype-sleutels en een sectie die geen object is', () => {
        expect(datatableGrantsOf({ datatables: { __proto__: { scope: 'all' } } }).grants).toEqual([]);
        expect(datatableGrantsOf({ datatables: 'nee' }).grants).toEqual([]);
        expect(datatableGrantsOf(null).grants).toEqual([]);
    });
});

describe('datatableRows', () => {
    const TOOLS = { datatables: { t1: { scope: 'own', columns: '*' }, t2: { scope: 'all', columns: [] } } };

    it('vult de naam aan waar de tabellenlijst hem kent', () => {
        const { rows } = datatableRows({ toolsConfig: TOOLS, tables: [{ id: 't1', name: 'Quotes' }], state: READ.OK });
        expect(rows[0]).toMatchObject({ id: 't1', name: 'Quotes', scope: 'own', readable: true, grantsNothing: false });
        expect(rows[1]).toMatchObject({ id: 't2', name: null, scope: 'all', readable: false, grantsNothing: true });
    });

    it('houdt elke grant als de tabellenlijst niet gelezen kon worden', () => {
        const { rows } = datatableRows({ toolsConfig: TOOLS, tables: null, state: READ.ERROR });
        expect(rows).toHaveLength(2);
        expect(rows.every(r => r.readable === false)).toBe(true);
        // De GRANT komt uit de config van de agent en is dus wél bekend.
        expect(rows[0].scope).toBe('own');
    });
});

describe('otherAgentUsers', () => {
    it('trekt de agent zelf eraf, maar alleen als hij meetelt', () => {
        expect(otherAgentUsers(3, true)).toBe(2);
        expect(otherAgentUsers(3, false)).toBe(3);
        expect(otherAgentUsers(1, true)).toBe(0);
    });

    it('zakt nooit onder nul en blijft null als er niets gemeten is', () => {
        expect(otherAgentUsers(0, true)).toBe(0);
        expect(otherAgentUsers(null, true)).toBeNull();
        expect(otherAgentUsers(undefined, false)).toBeNull();
    });
});

describe('skillRows', () => {
    const SKILLS = [
        { id: 's1', name: 'Explain a quote', icon: '📄', steps: [1, 2, 3, 4, 5], rulesV2: [1, 2, 3] },
        { id: 's2', name: 'Price alternatives', steps: [], rulesV2: [] },
    ];
    const USAGE = { s1: { agents: 3 }, s2: { agents: 1 } };

    it('telt stappen en regels en trekt de agent zelf van de gebruikstelling af', () => {
        const rows = skillRows({
            ids: ['s1'], skills: SKILLS, state: READ.OK,
            usage: USAGE, usageState: READ.OK, savedSkillIds: ['s1'], agentSaved: true,
        });
        expect(rows[0]).toMatchObject({ name: 'Explain a quote', stepCount: 5, ruleCount: 3, otherAgents: 2, readable: true });
    });

    it('trekt niets af voor een skill die nog niet opgeslagen is', () => {
        const rows = skillRows({
            ids: ['s1'], skills: SKILLS, state: READ.OK,
            usage: USAGE, usageState: READ.OK, savedSkillIds: [], agentSaved: true,
        });
        expect(rows[0].otherAgents).toBe(3);
    });

    it('laat de gebruikstelling null als die lezing mislukte — nooit 0', () => {
        const rows = skillRows({
            ids: ['s1'], skills: SKILLS, state: READ.OK,
            usage: null, usageState: READ.ERROR, savedSkillIds: ['s1'], agentSaved: true,
        });
        expect(rows[0].otherAgents).toBeNull();
        expect(rows[0].stepCount).toBe(5);
    });

    it('nul stappen is een echte nul', () => {
        const rows = skillRows({ ids: ['s2'], skills: SKILLS, state: READ.OK, usage: USAGE, usageState: READ.OK, savedSkillIds: [], agentSaved: false });
        expect(rows[0].stepCount).toBe(0);
        expect(rows[0].ruleCount).toBe(0);
    });

    it('houdt een gekoppelde skill die de lijst niet kent, zonder tellers', () => {
        const rows = skillRows({ ids: ['s9'], skills: SKILLS, state: READ.OK, usage: USAGE, usageState: READ.OK, savedSkillIds: [], agentSaved: false });
        expect(rows[0]).toMatchObject({ id: 's9', readable: false, stepCount: null, ruleCount: null });
    });

    it('maakt van een mislukte skill-lezing geen lege lijst', () => {
        const rows = skillRows({ ids: ['s1', 's2'], skills: null, state: READ.ERROR, usage: null, usageState: READ.ERROR, savedSkillIds: [], agentSaved: false });
        expect(rows).toHaveLength(2);
        expect(rows.every(r => r.readable === false)).toBe(true);
    });
});

describe('isTrulyEmpty / anyFailed', () => {
    it('"leeg" mag alleen als élke bron gelezen is', () => {
        expect(isTrulyEmpty([READ.OK, READ.OK], [0, 0])).toBe(true);
        expect(isTrulyEmpty([READ.OK, READ.LOADING], [0, 0])).toBe(false);
        expect(isTrulyEmpty([READ.OK, READ.ERROR], [0, 0])).toBe(false);
        expect(isTrulyEmpty([READ.OK, READ.OK], [0, 1])).toBe(false);
    });

    it('meldt een mislukte bron', () => {
        expect(anyFailed([READ.OK, READ.ERROR])).toBe(true);
        expect(anyFailed([READ.OK, READ.LOADING])).toBe(false);
        expect(anyFailed(null)).toBe(false);
    });
});
