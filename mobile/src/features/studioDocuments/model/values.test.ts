import type { ContractParameter } from './types';
import {
    coerceInput,
    columnTotals,
    formatTotal,
    inputText,
    listRows,
    newParameter,
    ruleCount,
    ruleFor,
    setRowField,
    withType,
} from './values';

const field = (key: string, type: ContractParameter['type'], label = ''): ContractParameter => ({
    key,
    type,
    label,
    required: false,
    summary: '',
    instructions: '',
});

describe('customer values', () => {
    it('reads what was typed as the parameter type means it', () => {
        expect(coerceInput('number', '12,5')).toBe(12.5);
        expect(coerceInput('number', 'abc')).toBe('abc');
        expect(coerceInput('text', '')).toBeUndefined();
        expect(coerceInput('date', '2026-09-24')).toBe('2026-09-24');
        expect(inputText(undefined)).toBe('');
        expect(inputText(3)).toBe('3');
        expect(inputText({ a: 1 })).toBe('{"a":1}');
    });

    it('edits the rows of a list', () => {
        const rows = listRows([{ description: 'Design' }, 'junk']);
        expect(rows).toEqual([{ description: 'Design' }, {}]);
        expect(setRowField(rows, 1, 'amount', 40)).toEqual([{ description: 'Design' }, { amount: 40 }]);
        expect(listRows('nope')).toEqual([]);
    });

    it('sums every number column of the line items', () => {
        const fields = [field('description', 'text'), field('amount', 'number', 'Amount'), field('hours', 'number')];
        const rows = [{ amount: 0.1, hours: 2 }, { amount: 0.2 }, { amount: 'x', hours: 3 }];
        const totals = columnTotals(fields, rows);
        expect(totals.map((t) => [t.key, t.label, formatTotal(t.total)])).toEqual([
            ['amount', 'Amount', '0.3'],
            ['hours', 'hours', '5'],
        ]);
    });
});

describe('contract edits', () => {
    it('brings what a new type needs', () => {
        const base = newParameter();
        expect(withType(base, 'choice').options).toEqual(['Option 1']);
        expect(withType({ ...base, options: ['a'] }, 'choice').options).toEqual(['a']);
        expect(withType(base, 'list').fields).toEqual([]);
        expect(withType(base, 'number').type).toBe('number');
    });

    it('starts a rule with the value its parameter type starts from', () => {
        expect(ruleFor(field('on', 'boolean'))).toEqual({ parameter: 'on', operator: 'equals', value: true });
        expect(ruleFor(field('n', 'number'), 'greater_than')).toEqual({ parameter: 'n', operator: 'greater_than', value: 0 });
        expect(ruleFor(undefined)).toEqual({ parameter: '', operator: 'equals', value: '' });
    });

    it('counts the rules of a condition however it nests', () => {
        const rule = { parameter: 'a', operator: 'is_set' as const };
        expect(ruleCount({ all: [rule, { any: [rule, rule] }] })).toBe(3);
        expect(ruleCount(null)).toBe(0);
    });
});
