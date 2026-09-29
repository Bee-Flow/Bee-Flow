// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
    buildSavePayload, draftOf, examplesOf, filterSkills, isAgentCallable, isEmptySkill,
    metaLine, moveItem, refIdsOfKind, refKindKey, rulesOf, sortSkills, stepsOf, testChip,
    usageSubline,
} from './skillModel';

// The translator the components get: key + English fallback, placeholders
// filled in, so a test reads the sentence a user would.
const t = (key, fallback, params) => String(fallback ?? key)
    .replace(/\{(\w+)\}/g, (_, k) => String(params?.[k] ?? `{${k}}`));

describe('skillModel — normalisation', () => {
    it('reads NULL facets as empty lists, not as a crash', () => {
        const skill = { id: 's1', name: 'x' };
        expect(stepsOf(skill)).toEqual([]);
        expect(rulesOf(skill)).toEqual([]);
        expect(examplesOf(skill)).toEqual([]);
        expect(draftOf(skill).knowledgeBaseIds).toEqual([]);
    });

    it('gives an id-less row a stable positional id so React and dnd-kit can key it', () => {
        const rows = stepsOf({ steps: [{ text: 'a' }, { text: 'b' }] });
        expect(rows.map(r => r.id)).toEqual(['step_1', 'step_2']);
    });

    it('drops a reference whose kind is not one the runtime understands', () => {
        const [step] = stepsOf({
            steps: [{ id: 's', text: 'x', refs: [{ kind: 'kb', id: 'k1' }, { kind: 'wormhole', id: 'w' }, { kind: 'table' }] }],
        });
        expect(step.refs).toEqual([{ kind: 'kb', id: 'k1' }]);
    });

    it('reads an unknown polarity as "must" rather than inventing a third state', () => {
        expect(rulesOf({ rulesV2: [{ id: 'r', polarity: 'maybe', text: 'x' }] })[0].polarity).toBe('must');
    });

    it('derives referenced tables from the steps, de-duplicated and in order', () => {
        const skill = {
            steps: [
                { id: 'a', text: '', refs: [{ kind: 'table', id: 't2' }] },
                { id: 'b', text: '', refs: [{ kind: 'table', id: 't2' }, { kind: 'kb', id: 'k' }, { kind: 'table', id: 't1' }] },
            ],
        };
        expect(refIdsOfKind(skill, 'table')).toEqual(['t2', 't1']);
    });

    it('maps a ref kind onto the colour key that paints it', () => {
        expect(refKindKey('table')).toBe('datatable');
        expect(refKindKey('kb')).toBe('kb');
        expect(refKindKey('automation')).toBe('automation');
        expect(refKindKey('nope')).toBe(null);
    });
});

describe('skillModel — the sentences the list and the table share', () => {
    it('says "draft · empty" for a skill with no steps and no description', () => {
        expect(isEmptySkill({ steps: [], description: '' })).toBe(true);
        expect(metaLine({ steps: [], description: '' }, t)).toBe('draft · empty');
        expect(usageSubline({ steps: [], description: '' }, { agents: 2 }, t)).toBe('draft · empty');
    });

    // One rule, one step and one example are all ordinary. The ternary is
    // around the KEY (nOf), so this reads as a sentence in every language.
    it('counts what a real skill is made of, in the singular where it is one', () => {
        const skill = {
            description: 'x',
            steps: [{ id: 'a' }, { id: 'b' }],
            rulesV2: [{ id: 'r' }],
            examplesV2: [],
        };
        expect(metaLine(skill, t)).toBe('2 steps · 1 rule · 0 examples');
        expect(metaLine({ ...skill, steps: [{ id: 'a' }], examplesV2: [{ id: 'e' }] }, t))
            .toBe('1 step · 1 rule · 1 example');
    });

    it('says NOTHING when the usage summary has not answered — an absent count is not a zero', () => {
        expect(usageSubline({ description: 'x', steps: [{ id: 'a' }] }, undefined, t)).toBe('');
    });

    it('only says "not linked yet" from a row that actually answered', () => {
        const skill = { description: 'x', steps: [{ id: 'a' }] };
        expect(usageSubline(skill, { agents: 0, automations: 0 }, t)).toBe('not linked yet');
        expect(usageSubline(skill, { agents: 3, automations: 1 }, t)).toBe('3 agents · 1 automation');
        expect(usageSubline(skill, { agents: 0, automations: 2 }, t)).toBe('2 automations');
        expect(usageSubline(skill, { agents: 1, automations: 0 }, t)).toBe('1 agent');
    });
});

describe('skillModel — the test chip', () => {
    it('separates "never tested" from "tested and fine"', () => {
        expect(testChip(null, t)).toEqual({ tone: 'idle', label: 'not tested' });
        expect(testChip({ status: 'ok', adviceCount: 0 }, t)).toEqual({ tone: 'ok', label: 'ok' });
    });

    it('counts advice, and never reports "0 advice"', () => {
        expect(testChip({ status: 'warning', adviceCount: 2 }, t).label).toBe('2 advice');
        expect(testChip({ status: 'warning', adviceCount: 0 }, t).label).toBe('1 advice');
        expect(testChip({ status: 'error' }, t)).toEqual({ tone: 'error', label: 'failed' });
    });
});

