import { describe, expect, it } from 'vitest';
import { hasDetails, joinOptions, mergeLines, setDetail, splitOptions, toOption, visibleRows } from './choiceOptionsModel';

describe('choice options model', () => {
    it('shows one line per usable value and hides blank ones', () => {
        expect(joinOptions(['Red', { value: 'Green', label: 'G' }, { label: 'no value' }, ''])).toBe('Red\nGreen');
    });

    it('splits the text the way the editor always has', () => {
        expect(splitOptions(' Red \n\nBlue\n')).toEqual(['Red', 'Blue']);
    });

    it('stays plain strings until a choice gets its own label or hint', () => {
        expect(mergeLines(['Red', 'Blue'], ['Red'])).toEqual(['Red', 'Blue']);
        expect(toOption({ value: 'a', label: 'a' })).toBe('a');
        expect(toOption({ value: 'a', label: 'A' })).toEqual({ value: 'a', label: 'A' });
        expect(toOption({ value: 'a', hint: 'first' })).toEqual({ value: 'a', hint: 'first' });
    });

    it('keeps the label and hint of the choice at the same position while its value is retyped', () => {
        const before = [{ value: 'nl', label: 'Netherlands', hint: 'Dutch office' }, 'be'];
        expect(mergeLines(['nld', 'be'], before)).toEqual([{ value: 'nld', label: 'Netherlands', hint: 'Dutch office' }, 'be']);
    });

    it('sets and clears a label without touching the others', () => {
        const set = setDetail(['a', 'b'], 1, 'label', 'Bee hive ');
        // Kept as typed, so a space inside or after a word survives while typing.
        expect(set).toEqual(['a', { value: 'b', label: 'Bee hive ' }]);
        expect(setDetail(set, 1, 'label', '')).toEqual(['a', 'b']);
        expect(setDetail(set, 1, 'label', '   ')).toEqual(['a', 'b']);
        expect(setDetail(['a'], 0, 'hint', 'note')).toEqual([{ value: 'a', hint: 'note' }]);
    });

    it('knows when the details are in use', () => {
        expect(hasDetails(['a', 'b'])).toBe(false);
        expect(hasDetails([{ value: 'a', label: 'a' }])).toBe(false);
        expect(hasDetails([{ value: 'a', hint: 'x' }])).toBe(true);
        expect(visibleRows(null)).toEqual([]);
    });
});
