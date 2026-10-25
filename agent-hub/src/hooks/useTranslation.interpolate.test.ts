import { describe, it, expect } from 'vitest';
import { interpolate } from './useTranslation';

/**
 * `{naam}` → the value, LITERALLY.
 *
 * This test exists for one reason: `String.prototype.replace` with a replacement
 * STRING knows `$&`, `` $` ``, `$'` and `$1`..`$9` as special characters, and the
 * values that come through here are user input: a file name, a table name, a path.
 * The old implementation therefore scrubbed out precisely that name from the message
 * that exists BECAUSE the name contains odd characters.
 */
describe('interpolate — een waarde is tekst, geen vervangingspatroon', () => {
    it('zet een gewone waarde in', () => {
        expect(interpolate('Hello {name}', { name: 'Ada' })).toBe('Hello Ada');
    });

    it('BIJT — `$&` blijft `$&` en eet de placeholder niet op', () => {
        // With a replacement STRING this became 'a{segment}b.txt'.
        expect(interpolate('Bad name "{segment}"', { segment: 'a$&b.txt' }))
            .toBe('Bad name "a$&b.txt"');
    });

    it('BIJT — `$1` en `` $` `` en `$\'` blijven staan', () => {
        expect(interpolate('{x}', { x: '$1' })).toBe('$1');
        expect(interpolate('{x}', { x: '$`' })).toBe('$`');
        expect(interpolate('{x}', { x: "$'" })).toBe("$'");
        expect(interpolate('{x}', { x: '100$$' })).toBe('100$$');
    });

    it('vervangt elke voorkomen van dezelfde placeholder', () => {
        expect(interpolate('{a} en {a}', { a: 'x' })).toBe('x en x');
    });

    it('laat de tekst met rust zonder params, en zet niet-strings om', () => {
        expect(interpolate('Hello {name}', null)).toBe('Hello {name}');
        expect(interpolate('{n} rows', { n: 3 })).toBe('3 rows');
    });
});
