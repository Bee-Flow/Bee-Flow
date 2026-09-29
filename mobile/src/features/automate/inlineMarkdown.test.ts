import { isPlain, parseInlineMarkdown } from './inlineMarkdown';

const flat = (s: string) => parseInlineMarkdown(s).map((x) => [x.text, x.bold, x.italic, x.href]);

describe('the markdown subset a Studio app may use', () => {
    it('leaves plain text alone', () => {
        expect(flat('Just words')).toEqual([['Just words', false, false, null]]);
        expect(isPlain(parseInlineMarkdown('Just words'))).toBe(true);
    });

    it('renders **bold** rather than printing the asterisks', () => {
        // The bug this exists to fix: 464 `text` nodes across the shipped
        // templates were reaching the phone with their markup showing.
        expect(flat('is **spoed** nodig')).toEqual([
            ['is ', false, false, null],
            ['spoed', true, false, null],
            [' nodig', false, false, null],
        ]);
    });

    it('renders *italic*', () => {
        expect(flat('a *little* emphasis')).toEqual([
            ['a ', false, false, null],
            ['little', false, true, null],
            [' emphasis', false, false, null],
        ]);
    });

    it('nests italic inside bold', () => {
        expect(flat('**very *very* much**')).toEqual([
            ['very ', true, false, null],
            ['very', true, true, null],
            [' much', true, false, null],
        ]);
    });

    it('keeps an unclosed marker as literal text', () => {
        expect(flat('2 * 3 = 6')).toEqual([['2 * 3 = 6', false, false, null]]);
        expect(flat('**')).toEqual([['**', false, false, null]]);
    });

    it('reads a link', () => {
        expect(flat('see [the docs](https://beeflow.nl/docs) now')).toEqual([
            ['see ', false, false, null],
            ['the docs', false, false, 'https://beeflow.nl/docs'],
            [' now', false, false, null],
        ]);
    });

    it('refuses a link that is not http(s) — it stays literal', () => {
        // Same restriction the web applies. A javascript: or data: href in an
        // app definition is not something the phone will offer to open.
        expect(flat('[tap](javascript:alert(1))')).toEqual([
            ['[tap](javascript:alert(1))', false, false, null],
        ]);
    });

    it('leaves a malformed link alone', () => {
        expect(flat('[no closing paren](https://x.com')).toEqual([
            ['[no closing paren](https://x.com', false, false, null],
        ]);
        expect(flat('[](https://x.com)')).toEqual([['[](https://x.com)', false, false, null]]);
    });

    it('handles null and empty without throwing', () => {
        expect(parseInlineMarkdown(null)).toEqual([]);
        expect(parseInlineMarkdown(undefined)).toEqual([]);
        expect(parseInlineMarkdown('')).toEqual([]);
    });

    it('marks bold inside a link label', () => {
        expect(flat('[**go**](https://x.com)')).toEqual([
            ['go', true, false, 'https://x.com'],
        ]);
    });
});
