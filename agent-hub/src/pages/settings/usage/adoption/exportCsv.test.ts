import { describe, expect, it } from 'vitest';
import { createState, ROUTES } from '@/demo/fixtures/monitoring';
import type { AdoptionAreas, AdoptionGroups, AdoptionPeoplePage, AdoptionStudio, AdoptionStudioItems, AdoptionSummary } from './adoption.types';
import { adoptionCsv, itemsCsv } from './exportCsv';

type Handler = (ctx: { state: object; query: URLSearchParams }) => unknown;
const get = <T>(route: string, q = 'days=30') => (ROUTES as unknown as Record<string, Handler>)[`GET /api/usage/adoption/${route}`]({ state: createState(), query: new URLSearchParams(q) }) as T;

const NAMES = /Alex Morgan|Sam Rivera|Robin Patel|Jamie Chen/;

function sections(people: AdoptionPeoplePage, revealed: boolean): string {
    return adoptionCsv({
        summary: get<AdoptionSummary>('summary'), areas: get<AdoptionAreas>('areas'), studio: get<AdoptionStudio>('studio'),
        groups: get<AdoptionGroups>('groups'), people, revealed,
    });
}

describe('adoptionCsv', () => {
    it('writes one section per table, from explicit columns', () => {
        const csv = sections(get<AdoptionPeoplePage>('people', 'days=30&limit=200'), false);
        const titles = csv.split('\n').filter(l => l.startsWith('# '));
        expect(titles).toEqual(['# period', '# areas', '# studio', '# groups', '# people (pseudonymous)']);
        expect(csv).toContain('member,role,groups,status,last_seen_at,calls,ai_cost,areas,built,first_ai_use_at');
        expect(csv).toContain('kb,18,12,7,1,no signal,no signal,');
        expect(csv).not.toMatch(/avatar|firstAiUseAt|\[object Object\]/);
    });

    it('never contains a name unless the names are revealed on screen', () => {
        const pseudonymous = sections(get<AdoptionPeoplePage>('people', 'days=30&limit=200'), false);
        expect(pseudonymous).not.toMatch(NAMES);
        expect(pseudonymous).toMatch(/Member · [A-Z2-9]{4}/);
        const revealedAnswerHiddenScreen = sections(get<AdoptionPeoplePage>('people', 'days=30&limit=200&reveal=true'), false);
        expect(revealedAnswerHiddenScreen).not.toMatch(NAMES);
        const revealed = sections(get<AdoptionPeoplePage>('people', 'days=30&limit=200&reveal=true'), true);
        expect(revealed).toMatch(NAMES);
        expect(revealed).toContain('# people (names revealed, recorded in the access audit log)');
    });

    it('a revealed flag over a pseudonymous answer still writes pseudonyms', () => {
        const csv = sections(get<AdoptionPeoplePage>('people', 'days=30&limit=200'), true);
        expect(csv).toContain('# people (pseudonymous)');
        expect(csv).not.toMatch(NAMES);
    });

    it('leaves out a section it has no data for', () => {
        const csv = adoptionCsv({ summary: null, areas: null, studio: null, groups: null, people: null, revealed: false });
        expect(csv).toBe('');
    });
});

describe('itemsCsv', () => {
    it('lists the items with their makers and nothing else', () => {
        const csv = itemsCsv(get<AdoptionStudioItems>('studio/items', 'kind=agent'));
        const [head, first] = csv.split('\n');
        expect(head).toBe('name,owner,audience,created_at,last_used_at,people,uses,ai_cost');
        expect(first.startsWith('Sales assistant,Alex Morgan,org,')).toBe(true);
        expect(csv).not.toMatch(/Member · /);
    });
});
