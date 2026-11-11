import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import CellValue from './cellValue';

/**
 * A `relation` cell next to an expanded relation (a records binding with
 * `expand`): the display value of the related row instead of its id, and
 * exactly the old cell when the row carries no expansion.
 */

const text = (props: Parameters<typeof CellValue>[0]) => render(<CellValue {...props} />).container.textContent;

describe('cellValue — relation with an expanded row', () => {
    const row = { id: 'o1', customer: 'rec_c1', customer_record: { id: 'rec_c1', name: 'Acme', _label: 'Acme' } };

    it('shows the related row by its display value, on the relation field and on the expansion', () => {
        expect(text({ value: 'rec_c1', format: 'relation', col: { key: 'customer' }, row })).toBe('Acme');
        expect(text({ value: row.customer_record, format: 'relation', col: { key: 'customer_record' }, row })).toBe('Acme');
    });

    it('is the record id as before without an expansion, and when the related row is not readable', () => {
        expect(text({ value: 'rec_c1', format: 'relation', col: { key: 'customer' }, row: { id: 'o1', customer: 'rec_c1' } })).toBe('rec_c1');
        expect(text({ value: 'rec_c1', format: 'relation', col: { key: 'customer' }, row: { id: 'o1', customer: 'rec_c1', customer_record: null } })).toBe('rec_c1');
        expect(text({ value: 'rec_c1', format: 'relation' })).toBe('rec_c1');
    });

    it('a toneMap label still wins, and a badge never reads the expansion', () => {
        const col = { key: 'customer', toneMap: [{ value: 'rec_c1', label: 'Key account', tone: 'success' }] };
        expect(text({ value: 'rec_c1', format: 'relation', col, row })).toBe('Key account');
        expect(text({ value: 'rec_c1', format: 'badge', col: { key: 'customer' }, row })).toBe('rec_c1');
    });
});
