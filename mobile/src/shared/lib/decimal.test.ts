/** A decimal comma reads as a dot; anything that is not one number is not guessed at. */

import { normaliseDecimal, parseDecimal } from './decimal';

describe('parseDecimal', () => {
    it.each([
        ['1,5', 1.5],
        ['1.5', 1.5],
        ['0,05', 0.05],
        ['0.05', 0.05],
        [' 42 ', 42],
        ['-3,25', -3.25],
        ['+7', 7],
        [',5', 0.5],
        ['1,', 1],
        ['0.', 0],
    ])('reads %j as %p', (text, number) => {
        expect(parseDecimal(text)).toBe(number);
    });

    it.each(['', '   ', '-', ',', '.', '1.2.3', '1,2,3', '1.000,5', '1,000.5', 'abc', '1e3', '0x10', 'Infinity', '1 000'])(
        'refuses %j',
        (text) => {
            expect(parseDecimal(text)).toBeNull();
        },
    );
});

describe('normaliseDecimal', () => {
    it('reads one decimal comma as a dot', () => {
        expect(normaliseDecimal('1,5')).toBe('1.5');
        expect(normaliseDecimal('-0,25')).toBe('-0.25');
    });

    it('leaves a dot, two separators and plain text as they came', () => {
        expect(normaliseDecimal('1.5')).toBe('1.5');
        expect(normaliseDecimal('1.000,5')).toBe('1.000,5');
        expect(normaliseDecimal('1,2,3')).toBe('1,2,3');
        expect(normaliseDecimal('forty')).toBe('forty');
    });
});
