import { describe, expect, it } from 'vitest';
import { cannotComeAlong, comingAlong, parseRelated, type RelatedState } from './relatedParts';

/**
 * Reading the server's answer. A body that is not a related list is an error,
 * never "nothing comes along"; a status this client does not know is not one
 * it may add.
 */
describe('parseRelated', () => {
    it('keeps the order the server gave (dependencies first) and who needs each part', () => {
        const parsed = parseRelated({
            truncated: true,
            related: [
                { kind: 'datatable', id: 't1', name: 'Leads', relation: 'reads_table', status: 'addable', via: [{ kind: 'automation', id: 'a1', name: 'Nightly', relation: 'reads_table' }] },
                { kind: 'automation', id: 'a1', name: 'Nightly', relation: 'runs', status: 'in_other_solution', solutionName: 'Onboarding', via: [] },
            ],
        });
        expect(parsed?.truncated).toBe(true);
        expect(parsed?.related.map(p => p.id)).toEqual(['t1', 'a1']);
        expect(parsed?.related[0].via[0]).toEqual({ kind: 'automation', id: 'a1', name: 'Nightly', relation: 'reads_table' });
        expect(parsed?.related[1].solutionName).toBe('Onboarding');
    });

    it('is null for anything that is not a related list', () => {
        expect(parseRelated(null)).toBeNull();
        expect(parseRelated([])).toBeNull();
        expect(parseRelated({ error: 'Request failed' })).toBeNull();
    });

    it('never lets an unknown status be added, and skips rows without a kind and id', () => {
        const parsed = parseRelated({ related: [{ kind: 'app', id: 'x', status: 'brand_new' }, { kind: 'app' }, 7] });
        expect(parsed?.related).toHaveLength(1);
        expect(parsed?.related[0].status).toBe('not_found');
    });
});

describe('the two groups', () => {
    const state: RelatedState = {
        status: 'ok',
        result: {
            truncated: false,
            related: ['addable', 'already_here', 'in_other_solution', 'not_yours', 'not_found'].map(status => ({
                kind: 'app', id: status, name: null, relation: null, via: [], status: status as 'addable',
            })),
        },
    };

    it('split into what is filed with the selection and what the release check will flag', () => {
        expect(comingAlong(state).map(p => p.id)).toEqual(['addable']);
        expect(cannotComeAlong(state).map(p => p.id)).toEqual(['in_other_solution', 'not_yours', 'not_found']);
        expect(comingAlong({ status: 'error' })).toEqual([]);
        expect(cannotComeAlong({ status: 'loading' })).toEqual([]);
    });
});
