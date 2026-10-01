import { describe, it, expect } from 'vitest';
import { interpolate, type TranslateFn } from '../../../../hooks/useTranslation';
import { formulaSummary, humanizeKey, partsFromSource, pickLabel, type LabelPart } from './usePickLabel';

// The English defaults, as t() resolves them without a catalogue.
const t: TranslateFn = (key, fallback, params) => interpolate(typeof fallback === 'string' ? fallback : key, params);
const key = (k: string): LabelPart => ({ key: k, text: humanizeKey(k) });

describe('pickLabel: a value named in words, never a path', () => {
    it('one value: the field of its parent', () => {
        const pick = { from: { root: 'trigger' as const, path: ['Klant', 'E-mail adres'] }, take: 'one' };
        expect(pickLabel(t, pick)).toBe('E-mail adres of klant');
    });

    it('a column of a list: of all, of the first, of the last, the number', () => {
        const from = { root: 'steps' as const, id: 's1', path: ['orderregels', 'product'] };
        expect(pickLabel(t, { from, take: 'all' })).toBe('Product of all orderregels');
        expect(pickLabel(t, { from, take: 'first' })).toBe('Product of the first orderregels');
        expect(pickLabel(t, { from, take: 'last' })).toBe('Product of the last orderregels');
        expect(pickLabel(t, { from, take: 'count' })).toBe('Number of product');
        expect(pickLabel(t, { from, take: 'each' })).toBe('Product (of this orderregels)');
    });

    it('a list position: the first row, row n', () => {
        expect(pickLabel(t, { from: { root: 'trigger', path: ['orderregel', 0] } })).toBe('The first orderregel');
        expect(pickLabel(t, { from: { root: 'trigger', path: ['Orderregels', 2] } })).toBe('Orderregels, row 3');
        expect(pickLabel(t, { from: { root: 'trigger', path: ['orders', 0, 'id'] } })).toBe('ID of the first orders');
    });

    it('the parts the source panel gives win over the stored label; the stored label over the path', () => {
        const pick = { from: { root: 'trigger' as const, path: ['a', 'b'] }, take: 'one', label: 'E-mail van klant' };
        expect(pickLabel(t, pick)).toBe('E-mail van klant');
        expect(pickLabel(t, pick, { labelParts: [key('customer'), key('email_address')] })).toBe('Email address of customer');
    });

    it('a legacy [*] part reads as "all", and acronyms keep their capitals', () => {
        const parts: LabelPart[] = [key('IBAN_list'), { each: true }, key('iban')];
        expect(pickLabel(t, { from: { root: 'trigger', path: [] }, take: 'one' }, { labelParts: parts })).toBe('IBAN of all IBAN list');
    });

    it('a whole step or trigger output is named after it', () => {
        expect(pickLabel(t, { from: { root: 'steps', id: 'fetch', path: [] } }, { groupLabel: 'Orders ophalen' })).toBe('Output of Orders ophalen');
        expect(pickLabel(t, { from: { root: 'trigger', path: [] } })).toBe('Incoming data');
        expect(pickLabel(t, { from: { root: 'trigger', path: ['naam'] } })).toBe('Naam');
    });

    it('partsFromSource: keys, positions, and the legacy wildcard', () => {
        expect(partsFromSource({ root: 'trigger', path: ['first_name', 0] })).toEqual([{ key: 'first_name', text: 'First name' }, { index: 0 }]);
        expect(partsFromSource(null)).toEqual([]);
    });
});

describe('formulaSummary: a Formula chip without jargon', () => {
    const labels = new Map([['fetch', 'Berichten ophalen']]);

    it('an expression keeps its function and strings, and names its values', () => {
        const s = formulaSummary(t, { kind: 'expr', value: 'join(steps.fetch.output.data.results[*].subject, ", steps.x")' }, labels);
        expect(s).toBe('join(‹Berichten ophalen › Data › Results › Subject›, ", steps.x")');
    });

    it('a template names its placeholders; a ref is its value', () => {
        expect(formulaSummary(t, { kind: 'template', value: 'Bel {{trigger.output.customer["phone number"]}}' })).toBe('Bel ‹Incoming data › Customer › phone number›');
        expect(formulaSummary(t, { kind: 'ref', path: 'steps.fetch.status' }, labels)).toBe('‹Status›');
    });

    it('no summary shows a path, a [*], {{ }} or loop.', () => {
        const cases = [
            { kind: 'expr', value: 'count(loop.row.items[*]) > 2 ? vars.rate : item.amount' },
            { kind: 'template', value: '{{steps.a.output.items[*].name}} en {{trigger.firedAt}}' },
        ];
        for (const c of cases) expect(formulaSummary(t, c)).not.toMatch(/\{\{|\[\*\]|steps\.|loop\.|\.output/);
    });
});
