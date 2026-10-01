import { describe, it, expect } from 'vitest';
import { interpolate, type TranslateFn } from '../../../../hooks/useTranslation';
import { formulaSummary, humanizeKey, listPathLabel, partsFromSource, pickLabel, type LabelPart } from './usePickLabel';

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
        expect(pickLabel(t, { from, take: 'each' })).toBe('Product (of this orderregel)');
    });

    it('a value of the current item: "<field> (of this <item>)", the item named after its list', () => {
        const from = { root: 'steps' as const, id: 's1', path: ['orderregels', 'product', 'email'] };
        expect(pickLabel(t, { from, take: 'each' }, { itemNoun: 'Orderregel' })).toBe('Email (of this orderregel)');
        // Without the step's item name: the key it sits in, read as one item.
        expect(pickLabel(t, { from, take: 'each' })).toBe('Email (of this product)');
        // The source panel's parts are relative to the item.
        expect(pickLabel(t, { from, take: 'each' }, { labelParts: [key('email')], itemNoun: 'Orderregel', groupLabel: 'Orders' })).toBe('Email (of this orderregel)');
        // The item itself, for a list of plain values.
        expect(pickLabel(t, { from: { root: 'steps', id: 's1', path: ['tags'] }, take: 'each' }, { itemNoun: 'Tag', groupLabel: 'Orders' })).toBe('Current tag');
    });

    it('a loop item\'s own key reads as a value of this item', () => {
        expect(pickLabel(t, { from: { root: 'loop', id: 'regel', path: ['email'] } }, { groupLabel: 'Current orderregel' })).toBe('Email (of this regel)');
        expect(pickLabel(t, { from: { root: 'loop', id: 'regel', path: ['email'] } }, { itemNoun: 'Orderregel' })).toBe('Email (of this orderregel)');
        expect(pickLabel(t, { from: { root: 'loop', id: 'regel', path: ['klant', 'email'] } })).toBe('Email of klant');
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

    it('a value at the top of a step is named with the step, which keeps its capitals', () => {
        const from = { root: 'steps' as const, id: 'fetch', path: ['tags'] };
        const ctx = { groupLabel: 'Bestelling ontvangen' };
        expect(pickLabel(t, { from, take: 'one' }, ctx)).toBe('Tags from Bestelling ontvangen');
        expect(pickLabel(t, { from, take: 'all' }, ctx)).toBe('Tags from Bestelling ontvangen');
        expect(pickLabel(t, { from, take: 'first' }, ctx)).toBe('The first tags from Bestelling ontvangen');
        expect(pickLabel(t, { from, take: 'count' }, ctx)).toBe('Number of tags');
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

describe('listPathLabel and the JSON-text formula', () => {
    const labels = new Map([['fetch', 'Berichten ophalen']]);

    it('names a list path the way a chip would', () => {
        expect(listPathLabel(t, 'steps.fetch.output.data.results', labels)).toBe('Results of data');
        expect(listPathLabel(t, 'steps.fetch.output.items[*].lines', labels)).toBe('Lines of all items');
        expect(listPathLabel(t, 'trigger.output.orders', labels)).toBe('Orders from incoming data');
        expect(listPathLabel(t, 'not a path', labels)).toBe('not a path');
    });

    it('a value read out of a JSON text reads as words, without parseJson', () => {
        const s = formulaSummary(t, { kind: 'expr', value: 'parseJson(item.body, "order.total")' });
        expect(s).toBe('‹Body›, read from the text: order.total');
    });
});
