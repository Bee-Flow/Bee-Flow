import { describe, expect, it } from 'vitest';
import {
    deepenedForEach, findNestedColumn, innerForEachPick, innerListPath, nestedListPick, rebaseForEach, rebindToNewItem, relativeToItem,
} from './deepenForEach';
// The runtime's own walker and per-item runner: the deepened forEach must give
// ONE flat list, and keep each inner item's outer item bound.
const { walkPath } = require('../../../../../../server/automation/bind');
const { execForEachStep } = require('../../../../../../server/core/automationRunner/execFlow');

// Gmail read, run per search result: each result's output holds its attachments.
const RUN = {
    steps: {
        s3: {
            output: {
                results: [
                    { index: 0, output: { id: 'm1', subject: 'Factuur', attachments: [
                        { filename: 'a.pdf', mimeType: 'application/pdf', attachmentId: 'a1', messageId: 'm1' },
                        { filename: 'logo.png', mimeType: 'image/png', attachmentId: 'a2', messageId: 'm1' },
                    ] } },
                    { index: 1, output: { id: 'm2', subject: 'Bon', attachments: [
                        { filename: 'b.pdf', mimeType: 'application/pdf', attachmentId: 'a3', messageId: 'm2' },
                    ] } },
                ],
            },
        },
    },
};
const FE = { overRef: 'steps.s3.output.results[*].output', itemVar: 'result', maxIterations: 100 };

// Shopify: orders → line items → properties; parent and child both have an `id`.
const SHOP = {
    steps: {
        shop: {
            output: {
                orders: [
                    { id: 1001, name: '#1001', 'line-items': [{ id: 9001, sku: 'TSHIRT-M', properties: [{ name: 'Engraving', value: 'Tom' }] }, { id: 9002, sku: 'MUG', properties: [{ name: 'Gift', value: 'yes' }] }],
                        line_items: [{ id: 9001, sku: 'TSHIRT-M', properties: [{ name: 'Engraving', value: 'Tom' }] }, { id: 9002, sku: 'MUG', properties: [{ name: 'Gift', value: 'yes' }] }] },
                    { id: 1002, name: '#1002', 'line-items': [{ id: 9003, sku: 'CAP', properties: [{ name: 'Color', value: 'Red' }] }],
                        line_items: [{ id: 9003, sku: 'CAP', properties: [{ name: 'Color', value: 'Red' }] }] },
                ],
            },
        },
    },
};
const ORDERS = { overRef: 'steps.shop.output.orders', itemVar: 'order', maxIterations: 100 };

/** Run a step per item the way the runner does and collect what each run saw. */
async function runs(forEach: object, inputs: Record<string, { kind: string; path: string }>, root: object) {
    const { resolveInputs } = require('../../../../../../server/automation/bind');
    const state = { trigger: { output: {} }, vars: {}, secrets: {}, loop: {}, ...root };
    const out = await execForEachStep({ id: 'x', type: 'integration_action', tool: 'x', forEach, inputs }, {}, state, 'live',
        async (step: { inputs: object }, _c: unknown, sub: object) => ({ output: resolveInputs(step.inputs, sub) }));
    return out.output.results.map((r: { output: unknown }) => r.output);
}

describe('nestedListPick', () => {
    it('recognises a value from a list inside the step\'s own item', () => {
        expect(nestedListPick('loop.result.attachments[*].attachmentId', 'result')).toEqual({
            fromVar: 'result', listTail: 'attachments', fieldTail: '.attachmentId', itemVar: 'attachment', between: [],
        });
    });

    it('leaves alone a plain field, another loop\'s item and a missing variable', () => {
        expect(nestedListPick('loop.result.subject', 'result')).toBeNull();
        expect(nestedListPick('loop.row.attachments[*].attachmentId', 'result')).toBeNull();
        expect(nestedListPick('loop.result.attachments[*].id', null)).toBeNull();
    });

    it('reads keys that are not identifiers, and names the item as an identifier', () => {
        expect(nestedListPick('loop.order["line-items"][*]["unit price"]', 'order')).toEqual({
            fromVar: 'order', listTail: '["line-items"]', fieldTail: '["unit price"]', itemVar: 'line_item', between: [],
        });
    });

    it('goes down two lists at once, naming the list it passes', () => {
        expect(nestedListPick('loop.order.line_items[*].properties[*].value', 'order')).toEqual({
            fromVar: 'order', listTail: 'line_items[*].properties', fieldTail: '.value', itemVar: 'property',
            between: [{ itemVar: 'line_item', tail: 'line_items' }],
        });
    });

    it('never names the new item like the current one or a kept parent', () => {
        expect(nestedListPick('loop.result.results[*].id', 'result')?.itemVar).toBe('result_item');
        expect(nestedListPick('loop.x.orders[*].id', 'x', ['order'])?.itemVar).toBe('order_item');
    });
});

