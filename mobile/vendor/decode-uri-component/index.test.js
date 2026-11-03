/* global describe, it, expect */
// Tests for the vendored CommonJS port of decode-uri-component 0.5.1. The malformed-input
// cases follow upstream's behaviour (a broken run stays literal, a truncated %C2 and the
// UTF-16 BOM pairs become U+FFFD); the timing cases are the payload shapes of
// GHSA-vcc3-ghjq-m6fr and GHSA-qr28-fpjm-wq7f, which made the pre-0.5.1 decoder run for minutes.
const decodeUriComponent = require('./index.js');

describe('decode-uri-component (vendored 0.5.1)', () => {
    it('is the function itself, also as .default', () => {
        expect(typeof decodeUriComponent).toBe('function');
        expect(decodeUriComponent.default).toBe(decodeUriComponent);
    });

    it('decodes well-formed input like decodeURIComponent', () => {
        expect(decodeUriComponent('%25')).toBe('%');
        expect(decodeUriComponent('foo%20bar')).toBe('foo bar');
        expect(decodeUriComponent('a%2Fb%3Fc')).toBe('a/b?c');
        expect(decodeUriComponent('%E5%A5%BD')).toBe('好');
        expect(decodeUriComponent('%e5%a5%bd')).toBe('好');
        expect(decodeUriComponent('%F0%9F%98%80')).toBe('😀');
        expect(decodeUriComponent('plain')).toBe('plain');
        expect(decodeUriComponent('')).toBe('');
    });

    it('leaves a lone or non-hex percent sign literal', () => {
        expect(decodeUriComponent('%')).toBe('%');
        expect(decodeUriComponent('%G1')).toBe('%G1');
        expect(decodeUriComponent('100%')).toBe('100%');
    });

    it('keeps truncated and invalid UTF-8 sequences literal, decoding the rest', () => {
        expect(decodeUriComponent('%E0%A4%A')).toBe('%E0%A4%A');
        expect(decodeUriComponent('%E0%A4')).toBe('%E0%A4');
        expect(decodeUriComponent('%F0%9F%98')).toBe('%F0%9F%98');
        expect(decodeUriComponent('%80')).toBe('%80');
        expect(decodeUriComponent('%C3%28')).toBe('%C3(');
        expect(decodeUriComponent('%C0%AF')).toBe('%C0%AF');
        expect(decodeUriComponent('%ED%A0%80')).toBe('%ED%A0%80');
        expect(decodeUriComponent('%E5%A5%BDabc%E0')).toBe('好abc%E0');
        expect(decodeUriComponent('%E5%A5%BD%E5%A5')).toBe('好%E5%A5');
        expect(decodeUriComponent('%E0%A4%A%E0%A4%A')).toBe('%E0%A4%A%E0%A4%A');
    });

    it('turns a truncated %C2 and the UTF-16 BOM pairs into replacement characters', () => {
        expect(decodeUriComponent('%C2')).toBe('�');
        expect(decodeUriComponent('%C2%')).toBe('�%');
        expect(decodeUriComponent('%FE%FF')).toBe('��');
        expect(decodeUriComponent('%FF%FE')).toBe('��');
    });

    it('rejects non-string input', () => {
        expect(() => decodeUriComponent(undefined)).toThrow(TypeError);
        expect(() => decodeUriComponent(42)).toThrow(/string/);
    });

    describe('denial-of-service payloads finish fast', () => {
        const payloads = {
            'a long run of bare percent signs': '%'.repeat(1e5),
            'a long run of truncated three-byte sequences': '%C3%'.repeat(5e4),
            'a long run of truncated four-byte sequences': '%F0%9F%98'.repeat(3e4),
            'valid text followed by a long malformed tail': `${'%E5%A5%BD'.repeat(1e4)}${'%E0%A4%A'.repeat(1e4)}`,
            'a long run of continuation bytes': '%80'.repeat(1e5),
            'a long run of an invalid lead byte followed by a broken byte': `${'%FF'.repeat(1e5)}%`,
        };

        for (const [name, payload] of Object.entries(payloads)) {
            it(`${name} (${payload.length} chars)`, () => {
                const started = Date.now();
                const result = decodeUriComponent(payload);
                expect(Date.now() - started).toBeLessThan(1000);
                expect(typeof result).toBe('string');
            });
        }

        it('decodes the long bare-percent payload to itself', () => {
            const payload = '%'.repeat(1e5);
            expect(decodeUriComponent(payload)).toBe(payload);
        });
    });
});
