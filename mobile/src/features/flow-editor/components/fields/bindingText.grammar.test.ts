/**
 * The phone's value field with the paths real payloads carry: quoted keys,
 * `}` inside a key, match segments, JSON nested in JSON text — and a pick into
 * a one-value slot shaped the way the web's value builder shapes it.
 */

import { act, renderHook } from '@testing-library/react-native';

import { evaluate, getPath } from '@/shared/expr';

import { bindingToText, chipsIn, fromFormula, insertPath, textToBinding, textToParts, toFormula, unwrapRefs } from './bindingText';
import { useBindingText } from './useBindingText';

const lvl3 = '```json\n' + JSON.stringify({ verdict: { score: 0.93, 'reason code': 'R-7' } }) + '\n```';
const lvl2 = JSON.stringify({ items: [{ sku: 'A1', meta: JSON.stringify({ tags: ['x', 'y'], ai: lvl3 }) }] });
const ROOT = {
    steps: {
        http: { output: { body: JSON.stringify({ data: { payload: lvl2 } }) } },
        graph: { output: { value: [{ from: { emailAddress: { address: 'ada@x.nl' } } }, { from: { emailAddress: { address: 'bob@x.nl' } } }], rates: [0.21, 0.09] } },
    },
};
const deep = 'steps.http.output.body.data.payload.items[0].meta.ai.verdict["reason code"]';

describe('text ⇄ binding with awkward keys', () => {
    it('a key holding }} is one pill', () => {
        expect(textToParts('Hi {{ steps.s.output.odd["a}}b"] }}!')).toEqual([
            { type: 'text', text: 'Hi ' }, { type: 'data', path: 'steps.s.output.odd["a}}b"]' }, { type: 'text', text: '!' },
        ]);
        expect(unwrapRefs('{{steps.s.output.odd["a}}b"]}}')).toBe('steps.s.output.odd["a}}b"]');
    });

    it('a picked path is written canonically; a formula pick is its own operand', () => {
        expect(insertPath('', null, 'trigger.output.headers.content-type', { mode: 'binding' }).value).toBe('{{trigger.output.headers["content-type"]}}');
        expect(insertPath('steps.a.output.x', null, 'steps.b.output.y', { mode: 'binding', formula: true }).value).toBe('steps.a.output.x steps.b.output.y');
        expect(insertPath('first(', null, 'steps.b.output.y', { mode: 'expression' }).value).toBe('first(steps.b.output.y');
    });

    it('formula chips cover a bracket after the root and skip string literals', () => {
        const chips = chipsIn('concat("steps.a.output.x", first(steps.g.output["value"]))', true);
        expect(chips.map((c) => c.path)).toEqual(['steps.g.output["value"]']);
    });

    it('JSON nested in JSON text round-trips through Text and Formula', () => {
        const text = `{{${deep}}}`;
        expect(textToBinding(text, 'binding')).toEqual({ kind: 'ref', path: deep });
        expect(getPath(ROOT, deep)).toBe('R-7');
        const formula = toFormula(text);
        expect(formula).toEqual({ text: deep, formula: true });
        expect(evaluate(formula.text, ROOT)).toBe('R-7');
        expect(fromFormula(formula.text)).toEqual({ text, formula: false });
        expect(chipsIn(text, false)[0]?.suffix).toBe('Reason code');
        expect(bindingToText({ kind: 'ref', path: deep }, 'binding')).toEqual({ text, formula: false });
    });
});

describe('a pick into a one-value slot is shaped', () => {
    const shaping = { slot: 'Recipient address', expectKind: 'email', expectShape: 'scalar', sampleRoot: ROOT };

    it('a list of addresses goes in joined, not as the raw list', async () => {
        const onChange = jest.fn();
        const hook = await renderHook(() => useBindingText({ kind: 'literal', value: '' }, 'binding', onChange, shaping));
        await act(async () => hook.result.current.insert('steps.graph.output.value[*].from.emailAddress'));
        const b = onChange.mock.calls.at(-1)?.[0] as { kind: string; value: string };
        expect(b.kind).toBe('expr');
        expect(evaluate(b.value, ROOT)).toBe('ada@x.nl, bob@x.nl');
    });

    it('a list into a number slot takes the first', async () => {
        const onChange = jest.fn();
        const hook = await renderHook(() => useBindingText(null, 'binding', onChange, { ...shaping, slot: 'Rate', expectKind: 'number' }));
        await act(async () => hook.result.current.insert('steps.graph.output.rates'));
        const b = onChange.mock.calls.at(-1)?.[0] as { value: string };
        expect(evaluate(b.value, ROOT)).toBe(0.21);
    });

    it('without shaping, or into typed text, the pick goes in as it is', async () => {
        const onChange = jest.fn();
        const hook = await renderHook(() => useBindingText({ kind: 'literal', value: 'To: ' }, 'binding', onChange, shaping));
        await act(async () => hook.result.current.insert('steps.graph.output.rates'));
        expect(onChange.mock.calls.at(-1)?.[0]).toEqual({ kind: 'template', value: 'To: {{steps.graph.output.rates}}' });
    });
});