describe('deepenedForEach', () => {
    it('runs over every attachment of every email, as one flat list the runtime resolves', () => {
        const plan = nestedListPick('loop.result.attachments[*].attachmentId', 'result')!;
        const fe = deepenedForEach(FE, plan);
        expect(fe).toMatchObject({ overRef: 'steps.s3.output.results[*].output.attachments', itemVar: 'attachment', maxIterations: 100 });
        expect(fe.parents).toEqual([{ itemVar: 'result', overRef: 'steps.s3.output.results[*].output' }]);
        expect(walkPath(fe.overRef, RUN).map((a: { attachmentId: string }) => a.attachmentId)).toEqual(['a1', 'a2', 'a3']);
    });

    it('flattens a plain list first', () => {
        const plan = nestedListPick('loop.mail.attachments[*].attachmentId', 'mail')!;
        expect(deepenedForEach({ overRef: 'steps.s1.output.messages', itemVar: 'mail' }, plan).overRef)
            .toBe('steps.s1.output.messages[*].attachments');
    });

    it('moved twice, the overRef still resolves: orders → line items → properties', () => {
        const fe1 = deepenedForEach(ORDERS, nestedListPick('loop.order.line_items[*].sku', 'order')!);
        expect(fe1.overRef).toBe('steps.shop.output.orders[*].line_items');
        const fe2 = deepenedForEach(fe1, nestedListPick('loop.line_item.properties[*].value', 'line_item', ['order'])!);
        expect(fe2.overRef).toBe('steps.shop.output.orders[*].line_items[*].properties');
        expect(walkPath(fe2.overRef, SHOP).map((p: { value: string }) => p.value)).toEqual(['Tom', 'yes', 'Red']);
        expect(fe2.parents).toEqual([
            { itemVar: 'order', overRef: 'steps.shop.output.orders' },
            { itemVar: 'line_item', overRef: 'steps.shop.output.orders[*].line_items' },
        ]);
    });

    it('two levels in one move, and a list key that is not an identifier', () => {
        const fe = deepenedForEach(ORDERS, nestedListPick('loop.order.line_items[*].properties[*].value', 'order')!);
        expect(fe.overRef).toBe('steps.shop.output.orders[*].line_items[*].properties');
        expect(fe.parents?.map(p => p.itemVar)).toEqual(['order', 'line_item']);
        const hy = deepenedForEach(ORDERS, nestedListPick('loop.order["line-items"][*].sku', 'order')!);
        expect(hy.overRef).toBe('steps.shop.output.orders[*]["line-items"]');
        expect(walkPath(hy.overRef, SHOP).map((l: { sku: string }) => l.sku)).toEqual(['TSHIRT-M', 'MUG', 'CAP']);
    });

    it('decides from the data whether the current items are a list column', () => {
        // A step put on the flattened column by hand (no parents recorded).
        const over = { overRef: 'steps.shop.output.orders[*].line_items', itemVar: 'line_item' };
        const plan = nestedListPick('loop.line_item.properties[*].value', 'line_item')!;
        expect(deepenedForEach(over, plan, SHOP).overRef).toBe('steps.shop.output.orders[*].line_items[*].properties');
        // An envelope's output is one record per run.
        expect(deepenedForEach(FE, nestedListPick('loop.result.attachments[*].x', 'result')!, RUN).overRef)
            .toBe('steps.s3.output.results[*].output.attachments');
    });
});

