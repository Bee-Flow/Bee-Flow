'use strict';
/**
 * utils/zod.js: zod 4 answering in the words zod 3 used.
 *
 * Every expected value below was captured from zod 3.25 (`zod/v3`) running the
 * same schema on the same input, so this file is the proof that moving the
 * server to zod 4 did not change a refusal that reaches a client: the message
 * of every issue and the path it is reported at. Where zod 4 itself differs and
 * we cannot hide it, the last section says so in an assertion.
 *
 * Run: cd server && node --test utils/zod.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { z, typeError, onUnknownKeys, datetimeWithOffset } = require('./zod');

const CASES = [
    ['string, missing', (z) => z.string(), undefined,
        [['', 'Required']]],
    ['string, number', (z) => z.string(), 5,
        [['', 'Expected string, received number']]],
    ['string, null', (z) => z.string(), null,
        [['', 'Expected string, received null']]],
    ['string, array', (z) => z.string(), [],
        [['', 'Expected string, received array']]],
    ['string, nan', (z) => z.number(), NaN,
        [['', 'Expected number, received nan']]],
    ['number, string', (z) => z.number(), '5',
        [['', 'Expected number, received string']]],
    ['boolean, string', (z) => z.boolean(), 'true',
        [['', 'Expected boolean, received string']]],
    ['array, object', (z) => z.array(z.string()), {},
        [['', 'Expected array, received object']]],
    ['object, string', (z) => z.object({ a: z.string() }), 'x',
        [['', 'Expected object, received string']]],
    ['object, null', (z) => z.object({ a: z.string() }), null,
        [['', 'Expected object, received null']]],
    ['object, array', (z) => z.object({ a: z.string() }), [],
        [['', 'Expected object, received array']]],
    ['object field missing', (z) => z.object({ a: z.string() }), {},
        [['a', 'Required']]],
    ['record, array', (z) => z.record(z.string(), z.number()), [],
        [['', 'Expected object, received array']]],
    ['record value', (z) => z.record(z.string(), z.number()), {'a':'x'},
        [['a', 'Expected number, received string']]],
    ['min string', (z) => z.string().min(2), 'a',
        [['', 'String must contain at least 2 character(s)']]],
    ['max string', (z) => z.string().max(2), 'abc',
        [['', 'String must contain at most 2 character(s)']]],
    ['length string', (z) => z.string().length(3), 'ab',
        [['', 'String must contain exactly 3 character(s)']]],
    ['min array', (z) => z.array(z.string()).min(2), ['a'],
        [['', 'Array must contain at least 2 element(s)']]],
    ['max array', (z) => z.array(z.string()).max(1), ['a','b'],
        [['', 'Array must contain at most 1 element(s)']]],
    ['length array', (z) => z.array(z.string()).length(2), ['a'],
        [['', 'Array must contain exactly 2 element(s)']]],
    ['nonempty array', (z) => z.array(z.string()).nonempty(), [],
        [['', 'Array must contain at least 1 element(s)']]],
    ['int', (z) => z.number().int(), 1.5,
        [['', 'Expected integer, received float']]],
    ['gte', (z) => z.number().min(3), 1,
        [['', 'Number must be greater than or equal to 3']]],
    ['lte', (z) => z.number().max(3), 5,
        [['', 'Number must be less than or equal to 3']]],
    ['gt', (z) => z.number().gt(3), 3,
        [['', 'Number must be greater than 3']]],
    ['lt', (z) => z.number().lt(3), 3,
        [['', 'Number must be less than 3']]],
    ['positive', (z) => z.number().positive(), 0,
        [['', 'Number must be greater than 0']]],
    ['nonnegative', (z) => z.number().nonnegative(), -1,
        [['', 'Number must be greater than or equal to 0']]],
    ['multipleOf', (z) => z.number().multipleOf(3), 4,
        [['', 'Number must be a multiple of 3']]],
    ['coerce number', (z) => z.coerce.number(), 'abc',
        [['', 'Expected number, received nan']]],
    ['coerce int', (z) => z.coerce.number().int().min(1).max(100), '0',
        [['', 'Number must be greater than or equal to 1']]],
    ['enum, value', (z) => z.enum(['a', 'b']), 'c',
        [['', "Invalid enum value. Expected 'a' | 'b', received 'c'"]]],
    ['enum, missing', (z) => z.enum(['a', 'b']), undefined,
        [['', 'Required']]],
    ['enum, number', (z) => z.enum(['a', 'b']), 5,
        [['', "Expected 'a' | 'b', received number"]]],
    ['literal', (z) => z.literal('a'), 'b',
        [['', 'Invalid literal value, expected "a"']]],
    ['literal number', (z) => z.literal(5), 6,
        [['', 'Invalid literal value, expected 5']]],
    ['union', (z) => z.union([z.string(), z.number()]), true,
        [['', 'Invalid input']]],
    ['union, missing', (z) => z.union([z.string(), z.number()]), undefined,
        [['', 'Invalid input']]],
    ['discriminated union, unknown tag', (z) => z.discriminatedUnion('t', [z.object({ t: z.literal('a') }), z.object({ t: z.literal('b') })]), {'t':'c'},
        [['t', "Invalid discriminator value. Expected 'a' | 'b'"]]],
    ['discriminated union, no tag', (z) => z.discriminatedUnion('t', [z.object({ t: z.literal('a') }), z.object({ t: z.literal('b') })]), {},
        [['t', "Invalid discriminator value. Expected 'a' | 'b'"]]],
    ['discriminated union, string', (z) => z.discriminatedUnion('t', [z.object({ t: z.literal('a') }), z.object({ t: z.literal('b') })]), 'x',
        [['', 'Expected object, received string']]],
    ['strict, one unknown key', (z) => z.object({ a: z.string() }).strict(), {'a':'x','b':1},
        [['', "Unrecognized key(s) in object: 'b'"]]],
    ['strict, two unknown keys', (z) => z.object({ a: z.string() }).strict(), {'a':'x','b':1,'c':2},
        [['', "Unrecognized key(s) in object: 'b', 'c'"]]],
    ['strict, misspelt required key', (z) => z.object({ message: z.string() }).strict(), {'mesage':'x'},
        [['message', 'Required'], ['', "Unrecognized key(s) in object: 'mesage'"]]],
    ['email', (z) => z.string().email(), 'nope',
        [['', 'Invalid email']]],
    ['url', (z) => z.string().url(), 'nope',
        [['', 'Invalid url']]],
    ['regex', (z) => z.string().regex(/^a+$/), 'b',
        [['', 'Invalid']]],
    ['date', (z) => z.string().date(), '2024-02-30',
        [['', 'Invalid date']]],
    ['includes', (z) => z.string().includes('a'), 'b',
        [['', 'Invalid input: must include "a"']]],
    ['startsWith', (z) => z.string().startsWith('a'), 'b',
        [['', 'Invalid input: must start with "a"']]],
    ['endsWith', (z) => z.string().endsWith('a'), 'b',
        [['', 'Invalid input: must end with "a"']]],
    ['refine, no message', (z) => z.string().refine((s) => s.length > 3), 'ab',
        [['', 'Invalid input']]],
    ['superRefine, no message', (z) => z.string().superRefine((s, ctx) => { ctx.addIssue({ code: 'custom' }); }), 'ab',
        [['', 'Invalid input']]],
    ['pipe into enum', (z) => z.string().trim().toLowerCase().pipe(z.enum(['a', 'b'])), ' C ',
        [['', "Invalid enum value. Expected 'a' | 'b', received 'c'"]]],
    ['nested path', (z) => z.object({ a: z.object({ b: z.array(z.string().min(2)) }) }), {'a':{'b':['x']}},
        [['a.b.0', 'String must contain at least 2 character(s)']]],
    ['record key refine', (z) => z.record(z.string().refine((k) => k.startsWith('x'), { message: 'bad key' }), z.number()), {'a':1},
        [['a', 'bad key']]],
    ['own message on min', (z) => z.string().min(2, 'MIN'), 'a',
        [['', 'MIN']]],

];

for (const [label, build, input, expected] of CASES) {
    test(`zod 3 wording: ${label}`, () => {
        const result = build(z).safeParse(input);
        if (expected === null) {
            assert.strictEqual(result.success, true);
            return;
        }
        assert.strictEqual(result.success, false);
        assert.deepStrictEqual(result.error.issues.map((i) => [i.path.join('.'), i.message]), expected);
    });
}

test('typeError words a missing value and a wrong type apart, and leaves other issues alone', () => {
    const schema = z.object({ a: z.string({ error: typeError({ required: 'MISSING', invalid: 'WRONG' }) }).min(2) }).strict();
    const messages = (input) => schema.safeParse(input).error.issues.map((i) => i.message);
    assert.deepStrictEqual(messages({}), ['MISSING']);
    assert.deepStrictEqual(messages({ a: 5 }), ['WRONG']);
    assert.deepStrictEqual(messages({ a: 'x' }), ['String must contain at least 2 character(s)']);
    assert.deepStrictEqual(messages({ a: 'xy', b: 1 }), ["Unrecognized key(s) in object: 'b'"]);
    // Either wording may be left out: zod 3's own text speaks then.
    const onlyInvalid = z.string({ error: typeError({ invalid: 'WRONG' }) });
    assert.strictEqual(onlyInvalid.safeParse(undefined).error.issues[0].message, 'Required');
    assert.strictEqual(onlyInvalid.safeParse(5).error.issues[0].message, 'WRONG');
});

test('typeError on an object does not swallow the unknown-key refusal', () => {
    const schema = z.object({ a: z.string() }, { error: typeError({ invalid: 'AN OBJECT' }) }).strict();
    assert.strictEqual(schema.safeParse('x').error.issues[0].message, 'AN OBJECT');
    assert.strictEqual(schema.safeParse({ a: 'x', b: 1 }).error.issues[0].message, "Unrecognized key(s) in object: 'b'");
});

test('onUnknownKeys replaces .strict(message), which zod 4 no longer takes', () => {
    const schema = z.object({ a: z.string() }, { error: onUnknownKeys('NO SUCH KEY', typeError({ invalid: 'AN OBJECT' })) }).strict();
    assert.strictEqual(schema.safeParse({ a: 'x', b: 1 }).error.issues[0].message, 'NO SUCH KEY');
    assert.strictEqual(schema.safeParse(7).error.issues[0].message, 'AN OBJECT');
    assert.strictEqual(schema.safeParse({}).error.issues[0].message, 'Required');
    // With nothing to fall back on, the zod 3 text speaks.
    const bare = z.object({}, { error: onUnknownKeys('NO SUCH KEY') }).strict();
    assert.strictEqual(bare.safeParse(7).error.issues[0].message, 'Expected object, received number');
});

test('an error function on an enum covers a missing value and a wrong one, as errorMap did', () => {
    const schema = z.enum(['a', 'b'], { error: () => 'CHOOSE' });
    for (const input of [undefined, 5, 'c']) assert.strictEqual(schema.safeParse(input).error.issues[0].message, 'CHOOSE');
});

test('datetimeWithOffset accepts what zod 3 datetime({ offset: true }) accepted', () => {
    const accepted = ['2024-01-02T03:04:05Z', '2024-01-02T03:04:05.123Z', '2024-01-02T03:04:05+02:00', '2024-01-02T03:04:05+0200',
        '2024-01-02T03:04Z', '2024-02-29T03:04+05:30', '2024-01-02T03:04:05+99:99'];
    const refused = ['2024-01-02T03:04:05', '2024-01-02T03:04:05+02', '2024-02-30T03:04:05Z', '2023-02-29T03:04Z',
        '2024-01-02T24:00:00Z', '2024-01-02T03:04:05.Z', '2024-01-02T03:04:05z', ' 2024-01-02T03:04:05Z', '2024-01-02T03:04:05Z\n', ''];
    for (const s of accepted) assert.strictEqual(datetimeWithOffset.test(s), true, s);
    for (const s of refused) assert.strictEqual(datetimeWithOffset.test(s), false, JSON.stringify(s));
});

test('guid() takes every uuid-shaped id zod 3 uuid() took, and words it "uuid"', () => {
    const schema = z.string().guid();
    for (const id of ['123e4567-e89b-12d3-a456-426614174000', '00000000-0000-0000-0000-000000000000',
        '11111111-1111-1111-1111-111111111111', 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', 'ffffffff-ffff-ffff-ffff-ffffffffffff']) {
        assert.strictEqual(schema.safeParse(id).success, true, id);
    }
    for (const id of ['', '123e4567e89b12d3a456426614174000', '123e4567-e89b-12d3-a456-42661417400', 'g23e4567-e89b-12d3-a456-426614174000',
        '123e4567-e89b-12d3-a456-426614174000\n', '{123e4567-e89b-12d3-a456-426614174000}']) {
        assert.strictEqual(schema.safeParse(id).success, false, JSON.stringify(id));
    }
    assert.strictEqual(schema.safeParse('nope').error.issues[0].message, 'Invalid uuid');
});

test('z.unknown() as an object field is optional once .optional() says so (zod 4 requires the key otherwise)', () => {
    assert.strictEqual(z.object({ a: z.unknown().optional() }).safeParse({}).success, true);
    assert.deepStrictEqual(z.object({ a: z.unknown().optional() }).safeParse({}).data, {});
    assert.strictEqual(z.object({ a: z.unknown() }).safeParse({}).success, false,
        'if this passes, zod 4 reads a bare unknown as optional again and the .optional() calls are redundant');
});

test('.default() no longer runs the default through the schema; .prefault() does, as zod 3 default() did', () => {
    const schema = z.string().regex(/^\d+$/).transform(Number);
    assert.strictEqual(z.object({ n: schema.prefault('7') }).parse({}).n, 7);
    assert.strictEqual(z.object({ n: schema.default('7') }).parse({}).n, '7',
        'if this is 7, .default() runs through the schema again and .prefault() is redundant');
});

test('string length counts UTF-16 units, as zod 3 did (zod 4.5 started counting code points)', () => {
    const emoji = '\u{1F600}'; // one code point, two UTF-16 units
    assert.strictEqual(z.string().min(2).safeParse(emoji).success, true);
    assert.strictEqual(z.string().max(1).safeParse(emoji).success, false);
    assert.strictEqual(z.array(z.string()).length(2).safeParse(['a', 'b']).success, true);
});

test('known difference: a wrong-type value also meets the length checks zod 4 runs on anything with a length', () => {
    // zod 3 stopped at the type error. The first issue, the one a client reads, is the same.
    const issues = z.string().min(2, 'MIN').safeParse(['a']).error.issues.map((i) => i.message);
    assert.strictEqual(issues[0], 'Expected string, received array');
});

test('known difference: an array that is too short AND has a bad element lists the element first', () => {
    // zod 3 listed the array's size issue first.
    const issues = z.array(z.string()).min(2).safeParse([1]).error.issues.map((i) => i.message);
    assert.deepStrictEqual(issues.sort(), ['Array must contain at least 2 element(s)', 'Expected string, received number']);
});
