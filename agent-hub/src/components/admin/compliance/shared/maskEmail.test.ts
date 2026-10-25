// @vitest-environment node
import { describe, it, expect } from 'vitest';
import maskEmail, { MASK, maskEmail as named } from './maskEmail';

describe('maskEmail — an address as a list may show it (BFSF-441)', () => {
    it('keeps the first character and the domain, hides the rest of the local part', () => {
        expect(maskEmail('john.doe@gmail.com')).toBe('j.•••@gmail.com');
        expect(maskEmail('Tom@Beeflow.nl')).toBe('T.•••@Beeflow.nl');      // case untouched, the domain is not the secret
        expect(maskEmail('  ab@x.io ')).toBe('a.•••@x.io');                 // surrounding whitespace is not part of the address
        expect(maskEmail('info+dsr@sub.example.co.uk')).toBe('i.•••@sub.example.co.uk');
        expect(maskEmail('日本語@example.jp')).toBe('日.•••@example.jp');
        expect(maskEmail('😀x@example.com')).toBe('😀.•••@example.com');      // a code point, not half a surrogate pair
    });

    it('a local part shorter than two characters is masked whole — one letter would be the entire secret', () => {
        expect(maskEmail('a@x.io')).toBe('•••@x.io');
        expect(maskEmail('7@example.com')).toBe('•••@example.com');
    });

    it('anything that is not recognisably an e-mail address is masked completely', () => {
        for (const v of ['not an email', '', '   ', '@example.com', 'john@', 'a@b@c.com', 'john doe@example.com', null, undefined, 42, {}, ['a@b.c']]) {
            expect(maskEmail(v)).toBe('•••');
        }
    });

    it('exports the mask constant and the same function under both names', () => {
        expect(MASK).toBe('•••');
        expect(named).toBe(maskEmail);
    });
});
