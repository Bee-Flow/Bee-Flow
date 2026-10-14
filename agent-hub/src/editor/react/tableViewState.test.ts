import { describe, it, expect, beforeEach } from 'vitest';
import { loadCollapsed, saveCollapsed, loadHiddenHeaders, saveHiddenHeaders } from './tableViewState';

describe('table view state (collapsed tables, hidden column names)', () => {
    beforeEach(() => localStorage.clear());

    it('round-trips per notebook, under separate keys', () => {
        saveCollapsed('nb1', new Set([0, 2]));
        saveHiddenHeaders('nb1', new Set([1]));
        expect([...loadCollapsed('nb1')]).toEqual([0, 2]);
        expect([...loadHiddenHeaders('nb1')]).toEqual([1]);
        expect(loadCollapsed('nb2').size).toBe(0);
        expect(localStorage.getItem('bf.table.collapsed.nb1')).toBe('[0,2]');
        expect(localStorage.getItem('bf.table.noheaders.nb1')).toBe('[1]');
    });

    it('stores a document without a notebook id under "doc"', () => {
        saveCollapsed(undefined, new Set([3]));
        expect(localStorage.getItem('bf.table.collapsed.doc')).toBe('[3]');
        expect([...loadCollapsed(null)]).toEqual([3]);
    });

    it('starts empty when the stored value is unreadable', () => {
        localStorage.setItem('bf.table.collapsed.nb1', '{not json');
        localStorage.setItem('bf.table.noheaders.nb1', '{not json');
        expect(loadCollapsed('nb1').size).toBe(0);
        expect(loadHiddenHeaders('nb1').size).toBe(0);
    });
});
