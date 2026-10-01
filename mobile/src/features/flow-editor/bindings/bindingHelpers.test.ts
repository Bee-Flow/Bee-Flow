import { previewValue } from './bindingHelpers';

describe('previewValue', () => {
    it.each<[unknown, string]>([
        [null, '—'],
        [undefined, '—'],
        ['', ''],
        ['short', 'short'],
        ['x'.repeat(60), `${'x'.repeat(39)}…`],
        [0, '0'],
        [3.5, '3.5'],
        [true, 'true'],
        [[], '[0 items]'],
        [[1], '[1 item]'],
        [[1, 2], '[2 items]'],
        [{}, '{}'],
        [{ a: 1 }, '{a}'],
        [{ a: 1, b: 2, c: 3, d: 4 }, '{a, b, c…}'],
    ])('previewValue(%p)', (value, shown) => {
        expect(previewValue(value)).toBe(shown);
    });

    it('cuts a long text to the length asked for', () => {
        expect(previewValue('abcdefgh', 5)).toBe('abcd…');
        expect(previewValue(Symbol.for('s'))).toBe('Symbol(s)');
    });
});
