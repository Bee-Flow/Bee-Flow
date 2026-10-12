import { describe, expect, it, vi } from 'vitest';
import { planDeepPick } from './deepPick';

const ROOT = {
    steps: { shop: { output: { orders: [{ id: 1, line_items: [{ sku: 'A' }, { sku: 'B' }] }, { id: 2, line_items: [{ sku: 'C' }] }] } } },
    loop: { order: { id: 1, line_items: [{ sku: 'A' }, { sku: 'B' }] } },
};

describe('planDeepPick', () => {
    it('a step per order, given a line item column: moves down, keeps the order', () => {
        const apply = vi.fn();
        const p = planDeepPick('loop.order.line_items[*].sku', { deepenForEach: { itemVar: 'order', apply }, sampleRoot: ROOT })!;
        expect(p.binding).toEqual({ kind: 'ref', path: 'loop.line_item.sku' });
        if (!p.plan) throw new Error('expected a move down');
        expect(p.plan.listTail).toBe('line_items');
        expect(p.newItem).toEqual({ sku: 'A' });
        expect(p.runs).toBe(2);
    });

    it('the same column by its full path, when the editor hands over the step\'s list', () => {
        const p = planDeepPick('steps.shop.output.orders[*].line_items[*].sku', {
            deepenForEach: { itemVar: 'order', forEach: { overRef: 'steps.shop.output.orders', itemVar: 'order' }, apply: vi.fn() }, sampleRoot: ROOT,
        })!;
        expect(p.binding.path).toBe('loop.line_item.sku');
    });

    it('a step not yet per item: once per inner item, the outer item kept', () => {
        const p = planDeepPick('steps.shop.output.orders[*].line_items[*].sku', { canForEach: true, sampleRoot: ROOT })!;
        expect(p.forEach).toEqual({
            overRef: 'steps.shop.output.orders[*].line_items', itemVar: 'line_item', maxIterations: 100,
            parents: [{ itemVar: 'order', overRef: 'steps.shop.output.orders' }],
        });
        expect(p.runs).toBe(3);
    });

    it('nothing for a one-level column, or when the step may not iterate', () => {
        expect(planDeepPick('steps.shop.output.orders[*].id', { canForEach: true, sampleRoot: ROOT })).toBeNull();
        expect(planDeepPick('steps.shop.output.orders[*].line_items[*].sku', { canForEach: false, sampleRoot: ROOT })).toBeNull();
    });
});