describe('the outer item stays bound (parent context)', () => {
    it('an order id stays the ORDER id per line item, never the line item\'s own id', async () => {
        const plan = nestedListPick('loop.order.line_items[*].sku', 'order')!;
        const fe = deepenedForEach(ORDERS, plan);
        const before = { orderId: { kind: 'ref', path: 'loop.order.id' } };
        const { inputs, orphans } = rebindToNewItem(before, plan, null);
        expect(inputs.orderId).toEqual({ kind: 'ref', path: 'loop.order.id' });
        expect(orphans).toEqual([]);
        const seen = await runs(fe, { ...(inputs as Record<string, { kind: string; path: string }>), sku: { kind: 'ref', path: `loop.${plan.itemVar}${plan.fieldTail}` } }, SHOP);
        expect(seen).toEqual([{ orderId: 1001, sku: 'TSHIRT-M' }, { orderId: 1001, sku: 'MUG' }, { orderId: 1002, sku: 'CAP' }]);
    });

    it('the email\'s id stays the email\'s id per attachment', async () => {
        const plan = nestedListPick('loop.result.attachments[*].attachmentId', 'result')!;
        const fe = deepenedForEach(FE, plan);
        const seen = await runs(fe, { messageId: { kind: 'ref', path: 'loop.result.id' }, attachmentId: { kind: 'ref', path: 'loop.attachment.attachmentId' } }, RUN);
        expect(seen).toEqual([{ messageId: 'm1', attachmentId: 'a1' }, { messageId: 'm1', attachmentId: 'a2' }, { messageId: 'm2', attachmentId: 'a3' }]);
    });
});

describe('rebindToNewItem', () => {
    const plan = nestedListPick('loop.result.attachments[*].attachmentId', 'result')!;

    it('leaves every read of the old item alone: it is still bound, as the parent', () => {
        const inputs = {
            messageId: { kind: 'ref', path: 'loop.result.id' },
            whole: { kind: 'ref', path: 'loop.result' },
            odd: { kind: 'ref', path: 'loop.result["customer-id"]' },
            title: { kind: 'template', value: 'Re: {{loop.result.subject}} for {{ loop.result["email"] }}' },
            note: { kind: 'literal', value: 'x' },
        };
        const r = rebindToNewItem(inputs, plan, null);
        expect(r.inputs).toEqual(inputs);
        expect(r.orphans).toEqual([]);
        expect(r.moved).toEqual([]);
    });

    it('moves a column of the very list the step moved to, in every syntax and nested map', () => {
        const r = rebindToNewItem({
            names: { kind: 'ref', path: 'loop.result.attachments[*].filename' },
            title: { kind: 'template', value: 'File {{ loop.result.attachments[*].filename }} of {{loop.result.subject}}' },
            size: { kind: 'expr', value: 'upper(loop.result.attachments[*].mimeType)' },
            values: { Name: { kind: 'ref', path: 'loop.result.attachments[*]["filename"]' } },
        }, plan, null);
        expect(r.inputs.names).toEqual({ kind: 'ref', path: 'loop.attachment.filename' });
        expect((r.inputs.title as { value: string }).value).toBe('File {{ loop.attachment.filename }} of {{loop.result.subject}}');
        expect((r.inputs.size as { value: string }).value).toBe('upper(loop.attachment.mimeType)');
        expect(r.inputs.values).toEqual({ Name: { kind: 'ref', path: 'loop.attachment.filename' } });
        expect(r.moved.sort()).toEqual(['names', 'size', 'title', 'values']);
    });

    it('reports reads of the old item when it cannot be kept (a list that is no path)', () => {
        const r = rebindToNewItem({ messageId: { kind: 'ref', path: 'loop.result.id' } }, plan, null, { overRef: '{{ nope', itemVar: 'result' });
        expect(r.orphans).toEqual(['messageId']);
    });
});

describe('findNestedColumn', () => {
    const MAIL = RUN.steps.s3.output.results[0].output;

    it('finds a column of a list inside the item', () => {
        expect(findNestedColumn(['attachmentId'], MAIL, 'result')?.path).toBe('loop.result.attachments[*].attachmentId');
    });

    it('never for a column that only repeats the item\'s own value (mark as read stays per email)', () => {
        expect(findNestedColumn(['messageId'], MAIL, 'result')).toBeNull();
    });

    it('any depth, any key spelling, any element (not only the first)', () => {
        const graph = { id: 'ev1', value: [{ id: 'e1' }, { id: 'e2', attendees: [{ emailAddress: { address: 'a@x.nl' }, type: 'required' }] }] };
        expect(findNestedColumn(['type'], graph, 'event')?.path).toBe('loop.event.value[*].attendees[*].type');
        expect(findNestedColumn(['unit_price'], { 'line-items': [{ 'Unit Price': 5 }] }, 'order')?.path).toBe('loop.order["line-items"][*]["Unit Price"]');
        expect(findNestedColumn(['attachmentId'], { payload: JSON.stringify({ parts: [{ attachmentId: 'p1' }] }) }, 'msg')?.path)
            .toBe('loop.msg.payload.parts[*].attachmentId');
    });

    it('its path is one nestedListPick can move the step to', () => {
        const hit = findNestedColumn(['value'], { line_items: [{ properties: [{ name: 'x', value: 'y' }] }] }, 'order')!;
        expect(hit.path).toBe('loop.order.line_items[*].properties[*].value');
        expect(nestedListPick(hit.path, 'order')?.itemVar).toBe('property');
    });
});

