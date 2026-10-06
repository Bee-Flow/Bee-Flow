/**
 * A value from a list inside a list, written into an app action's input on
 * the phone: the step runs once per INNER item, the outer item kept
 * (`forEach.parents`), and the run binds each line item's own order.
 *
 * Only where the web does it (ValueBuilder.proposePick): a pick into a still
 * empty input that takes ONE value. A list parameter takes the column as the
 * list it is, and typing a formula never moves the step mid-word.
 */

import type { FlowCatalog } from '@/features/flow-editor/api';
import type { FlowNode } from '@/features/flow-editor/bindings';
import { deepenInputsWrite, nestedColumnPatch } from '@/features/flow-editor/bindings/deepenInputs';
import { textToBinding } from '@/features/flow-editor/components/fields/bindingText';
import { getPath } from '@/shared/expr';

import { editThrough } from '../testing';
import { INTEGRATION_ACTION } from './integration';

const ORDERS = [{ id: 'o1', line_items: [{ sku: 'A' }, { sku: 'B' }] }, { id: 'o2', line_items: [{ sku: 'C' }] }];
const ROOT = { steps: { shop: { output: { orders: ORDERS } } }, loop: { order: ORDERS[0] } };
const SCHEMA = {
    properties: { orderId: { type: 'string' }, sku: { type: 'string' }, note: { type: 'string' }, skus: { type: 'array', items: { type: 'string' } } },
};
const CATALOG = { apps: [{ id: 'shop', label: 'Shop', actions: [{ name: 'stock_check', inputSchema: SCHEMA }] }] } as unknown as FlowCatalog;
const CTX = { sampleRoot: ROOT, catalog: CATALOG };
const step = (extra: Partial<FlowNode> = {}): FlowNode => ({ id: 'chk', type: 'integration_action', tool: 'stock_check', inputs: {}, ...extra }) as FlowNode;
const PER_ORDER_FE = { overRef: 'steps.shop.output.orders', itemVar: 'order', maxIterations: 100 };
const perOrder = () => step({ forEach: PER_ORDER_FE, inputs: { orderId: { kind: 'ref', path: 'loop.order.id' } } });

describe('a pick from a list inside a list', () => {
    it('a step not yet per item runs per line item and keeps the order', () => {
        const { patch } = editThrough(INTEGRATION_ACTION, step(), [['inputs', { sku: { kind: 'ref', path: 'steps.shop.output.orders[*].line_items[*].sku' } }]], CTX);
        expect(patch.forEach).toEqual({
            overRef: 'steps.shop.output.orders[*].line_items', itemVar: 'line_item', maxIterations: 100,
            parents: [{ itemVar: 'order', overRef: 'steps.shop.output.orders' }],
        });
        expect(patch.inputs).toEqual({ sku: { kind: 'ref', path: 'loop.line_item.sku' } });
        // The list the step now runs over: every line item of every order (the
        // runner binds each one's order as `loop.order`; server forEachScope tests).
        expect(getPath(ROOT, String((patch.forEach as { overRef: string }).overRef))).toEqual([{ sku: 'A' }, { sku: 'B' }, { sku: 'C' }]);
    });

    it('a step per order moves down, keeps its order fields, from the item or the full path', () => {
        for (const path of ['loop.order.line_items[*].sku', 'steps.shop.output.orders[*].line_items[*].sku']) {
            const { patch } = editThrough(INTEGRATION_ACTION, perOrder(), [['inputs', { orderId: { kind: 'ref', path: 'loop.order.id' }, sku: { kind: 'template', value: `{{${path}}}` } }]], CTX);
            expect(patch.forEach).toEqual({
                overRef: 'steps.shop.output.orders[*].line_items', itemVar: 'line_item', maxIterations: 100,
                parents: [{ itemVar: 'order', overRef: 'steps.shop.output.orders' }],
            });
            expect(patch.inputs).toEqual({ orderId: { kind: 'ref', path: 'loop.order.id' }, sku: { kind: 'ref', path: 'loop.line_item.sku' } });
        }
    });

    it('anything else goes in as it is', () => {
        const scalar = { properties: { id: { type: 'string' }, note: { type: 'string' }, sku: { type: 'string' } } };
        expect(deepenInputsWrite(null, {}, { id: { kind: 'ref', path: 'steps.shop.output.orders[*].id' } }, { sampleRoot: ROOT, schema: scalar })).toEqual({ inputs: { id: { kind: 'ref', path: 'steps.shop.output.orders[*].id' } } });
        expect(deepenInputsWrite(null, {}, { note: { kind: 'literal', value: 'loop.order.line_items[*].sku' } }, { sampleRoot: ROOT, schema: scalar }).forEach).toBeUndefined();
        const kept = { sku: { kind: 'ref', path: 'loop.order.line_items[*].sku' } };
        // An input that did not change this time is not moved again.
        expect(deepenInputsWrite({ overRef: 'x', itemVar: 'order' }, kept, kept, { sampleRoot: ROOT, schema: scalar }).forEach).toBeUndefined();
    });

    it('auto-map\'s patch for a step per mail: the attachment column, which the write then moves to', () => {
        const mail = { id: 'm1', attachments: [{ attachmentId: 'a1', messageId: 'm1' }] };
        const schema = { properties: { messageId: { type: 'string' }, attachmentId: { type: 'string' } }, required: ['messageId', 'attachmentId'] };
        expect(nestedColumnPatch(schema, { messageId: { kind: 'ref', path: 'loop.mail.id' } }, mail, 'mail')).toEqual({ attachmentId: { kind: 'ref', path: 'loop.mail.attachments[*].attachmentId' } });
        expect(nestedColumnPatch(schema, { messageId: { kind: 'ref', path: 'loop.mail.id' }, attachmentId: { kind: 'ref', path: 'x' } }, mail, 'mail')).toEqual({});
        // A list parameter is never filled with a column the write would not move to.
        const list = { properties: { attachmentId: { type: 'array' } } };
        expect(nestedColumnPatch(list, {}, mail, 'mail')).toEqual({});
    });
});

