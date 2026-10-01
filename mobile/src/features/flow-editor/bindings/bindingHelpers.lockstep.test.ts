/**
 * DIFFERENTIAL lockstep: agent-hub `utils/bindingHelpers.js` and its port run
 * the same inputs and must agree. When this fails the web side changed —
 * update the port, don't loosen the test.
 *
 * The path walkers are not compared here any more: both sides read paths with
 * the shared mapping core, which shared/mapping/corpus.test.ts holds to the
 * server. previewValue is the phone's own (bindingHelpers.test.ts).
 */

import * as port from './bindingHelpers';
import * as cond from './conditionText';
import { requireWeb } from './testing/web';

const web = requireWeb('utils/bindingHelpers.js');

const BINDINGS: unknown[] = [
    null, undefined, 'bare', 42, true, { kind: 'literal', value: 'x' }, { kind: 'literal', value: null },
    { kind: 'literal', value: 7 }, { kind: 'literal', value: false }, { kind: 'literal', value: { a: 1 } },
    { kind: 'literal' }, { kind: 'template', value: 'Hi {{trigger.output.name}}' }, { kind: 'template' },
    { kind: 'template', value: '{{steps.a.output.x}}' }, { kind: 'template', value: 'a {{x + 1}} b' },
    { kind: 'template', value: 'no tokens' }, { kind: 'template', value: '{{a.b}} and {{c}}!' },
    { kind: 'ref', path: 'steps.a.output' }, { kind: 'ref' }, { kind: 'expr', value: 'lower(x)' }, { kind: 'expr' },
    { kind: 'mystery', value: 1 },
];

const TEXTS = [
    '', 'steps.a.output.x', '  trigger.output.y ', 'vars.k', 'secrets.api', 'loop.item.x', 'item.x', 'x + 1',
    'hello {{trigger.output.name}}', '{{ }}', 'a.b[*].c', '$var', '1abc', 'steps.a.output.results[*].x',
    'steps.x.output.rows[*]["Order date"]', "trigger.output['content-type']", 'steps.x.output["a b"] + 1', 'nope["x"]',
];

describe('mode <-> binding', () => {
    it.each(TEXTS)('bindingFromInput(%p)', (text) => {
        for (const mode of ['fixed', 'expression'] as const) {
            expect(port.bindingFromInput(text, mode)).toStrictEqual(web.bindingFromInput?.(text, mode));
        }
    });

    it('bindingFromInput on non-strings', () => {
        for (const v of [null, undefined, 5]) {
            expect(port.bindingFromInput(v, 'fixed')).toStrictEqual(web.bindingFromInput?.(v, 'fixed'));
            expect(port.bindingFromInput(v, 'expression')).toStrictEqual(web.bindingFromInput?.(v, 'expression'));
        }
    });

    it.each(BINDINGS.map((b) => [JSON.stringify(b) ?? String(b), b]))('inputFromBinding(%s)', (_label, b) => {
        expect(port.inputFromBinding(b as never)).toStrictEqual(web.inputFromBinding?.(b));
    });

    it('inputFromBinding survives a value JSON cannot encode', () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        const b = { kind: 'literal', value: cyclic };
        expect(port.inputFromBinding(b)).toStrictEqual(web.inputFromBinding?.(b));
        const odd = { kind: 'odd', big: 1n };
        expect(port.inputFromBinding(odd)).toStrictEqual(web.inputFromBinding?.(odd));
    });

    it.each(TEXTS)('detectTemplate / isCleanPath / suggestKeyFromPath / formatPathForInsert(%p)', (text) => {
        expect(port.detectTemplate(text)).toBe(web.detectTemplate?.(text));
        expect(port.isCleanPath(text)).toBe(web.isCleanPath?.(text));
        expect(port.suggestKeyFromPath(text)).toBe(web.suggestKeyFromPath?.(text));
        for (const mode of ['fixed', 'expression']) {
            expect(port.formatPathForInsert(text, mode)).toBe(web.formatPathForInsert?.(text, mode));
        }
    });

    it('the guards on non-strings agree', () => {
        for (const v of [null, 3, {}]) {
            expect(port.detectTemplate(v)).toBe(web.detectTemplate?.(v));
            expect(port.isCleanPath(v)).toBe(web.isCleanPath?.(v));
            expect(port.suggestKeyFromPath(v)).toBe(web.suggestKeyFromPath?.(v));
        }
        expect(port.suggestKeyFromPath('trigger.output')).toBe(web.suggestKeyFromPath?.('trigger.output'));
        expect(port.suggestKeyFromPath('steps.x.output')).toBe(web.suggestKeyFromPath?.('steps.x.output'));
    });
});

/** The DOM element the web helpers mutate, faked around a string. */
function fakeInput(value: string, start?: number, end?: number) {
    return {
        tagName: 'INPUT',
        value,
        selectionStart: start,
        selectionEnd: end,
        setSelectionRange() {},
        focus() {},
    };
}

