/**
 * The degradation contract: whatever the server sends, the reader answers the
 * spec'd shape — unknown fields ignored, missing fields defaulted to
 * something a screen can render, and a payload that is not even an object
 * yielding the all-defaults object rather than a throw.
 *
 * These helpers stand between client.ts's unchecked `as T` cast and the
 * screens; serverContract.test.ts pins the other side of the same line.
 */

import fs from 'node:fs';
import path from 'node:path';

import { asCount, field, MIN_SERVER_BUILD, nullable, pick, shapeListOf, shapeOf } from './contract';

describe('the optional and nullable readers', () => {
    it('keep a present value and answer undefined or null for anything else', () => {
        expect(field.optStr('x')).toBe('x');
        expect(field.optStr(1)).toBeUndefined();
        expect(field.optBool(false)).toBe(false);
        expect(field.optBool('false')).toBeUndefined();
        expect(field.optNum('3')).toBe(3);
        expect(field.optNum(null)).toBeUndefined();
        expect(field.numOrNull(2.5)).toBe(2.5);
        expect(field.numOrNull('soon')).toBeNull();
    });

    it('accept only the stated literals', () => {
        const roles = ['owner', 'editor', 'viewer'] as const;
        expect(field.oneOf(roles, 'viewer')('owner')).toBe('owner');
        expect(field.oneOf(roles, 'viewer')('admin')).toBe('viewer');
        expect(field.oneOfOrNull(roles)('editor')).toBe('editor');
        expect(field.oneOfOrNull(roles)(1)).toBeNull();
        expect(field.optOneOf(roles)('viewer')).toBe('viewer');
        expect(field.optOneOf(roles)(undefined)).toBeUndefined();
    });

    it('read string arrays in all three forms', () => {
        expect(field.strArray(['a', 1, 'b'])).toEqual(['a', 'b']);
        expect(field.strArray('a')).toEqual([]);
        expect(field.optStrArray(['a'])).toEqual(['a']);
        expect(field.optStrArray(null)).toBeUndefined();
    });

    it('read lists of shaped rows in all three forms', () => {
        const row = shapeOf({ id: field.str('') });
        expect(field.list(row)([{ id: 'a' }, 'junk'])).toEqual([{ id: 'a' }, { id: '' }]);
        expect(field.list(row)('nope')).toEqual([]);
        expect(field.listOrNull(row)(null)).toBeNull();
        expect(field.optList(row)(undefined)).toBeUndefined();
        expect(field.arrayOrNull([1, 'x'])).toEqual([1, 'x']);
        expect(field.arrayOrNull({})).toBeNull();
    });

    it('take an object on trust but never anything else', () => {
        const config = { flag: true };
        expect(field.record({})(config)).toBe(config);
        expect(field.record({ d: 1 })([1])).toEqual({ d: 1 });
        expect(field.record({ d: 1 })('x')).toEqual({ d: 1 });
        expect(field.recordOrNull(config)).toBe(config);
        expect(field.recordOrNull(null)).toBeNull();
        expect(field.optRecord(config)).toBe(config);
        expect(field.optRecord(3)).toBeUndefined();
        expect(field.raw([1, { a: 2 }])).toEqual([1, { a: 2 }]);
    });
});

describe('pick and nullable', () => {
    it('pick reads one property of an object and nothing of anything else', () => {
        expect(pick({ runs: [1] }, 'runs')).toEqual([1]);
        expect(pick([1], 'runs')).toBeUndefined();
        expect(pick(null, 'runs')).toBeUndefined();
        expect(pick('runs', 'runs')).toBeUndefined();
    });

    it('nullable applies the reader to an object and answers null otherwise', () => {
        const read = nullable(shapeOf({ id: field.str('') }));
        expect(read({ id: 'a' })).toEqual({ id: 'a' });
        expect(read({})).toEqual({ id: '' });
        expect(read(null)).toBeNull();
        expect(read('<html>')).toBeNull();
        expect(read([{ id: 'a' }])).toBeNull();
    });
});

describe('field readers', () => {
    it('answer the value when the type is right', () => {
        expect(field.str('x')('hello')).toBe('hello');
        expect(field.strOrNull('hello')).toBe('hello');
        expect(field.bool(true)(false)).toBe(false);
        expect(field.num(0)(42)).toBe(42);
        expect(field.strArrayOrNull(['mon', 'tue'])).toEqual(['mon', 'tue']);
    });

    it('answer the default for anything else', () => {
        expect(field.str('Untitled cowork')(undefined)).toBe('Untitled cowork');
        expect(field.str('x')(42)).toBe('x');
        expect(field.strOrNull(42)).toBeNull();
        expect(field.bool(false)('true')).toBe(false);
        expect(field.num(0)(Number.NaN)).toBe(0);
        expect(field.strArrayOrNull('mon')).toBeNull();
    });

    it('keep only the strings in a mixed array', () => {
        expect(field.strArrayOrNull(['mon', 3, null, 'tue'])).toEqual(['mon', 'tue']);
    });

    it('accept a numeric string as a number — COUNT() arrives that way', () => {
        expect(field.num(0)('7')).toBe(7);
        expect(asCount('12')).toBe(12);
        expect(asCount('')).toBeNull();
        expect(asCount('soon')).toBeNull();
        expect(asCount(Infinity)).toBeNull();
    });
});

describe('shapeOf', () => {
    const read = shapeOf({
        id: field.str(''),
        title: field.str('Notification'),
        link: field.strOrNull,
        read: field.bool(false),
    });

    it('is an allow-list: unknown fields do not come through', () => {
        const out = read({ id: 'n1', title: 'Hi', link: null, read: true, secret_new_col: 'x' });
        expect(out).toEqual({ id: 'n1', title: 'Hi', link: null, read: true });
    });

    it('defaults a missing or renamed field instead of leaking undefined', () => {
        // The exact failure this exists for: a server rename arrives as an
        // absent key, and the screen must render a stated placeholder.
        expect(read({ id: 'n1', heading: 'renamed away' }).title).toBe('Notification');
    });

    it('answers all-defaults for a payload that is not an object', () => {
        for (const raw of [null, undefined, 'error page', 42, true]) {
            expect(read(raw)).toEqual({ id: '', title: 'Notification', link: null, read: false });
        }
    });
});

describe('shapeListOf', () => {
    const readRows = shapeListOf({ id: field.str(''), title: field.str('?') });

    it('answers [] for anything that is not an array', () => {
        expect(readRows(undefined)).toEqual([]);
        expect(readRows({ notifications: [] })).toEqual([]);
        expect(readRows('nope')).toEqual([]);
    });

    it('drops non-object rows and shapes the rest', () => {
        expect(readRows([{ id: 'a', title: 'A' }, null, 'junk', { id: 'b' }])).toEqual([
            { id: 'a', title: 'A' },
            { id: 'b', title: '?' },
        ]);
    });
});

describe('MIN_SERVER_BUILD', () => {
    it('is a date, so a human can compare it with a server build stamp', () => {
        expect(MIN_SERVER_BUILD).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('matches the literal app.config.ts stamps into the build', () => {
        // app.config.ts cannot import this module (expo's config loader
        // transpiles only that one file), so it carries a literal copy — and
        // a copy nothing checks drifts. This is the check.
        const config = fs.readFileSync(path.resolve(__dirname, '../../../app.config.ts'), 'utf8');
        expect(config).toContain(`const minServerBuild = '${MIN_SERVER_BUILD}';`);
    });
});
