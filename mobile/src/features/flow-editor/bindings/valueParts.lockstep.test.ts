/**
 * DIFFERENTIAL lockstep: agent-hub `Builder/mapping/valueParts.js` and
 * `refTokens.js` beside their ports. When this fails the web side changed —
 * update the port, don't loosen the test.
 */

import * as rt from './refTokens';
import { BUILDER, requireWeb, webValue } from './testing/web';
import * as vp from './valueParts';
import * as vt from './valueTransforms';

const webVp = requireWeb(`${BUILDER}/mapping/valueParts.js`);
const webRt = requireWeb(`${BUILDER}/mapping/refTokens.js`);

const BINDINGS: unknown[] = [
    null, undefined, '', 'plain', 12, false,
    { kind: 'literal', value: '' }, { kind: 'literal', value: 'Hello' }, { kind: 'literal', value: 3 },
    { kind: 'literal', value: { a: 1 } }, { kind: 'literal', value: null },
    { kind: 'ref', path: 'steps.a.output.total' }, { kind: 'ref', path: '' }, { kind: 'ref', path: 'secrets.key' },
    { kind: 'ref', path: 'item.name' }, { kind: 'ref', path: '_index' }, { kind: 'ref', path: 'vars.x' },
    { kind: 'template', value: 'Order {{item.id}} for {{trigger.output.name}}!' }, { kind: 'template', value: '' },
    { kind: 'template', value: '{{lower(item.x)}}' }, { kind: 'template', value: 'just text' },
    { kind: 'expr', value: '' }, { kind: 'expr', value: 'steps.a.output.x' }, { kind: 'expr', value: 'lower(item.name)' },
    { kind: 'expr', value: 'join(steps.a.output.list, "\\n")' }, { kind: 'expr', value: "join(item.tags, ', ')" },
    { kind: 'expr', value: 'formatNumber(item.total, "percent")' }, { kind: 'expr', value: 'formatDate(item.d, "D MMMM YYYY")' },
    { kind: 'expr', value: 'yesNoText(item.ok, "ja", "nee")' }, { kind: 'expr', value: 'yesNoText(item.ok, "a\\"b", \'c\')' },
    { kind: 'expr', value: 'parseJson(item.body)' }, { kind: 'expr', value: 'parseJson(item.body, "a.b")' },
    { kind: 'expr', value: 'parseJson(secrets.x)' }, { kind: 'expr', value: 'unknownFn(item.x)' },
    { kind: 'expr', value: 'item.x + 1' }, { kind: 'expr', value: 'count(item.list)' }, { kind: 'expr', value: 'join(x.y, "a")' },
    { kind: 'weird' },
    // Engine string escapes the old copied decoder did not know.
    { kind: 'expr', value: 'join(item.tags, "\\u2022 ")' }, { kind: 'expr', value: 'join(item.tags, "\\r\\n")' },
    { kind: 'expr', value: "yesNoText(item.ok, '\\u2713', \"\\f\\b\")" }, { kind: 'expr', value: 'parseJson(item.body, "[\\"a\\u2022b\\"]")' },
];

