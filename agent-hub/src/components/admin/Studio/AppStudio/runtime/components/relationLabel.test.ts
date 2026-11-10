import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { EXPAND_DEFAULT_SUFFIX, EXPAND_LABEL_KEY, relationCellValue } from './relationLabel';

const require = createRequire(import.meta.url);
const vocabulary = require('../../../../../../../../server/core/dataEngine/dataModel/vocabulary.js');

describe('relationCellValue', () => {
    it('names the expansion the way the server does', () => {
        expect(EXPAND_DEFAULT_SUFFIX).toBe(vocabulary.EXPAND_DEFAULT_SUFFIX);
        expect(EXPAND_LABEL_KEY).toBe(vocabulary.EXPAND_LABEL_KEY);
    });

    it('shows the display value of the expanded row next to a relation field', () => {
        const row = { id: 'o1', customer: 'rec_c1', customer_record: { id: 'rec_c1', name: 'Acme', _label: 'Acme' } };
        expect(relationCellValue('rec_c1', row, 'customer')).toBe('Acme');
        expect(relationCellValue(row.customer_record, row, 'customer_record')).toBe('Acme');
    });

    it('leaves the value alone without an expansion, a label, or a readable related row', () => {
        expect(relationCellValue('rec_c1', { id: 'o1', customer: 'rec_c1' }, 'customer')).toBe('rec_c1');
        expect(relationCellValue('rec_c1', { customer: 'rec_c1', customer_record: null }, 'customer')).toBe('rec_c1');
        expect(relationCellValue('rec_c1', { customer: 'rec_c1', customer_record: { id: 'rec_c1' } }, 'customer')).toBe('rec_c1');
        expect(relationCellValue('rec_c1', { customer: 'rec_c1', customer_record: 'text' }, 'customer')).toBe('rec_c1');
        expect(relationCellValue('rec_c1', null, 'customer')).toBe('rec_c1');
        expect(relationCellValue('rec_c1', { customer_record: { _label: 'x' } }, undefined)).toBe('rec_c1');
    });

    it('an expanded row without a display field shows its id, never the object', () => {
        expect(relationCellValue({ id: 'rec_c1', city: 'Utrecht' }, {}, 'buyer')).toBe('rec_c1');
        expect(relationCellValue({ city: 'Utrecht' }, {}, 'buyer')).toBeNull();
    });
});
