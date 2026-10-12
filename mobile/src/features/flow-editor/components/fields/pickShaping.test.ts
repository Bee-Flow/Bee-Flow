/**
 * A pick into an empty one-value input on the phone goes through the web's
 * value-builder pipeline: the pick decision (proposePick.ts), then a value
 * from a list INSIDE a list stays a path so the step runs once per inner item
 * (deepPick.ts / deepenInputs.ts), and only then the quiet join or first.
 */

import { deepenInputsWrite } from '@/features/flow-editor/bindings/deepenInputs';
import { BUILDER, requireWeb } from '@/features/flow-editor/bindings/testing/web';

import { shapePick } from './pickShaping';

const webPick = requireWeb(`${BUILDER}/mapping/proposePick.ts`);
const webDeep = requireWeb(`${BUILDER}/mapping/deepPick.ts`);

const ORDERS = [
    { id: 'o1', line_items: [{ sku: 'A' }, { sku: 'B' }] },
    { id: 'o2', line_items: [{ sku: 'C' }] },
];
const ROOT = {
    steps: { shop: { output: { orders: ORDERS, tags: ['red', 'blue'], count: 2 } } },
    loop: { order: ORDERS[0] },
};
const TEXT = { slot: 'Subject', expectKind: 'text', expectShape: 'scalar', sampleRoot: ROOT };
const PER_ORDER = { overRef: 'steps.shop.output.orders', itemVar: 'order' };
const NESTED = 'steps.shop.output.orders[*].line_items[*].sku';
// The input takes one value: only then does the write move the step.
const SCHEMA = { properties: { subject: { type: 'string' } } };

describe('a list into a one-value input', () => {
    it.each([{ forEach: null }, {}, undefined])('is joined, as on the web (deepen %j)', (deepen) => {
        const shaped = shapePick('steps.shop.output.tags', { ...TEXT, deepen });
        const web = webPick.proposePickBinding!('steps.shop.output.tags', ROOT, TEXT) as { remedy: { binding: unknown } };
        expect(shaped.binding).toStrictEqual(web.remedy.binding);
        expect(shaped.binding).toMatchObject({ kind: 'expr' });
    });

    it('a value that fits goes in as its path', () => {
        expect(shapePick('steps.shop.output.count', { ...TEXT, deepen: {} })).toStrictEqual({ path: 'steps.shop.output.count', binding: null });
    });
});

describe('a value from a list inside a list', () => {
    it('keeps its path, and the write runs the step once per inner item', () => {
        expect(webDeep.planDeepPick!(NESTED, { canForEach: true, sampleRoot: ROOT })).toBeTruthy();
        const shaped = shapePick(NESTED, { ...TEXT, deepen: { forEach: null } });
        expect(shaped).toStrictEqual({ path: NESTED, binding: null });
        const written = deepenInputsWrite(null, {}, { subject: { kind: 'ref', path: shaped.path } }, { sampleRoot: ROOT, schema: SCHEMA });
        expect(written.forEach).toBeTruthy();
        expect((written.inputs.subject as { path: string }).path).toMatch(/^loop\./);
    });

    it('while the step already runs per order, moves it down to the line items', () => {
        const pick = 'loop.order.line_items[*].sku';
        for (const deepen of [{ forEach: PER_ORDER }, {}]) {
            expect(shapePick(pick, { ...TEXT, deepen })).toStrictEqual({ path: pick, binding: null });
        }
        const written = deepenInputsWrite(PER_ORDER, {}, { subject: { kind: 'ref', path: pick } }, { sampleRoot: ROOT, schema: SCHEMA });
        expect(written.forEach?.parents).toEqual([expect.objectContaining({ itemVar: 'order' })]);
    });

    it('is joined where nothing would run the step per inner item', () => {
        expect(shapePick(NESTED, TEXT).binding).toMatchObject({ kind: 'expr' });
    });
});
