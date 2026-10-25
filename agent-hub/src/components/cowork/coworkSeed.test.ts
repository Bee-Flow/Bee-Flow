// @vitest-environment node
import { describe, it, expect } from 'vitest';
import appendAppSeed, { appendAppSeed as named } from './coworkSeed';

/**
 * The one property that matters here: picking an app must never cost you what
 * you already typed. The composer replaced the whole brief with the seed until
 * this module existed, which was silent data loss on a normal click.
 */
describe('appendAppSeed — the join rule', () => {
    it('is the same function under both names', () => {
        expect(named).toBe(appendAppSeed);
    });

    it('never drops what is already there', () => {
        for (const base of ['a', 'Mail the team', 'line one\nline two', '  padded  ', 'ends with a space ']) {
            const next = appendAppSeed(base, 'SEED');
            expect(next).toContain(base);
            expect(next).toContain('SEED');
            expect(next.indexOf(base)).toBe(0);
        }
    });

    it('separates two sentences with a newline', () => {
        expect(appendAppSeed('Mail the team', 'Show my recent emails'))
            .toBe('Mail the team\nShow my recent emails');
    });

    it('continues in place when the brief already ends in whitespace', () => {
        // Several seeds are half-sentences ending in a space themselves.
        expect(appendAppSeed('Look up ', 'Search my contacts for ')).toBe('Look up Search my contacts for ');
        expect(appendAppSeed('One\n', 'Two')).toBe('One\nTwo');
    });

    it('returns the seed alone for an empty or whitespace-only brief', () => {
        expect(appendAppSeed('', 'SEED')).toBe('SEED');
        expect(appendAppSeed('   ', 'SEED')).toBe('SEED');
        expect(appendAppSeed(' \n\t ', 'SEED')).toBe('SEED');
        expect(appendAppSeed(null, 'SEED')).toBe('SEED');
        expect(appendAppSeed(undefined, 'SEED')).toBe('SEED');
    });

    it('leaves the brief untouched when there is no seed', () => {
        expect(appendAppSeed('Keep this', '')).toBe('Keep this');
        expect(appendAppSeed('Keep this', null)).toBe('Keep this');
        expect(appendAppSeed('Keep this', undefined)).toBe('Keep this');
        expect(appendAppSeed(null, null)).toBe('');
    });
});
