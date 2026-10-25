// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { datetimeTargetColumn, impliedListMode, isDateTimeListMode, splitWildcardPath } from './datetimeTarget';

describe('datetimeTargetColumn', () => {
    it('names the column after the part, which is what the author expects to see', () => {
        expect(datetimeTargetColumn({ op: 'extract', part: 'day' })).toBe('day');
        expect(datetimeTargetColumn({ op: 'extract', part: 'dayOfWeek' })).toBe('dayOfWeek');
    });

    it('lets an explicit name win', () => {
        expect(datetimeTargetColumn({ op: 'extract', part: 'day', target: 'dagnummer' })).toBe('dagnummer');
        expect(datetimeTargetColumn({ op: 'extract', part: 'day', target: '  spaced  ' })).toBe('spaced');
    });

    it('ignores a blank name rather than producing an empty column', () => {
        expect(datetimeTargetColumn({ op: 'extract', part: 'day', target: '   ' })).toBe('day');
    });

    it('falls back to the operation for the ops with no part', () => {
        expect(datetimeTargetColumn({ op: 'diff' })).toBe('diff');
        expect(datetimeTargetColumn({ op: 'format' })).toBe('formatted');
        expect(datetimeTargetColumn({ op: 'addDays' })).toBe('addDays');
        expect(datetimeTargetColumn({})).toBe('value');
    });
});

describe('isDateTimeListMode', () => {
    it('is the presence of arrayRef, not its content', () => {
        // '' means "list mode, source not picked yet" — the same convention the
        // Edit data node uses, and what keeps the autosave from 400ing.
        expect(isDateTimeListMode({ arrayRef: '' })).toBe(true);
        expect(isDateTimeListMode({ arrayRef: 'steps.x.output.results' })).toBe(true);
        expect(isDateTimeListMode({})).toBe(false);
        expect(isDateTimeListMode({ arrayRef: null })).toBe(false);
        expect(isDateTimeListMode(null)).toBe(false);
    });
});

describe('splitWildcardPath', () => {
    it('splits a dropped column into the list and the field', () => {
        expect(splitWildcardPath('steps.act_def3f38e.output.results[*].updated')).toEqual({
            arrayRef: 'steps.act_def3f38e.output.results',
            itemPath: 'item.updated',
        });
    });

    it('handles a nested field inside the row', () => {
        expect(splitWildcardPath('steps.x.output.rows[*].meta.createdAt')).toEqual({
            arrayRef: 'steps.x.output.rows',
            itemPath: 'item.meta.createdAt',
        });
    });

    it('handles a list of bare values', () => {
        expect(splitWildcardPath('steps.x.output.dates[*]')).toEqual({
            arrayRef: 'steps.x.output.dates',
            itemPath: 'item',
        });
    });

    it('leaves an ordinary single-date path alone', () => {
        expect(splitWildcardPath('trigger.output.timestamp')).toBeNull();
        expect(splitWildcardPath('steps.x.output.results[0].updated')).toBeNull();
        expect(splitWildcardPath('')).toBeNull();
        expect(splitWildcardPath(null)).toBeNull();
    });

    it('refuses a list of lists — one column is all this step can add', () => {
        expect(splitWildcardPath('steps.x.output.a[*].b[*].c')).toBeNull();
    });

    it('refuses a leading wildcard, which names no list', () => {
        expect(splitWildcardPath('[*].updated')).toBeNull();
    });
});

describe('impliedListMode', () => {
    // Mirrors server automation/datetimeListMode.js: a step saved with a whole
    // column in "Input date" and no arrayRef runs as list mode (BFSF-375).
    it('reads a column without arrayRef as list mode over its list', () => {
        expect(impliedListMode({ op: 'extract', part: 'day', input: 'steps.s.output.results[*].updated' })).toEqual({
            arrayRef: 'steps.s.output.results',
            input: 'item.updated',
        });
        expect(impliedListMode({ input: 'steps.s.output.results[*].updated', arrayRef: null })).toEqual({
            arrayRef: 'steps.s.output.results',
            input: 'item.updated',
        });
    });

    it('moves a second column along only when it is from the same list', () => {
        expect(impliedListMode({
            op: 'diff', input: 'steps.s.output.results[*].created', input2: 'steps.s.output.results[*].updated',
        })).toEqual({ arrayRef: 'steps.s.output.results', input: 'item.created', input2: 'item.updated' });
        expect(impliedListMode({
            op: 'diff', input: 'steps.s.output.results[*].created', input2: 'trigger.output.when',
        })).toEqual({ arrayRef: 'steps.s.output.results', input: 'item.created' });
    });

    it('implies nothing for a single date, an explicit list mode or a list of lists', () => {
        expect(impliedListMode({ input: 'trigger.output.when' })).toBeNull();
        expect(impliedListMode({ arrayRef: '', input: 'steps.s.output.results[*].updated' })).toBeNull();
        expect(impliedListMode({ arrayRef: 'steps.s.output.results', input: 'item.updated' })).toBeNull();
        expect(impliedListMode({ input: 'steps.s.output.a[*].b[*].c' })).toBeNull();
        expect(impliedListMode(null)).toBeNull();
    });

    it('implies nothing for `now`, which reads no input date', () => {
        expect(impliedListMode({ op: 'now', input: 'steps.s.output.results[*].updated' })).toBeNull();
    });
});
