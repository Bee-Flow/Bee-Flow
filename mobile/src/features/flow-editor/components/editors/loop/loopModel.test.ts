import { friendlyPath, loopLists, pickLoopListFull } from './loopModel';

describe('loopModel: the list a Loop repeats over', () => {
    it('names a deep list in words, never as a path', () => {
        expect(friendlyPath('steps.s1.output.value[*].attachments', new Map([['s1', 'Read the purchasing inbox']])))
            .toBe('Read the purchasing inbox ▸ Value ▸ Attachments (inside each row)');
    });

    it('names what a Condition keeps by the Condition, not "Items"', () => {
        const labels = new Map([['f', 'Only PDFs']]);
        expect(friendlyPath('steps.f.output.items', labels, null, new Map([['f', 'filter']]))).toBe('Only PDFs');
        expect(friendlyPath('steps.f.output.items', labels)).toBe('Only PDFs ▸ Items');
    });

    it('offers lists at any depth, also inside JSON text, never a step\'s own item', () => {
        const groups = [
            { id: 'h', label: 'Graph', kind: 'http_request', basePath: 'steps.h.output', sample: { body: JSON.stringify({ value: [{ id: 'e1' }] }) }, fields: [] },
            { id: 'x__foreach', label: 'Current item (x)', kind: 'loop', basePath: 'loop.x', ownItem: true, sample: { rows: [{ a: 1 }] }, fields: [] },
        ];
        expect(loopLists(groups, null, null).map((l) => l.path)).toEqual(['steps.h.output.body.value']);
        // One item is "1 item".
        const root = { steps: { h: { output: groups[0]?.sample } } };
        expect(loopLists(groups, root, null)[0]?.preview).toBe('1 item');
    });

    it('picking another list renames the item and moves the steps inside by field name', () => {
        const draft = {
            overRef: 'steps.a.output.rows', itemVar: 'row',
            body: [{ id: 'c1', type: 'condition', expr: 'loop.row.amount > 10' }, { id: 'n1', type: 'notification', title: '{{ loop.row.code }}' }],
        };
        const root = { steps: { b: { output: { orders: [{ amount: 5, number: 'A' }] } } } };
        const r = pickLoopListFull(draft, 'steps.b.output.orders', root);
        expect(r.patch.itemVar).toBe('order');
        expect((r.patch.body as { expr?: string }[])[0]?.expr).toBe('loop.order.amount > 10');
        expect(r.orphans).toEqual(['n1']);
        // Without steps inside, a named item keeps its name.
        expect(pickLoopListFull({ overRef: '', itemVar: 'row' }, 'steps.b.output.orders').patch).toEqual({ overRef: 'steps.b.output.orders', itemVar: 'row' });
    });
});