describe('valueParts', () => {
    it.each(BINDINGS.map((b) => [JSON.stringify(b) ?? String(b), b]))('parseValue(%s) and back', (_l, b) => {
        const mine = vp.parseValue(b as never);
        const theirs = webVp.parseValue?.(b) as vp.ParsedValue;
        expect(mine).toStrictEqual(theirs);
        if (mine.supported) {
            expect(vp.buildValue(mine.parts, mine.transform, mine.transformArg, mine.transformArg2)).toStrictEqual(
                webVp.buildValue?.(theirs.parts, theirs.transform, theirs.transformArg, theirs.transformArg2),
            );
        }
    });

    it.each([
        [[], null], [[{ type: 'text', text: '' }], null], [[{ type: 'text', text: 'x' }], 'lower'],
        [[{ type: 'data', path: 'item.a' }], null], [[{ type: 'data', path: 'item.a' }], 'upper'],
        [[{ type: 'data', path: 'item.a' }], 'join'], [[{ type: 'data', path: 'item.a' }], 'formatDate'],
        [[{ type: 'data', path: 'item.a' }], 'yesNoText'], [[{ type: 'data', path: 'item.a' }], 'bogus'],
        [[{ type: 'data', path: 'foo + 1' }], null], [[{ type: 'data', path: '' }, null, 'x'], null],
        [[{ type: 'text', text: 'a ' }, { type: 'data', path: 'item.a' }], 'lower'],
        [[{ type: 'json', path: 'item.b', jsonPath: '' }], null], [[{ type: 'json', path: 'item.b', jsonPath: 'x"y' }], null],
        [[{ type: 'text', text: 'x' }, { type: 'json', path: 'item.b', jsonPath: 'k' }], null], ['nope', null],
    ])('buildValue(%j, %p)', (parts, transform) => {
        expect(vp.buildValue(parts, transform)).toStrictEqual(webVp.buildValue?.(parts, transform));
        expect(vp.buildValue(parts, transform, 'A\n"b"', 'c\t')).toStrictEqual(
            webVp.buildValue?.(parts, transform, 'A\n"b"', 'c\t'),
        );
    });

    it.each([
        'steps.a.output.total', 'steps.gone.output.x[*].from_email', 'steps.a.output', 'trigger.output.subject', 'trigger',
        'loop.item.name', 'item.from_email', 'item', '_index', 'vars.my_var', 'secrets.x', '', 'odd path',
    ])('describeDataPath(%p)', (path) => {
        const labels = new Map([['a', 'Gmail search']]);
        expect(vp.describeDataPath(path, labels)).toStrictEqual(webVp.describeDataPath?.(path, labels));
        expect(vp.describeDataPath(path)).toStrictEqual(webVp.describeDataPath?.(path));
    });

    it('a string argument reads as the engine reads it', () => {
        expect(vp.parseValue({ kind: 'expr', value: 'join(item.tags, "\\u2022 ")' }).transformArg).toBe('\u2022 ');
        expect(vp.parseValue({ kind: 'expr', value: "join(item.tags, '\\r\\n')" }).transformArg).toBe('\r\n');
    });

    it.each(['', 'a\\b', 'say "hi"', 'line\nbreak', 'cr\r\nlf', 'tab\t', null])('escapeExprString(%p)', (s) => {
        expect(vp.escapeExprString(s)).toBe(webVp.escapeExprString?.(s));
    });

    it.each(['steps.a.output', 'item', '_index', 'secrets.x', 'x.y', '', ' item.a ', 'item[0]', 'vars'])('isDataPath(%p)', (p) => {
        expect(vp.isDataPath(p)).toBe(webVp.isDataPath?.(p));
    });

    it('the transform tables match, words included', () => {
        type WebTransform = { id: string; label: string; hint: string; for: string; arg?: string; argDefault?: string; arg2Default?: string };
        const theirs = webValue<WebTransform[]>(webVp, 'VALUE_TRANSFORMS');
        expect(vt.VALUE_TRANSFORMS.map(({ labelEn, hintEn, ...rest }) => ({ ...rest, label: labelEn, hint: hintEn })))
            .toStrictEqual(theirs);
        type Labelled = { value: string; label: string };
        expect(vt.DATE_FORMATS.map(({ value, example }) => ({ value, label: example })))
            .toStrictEqual(webValue<Labelled[]>(webVp, 'DATE_FORMATS'));
        expect(vt.NUMBER_STYLES.map(({ value, labelEn }) => ({ value, label: labelEn })))
            .toStrictEqual(webValue<Labelled[]>(webVp, 'NUMBER_STYLES'));
        expect(vt.NL_DATE_LONG).toBe(webValue(webVp, 'NL_DATE_LONG'));
        for (const tr of theirs) {
            expect(vt.transformLabel(tr.id)).toBe(webVp.transformLabel?.(tr.id));
            expect(vt.transformHint(tr.id)).toBe(tr.hint);
        }
        expect(vt.transformLabel('nope')).toBe(webVp.transformLabel?.('nope'));
        expect(vt.transformHint('nope')).toBe('');
        expect(vt.numberStyleLabel('percent')).toBe('a percentage (12,5%)');
        expect(vt.numberStyleLabel('other')).toBe('other');
    });
});

describe('refTokens', () => {
    const TEXTS = [
        '', 'steps.a1.output.subject', 'contains(steps.a1.output.body, "x") && trigger.output.ok',
        'mysteps.x.output', 'vars.trigger', 'x.loop.y', 'loop.item.name + loop.row', 'trigger', 'trigger.output',
        'Hi {{steps.a.output.name}}, see {{ trigger.output.link }} and {{ lower(x) }}',
        '{{loop.item}}', '{{unknown.path}}', 'steps.a.output[*].x', 'steps.a.output.results[0].id', null, 42,
        // Digit and unicode names after a dot, as the engine reads them.
        'steps.a.output.items.0.price * steps.a.output.items.0.qty', 'loop.row.cells.1 + 1', 'steps.a.output.naam.prénom + "x"',
        'steps.a.output.total-steps.b.output.tax', 'steps.a.output.content-type * 2', 'steps.s1.output.items[i].x',
    ];

    it.each(TEXTS)('parseRefTokens(%p)', (text) => {
        for (const mode of ['expression', 'fixed']) {
            const mine = rt.parseRefTokens(text, { mode });
            expect(mine).toStrictEqual(webRt.parseRefTokens?.(text, { mode }));
            expect(rt.serializeRefTokens(mine)).toBe(webRt.serializeRefTokens?.(mine));
            expect(rt.hasRefTokens(text, mode)).toBe(webRt.hasRefTokens?.(text, mode));
        }
        expect(rt.parseRefTokens(text)).toStrictEqual(webRt.parseRefTokens?.(text));
    });

    it('classifies and names refs', () => {
        for (const p of ['steps.a.output.x', 'loop.row.y', 'trigger.output.z', 'trigger', 'nope', 5]) {
            expect(rt.classifyRef(p)).toStrictEqual(webRt.classifyRef?.(p));
        }
        const labels = new Map([['a', 'Search']]);
        const tokens = [
            { source: 'steps', stepId: 'a', fieldPath: 'x' }, { source: 'steps', stepId: 'gone', fieldPath: '' },
            { source: 'trigger', fieldPath: 'y' }, { source: 'loop', itemVar: 'row', fieldPath: '' },
            { source: 'loop', fieldPath: 'z' }, { source: 'other', path: 'p' }, null,
        ] as const;
        for (const tok of tokens) {
            expect(rt.resolveChipLabel(tok as never, labels)).toStrictEqual(webRt.resolveChipLabel?.(tok, labels));
            expect(rt.resolveChipLabel(tok as never)).toStrictEqual(webRt.resolveChipLabel?.(tok));
        }
        expect(rt.serializeRefTokens('x')).toBe(webRt.serializeRefTokens?.('x'));
    });
});
