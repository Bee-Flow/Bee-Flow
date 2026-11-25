// Which automations of a list response a plan can be made from: the caller's own.
import { describe, expect, it } from 'vitest';
import { ownAutomationsOf } from './coworkPlanApi';

describe('ownAutomationsOf', () => {
    it('keeps the automations the caller owns, with their title', () => {
        expect(ownAutomationsOf({ automations: [
            { id: 'a1', title: 'Supplier radar', role: 'owner' },
            { id: 'a2', title: 'Shared with me', role: 'view' },
            { id: 'a3', title: 'Editable by me', role: 'edit' },
        ] })).toEqual([{ id: 'a1', title: 'Supplier radar' }]);
    });

    it('a row without a role is the caller\'s own (an older response), and an untitled one is called by its id', () => {
        expect(ownAutomationsOf({ automations: [{ id: 'a1' }, { id: 'a2', title: '   ' }] })).toEqual([{ id: 'a1', title: 'a1' }, { id: 'a2', title: 'a2' }]);
    });

    it('leaves out what is no automation, and answers none for a body it cannot read', () => {
        expect(ownAutomationsOf({ automations: [null, 'x', { title: 'no id' }, { id: '' }, { id: 7 }] })).toEqual([]);
        for (const body of [null, undefined, 'text', {}, { automations: 'no' }]) expect(ownAutomationsOf(body)).toEqual([]);
    });
});
