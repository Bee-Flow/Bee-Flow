import { describe, expect, it } from 'vitest';
import { accentColor, gridTemplate } from './DataTable';

import { stub } from '@/test/mocks';
/** accentColor: a status tone's raw colour, the area's teal for 'kind', else null. */

describe('accentColor', () => {
    it('is null for a missing or unknown accent', () => {
        for (const accent of [null, undefined, '', 'nope', 'null', 'undefined']) {
            expect(accentColor(accent)).toBeNull();
        }
    });

    it('is the raw tone colour for a status tone', () => {
        expect(accentColor('success')).toBe('var(--success)');
        expect(accentColor('warning')).toBe('var(--warning)');
        expect(accentColor('error')).toBe('var(--error)');
        expect(accentColor('neutral')).toBe('var(--bg-tertiary)');
    });

    it("is the area's teal for 'kind'", () => {
        expect(accentColor('kind')).toBe('var(--kind-compliance)');
    });
});

describe('gridTemplate — which columns fold at which tier', () => {
    const col = (id: string, width: string, foldBelow?: unknown) => ({ id, width, foldBelow });
    const columns = stub<Parameters<typeof gridTemplate>[0]>([col('a', '1fr'), col('b', '80px', 1180), col('c', '60px', 900), col('d', '40px', 1000), col('e', '30px', '1180'), col('f', '20px', null), col('g', '10px', NaN)]);

    it('keeps every column without a tier', () => {
        expect(gridTemplate(columns)).toBe('1fr 80px 60px 40px 30px 20px 10px');
    });

    it('drops only the columns that fold at or above the tier, and only for a known fold width', () => {
        expect(gridTemplate(columns, 1180)).toBe('1fr 60px 40px 30px 20px 10px');
        expect(gridTemplate(columns, 900)).toBe('1fr 40px 30px 20px 10px');
    });

    it('is a single track for no columns', () => {
        expect(gridTemplate([])).toBe('1fr');
        expect(gridTemplate(undefined, 900)).toBe('1fr');
    });
});
