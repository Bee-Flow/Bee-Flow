// @vitest-environment node
/**
 * A string argument of a transform (join's separator, yesNoText's words,
 * parseJson's path) means what the expression ENGINE reads in it: `•`
 * is a bullet, `\r\n` a Windows line break. The visual editor decoded only
 * `\n` and `\t`, so opening `join(p, "• ")` showed "u2022 " and any
 * edit wrote that back, changing what the run produced.
 */
import { describe, expect, it } from 'vitest';
import { evaluate } from '@shared/expr/engine.mjs';
import * as vp from './valueParts';

type Fn = (...args: unknown[]) => unknown;
const parseValue = vp.parseValue as unknown as Fn;
const buildValue = vp.buildValue as unknown as Fn;

type Parsed = { supported: boolean; parts: unknown[]; transform: string | null; transformArg: string | null; transformArg2: string | null };
const ROOT = { steps: { a: { output: { tags: ['x', 'y'], ok: true, raw: '["a•b", 7]' } } } };

const rebuilt = (src: string) => {
    const p = parseValue({ kind: 'expr', value: src }) as Parsed;
    expect(p.supported).toBe(true);
    return { parsed: p, value: (buildValue(p.parts, p.transform, p.transformArg, p.transformArg2) as { value: string }).value };
};

describe('engine string escapes in transform arguments', () => {
    it.each([
        ['join(steps.a.output.tags, "\\u2022 ")', '• '],
        ['join(steps.a.output.tags, "\\r\\n")', '\r\n'],
        ['join(steps.a.output.tags, " \\f \\b ")', ' \f \b '],
        ["join(steps.a.output.tags, '\\u00A0|\\u00a0')", ' | '],
        ['join(steps.a.output.tags, "\\q\\/")', 'q/'],
    ])('%s shows the separator the run uses and survives an edit', (src, separator) => {
        const { parsed, value } = rebuilt(src);
        expect(parsed.transformArg).toBe(separator);
        expect(evaluate(value, ROOT)).toBe(evaluate(src, ROOT));
    });

    it("yesNoText's two words", () => {
        const src = 'yesNoText(steps.a.output.ok, "\\u2713", "\\u2717")';
        const { parsed, value } = rebuilt(src);
        expect([parsed.transformArg, parsed.transformArg2]).toEqual(['✓', '✗']);
        expect(evaluate(value, ROOT)).toBe('✓');
    });

    it("parseJson's path in the JSON", () => {
        const src = 'parseJson(steps.a.output.raw, "[1]")';
        expect(evaluate(rebuilt(src).value, ROOT)).toBe(7);
        const keyed = 'parseJson(steps.a.output.raw, "[\\"a\\u2022b\\"]")';
        const { parsed } = rebuilt(keyed);
        expect((parsed.parts[0] as { jsonPath: string }).jsonPath).toBe('["a•b"]');
    });
});
