import { describe, it, expect } from 'vitest';
import {
    kindOfValue, describeField, expectedKindFor, kindFits, formatBytes, looksLikeFile, isPlaceholder,
    isScalarKind, KINDS, KIND_TECHNICAL, KIND_WORD, ISO_DATE_RE,
} from './fieldKinds';

/**
 * The plain-language vocabulary (artboard 2c). Two cases matter more than the
 * rest: an EMPTY list must never read as "list of 0 · text", and a missing
 * sample must read as "not seen yet", never as "text".
 */
describe('kindOfValue', () => {
    it('names every scalar in plain words', () => {
        expect(kindOfValue('hello')).toBe('text');
        expect(kindOfValue(42)).toBe('number');
        expect(kindOfValue(true)).toBe('yesno');
        expect(kindOfValue('2026-09-02')).toBe('date');
        expect(kindOfValue('2026-09-02T10:26')).toBe('date');
    });

    it('tells a table from a list from a group from a file', () => {
        expect(kindOfValue([1, 2, 3])).toBe('list');
        expect(kindOfValue([{ a: 1 }, { a: 2 }])).toBe('table');
        expect(kindOfValue({ a: 1, b: 2 })).toBe('group');
        expect(kindOfValue({ fileId: 'f1', name: 'report.pdf', size: 12288, mime: 'application/pdf' })).toBe('file');
        expect(looksLikeFile({ url: 'https://x', filename: 'a.png', mimeType: 'image/png' })).toBe(true);
    });

    it('a null or a placeholder is "not seen yet", not text', () => {
        expect(kindOfValue(null)).toBe('unknown');
        expect(kindOfValue(undefined)).toBe('unknown');
        expect(kindOfValue('<string>')).toBe('unknown');
        expect(isPlaceholder('<file ref>')).toBe(true);
        expect(isPlaceholder('hello')).toBe(false);
    });

    it('every kind has a word', () => {
        for (const k of KINDS) expect(KIND_WORD[k]?.en, k).toBeTruthy();
    });
});

describe('describeField', () => {
    it('list: "list of 3 · text"', () => {
        const d = describeField({ key: 'periods', path: 'steps.a.output.periods', sample: ['2023', '2024', '2025'] });
        expect(d.kind).toBe('list');
        expect(`${d.word} ${d.detail}`).toBe('list of 3 · text');
    });

    it('an empty list never reads as "list of 0 · text"', () => {
        const d = describeField({ key: 'x', path: 'steps.a.output.x', sample: [] });
        expect(d.kind).toBe('list');
        expect(d.detail).toBe('· empty');
    });

    it('table: rows and columns', () => {
        const rows = Array.from({ length: 14 }, (_, i) => ({ post: `p${i}`, y2023: 1, y2024: 2, y2025: 3 }));
        const d = describeField({ key: 'pl', path: 'steps.a.output.pl', sample: rows });
        expect(d.kind).toBe('table');
        expect(`${d.word} ${d.detail}`).toBe('table · 14 rows · 4 columns');
    });

    it('group: how many fields', () => {
        const d = describeField({ key: 'balance', path: 'steps.a.output.balance', sample: { assets: 1, liabilities: 1, diff: 0 } });
        expect(`${d.word} ${d.detail}`).toBe('group · 3 fields');
    });

    it('file: name and size', () => {
        const d = describeField({ key: 'src', path: 'trigger.output.src', sample: { fileId: 'f', name: 'jaarrekening-2025.xlsx', size: 1258291, mime: 'x' } });
        expect(d.kind).toBe('file');
        expect(d.detail).toBe('· jaarrekening-2025.xlsx · 1.2 MB');
    });

    it('prefers the real value from the sample root over the design-time sample', () => {
        const root = { steps: { a: { output: { n: 7 } } } };
        const d = describeField({ key: 'n', path: 'steps.a.output.n', sample: '<string>' }, root);
        expect(d.kind).toBe('number');
        expect(d.value).toBe(7);
    });

    it('uses t() when given, with the English as the fallback argument', () => {
        const seen = [];
        const t = (key, en, params) => { seen.push(key); return `NL:${en}`; };
        const d = describeField({ key: 'x', path: 'p', sample: 'hi' }, null, t);
        expect(d.word).toBe('NL:text');
        expect(seen).toContain('routines.kind.text');
    });
});

