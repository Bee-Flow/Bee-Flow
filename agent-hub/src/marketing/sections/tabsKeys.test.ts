// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { indexForTabParam, nextTabIndex, tabKey } from './tabsKeys';

const items = [{ tabId: 'it' }, { tabId: 'legal' }, {}];

describe('tabKey', () => {
    it('uses the tab id, else the 1-based position', () => {
        expect(tabKey(items[0], 0)).toBe('it');
        expect(tabKey(items[2], 2)).toBe('3');
        expect(tabKey({ tabId: '  ' }, 0)).toBe('1');
        expect(tabKey(null, 4)).toBe('5');
    });
});

describe('indexForTabParam', () => {
    it('matches an id, then a 1-based position, else -1', () => {
        expect(indexForTabParam(items, 'legal')).toBe(1);
        expect(indexForTabParam(items, '3')).toBe(2);
        expect(indexForTabParam(items, '4')).toBe(-1);
        expect(indexForTabParam(items, '0')).toBe(-1);
        expect(indexForTabParam(items, 'nope')).toBe(-1);
        expect(indexForTabParam(items, null)).toBe(-1);
    });
});

describe('nextTabIndex', () => {
    it('wraps around and honours Home/End', () => {
        expect(nextTabIndex('ArrowRight', 2, 3)).toBe(0);
        expect(nextTabIndex('ArrowLeft', 0, 3)).toBe(2);
        expect(nextTabIndex('Home', 2, 3)).toBe(0);
        expect(nextTabIndex('End', 0, 3)).toBe(2);
        expect(nextTabIndex('a', 0, 3)).toBeNull();
        expect(nextTabIndex('ArrowRight', 0, 0)).toBeNull();
    });
});
