import { translate } from '@/core/i18n';

import { formulaSummary, pickLabel } from './pickLabel';

const t = translate;
const steps = (path: (string | number)[]) => ({ root: 'steps' as const, id: 's1', path });

describe('pickLabel', () => {
    it.each<[string, { from: object; take?: string; label?: string }, string, string]>([
        ['a field of a step', { from: steps(['email']) }, 'Orders ophalen', 'Email from Orders ophalen'],
        ['a field inside a record', { from: steps(['Klant', 'E-mail adres']) }, '', 'E-mail adres of klant'],
        ['a column of a list, all of it', { from: steps(['orders', 'product']), take: 'all' }, '', 'Product of all orders'],
        ['the first of a column', { from: steps(['orders', 'product']), take: 'first' }, '', 'Product of the first orders'],
        ['the current item', { from: steps(['orders', 'product']), take: 'each' }, '', 'Product (of this orders)'],
        ['a count', { from: steps(['orders']), take: 'count' }, '', 'Number of orders'],
        ['the first row', { from: steps(['orders', 0]) }, '', 'The first orders'],
        ['a later row', { from: steps(['orders', 2]) }, '', 'Orders, row 3'],
        ['a field of the first row', { from: steps(['orders', 0, 'id']) }, '', 'ID of the first orders'],
        ['a whole step', { from: steps([]) }, 'Orders ophalen', 'Output of Orders ophalen'],
        ['the incoming data', { from: { root: 'trigger', path: [] } }, '', 'Incoming data'],
        ['a stored label', { from: steps(['x']), label: ' Producten ' }, '', 'Producten'],
    ])('%s', (_name, pick, group, words) => {
        expect(pickLabel(t, pick as never, group)).toBe(words);
    });

    it('never names a path, a bracket or a [*]', () => {
        const words = pickLabel(t, { from: steps(['line_items', 'unit_price']), take: 'all' });
        expect(words).toBe('Unit price of all line items');
        expect(words).not.toMatch(/steps|\[|\]|\./);
    });

    it('says nothing for nothing', () => {
        expect(pickLabel(t, null)).toBe('');
    });
});

describe('formulaSummary', () => {
    const labels = new Map([['s1', 'Orders ophalen']]);

    it('words the paths of a formula, and leaves its strings alone', () => {
        expect(formulaSummary(t, { kind: 'expr', value: 'upper(steps.s1.output.name) + " steps.s1"' }, labels)).toBe('upper(‹Orders ophalen › Name›) + " steps.s1"');
        expect(formulaSummary(t, { kind: 'ref', path: 'trigger.output.items[0].sku' })).toBe('‹Incoming data › Items › #1 › Sku›');
        expect(formulaSummary(t, { kind: 'template', value: 'Hi {{ steps.s1.output.first_name }}!' }, labels)).toBe('Hi ‹Orders ophalen › First name›!');
    });

    it('says nothing for what is not a binding', () => {
        expect(formulaSummary(t, null)).toBe('');
        expect(formulaSummary(t, 'x')).toBe('');
        expect(formulaSummary(t, { kind: 'literal', value: 1 })).toBe('');
    });
});