describe('expectedKindFor / kindFits', () => {
    it('reads a JSON-schema property into a kind', () => {
        expect(expectedKindFor({ type: 'string' })).toBe('text');
        expect(expectedKindFor({ type: 'string', format: 'date-time' })).toBe('date');
        expect(expectedKindFor({ type: ['null', 'integer'] })).toBe('number');
        expect(expectedKindFor({ type: 'boolean' })).toBe('yesno');
        expect(expectedKindFor({ type: 'array' })).toBe('list');
        expect(expectedKindFor({ type: 'array', items: { type: 'object' } })).toBe('table');
        expect(expectedKindFor({ type: 'object' })).toBe('group');
        expect(expectedKindFor(null)).toBe('unknown');
    });

    it('is advisory and permissive: text takes any scalar, unknown fits everything', () => {
        expect(kindFits('number', 'text')).toBe(true);
        expect(kindFits('date', 'text')).toBe(true);
        expect(kindFits('list', 'text')).toBe(false);
        expect(kindFits('table', 'list')).toBe(true);
        expect(kindFits('unknown', 'number')).toBe(true);
        expect(kindFits('text', 'unknown')).toBe(true);
        expect(kindFits('text', 'number')).toBe(false);
    });

    it('formats byte counts for people', () => {
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(12288)).toBe('12 KB');
        expect(formatBytes(1258291)).toBe('1.2 MB');
        expect(formatBytes('x')).toBeNull();
    });

    it('exports the one ISO-date regex', () => {
        expect(ISO_DATE_RE.test('2026-09-02')).toBe(true);
        expect(ISO_DATE_RE.test('02-09-2026')).toBe(false);
    });
});

/**
 * `choice` — one of a DECLARED list. Added with the datatables restyle: a
 * `select` column and a tool parameter with an `enum` are the same idea, and
 * calling both "text" is what made "'nope' is not one of new, won" read as a
 * type error rather than a value error.
 */
describe('choice is a kind of its own', () => {
    it('has a word and a technical name like every other kind', () => {
        expect(KINDS).toContain('choice');
        for (const k of KINDS) {
            expect(KIND_WORD[k]?.en, k).toBeTruthy();
            expect(KIND_TECHNICAL[k], k).toBeTruthy();
        }
    });

    it('is never GUESSED from a value — only a declaration can say so', () => {
        // "won" is a string. That it came from an option list is knowledge the
        // value does not carry, and inventing it here would make every short
        // string a dropdown.
        expect(kindOfValue('won')).toBe('text');
        expect(describeField({ key: 'stage', path: 'p', sample: 'won' }).kind).toBe('text');
    });

    it('a schema property with an enum is a choice, not text', () => {
        expect(expectedKindFor({ type: 'string', enum: ['new', 'won'] })).toBe('choice');
        // Empty or absent enum stays text — an empty option list is not a
        // choice, it is a dropdown with nothing in it.
        expect(expectedKindFor({ type: 'string', enum: [] })).toBe('text');
        expect(expectedKindFor({ type: 'string' })).toBe('text');
        // A format still wins: a dated enum is a date.
        expect(expectedKindFor({ type: 'string', format: 'date', enum: ['2026-01-01'] })).toBe('date');
        // A non-string enum is left to its own type.
        expect(expectedKindFor({ type: 'integer', enum: [1, 2] })).toBe('number');
    });

    it('is a scalar, and binds both ways with text — the server checks the VALUE', () => {
        expect(isScalarKind('choice')).toBe(true);
        expect(kindFits('choice', 'text')).toBe(true);
        expect(kindFits('text', 'choice')).toBe(true);
        expect(kindFits('number', 'choice')).toBe(true);
        // A list is still not one value.
        expect(kindFits('list', 'choice')).toBe(false);
    });
});

describe('the email kind (round 2 leftover)', () => {
    it('reads one address as an email address, and anything around it as text', () => {
        expect(kindOfValue('t.kooy@vandijk.nl')).toBe('email');
        expect(kindOfValue('Jan <jan@x.nl>')).toBe('text');
        expect(kindOfValue('a@b.nl, c@d.nl')).toBe('text');
    });

    it('comes from a schema format, and fits text both ways', () => {
        expect(expectedKindFor({ type: 'string', format: 'email' })).toBe('email');
        expect(kindFits('email', 'text')).toBe(true);
        expect(kindFits('text', 'email')).toBe(true);
        expect(kindFits('number', 'email')).toBe(false);
        expect(isScalarKind('email')).toBe(true);
    });
});
