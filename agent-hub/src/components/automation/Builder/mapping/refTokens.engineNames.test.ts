// @vitest-environment node
/**
 * A formula's pills end exactly where the expression ENGINE's path ends.
 * After a member dot the engine reads any name, digits and accents included
 * (`items.0.price`, the shape older AI-built paths have; `naam.prénom`), so
 * a pill that stopped at `items` left `.0.price` as loose text, re-picking
 * through it kept that stale half, and "in use" marked the whole list.
 * A `-` stays a minus, as the engine reads it.
 */
import { describe, expect, it } from 'vitest';
import { evaluate } from '@shared/expr/engine.mjs';
import { usedPathsIn } from './boundPaths';
import { parseRefTokens, scanExprPaths, serializeRefTokens } from './refTokens';

type Tok = { type: string; raw?: string; fieldPath?: string };
const toks = (s: string) => parseRefTokens(s, { mode: 'expression' }) as Tok[];
const pills = (s: string) => toks(s).filter(t => t.type === 'ref');

const ROOT = {
    steps: {
        a: { output: { items: [{ price: 5, qty: 3 }], total: 10, content: 4, naam: { 'prénom': 'Jo', 'prénom': 'Ann' }, 'x-y': 1 } },
        b: { output: { tax: 2 } },
    },
    loop: { row: { cells: ['a', 'b'] } },
};

describe('formula pills follow the engine', () => {
    it('a digit segment stays inside the pill', () => {
        const f = 'steps.a.output.items.0.price * steps.a.output.items.0.qty';
        expect(pills(f).map(p => [p.raw, p.fieldPath])).toEqual([
            ['steps.a.output.items.0.price', 'items[0].price'],
            ['steps.a.output.items.0.qty', 'items[0].qty'],
        ]);
        expect(pills('steps.a.output.items.0.price * 2').map(p => p.raw)).toEqual(['steps.a.output.items.0.price']);
        expect(pills('loop.row.cells.1 + 1').map(p => p.raw)).toEqual(['loop.row.cells.1']);
        expect(serializeRefTokens(toks(f))).toBe(f);
    });

    it('accented names, composed or decomposed, are one pill', () => {
        expect(pills('steps.a.output.naam.prénom + "x"').map(p => p.raw)).toEqual(['steps.a.output.naam.prénom']);
        expect(pills('steps.a.output.naam.prénom + "x"').map(p => p.raw)).toEqual(['steps.a.output.naam.prénom']);
    });

    it('a minus is still a minus', () => {
        expect(pills('steps.a.output.total-steps.b.output.tax').map(p => p.raw)).toEqual(['steps.a.output.total', 'steps.b.output.tax']);
        expect(pills('steps.a.output.content-type * 2').map(p => p.raw)).toEqual(['steps.a.output.content']);
        // A whole stored ref with a dashed key is still one pill (the arithmetic rule).
        expect(pills('steps.a.output.x-y').map(p => p.raw)).toEqual(['steps.a.output.x-y']);
    });

    it('"in use" names the field, not the whole list', () => {
        expect([...usedPathsIn({ inputs: { x: { kind: 'expr', value: 'steps.a.output.items.0.price * 2' } } })])
            .toEqual(['steps.a.output.items[0].price']);
    });

    // Every path the scanner finds, replaced by the value it holds, leaves the
    // formula's result unchanged: a path cut short leaves its tail behind a
    // literal (an error), one read too long changes the value.
    it.each([
        'steps.a.output.items.0.price * steps.a.output.items.0.qty',
        'steps.a.output.items[0].price + 1',
        'steps.a.output.total-steps.b.output.tax',
        'steps.a.output.content-steps.b.output.tax',
        'steps.a.output.naam.prénom + "!"',
        'steps.a.output.naam.prénom + "!"',
        'steps.a.output["x-y"] + loop.row.cells.1',
        'steps.a.output.total / 2 > steps.b.output.tax ? "big" : "small"',
    ])('the scanner agrees with the engine on %s', (f) => {
        const replaced = scanExprPaths(f, ['steps', 'loop'])
            .map(p => ('path' in p ? `(${JSON.stringify(evaluate(String(p.path), ROOT))})` : (p as { text: string }).text))
            .join('');
        expect(evaluate(replaced, ROOT)).toEqual(evaluate(f, ROOT));
    });
});
