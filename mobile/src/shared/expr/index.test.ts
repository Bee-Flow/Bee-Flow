/**
 * The golden corpus, run through the phone's copy of the engine.
 *
 * agent-hub/src/shared/expr/corpus.mjs is the anti-drift contract both the
 * server (node --test) and the web (vitest) assert against. Loading it here —
 * rather than copying its cases — means a case the web adds is a case the
 * phone is held to on the next run. Each case is also run through the web's
 * own engine, so a green here is "same answer as the browser", not just
 * "same answer as the file says".
 */

import {
    EXPR_FUNCTION_NAMES,
    EXPR_FUNCTIONS,
    ExprError,
    checkExpr,
    compile,
    evaluate,
    parseExpr,
    tryEvaluate,
} from './index';

interface Corpus {
    SCOPE: Record<string, unknown>;
    CASES: { expr: string; expected: unknown }[];
    REJECT: string[];
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const corpus = require('../../../../agent-hub/src/shared/expr/corpus.mjs') as Corpus;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const web = require('../../../../agent-hub/src/shared/expr/index.mjs') as { evaluate: typeof evaluate };

describe('the golden corpus', () => {
    it('is loaded, and is not empty — an empty corpus would pass everything', () => {
        expect(corpus.CASES.length).toBeGreaterThan(100);
        expect(corpus.REJECT.length).toBeGreaterThan(5);
    });

    it.each(corpus.CASES.map((c) => [c.expr, c] as const))('%s', (_label, { expr, expected }) => {
        expect(evaluate(expr, corpus.SCOPE)).toEqual(expected);
        expect(evaluate(expr, corpus.SCOPE)).toEqual(web.evaluate(expr, corpus.SCOPE));
    });

    it.each(corpus.REJECT)('rejects %s at parse time', (expr) => {
        expect(() => parseExpr(expr)).toThrow();
    });
});

describe('the rest of the server engine suite', () => {
    it('tryEvaluate never throws and reports errors', () => {
        expect(tryEvaluate('1 + 1', corpus.SCOPE)).toEqual({ value: 2, error: null });
        const bad = tryEvaluate('unknownFn(1)', corpus.SCOPE);
        expect(bad.value).toBeUndefined();
        expect(bad.error).toBeTruthy();
    });

    it('compile reports referenced roots without executing', () => {
        const { refs } = compile('actions.search.result.count + form.amount * vars.rate');
        expect([...refs].sort()).toEqual(['actions', 'form', 'vars']);
    });

    it('ExprError carries a character index for the inspector', () => {
        let caught: unknown = null;
        try {
            parseExpr('1 + ');
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(ExprError);
        expect(typeof (caught as ExprError).index).toBe('number');
    });

    it('string members resolve as they do in a ref binding, and the prototype stays shut', () => {
        const state = { steps: { s1: { output: { body: 'hello world' } } } };
        expect(evaluate('steps.s1.output.body.length', state)).toBe(11);
        expect(evaluate('steps.s1.output.body.length > 5', state)).toBe(true);
        expect(evaluate('steps.s1.output.body[0]', state)).toBe('h');
        expect(evaluate('steps.s1.output.body.toUpperCase', state)).toBeUndefined();
        expect(evaluate('steps.s1.output.body["constructor"]', state)).toBeUndefined();
    });

    it('documents every function it will call', () => {
        const documented = EXPR_FUNCTIONS.map((f) => f.name).sort();
        expect(documented).toEqual([...EXPR_FUNCTION_NAMES].sort());
    });
});

describe('checkExpr', () => {
    it('names the roots of a good expression', () => {
        expect(checkExpr('steps.a.output.total > 10 && trigger.output.ok')).toEqual({
            ok: true,
            refs: ['steps', 'trigger'],
        });
    });

    it('says where a bad one breaks, without throwing', () => {
        const res = checkExpr('(1 + 2');
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.message).toMatch(/./);
            expect(typeof res.index).toBe('number');
        }
    });

    it('refuses a call outside the whitelist', () => {
        expect(checkExpr('fetch("http://evil")').ok).toBe(false);
    });

    it('reports a non-string as an error rather than throwing', () => {
        const res = checkExpr(42 as unknown as string);
        expect(res.ok).toBe(false);
    });

    it('reports a parser overflow (not an ExprError) without an index', () => {
        const deep = `${'('.repeat(50_000)}1${')'.repeat(50_000)}`;
        expect(checkExpr(deep)).toEqual({ ok: false, message: expect.any(String), index: null });
    });
});