describe('text editing over a selection', () => {
    it.each([
        ['abc', 1, 2, 'XY'], ['abc', undefined, undefined, '{{p}}'], ['', 0, 0, 'x'], ['hello', 5, 5, '!'],
    ] as const)('insertAtSelection(%p, %p, %p)', (value, start, end, snippet) => {
        const el = fakeInput(value, start, end);
        const webNext = web.insertAtCursor?.(el, snippet);
        const mine = port.insertAtSelection(value, { start, end }, snippet);
        expect(mine.value).toBe(webNext);
        expect(mine.caret).toBe((start ?? value.length) + snippet.length);
        expect(port.insertAtSelection(value, null, snippet).value).toBe(value + snippet);
    });

    it.each([
        ['abcdef', 1, 3, 'X'], ['abc', -5, 99, 'Z'], ['abc', 2, 1, 'Q'], ['', 0, 0, 'a'],
    ] as const)('replaceRange(%p, %p, %p)', (value, start, end, snippet) => {
        const el = fakeInput(value);
        const webNext = web.replaceRange?.(el, start, end, snippet);
        expect(port.replaceRange(value, start, end, snippet).value).toBe(webNext);
        expect(port.replaceRange(null, 0, 0, 'x')).toEqual({ value: 'x', caret: 1 });
    });

    const PREFIXES = [
        '', 'Hi {{', 'Hi {{trig', 'Hi {{ steps.a.out', 'Hi {{a}} b', '{{a{', '{{a-b', 'x steps.a.', 'steps.a.output[*].x',
        'st', 's', 'foo', 'x = trig', 'a.st', '(ite', 'vars', 'loop.', 'my_steps.a',
    ];

    it.each(PREFIXES)('getAutocompleteTokenFromPrefix(%p)', (before) => {
        for (const mode of ['fixed', 'expression']) {
            expect(port.getAutocompleteTokenFromPrefix(before, mode))
                .toStrictEqual(web.getAutocompleteTokenFromPrefix?.(before, mode));
            const roots = ['currentUser', 'form', 'bad-root', 3];
            expect(port.getAutocompleteTokenFromPrefix(before, mode, roots))
                .toStrictEqual(web.getAutocompleteTokenFromPrefix?.(before, mode, roots));
            expect(port.getAutocompleteTokenFromPrefix(before, mode, []))
                .toStrictEqual(web.getAutocompleteTokenFromPrefix?.(before, mode, []));
            expect(port.getAutocompleteTokenFromPrefix(before, mode, 'nope'))
                .toStrictEqual(web.getAutocompleteTokenFromPrefix?.(before, mode, 'nope'));
        }
    });

    it.each(PREFIXES)('getAutocompleteToken(%p + tail)', (before) => {
        const value = `${before} tail`;
        for (const mode of ['fixed', 'expression']) {
            const el = fakeInput(value, before.length);
            expect(port.getAutocompleteToken(value, before.length, mode))
                .toStrictEqual(web.getAutocompleteToken?.(el, mode));
            expect(port.getAutocompleteToken(value, undefined, mode))
                .toStrictEqual(web.getAutocompleteToken?.(fakeInput(value), mode));
        }
        expect(port.getAutocompleteTokenFromPrefix(null, 'fixed')).toBe(null);
        expect(port.getAutocompleteToken(null, 0, 'fixed')).toBe(null);
    });

    it('AUTOCOMPLETE_ROOTS and TEMPLATE_RE match', () => {
        expect(port.AUTOCOMPLETE_ROOTS).toStrictEqual(web.AUTOCOMPLETE_ROOTS);
        expect(String(port.TEMPLATE_RE)).toBe(String(web.TEMPLATE_RE));
    });
});

describe('conditions', () => {
    it.each([
        'steps.s1.output.total > 1000', 'a >= 2', 'a<=b', 'a === "x"', 'a !== null', 'a == 1', 'a != 2', 'a > ',
        '>= 3', 'x + 1 > 2', '', '   ', 'a =>= b', 'a => b', 'plain', 5,
    ])('parseSimpleCondition(%p)', (expr) => {
        expect(cond.parseSimpleCondition(expr)).toStrictEqual(web.parseSimpleCondition?.(expr));
    });

    it.each(BINDINGS.map((b) => [JSON.stringify(b) ?? String(b), b]))('renderBindingValue(%s)', (_l, b) => {
        expect(cond.renderBindingValue(b as never)).toBe(web.renderBindingValue?.(b));
        expect(cond.buildConditionExpr('a.b', '==', b as never)).toBe(web.buildConditionExpr?.('a.b', '==', b));
    });

    it('buildConditionExpr with no left side', () => {
        expect(cond.buildConditionExpr('', '==', 'x')).toBe(web.buildConditionExpr?.('', '==', 'x'));
        expect(cond.buildConditionExpr(null, '>', 1)).toBe(web.buildConditionExpr?.(null, '>', 1));
    });
});
