/**
 * The billing-country list is the web's, code for code and name for name, in
 * the same order: an organisation saved on the phone must show the same
 * country in the browser's select, and the other way round.
 */

import fs from 'node:fs';
import path from 'node:path';

import { COUNTRIES, countryName } from './countries';

const WEB = path.resolve(
    __dirname,
    '../../../../../agent-hub/src/components/admin/subscriptions/access/countries.js',
);

function webCountries(): { code: string; name: string }[] {
    const src = fs.readFileSync(WEB, 'utf8');
    const body = src.slice(src.indexOf('export const COUNTRIES'), src.indexOf('];'));
    return [...body.matchAll(/\{ code: '([A-Z]{2})', name: (?:"([^"]*)"|'([^']*)') \}/g)].map((m) => ({
        code: m[1] as string,
        name: (m[2] ?? m[3]) as string,
    }));
}

describe('the billing-country list', () => {
    it('matches the web list exactly', () => {
        const web = webCountries();
        expect(web.length).toBeGreaterThan(150);
        expect(COUNTRIES.map((c) => ({ code: c.code, name: c.name }))).toEqual(web);
    });

    it('names a stored code, and keeps an unknown one as it is', () => {
        expect(countryName('NL')).toBe('Netherlands');
        expect(countryName('XX')).toBe('XX');
        expect(countryName(undefined)).toBe('');
    });
});
