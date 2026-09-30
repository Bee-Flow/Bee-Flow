/**
 * The validators answer a message or null, and leave emptiness to `required`
 * so an optional field with a format rule can still be left blank.
 */

import { email, matches, maxLength, minLength, required } from './validators';

const ALL = {};

describe('validators', () => {
    it('required treats whitespace and nullish as missing', () => {
        const rule = required('needed');
        expect(rule('', ALL)).toBe('needed');
        expect(rule('   ', ALL)).toBe('needed');
        expect(rule(null, ALL)).toBe('needed');
        expect(rule(undefined, ALL)).toBe('needed');
        expect(rule('x', ALL)).toBeNull();
        expect(rule(0, ALL)).toBeNull();
    });

    it('minLength and maxLength measure trimmed text, and pass an empty value', () => {
        expect(minLength(3, 'short')('ab', ALL)).toBe('short');
        expect(minLength(3, 'short')(' abc ', ALL)).toBeNull();
        expect(minLength(3, 'short')('', ALL)).toBeNull();
        expect(maxLength(3, 'long')('abcd', ALL)).toBe('long');
        expect(maxLength(3, 'long')(' abc ', ALL)).toBeNull();
    });

    it('matches and email pass an empty value and check a present one', () => {
        expect(matches(/^\d+$/, 'digits')('12a', ALL)).toBe('digits');
        expect(matches(/^\d+$/, 'digits')('', ALL)).toBeNull();
        expect(email('bad')('a@b.nl', ALL)).toBeNull();
        expect(email('bad')('a@b', ALL)).toBe('bad');
        expect(email('bad')('', ALL)).toBeNull();
    });
});
