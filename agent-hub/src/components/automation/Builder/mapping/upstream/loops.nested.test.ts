import { describe, expect, it } from 'vitest';
import * as loops from './loops';

// JS module: its JSDoc-less defaults (`sampleRoot = null`) type looser than what it takes.
type Fn = (...a: unknown[]) => unknown;
const { describeForEachItem, describeForEachParents, describeLoop, inferLoopItemSample } = loops as unknown as Record<string, Fn>;
const { lastPathKey, suggestItemVar, uniqueItemVar } = loops;

// The runtime's walker: what a describer offers must resolve to the value it previews.
const { walkPath } = require('../../../../../../../server/automation/bind');

type Group = { fields: Array<{ key: string; path: string; sample: unknown; perIteration?: boolean; children?: unknown[] }>; sample: unknown };
const asGroup = (g: unknown) => g as Group;

describe('item names are identifiers', () => {
    it('a list key that is not an identifier gives one', () => {
        expect(suggestItemVar('line-items')).toBe('line_item');
        expect(suggestItemVar('Line Items')).toBe('line_item');
        expect(suggestItemVar('@odata.items')).toBe('odata_item');
        expect(suggestItemVar('2024')).toBe('item_2024');
        expect(suggestItemVar('null')).toBe('item');
        expect(suggestItemVar('messageIds')).toBe('messageId');
    });

    it('a unique name, and the last key of a quoted path', () => {
        expect(uniqueItemVar('order', ['order'])).toBe('order_item');
        expect(uniqueItemVar('order', ['order', 'order_item'])).toBe('order_2');
        expect(lastPathKey('steps.o.output["line-items"]')).toBe('line-items');
        expect(lastPathKey('steps.o.output.results[*].output.attachments')).toBe('attachments');
    });
});

describe('a Loop seen from downstream', () => {
    const ISSUES = [{ key: 'BF-1', 'Story Points': 5, '@odata.etag': 'W/1', 'line-items': [{ sku: 'A' }] }];
    const loop = { id: 'lp', type: 'loop', itemVar: 'issue', overRef: 'steps.jira.output.issues', body: [] as object[] };
    const def = { steps: [{ id: 'jira', type: 'integration_action', tool: 'jira_search' }, loop] };
    const root = { steps: { jira: { output: { issues: ISSUES } } } };

    it('quotes item keys the way the runtime reads them', () => {
        const g = asGroup(describeLoop(loop, new Map(), def, root));
        const paths = g.fields.map(f => f.path);
        expect(paths).toContain('steps.lp.output.results[*].item["Story Points"]');
        expect(paths).toContain('steps.lp.output.results[*].item["@odata.etag"]');
        const run = { steps: { lp: { output: { results: [{ index: 0, item: ISSUES[0], output: null }] } } } };
        expect(walkPath('steps.lp.output.results[*].item["Story Points"]', run)).toEqual([5]);
        expect(walkPath('steps.lp.output.results[*].item["@odata.etag"]', run)).toEqual(['W/1']);
    });

    it('offers what each iteration produced: the body\'s last step', () => {
        const withBody = { ...loop, body: [{ id: 'rd', type: 'integration_action', tool: 'gmail_read' }, { id: 'nt', type: 'note' }] };
        const tools = new Map([['gmail_read', { sample: { id: 'm1', subject: 'Hi', attachments: [{ attachmentId: 'a1' }] } }]]);
        const g = asGroup(describeLoop(withBody, tools, { steps: [def.steps[0], withBody] }, root));
        const subject = g.fields.find(f => f.path === 'steps.lp.output.results[*].output.subject');
        expect(subject?.perIteration).toBe(true);
        expect(subject?.sample).toEqual(['Hi']);
        const att = g.fields.find(f => f.path === 'steps.lp.output.results[*].output.attachments');
        expect(Array.isArray(att?.sample)).toBe(true);
    });
});

describe('the element shape is the union of the rows', () => {
    it('a key only a later row has is offered; a list that starts with null too', () => {
        const root = { steps: { g: { output: { value: [{ id: 'e1', subject: 'a' }, { id: 'e2', attendees: [{ type: 'required' }] }], nulls: [null, { a: 1 }] } } } };
        expect(Object.keys((inferLoopItemSample('steps.g.output.value', { steps: [] }, new Map(), root) || {}) as object)).toEqual(['id', 'subject', 'attendees']);
        expect(inferLoopItemSample('steps.g.output.nulls', { steps: [] }, new Map(), root)).toEqual({ a: 1 });
    });

    it('reads quoted and JSON-text lists in the catalog sample', () => {
        const tools = new Map([['http', { sample: { body: JSON.stringify({ 'line-items': [{ sku: 'A' }, { sku: 'B', qty: 2 }] }) } }]]);
        const def = { steps: [{ id: 'h', type: 'integration_action', tool: 'http' }] };
        expect(inferLoopItemSample('steps.h.output.body["line-items"]', def, tools, null)).toEqual({ sku: 'A', qty: 2 });
    });
});

describe('a step over a list inside a list keeps its outer items', () => {
    const root = { steps: { shop: { output: { orders: [{ id: 1001, line_items: [{ id: 9001, sku: 'A', properties: [{ name: 'n', value: 'v' }] }] }] } } } };
    const step = {
        id: 'st',
        forEach: {
            overRef: 'steps.shop.output.orders[*].line_items[*].properties', itemVar: 'property',
            parents: [{ itemVar: 'order', overRef: 'steps.shop.output.orders' }, { itemVar: 'line_item', overRef: 'steps.shop.output.orders[*].line_items' }],
        },
    };

    it('one group per outer item, before the item itself', () => {
        const parents = describeForEachParents(step, { steps: [] }, new Map(), root) as Array<{ basePath: string; ownItem: boolean; fields: Array<{ path: string }> }>;
        expect(parents.map(g => g.basePath)).toEqual(['loop.order', 'loop.line_item']);
        expect(parents.every(g => g.ownItem)).toBe(true);
        expect(parents[0].fields.map(f => f.path)).toContain('loop.order.id');
        expect(parents[1].fields.map(f => f.path)).toContain('loop.line_item.sku');
        const item = describeForEachItem(step, { steps: [] }, new Map(), root) as { basePath: string; ownItem: boolean; sample: unknown };
        expect(item.basePath).toBe('loop.property');
        expect(item.ownItem).toBe(true);
        expect(item.sample).toEqual({ name: 'n', value: 'v' });
    });

    it('a parent named like the item, or without a list, is not offered', () => {
        const bad = { id: 'st', forEach: { overRef: 'x', itemVar: 'a', parents: [{ itemVar: 'a', overRef: 'y' }, { itemVar: 'b' }, null] } };
        expect(describeForEachParents(bad, { steps: [] }, new Map(), null)).toEqual([]);
    });
});
