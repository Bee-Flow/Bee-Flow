// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { coerceExtractionName, EXTRACTION_FIELD_TYPES, MAX_EXTRACTION_FIELDS, sanitizeExtractionFields } from './extractionFields';

describe('data_extraction — the field schema', () => {
    it('coerceExtractionName turns what a person types into a legal output key', () => {
        expect(coerceExtractionName('Invoice Date')).toBe('invoice_date');
        expect(coerceExtractionName('€ totaal incl. BTW')).toBe('totaal_incl_btw');
        expect(coerceExtractionName('2nd line')).toBe('nd_line');
        expect(coerceExtractionName('a-b--c')).toBe('a_b_c');
        expect(coerceExtractionName('x'.repeat(60))).toHaveLength(40);
        expect(coerceExtractionName('')).toBe('');
        expect(coerceExtractionName(null)).toBe('');
    });

    it('sanitizeExtractionFields caps the list at 30 and ignores garbage rows', () => {
        const many = Array.from({ length: 40 }, (_, i) => ({ name: `f${i}`, type: 'string' }));
        expect(sanitizeExtractionFields([null, 'junk', ...many])).toHaveLength(MAX_EXTRACTION_FIELDS);
        expect(EXTRACTION_FIELD_TYPES).toEqual(['string', 'number', 'boolean', 'date']);
    });
});
