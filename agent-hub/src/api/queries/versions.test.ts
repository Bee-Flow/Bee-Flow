import { describe, expect, it } from 'vitest';
import { peopleOfPages, toVersionPeople } from './versions';

describe('the `people` of a versions answer', () => {
    it('keeps only entries that name somebody', () => {
        expect(toVersionPeople({
            u1: { name: 'Anna' }, u2: { email: 'bob@example.test' }, u3: {}, u4: null, u5: { name: '  ' }, u6: 'Carla',
        })).toEqual({ u1: { name: 'Anna' }, u2: { email: 'bob@example.test' } });
    });

    it('an answer without people (a notebook, an older server) names nobody', () => {
        expect(toVersionPeople(undefined)).toEqual({});
        expect(toVersionPeople([])).toEqual({});
        expect(toVersionPeople('x')).toEqual({});
    });

    it('merges every loaded page', () => {
        expect(peopleOfPages([{ people: { u1: { name: 'Anna' } } }, { people: { u2: { name: 'Bob' } } }]))
            .toEqual({ u1: { name: 'Anna' }, u2: { name: 'Bob' } });
        expect(peopleOfPages(undefined)).toEqual({});
    });
});
