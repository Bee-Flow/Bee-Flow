import { looksLikeEmail } from './dsr';
import { nameChanged, signInMethod } from './profile';

describe('nameChanged', () => {
    it('ignores surrounding space and refuses a blank name', () => {
        expect(nameChanged('Ada ', 'Ada')).toBe(false);
        expect(nameChanged('Ada L.', 'Ada')).toBe(true);
        expect(nameChanged('   ', 'Ada')).toBe(false);
    });
});

describe('signInMethod', () => {
    it('reads local as a password and anything else as single sign-on', () => {
        expect(signInMethod(undefined)).toBe('Password');
        expect(signInMethod('local')).toBe('Password');
        expect(signInMethod('azure_ad')).toBe('Azure ad single sign-on');
    });
});

describe('looksLikeEmail', () => {
    it('accepts something@something.tld, trimmed', () => {
        expect(looksLikeEmail(' a@b.nl ')).toBe(true);
        expect(looksLikeEmail('a@b')).toBe(false);
        expect(looksLikeEmail('')).toBe(false);
    });
});
