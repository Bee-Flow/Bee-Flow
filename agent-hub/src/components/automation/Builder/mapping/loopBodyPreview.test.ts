import { describe, expect, it } from 'vitest';
import { loopBodyPreview } from './loopBodyPreview';
import { computeLoopBodyGroups } from './upstream';

const ROOT = { steps: { shop: { output: { orders: [{ id: 1, line_items: [{ sku: 'A', qty: 2 }] }, { id: 2, number: '#2', line_items: [] }] } } } };
const OUTER = { id: 'lp1', type: 'loop', itemVar: 'order', overRef: 'steps.shop.output.orders', body: [] };
const INNER = { id: 'lp2', type: 'loop', itemVar: 'line_item', overRef: 'loop.order.line_items', body: [] };

type G = { basePath: string; sample: unknown; fields: Array<{ path: string }> };

describe('loopBodyPreview', () => {
    it('adds the loop\'s item (the union of its rows) to the preview root', () => {
        const root = loopBodyPreview(OUTER, ROOT) as { loop: { order: unknown } };
        expect(root.loop.order).toEqual({ id: 1, line_items: [{ sku: 'A', qty: 2 }], number: '#2' });
    });

    it('a batch is a list of items', () => {
        expect((loopBodyPreview({ ...OUTER, batchSize: 5 }, ROOT) as { loop: { order: unknown[] } }).loop.order).toHaveLength(1);
    });

    it('a Loop inside a Loop finds its item through the outer one', () => {
        const outerRoot = loopBodyPreview(OUTER, ROOT);
        const innerRoot = loopBodyPreview(INNER, outerRoot) as { loop: Record<string, unknown> };
        expect(innerRoot.loop.line_item).toEqual({ sku: 'A', qty: 2 });
        expect(innerRoot.loop.order).toBeTruthy();
        const groups = computeLoopBodyGroups(INNER, 0, [], innerRoot, null, { steps: [] }) as G[];
        const item = groups.find(g => g.basePath === 'loop.line_item')!;
        expect(item.sample).toEqual({ sku: 'A', qty: 2 });
        expect(item.fields.map(f => f.path)).toEqual(['loop.line_item.sku', 'loop.line_item.qty']);
    });

    it('leaves the root alone when the list does not resolve', () => {
        expect(loopBodyPreview({ overRef: 'steps.nope.output.x' }, ROOT)).toBe(ROOT);
        expect(loopBodyPreview(null, ROOT)).toBe(ROOT);
    });
});