describe('where the web does not move the step, the phone does not either', () => {
    const NESTED_ITEM = 'loop.order.line_items[*].sku';

    it('a list parameter takes "all SKUs of this order" as the list it is', () => {
        const skus = { kind: 'ref', path: NESTED_ITEM };
        const { patch } = editThrough(INTEGRATION_ACTION, perOrder(), [['inputs', { orderId: { kind: 'ref', path: 'loop.order.id' }, skus }]], CTX);
        expect(patch.forEach).toBeUndefined();
        expect(patch.inputs).toEqual({ orderId: { kind: 'ref', path: 'loop.order.id' }, skus });
    });

    it('a list parameter on a step that does not run per item gets no forEach', () => {
        const skus = { kind: 'ref', path: 'steps.shop.output.orders[*].line_items[*].sku' };
        const { patch } = editThrough(INTEGRATION_ACTION, step(), [['inputs', { skus }]], CTX);
        expect(patch.forEach).toBeUndefined();
        expect(patch.inputs).toEqual({ skus });
    });

    it.each([
        ['a formula', true, NESTED_ITEM],
        ['text with a placeholder', false, `{{${NESTED_ITEM}}}`],
    ])('typing %s, one key at a time, never moves the step', (_label, formula, typed) => {
        const edits = [...typed].map((_c, i) => ['inputs', { orderId: { kind: 'ref', path: 'loop.order.id' }, note: textToBinding(typed.slice(0, i + 1), 'binding', formula) }] as const);
        const { patch } = editThrough(INTEGRATION_ACTION, perOrder(), edits, CTX);
        expect(patch.forEach).toBeUndefined();
        expect((patch.inputs as Record<string, unknown>).note).toEqual(textToBinding(typed, 'binding', formula));
    });

    it('an input the action does not declare is left as it is', () => {
        const extra = { kind: 'ref', path: 'steps.shop.output.orders[*].line_items[*].sku' };
        expect(editThrough(INTEGRATION_ACTION, step(), [['inputs', { extra }]], CTX).patch.forEach).toBeUndefined();
        // Without a catalog the phone knows no input's shape: nothing moves.
        expect(editThrough(INTEGRATION_ACTION, step(), [['inputs', { sku: extra }]], { sampleRoot: ROOT }).patch.forEach).toBeUndefined();
    });
});
