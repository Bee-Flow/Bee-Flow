import { describe, it, expect } from 'vitest';
import { interpolate } from './useTranslation';

/**
 * `{naam}` → de waarde, LETTERLIJK.
 *
 * Deze test bestaat om één reden: `String.prototype.replace` met een
 * vervangings-STRING kent `$&`, `` $` ``, `$'` en `$1`..`$9` als speciale
 * tekens, en de waarden die hier langskomen zijn gebruikersinvoer — een
 * bestandsnaam, een tabelnaam, een pad. De oude implementatie sloopte
 * daardoor precies die naam uit de melding die bestaat OMDAT de naam rare
 * tekens bevat.
 */
describe('interpolate — een waarde is tekst, geen vervangingspatroon', () => {
    it('zet een gewone waarde in', () => {
        expect(interpolate('Hello {name}', { name: 'Ada' })).toBe('Hello Ada');
    });

    it('BIJT — `$&` blijft `$&` en eet de placeholder niet op', () => {
        // Met een vervangings-STRING werd dit 'a{segment}b.txt'.
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
