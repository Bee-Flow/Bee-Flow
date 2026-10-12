/**
 * A formula's chips end where the expression ENGINE's path ends: digits and
 * accents after a dot belong to the path (`items.0.price`, `naam.prénom`), a
 * `-` stays a minus. The web's refTokens.engineNames.test.ts, on the phone.
 */

import { evaluate } from '@/shared/expr';

import { usedPathsIn } from './boundPaths';
import { parseRefTokens, scanExprPaths } from './refTokens';
import { chipsIn } from '../components/fields/bindingText';

const ROOT = {
    steps: {
        a: { output: { items: [{ price: 5, qty: 3 }], total: 10, content: 4, naam: { 'prénom': 'Jo' } } },
        b: { output: { tax: 2 } },
    },
    loop: { row: { cells: ['a', 'b'] } },
};
const pills = (s: string) => parseRefTokens(s, { mode: 'expression' }).flatMap((t) => (t.type === 'ref' ? [t.raw] : []));

describe('formula chips follow the engine', () => {
    it('digit and accented segments stay inside the chip, a minus stays a minus', () => {
        expect(pills('steps.a.output.items.0.price * steps.a.output.items.0.qty')).toEqual(['steps.a.output.items.0.price', 'steps.a.output.items.0.qty']);
        expect(pills('steps.a.output.naam.prénom + "x"')).toEqual(['steps.a.output.naam.prénom']);
        expect(pills('steps.a.output.total-steps.b.output.tax')).toEqual(['steps.a.output.total', 'steps.b.output.tax']);
        expect(chipsIn('loop.row.cells.1 + 1', true).map((c) => c.path)).toEqual(['loop.row.cells.1']);
    });

    it('"in use" names the field, not the whole list', () => {
        expect([...usedPathsIn({ inputs: { x: { kind: 'expr', value: 'steps.a.output.items.0.price * 2' } } })]).toEqual(['steps.a.output.items[0].price']);
    });

    it.each([
        'steps.a.output.items.0.price * steps.a.output.items.0.qty',
        'steps.a.output.content-steps.b.output.tax',
        'steps.a.output.naam.prénom + "!"',
        'steps.a.output.total / 2 > loop.row.cells.1 ? "big" : "small"',
    ])('every scanned path, replaced by its value, leaves %s unchanged', (f) => {
        const replaced = scanExprPaths(f, ['steps', 'loop'])
            .map((p) => ('path' in p ? `(${JSON.stringify(evaluate(p.path, ROOT))})` : p.text))
            .join('');
        expect(evaluate(replaced, ROOT)).toEqual(evaluate(f, ROOT));
    });
});