describe('skillModel — filtering and sorting', () => {
    const rows = [
        { id: 'a', name: 'Alpha', description: 'quotes' },
        { id: 'b', name: 'Beta', description: 'meetings' },
        { id: 'c', name: 'Gamma', description: '' },
    ];

    it('filters over name and description, case-insensitively', () => {
        expect(filterSkills(rows, 'MEET').map(r => r.id)).toEqual(['b']);
        expect(filterSkills(rows, '  ').map(r => r.id)).toEqual(['a', 'b', 'c']);
    });

    it('sorts by usage, then by name, and never mutates the input', () => {
        const summary = { a: { agents: 1 }, b: { agents: 3, automations: 1 }, c: {} };
        const sorted = sortSkills(rows, 'used', summary);
        expect(sorted.map(r => r.id)).toEqual(['b', 'a', 'c']);
        expect(rows.map(r => r.id)).toEqual(['a', 'b', 'c']);
    });

    it('sorts by last use, treating "never" as the oldest', () => {
        const summary = {
            a: { lastUsedAt: '2026-09-01T00:00:00Z' },
            b: { lastUsedAt: null },
            c: { lastUsedAt: '2026-09-03T00:00:00Z' },
        };
        expect(sortSkills(rows, 'recent', summary).map(r => r.id)).toEqual(['c', 'a', 'b']);
    });
});

describe('skillModel — the save payload', () => {
    it('sends the STRUCTURE and never the text columns S1 regenerates from it', () => {
        const payload = buildSavePayload(draftOf({
            name: 'n', workflow: '1. old text', rules: '- old', examples: 'old',
            steps: [{ id: 's1', text: 'a', refs: [] }],
        }));
        expect(payload).not.toHaveProperty('workflow');
        expect(payload).not.toHaveProperty('rules');
        expect(payload).not.toHaveProperty('examples');
        expect(payload.steps).toEqual([{ id: 's1', text: 'a', refs: [] }]);
        expect(payload.rulesV2).toEqual([]);
        expect(payload.outputSchema).toBe(null);
    });
});

describe('skillModel — what may be offered as a callable tool', () => {
    it('accepts an agent_call routine however the row spells its trigger', () => {
        expect(isAgentCallable({ triggerKind: 'agent_call' })).toBe(true);
        expect(isAgentCallable({ triggerType: 'agent_call' })).toBe(true);
        expect(isAgentCallable({ definition: { trigger: { kind: 'agent_call' } } })).toBe(true);
    });

    /**
     * De volgorde is het punt, niet de drie spellingen.
     *
     * `trigger_type` is een gedenormaliseerde kolom met DEFAULT 'manual', en
     * ELKE rij uit GET /api/automation draagt hem (rowMappers zet hem altijd).
     * Met de kolom vooraan was de derde spelling — de enige die de runtime
     * zelf leest (agentCallableTools: `definition.trigger.kind`) — op dat
     * endpoint onbereikbaar. Die drift is geen theorie: POST leidt de kolom
     * niet af uit de definitie (PUT wel, sinds BFSF-318), dus een routine die
     * compleet in één POST aankomt houdt trigger_type='manual' tot iemand hem
     * opnieuw opslaat.
     */
    it('leest de DEFINITIE eerst — de kolom kan achterlopen, de definitie is wat de runtime aanroept', () => {
        expect(isAgentCallable({
            triggerType: 'manual',
            definition: { trigger: { kind: 'agent_call' } },
        }), 'de kolom staat nog op manual, de runtime roept hem wél aan').toBe(true);
        // En andersom: een definitie die géén agent_call zegt, wint ook.
        expect(isAgentCallable({
            triggerType: 'agent_call',
            definition: { trigger: { kind: 'schedule' } },
        })).toBe(false);
    });

    it('zegt "not counted" in plaats van "not linked yet" als de server een soort niet kon tellen', () => {
        // getUsageSummary slikt een ontbrekende automations-tabel; sinds deze
        // stap zegt hij dát ook, en de regel eronder mag dan niet beweren dat
        // er niets aan gekoppeld is.
        const skill = { id: 's1', name: 'x', steps: [{ id: '1', text: 'a' }] };
        expect(usageSubline(skill, { agents: 0, automations: 0, automationsUnchecked: true }, t)).toBe('not counted');
        expect(usageSubline(skill, { agents: 0, automations: 0 }, t)).toBe('not linked yet');
        // Met agents die er WEL zijn blijft de gewone regel staan: die telling
        // is echt gedaan.
        expect(usageSubline(skill, { agents: 2, automations: 0, automationsUnchecked: true }, t)).toBe('2 agents');
    });

    it('fails CLOSED: a routine with no trigger information is not offered', () => {
        expect(isAgentCallable({ id: 'a1', title: 'Nightly sync' })).toBe(false);
        expect(isAgentCallable({ triggerType: 'schedule' })).toBe(false);
        expect(isAgentCallable(null)).toBe(false);
    });
});

describe('skillModel — moveItem', () => {
    it('moves one item and leaves the original array alone', () => {
        const rows = ['a', 'b', 'c'];
        expect(moveItem(rows, 0, 2)).toEqual(['b', 'c', 'a']);
        expect(rows).toEqual(['a', 'b', 'c']);
    });

    it('ignores an out-of-range or no-op move', () => {
        expect(moveItem(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
        expect(moveItem(['a', 'b'], -1, 0)).toEqual(['a', 'b']);
        expect(moveItem(['a', 'b'], 0, 9)).toEqual(['a', 'b']);
    });
});
