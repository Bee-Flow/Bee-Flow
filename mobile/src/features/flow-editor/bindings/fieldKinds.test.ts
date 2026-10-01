import { expectedKindFor, isPlaceholder, KIND_WORD, KINDS, kindOfValue, looksLikeFile } from './fieldKinds';

describe('fieldKinds', () => {
    it('words every kind', () => {
        for (const kind of KINDS) expect(KIND_WORD[kind].key).toBe(`routines.kind.${kind}`);
    });

    it.each<[unknown, string]>([
        [null, 'unknown'], [undefined, 'unknown'], [3, 'number'], [true, 'yesno'], ['x', 'text'], ['<string>', 'unknown'],
        ['2026-01-01', 'date'], ['2026-01-01T10:00', 'date'], ['jan@voorbeeld.nl', 'email'], ['Jan <jan@x.nl>', 'text'],
        [[], 'list'], [[1, 2], 'list'], [[{ a: 1 }, null], 'table'], [{ fileId: 'a', name: 'r.pdf', size: 1 }, 'file'], [{ a: 1 }, 'group'],
    ])('kindOfValue(%p) is %p', (value, kind) => {
        expect(kindOfValue(value)).toBe(kind);
    });

    it.each<[unknown, string]>([
        [null, 'unknown'], [{ type: 'string' }, 'text'], [{ type: 'string', format: 'email' }, 'email'], [{ type: 'string', format: 'date-time' }, 'date'],
        [{ type: 'string', enum: ['a'] }, 'choice'], [{ enum: ['a'] }, 'choice'], [{ type: 'string', enum: ['a'], format: 'date' }, 'date'],
        [{ type: ['null', 'integer'] }, 'number'], [{ type: 'boolean' }, 'yesno'], [{ type: 'array', items: { type: 'object' } }, 'table'],
        [{ type: 'array' }, 'list'], [{ type: 'object' }, 'group'], [{ type: 'weird' }, 'unknown'],
    ])('expectedKindFor(%j) is %p', (prop, kind) => {
        expect(expectedKindFor(prop as never)).toBe(kind);
    });

    it('knows a placeholder and a file reference', () => {
        expect(isPlaceholder(' <date time> ')).toBe(true);
        expect(isPlaceholder('<a>b')).toBe(false);
        expect(looksLikeFile({ url: 'u', filename: 'f', mime: 'x' })).toBe(true);
        expect(looksLikeFile({ url: 'u', filename: 'f' })).toBe(false);
    });
});
