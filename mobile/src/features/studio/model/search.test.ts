/** Studio search: grouped by section, and never "no matches" over "could not look". */

import { searchGroups, searchLine, sectionForSearchKind } from './search';

const result = (results: Record<string, { id: string; name: string }[]>, errors: string[] = []) => ({
    query: 'inv',
    tooShort: false,
    results,
    errors,
});

describe('searchGroups', () => {
    it('groups non-empty kinds in the registry order; automations belong to aiTasks', () => {
        const groups = searchGroups(result({ meetingNotes: [{ id: 'm', name: 'M' }], automations: [{ id: 'a', name: 'A' }], apps: [] }));
        expect(groups.map((g) => g.kind)).toEqual(['automations', 'meetingNotes']);
        expect(groups[0]?.section?.id).toBe('aiTasks');
        expect(sectionForSearchKind('unknown')).toBeNull();
    });
});

describe('searchLine', () => {
    it('prompts under two characters, before anything else', () => {
        expect(searchLine({ term: 'i', loading: false, failed: true, result: undefined })).toBe('too_short');
    });

    it('says the search failed rather than that nothing matched', () => {
        expect(searchLine({ term: 'inv', loading: false, failed: true, result: undefined })).toBe('failed');
    });

    it('warns over a partial answer, even with hits', () => {
        expect(searchLine({ term: 'inv', loading: false, failed: false, result: result({ apps: [{ id: 'a', name: 'A' }] }, ['skills']) })).toBe('partial');
    });

    it('is honestly empty only when every kind answered', () => {
        expect(searchLine({ term: 'inv', loading: false, failed: false, result: result({ apps: [] }) })).toBe('empty');
        expect(searchLine({ term: 'inv', loading: false, failed: false, result: result({ apps: [{ id: 'a', name: 'A' }] }) })).toBeNull();
        expect(searchLine({ term: 'inv', loading: true, failed: false, result: undefined })).toBe('loading');
    });
});
