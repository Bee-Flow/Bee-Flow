import { isWebAddress, withScheme } from './webAddress';

describe('withScheme', () => {
    it('puts https:// in front of an address typed without one', () => {
        expect(withScheme(' example.com/report ')).toBe('https://example.com/report');
        expect(withScheme('example.com:8080/x')).toBe('https://example.com:8080/x');
    });

    it('keeps a scheme that was typed, whatever its case', () => {
        expect(withScheme('http://example.com')).toBe('http://example.com');
        expect(withScheme('HTTPS://Example.com')).toBe('HTTPS://Example.com');
        expect(withScheme('ftp://example.com')).toBe('ftp://example.com');
    });

    it('leaves an empty field empty', () => {
        expect(withScheme('   ')).toBe('');
    });
});

describe('isWebAddress', () => {
    it('takes a host with a dot, with or without the scheme', () => {
        expect(isWebAddress('example.com')).toBe(true);
        expect(isWebAddress('www.example.com/sitemap.xml')).toBe(true);
        expect(isWebAddress('http://intranet.local/x')).toBe(true);
    });

    it('refuses what the fetcher could not read', () => {
        expect(isWebAddress('')).toBe(false);
        expect(isWebAddress('example')).toBe(false);
        expect(isWebAddress('https://')).toBe(false);
        expect(isWebAddress('example.com/a b')).toBe(false);
        expect(isWebAddress('ftp://example.com')).toBe(false);
    });
});
