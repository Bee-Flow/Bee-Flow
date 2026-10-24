/**
 * The billing-country list is the web's own table (a generated copy under
 * ../mirror, see scripts/shared-mirror.manifest.json), so only the lookup
 * helpers are tested here.
 */

import { COUNTRIES, countryName } from './countries';

describe('the billing-country list', () => {
    it('is the web list, complete and unique', () => {
        expect(COUNTRIES.length).toBeGreaterThan(150);
        expect(new Set(COUNTRIES.map((c) => c.code)).size).toBe(COUNTRIES.length);
    });

    it('names a stored code, and keeps an unknown one as it is', () => {
        expect(countryName('NL')).toBe('Netherlands');
        expect(countryName('XX')).toBe('XX');
        expect(countryName(undefined)).toBe('');
    });
});