describe('a column of a list inside a list, from outside', () => {
    it('runs once per INNER item, keeping the outer item', async () => {
        const pick = innerForEachPick('steps.shop.output.orders[*].line_items[*].sku', SHOP)!;
        expect(pick.forEach).toEqual({
            overRef: 'steps.shop.output.orders[*].line_items', itemVar: 'line_item', maxIterations: 100,
            parents: [{ itemVar: 'order', overRef: 'steps.shop.output.orders' }],
        });
        expect(pick.binding).toEqual({ kind: 'ref', path: 'loop.line_item.sku' });
        expect(pick.runs).toBe(3);
        const seen = await runs(pick.forEach, { sku: pick.binding, order: { kind: 'ref', path: 'loop.order.name' } }, SHOP);
        expect(seen).toEqual([{ sku: 'TSHIRT-M', order: '#1001' }, { sku: 'MUG', order: '#1001' }, { sku: 'CAP', order: '#1002' }]);
    });

    it('not for a plain column (one list) or a whole inner list', () => {
        expect(innerForEachPick('steps.shop.output.orders[*].id')).toBeNull();
        expect(innerForEachPick('steps.shop.output.orders[*].line_items[*]')).toBeNull();
    });

    it('a step already per order reads the same column through its item', () => {
        expect(relativeToItem('steps.shop.output.orders[*].line_items[*].sku', ORDERS)).toBe('loop.order.line_items[*].sku');
        expect(relativeToItem('steps.s3.output.results[*].output.attachments[*].attachmentId', FE)).toBe('loop.result.attachments[*].attachmentId');
        expect(relativeToItem('steps.other.output.orders[*].sku', ORDERS)).toBeNull();
        expect(innerListPath(nestedListPick('loop.order["line-items"][*].sku', 'order')!)).toBe('loop.order["line-items"]');
    });
});

describe('the drag path: what "Comes in" offers and where a table drop lands', () => {
    it('the current item offers the columns of a list inside it', async () => {
        // JS modules: their JSDoc types are looser than what they take.
        const describeForEachItem = (await import('./upstream/loops')).describeForEachItem as unknown as (...a: unknown[]) => { fields: Array<{ key: string; children?: Array<{ path: string }> }> };
        const g = describeForEachItem(
            { id: 'att', forEach: { overRef: 'steps.s3.output.results[*].output', itemVar: 'result' } },
            { steps: [] }, new Map(), RUN,
        );
        const att = g.fields.find(f => f.key === 'attachments');
        expect((att?.children || []).map(c => c.path)).toContain('loop.result.attachments[*].attachmentId');
    });

    it('a whole table on a text slot named after a column takes that column', async () => {
        const columnForSlot = (await import('./mismatch')).columnForSlot as unknown as (p: string, r: unknown, o: { slot: string; expectedKind: string }) => string | null;
        const root = { loop: { result: RUN.steps.s3.output.results[0].output } };
        expect(columnForSlot('loop.result.attachments', root, { slot: 'attachmentId', expectedKind: 'text' }))
            .toBe('loop.result.attachments[*].attachmentId');
        expect(columnForSlot('loop.result.attachments', root, { slot: 'body', expectedKind: 'text' })).toBeNull();
    });
});

