import { describe, expect, it } from 'vitest';
import type { TranslateFn } from '../../../hooks/useTranslation';
import { firstSentence, selectionLabel } from './sheetAskText';

const fake = (_key: string, fallback: string, params?: Record<string, string | number>) => fallback.replace(/\{(\w+)\}/g, (_m, k) => String(params?.[k]));
const t = fake as unknown as TranslateFn;

describe('selectionLabel', () => {
    it('names cells, blocks, columns and rows', () => {
        expect(selectionLabel(t, { c1: 2, r1: 1, c2: 2, r2: 1 }, 'cell')).toBe('C2');
        expect(selectionLabel(t, { c1: 2, r1: 1, c2: 3, r2: 39 }, 'range')).toBe('C2:D40');
        expect(selectionLabel(t, { c1: 2, r1: 0, c2: 2, r2: 49 }, 'columns')).toBe('column C');
        expect(selectionLabel(t, { c1: 1, r1: 0, c2: 3, r2: 49 }, 'columns')).toBe('columns B–D');
        expect(selectionLabel(t, { c1: 0, r1: 2, c2: 25, r2: 4 }, 'rows')).toBe('rows 3–5');
    });
});

describe('firstSentence', () => {
    it('takes the first sentence, without markdown marks', () => {
        expect(firstSentence('**Added** a total in `A3`. Then I checked it.')).toBe('Added a total in A3.');
        expect(firstSentence('## Done\nSecond line.')).toBe('Done');
    });

    it('keeps decimals together, and cuts a very long sentence', () => {
        expect(firstSentence('The total is 3.5 now. Bye')).toBe('The total is 3.5 now.');
        expect(firstSentence('x'.repeat(400))).toHaveLength(160);
    });
});
