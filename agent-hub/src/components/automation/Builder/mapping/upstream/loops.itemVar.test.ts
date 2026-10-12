import { describe, expect, it } from 'vitest';
import { suggestItemVar } from './loops';

describe('suggestItemVar', () => {
    it('names one item of a list in plain singular', () => {
        expect(suggestItemVar('lines')).toBe('line');
        expect(suggestItemVar('files')).toBe('file');
        expect(suggestItemVar('messages')).toBe('message');
        expect(suggestItemVar('accounts')).toBe('account');
        expect(suggestItemVar('categories')).toBe('category');
        expect(suggestItemVar('addresses')).toBe('address');
        expect(suggestItemVar('boxes')).toBe('box');
        expect(suggestItemVar('matches')).toBe('match');
    });

    it('leaves words that only end in s, and empty keys get "item"', () => {
        expect(suggestItemVar('status')).toBe('status');
        expect(suggestItemVar('address')).toBe('address');
        expect(suggestItemVar('')).toBe('item');
    });
});