describe('pointing a per-item step at another list (rebaseForEach)', () => {
    const inputs = {
        messageId: { kind: 'ref', path: 'loop.result.id' },
        attachmentId: { kind: 'ref', path: 'loop.result.attachmentId' },
        title: { kind: 'template', value: 'Re: {{loop.result.subject}}' },
    };

    it('a list inside the current one keeps the current item: nothing to rebind', () => {
        const r = rebaseForEach({ overRef: 'steps.s1.output.results', itemVar: 'result' }, { path: 'steps.s1.output.results[*].attachments', element: { attachmentId: 'a1' } }, inputs);
        expect(r.forEach).toEqual({ overRef: 'steps.s1.output.results[*].attachments', itemVar: 'attachment', parents: [{ itemVar: 'result', overRef: 'steps.s1.output.results' }] });
        expect(r.bindings).toEqual(inputs);
        expect(r.orphans).toEqual([]);
    });

    it('another list renames the item; fields move where the new item has them, the rest is reported', () => {
        const r = rebaseForEach({ overRef: 'steps.s1.output.results', itemVar: 'result' }, { path: 'steps.s2.output.messages', element: { ID: 'x', Subject: 's', from: 'a' } }, inputs);
        expect(r.forEach).toEqual({ overRef: 'steps.s2.output.messages', itemVar: 'message', parents: undefined });
        expect(r.bindings.messageId).toEqual({ kind: 'ref', path: 'loop.message.ID' });
        expect(r.bindings.title).toEqual({ kind: 'template', value: 'Re: {{loop.message.Subject}}' });
        expect(r.bindings.attachmentId).toEqual(inputs.attachmentId);
        expect(r.moved.sort()).toEqual(['messageId', 'title']);
        expect(r.orphans).toEqual(['attachmentId']);
    });

    it('the same item name on a different list still reports a field the new item lacks', () => {
        const r = rebaseForEach({ overRef: 'steps.s1.output.results', itemVar: 'result' }, { path: 'steps.s9.output.results', element: { id: 'x' } }, inputs);
        expect(r.forEach.itemVar).toBe('result');
        expect(r.bindings).toEqual(inputs);
        expect(r.orphans.sort()).toEqual(['attachmentId', 'title']);
    });

    it('a Loop keeps no outer item: a list inside its rows renames the item in its body', () => {
        const body = [{ id: 'n1', type: 'notification', title: '{{ loop.row.sku }} of {{ loop.row.order }}' }];
        const r = rebaseForEach({ overRef: 'steps.a.output.rows', itemVar: 'row' }, { path: 'steps.a.output.rows[*].lines', element: { sku: 'A' } }, body, { strings: true, container: true });
        expect(r.forEach).toEqual({ overRef: 'steps.a.output.rows[*].lines', itemVar: 'line', parents: undefined });
        expect(r.bindings[0].title).toBe('{{ loop.line.sku }} of {{ loop.row.order }}');
        expect(r.orphans).toEqual(['n1']);
    });

    it('a Loop body: plain strings (a condition, a nested loop list) are rewritten too, per body step', () => {
        const body = [
            { id: 'c1', type: 'condition', expr: 'loop.row.amount > 10' },
            { id: 'n1', type: 'notification', title: 'Order {{ loop.row.number }}', body: 'x' },
        ];
        const r = rebaseForEach({ overRef: 'steps.a.output.rows', itemVar: 'row' }, { path: 'steps.b.output.orders', element: { amount: 1, number: 2 } }, body, { strings: true });
        expect(r.bindings[0].expr).toBe('loop.order.amount > 10');
        expect(r.bindings[1].title).toBe('Order {{ loop.order.number }}');
        expect(r.moved).toEqual(['c1', 'n1']);
    });
});

describe('lists inside JSON text', () => {
    // Graph over HTTP: events as JSON text, each event's attendees as JSON text again.
    const events = [
        { id: 'e1', subject: 'Plan', body: JSON.stringify({ attendees: [{ email: 'a@x.nl' }, { email: 'b@x.nl' }] }) },
        { id: 'e2', subject: 'Review', body: JSON.stringify({ attendees: [{ email: 'c@x.nl' }] }) },
    ];
    const ROOT = { steps: { h: { output: { status: 200, body: JSON.stringify({ value: events }) } } } };

    it('moving down into a list inside JSON text runs once per attendee and keeps the event', async () => {
        const fe0 = { overRef: 'steps.h.output.body.value', itemVar: 'event' };
        const plan = nestedListPick('loop.event.body.attendees[*].email', 'event')!;
        const fe = deepenedForEach(fe0, plan, ROOT);
        expect(fe.overRef).toBe('steps.h.output.body.value[*].body.attendees');
        expect(walkPath(fe.overRef, ROOT)).toHaveLength(3);
        const seen = await runs(fe, { subject: { kind: 'ref', path: 'loop.event.subject' }, to: { kind: 'ref', path: `loop.${plan.itemVar}${plan.fieldTail}` } }, ROOT);
        expect(seen).toEqual([{ subject: 'Plan', to: 'a@x.nl' }, { subject: 'Plan', to: 'b@x.nl' }, { subject: 'Review', to: 'c@x.nl' }]);
    });

    it('a column of a list inside a list inside JSON text, from outside', () => {
        const pick = innerForEachPick('steps.h.output.body.value[*].body.attendees[*].email', ROOT)!;
        expect(pick.forEach.overRef).toBe('steps.h.output.body.value[*].body.attendees');
        expect(pick.forEach.parents).toEqual([{ itemVar: 'value', overRef: 'steps.h.output.body.value' }]);
        expect(pick.runs).toBe(3);
    });
});
