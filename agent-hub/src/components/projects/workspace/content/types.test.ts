import { describe, expect, it } from 'vitest';
import { canEditContent, canRemoveItem } from './types';

describe('who may take an item out of the project', () => {
    it('never offers it to a viewer', () => {
        expect(canEditContent('viewer')).toBe(false);
        expect(canRemoveItem('viewer', 'me', 'me')).toBe(false);
    });

    it('offers it to the project owner for anyone’s item', () => {
        expect(canRemoveItem('owner', 'someone-else', 'me')).toBe(true);
        expect(canRemoveItem('owner', null, 'me')).toBe(true);
    });

    it('offers an editor only their own items', () => {
        expect(canRemoveItem('editor', 'me', 'me')).toBe(true);
        expect(canRemoveItem('editor', 'someone-else', 'me')).toBe(false);
    });

    it('offers an editor nothing whose owner is not known', () => {
        // Every card now carries its owner (notebooks included), so a missing
        // owner is not a reason to offer a button the server would refuse.
        expect(canRemoveItem('editor', undefined, 'me')).toBe(false);
        expect(canRemoveItem('editor', 'me', null)).toBe(false);
    });
});
