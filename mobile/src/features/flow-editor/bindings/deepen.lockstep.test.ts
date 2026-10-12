/**
 * DIFFERENTIAL lockstep for the deep reading, the per-item moves and the item
 * describers: agent-hub `Builder/mapping/{deepFields,deepenForEach,itemRefs,
 * innerList,autoMapIteration}.ts` and `upstream/loops.js` against their ports,
 * on payloads as they come: JSON text inside JSON text, name/value lists,
 * keys that are not identifiers, lists inside lists. When this fails the web
 * side changed — update the port, don't loosen the test.
 */

import * as am from './autoMap';
import { applyAutoMapToStep } from './autoMapStep';
import * as dp from './deepenForEach';
import * as df from './deepFields';
import { planDeepPick } from './deepPick';
import { listPathLabel } from './listPathLabel';
import { BUILDER, requireWeb } from './testing/web';
import type { Catalog, FlowDefinition, VariableGroup } from './types';
import * as loops from './upstream/loops';

const web = {
    df: requireWeb(`${BUILDER}/mapping/deepFields.ts`),
    dp: requireWeb(`${BUILDER}/mapping/deepenForEach.ts`),
    am: requireWeb(`${BUILDER}/mapping/autoMapInputs.js`),
    loops: requireWeb(`${BUILDER}/mapping/upstream/loops.js`),
};

beforeAll(() => {
    jest.useFakeTimers({ now: new Date('2026-03-01T10:00:00Z') });
});
afterAll(() => {
    jest.useRealTimers();
});

// An HTTP body (text) holding a payload (text) holding items whose meta is text
// again, down to a fenced AI answer.
const LVL3 = '```json\n' + JSON.stringify({ verdict: { score: 0.93, 'reason code': 'R-7' } }) + '\n```';
const ITEMS = [{ sku: 'A1', meta: JSON.stringify({ tags: ['x', 'y'], ai: LVL3 }) }, { sku: 'B2', meta: '{"tags":["z"]}' }];
const BODY = JSON.stringify({ data: { payload: JSON.stringify({ items: ITEMS }) } });
const UGLY: Record<string, unknown> = {
    status: 200,
    body: BODY,
    headers: [{ name: 'Content-Type', value: 'application/json' }, { name: 'X-Request-Id', value: 'r1' }],
    'line-items': [{ 'Unit Price': 5, sku: 'A', properties: [{ name: 'Engraving', value: 'Tom' }] }, { sku: 'B', 'Story Points': 3 }],
    data: { object: { lines: { data: [{ id: 'il_1', amount: 100 }] } } },
    tags: [{ Key: 'Owner', Value: 'tom' }],
    nulls: [null, { a: 1 }],
    'Prénom': 'Anne',
};

function group(id: string, output: unknown, kind = 'integration_action', extra: Partial<VariableGroup> = {}): VariableGroup {
    const basePath = `steps.${id}.output`;
    const fields = output && typeof output === 'object' && !Array.isArray(output)
        ? Object.entries(output).map(([key, sample]) => ({ key, path: `${basePath}${/^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`}`, sample }))
        : [];
    return { id, label: id, kind, basePath, sample: output, fields, ...extra };
}

describe('deepFields', () => {
    it('reads the same positions, lists and entries', () => {
        for (const v of [UGLY, ITEMS, BODY, null, 'text', [[1, 2]], { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }]) {
            expect(df.deepValueFields(v, 'steps.x.output')).toStrictEqual(web.df.deepValueFields?.(v, 'steps.x.output'));
            expect(df.listSources(v, 'steps.x.output')).toStrictEqual(web.df.listSources?.(v, 'steps.x.output'));
            expect(df.mergeElementSamples(v)).toStrictEqual(web.df.mergeElementSamples?.(v));
        }
        for (const g of [group('u', UGLY), group('c', { result: { lines: [{ a: 1 }] }, logs: ['x'], httpCalls: 0 }, 'code')]) {
            expect(df.groupListSources(g)).toStrictEqual(web.df.groupListSources?.(g));
            expect(df.groupValueFields(g)).toStrictEqual(web.df.groupValueFields?.(g));
        }
        for (const k of ['Prénom', 'first-name', 'First Name', 'firstName', null, 'ÉMAIL']) expect(df.foldKey(k)).toBe(web.df.foldKey?.(k));
        expect(df.pairEntries(UGLY.headers)).toStrictEqual(web.df.pairEntries?.(UGLY.headers));
    });

    it('reaches the bottom of JSON text inside JSON text', () => {
        const paths = df.deepValueFields({ body: JSON.stringify({ data: { payload: JSON.stringify({ meta: JSON.stringify({ ai: LVL3 }) }) } }) }, 'steps.h.output').map((n) => n.path);
        expect(paths).toContain('steps.h.output.body.data.payload.meta.ai.verdict["reason code"]');
    });
});

describe('per-item moves', () => {
    const SHOP = { steps: { shop: { output: { orders: [{ id: 1, line_items: [{ sku: 'A', properties: [{ name: 'n', value: 'v' }] }] }] } } } };
    const FE = { overRef: 'steps.shop.output.orders', itemVar: 'order' };

    it('plan, move, rebind and the column finder agree', () => {
        for (const [path, v] of [
            ['loop.order.line_items[*].sku', 'order'],
            ['loop.order["line-items"][*]["unit price"]', 'order'],
            ['loop.order.line_items[*].properties[*].value', 'order'],
            ['loop.result.results[*].id', 'result'],
            ['loop.order.subject', 'order'],
        ] as const) {
            const plan = dp.nestedListPick(path, v);
            expect(plan).toStrictEqual(web.dp.nestedListPick?.(path, v));
            if (!plan) continue;
            expect(dp.deepenedForEach(FE, plan, SHOP)).toStrictEqual(web.dp.deepenedForEach?.(FE, plan, SHOP));
            expect(dp.deepenedForEach({ ...FE, parents: [{ itemVar: 'x', overRef: 'steps.a.output.x' }] }, plan)).toStrictEqual(
                web.dp.deepenedForEach?.({ ...FE, parents: [{ itemVar: 'x', overRef: 'steps.a.output.x' }] }, plan),
            );
            const inputs = {
                id: { kind: 'ref', path: 'loop.order.id' },
                col: { kind: 'ref', path: 'loop.order.line_items[*].sku' },
                text: { kind: 'template', value: 'Order {{ loop.order.line_items[*].sku }} {{loop.order.id}}' },
                expr: { kind: 'expr', value: 'upper(loop.order.line_items[*].sku)' },
                values: { A: { kind: 'ref', path: 'loop.order.line_items[*].sku' } },
            };
            expect(dp.rebindToNewItem(inputs, plan, null)).toStrictEqual(web.dp.rebindToNewItem?.(inputs, plan, null));
        }
        const item = { id: 'm1', attachments: [{ attachmentId: 'a1', messageId: 'm1' }], payload: JSON.stringify({ parts: [{ partId: 'p' }] }) };
        for (const keys of [['attachmentId'], ['messageId'], ['partId'], ['nope']]) {
            expect(dp.findNestedColumn(keys, item, 'mail')).toStrictEqual(web.dp.findNestedColumn?.(keys, item, 'mail'));
        }
        for (const p of ['steps.shop.output.orders[*].line_items[*].sku', 'steps.shop.output.orders[*].id', 'steps.h.output.body.value[*].body.attendees[*].email']) {
            expect(dp.innerForEachPick(p, SHOP)).toStrictEqual(web.dp.innerForEachPick?.(p, SHOP));
            expect(dp.relativeToItem(p, FE)).toStrictEqual(web.dp.relativeToItem?.(p, FE));
        }
    });

    it('re-pointing at another list agrees, fields and all', () => {
        const inputs = { a: { kind: 'ref', path: 'loop.order.id' }, b: { kind: 'template', value: '{{loop.order.Subject}}' } };
        for (const [path, element] of [
            ['steps.shop.output.orders[*].line_items', { sku: 'A' }],
            ['steps.other.output.messages', { ID: 'x', subject: 's' }],
            ['steps.shop.output.orders', { id: 1 }],
        ] as const) {
            expect(dp.rebaseForEach(FE, { path, element }, inputs)).toStrictEqual(web.dp.rebaseForEach?.(FE, { path, element }, inputs));
        }
        const body = [{ id: 'c', type: 'condition', expr: 'loop.order.id > 1' }];
        expect(dp.rebaseForEach(FE, { path: 'steps.b.output.rows', element: { id: 1 } }, body, { strings: true })).toStrictEqual(
            web.dp.rebaseForEach?.(FE, { path: 'steps.b.output.rows', element: { id: 1 } }, body, { strings: true }),
        );
    });
});

describe('the item describers', () => {
    const tools = new Map([
        ['gmail_read', { sample: { id: 'm1', subject: 'Hi', attachments: [{ attachmentId: 'a1' }] }, schema: null }],
        ['shop', { sample: { 'line-items': [{ sku: 'A' }, { sku: 'B', qty: 2 }], body: JSON.stringify({ value: [{ id: 'e' }] }) }, schema: null }],
    ]);
    const def: FlowDefinition = { steps: [{ id: 'o', type: 'integration_action', tool: 'shop' }, { id: 'r', type: 'integration_action', tool: 'gmail_read', forEach: { overRef: 'x', itemVar: 'y' } }] };
    const root = { steps: { j: { output: { issues: [{ key: 'BF-1', 'Story Points': 5, '@odata.etag': 'W/1' }, null, { key: 'BF-2', extra: true }] } } } };

    it('a Loop downstream: quoted item keys and the body\'s output', () => {
        const loop = { id: 'lp', type: 'loop', itemVar: 'issue', overRef: 'steps.j.output.issues', body: [{ id: 'rd', type: 'integration_action', tool: 'gmail_read' }] };
        expect(loops.describeLoop(loop, tools, def, root)).toStrictEqual(web.loops.describeLoop?.(loop, tools, def, root));
        const perItemBody = { ...loop, body: [{ id: 'rd', type: 'integration_action', tool: 'gmail_read', forEach: { overRef: 'loop.issue.x', itemVar: 'x' } }] };
        expect(loops.describeLoop(perItemBody, tools, def, root)).toStrictEqual(web.loops.describeLoop?.(perItemBody, tools, def, root));
    });

    it('a per-item step: its item, its outer items, the union of rows', () => {
        const step = {
            id: 'st',
            forEach: { overRef: 'steps.j.output.issues', itemVar: 'issue', parents: [{ itemVar: 'issue', overRef: 'x' }, { itemVar: 'p', overRef: 'steps.o.output["line-items"]' }, null] },
        };
        expect(loops.describeForEachItem(step, def, tools, root)).toStrictEqual(web.loops.describeForEachItem?.(step, def, tools, root));
        expect(loops.describeForEachParents(step, def, tools, root)).toStrictEqual(web.loops.describeForEachParents?.(step, def, tools, root));
        for (const ref of ['steps.j.output.issues', 'steps.o.output["line-items"]', 'steps.o.output.body.value', 'steps.r.output.results[*].output.attachments', 'nope', '']) {
            expect(loops.inferLoopItemSample(ref, def, tools, root)).toStrictEqual(web.loops.inferLoopItemSample?.(ref, def, tools, root));
            expect(loops.inferLoopItemSample(ref, def, tools, null)).toStrictEqual(web.loops.inferLoopItemSample?.(ref, def, tools, null));
        }
        for (const k of ['line-items', 'Line Items', '@odata.items', '2024', 'null', 'messageIds', 'categories', '']) {
            expect(loops.suggestItemVar(k)).toBe(web.loops.suggestItemVar?.(k));
        }
        expect(loops.uniqueItemVar('a', ['a', 'a_item'])).toBe(web.loops.uniqueItemVar?.('a', ['a', 'a_item']));
        expect(loops.lastPathKey('steps.o.output["line-items"]')).toBe(web.loops.lastPathKey?.('steps.o.output["line-items"]'));
    });
});

describe('auto-map on ugly shapes', () => {
    const groups = [group('far', { email: 'old@x.nl', results: [{ id: 'r' }] }), group('u', UGLY)];

    it('the same fields at any depth, the same lists', () => {
        const schema = { properties: { email: { type: 'string' }, contentType: { type: 'string' }, owner: { type: 'string' }, unitPrice: { type: 'number' }, prenom: { type: 'string' }, reasonCode: { type: 'string' } }, required: [] };
        expect(am.autoMapInputs(schema, {}, groups)).toStrictEqual(web.am.autoMapInputs?.(schema, {}, groups));
        expect(am.autoMapInputs(schema, {}, groups).contentType).toEqual({ kind: 'ref', path: 'steps.u.output.headers[name="Content-Type"].value' });
        for (let n = 0; n <= groups.length; n++) expect(am.nearestArrayRef(groups.slice(0, n))).toBe(web.am.nearestArrayRef?.(groups.slice(0, n)));
    });

    it('which list a step runs once per item over', () => {
        const catalog: Catalog = {
            apps: [{
                actions: [
                    { name: 'gmail_search', outputSample: { results: [{ id: 'm1' }], total: 1 } },
                    // A read mail is a mail (a subject and a thread, as Gmail's own sample):
                    // that is what makes its `id` the messageId (autoMapEntity.ts).
                    { name: 'gmail_read', inputSchema: { properties: { messageId: { type: 'string' } }, required: ['messageId'] }, outputSample: { id: 'm1', threadId: 't1', subject: 'Invoice', attachments: [{ attachmentId: 'a1', messageId: 'm1' }] } },
                    { name: 'gmail_mark_read', inputSchema: { properties: { messageId: { type: 'string' } }, required: ['messageId'] } },
                    { name: 'gmail_read_attachment', inputSchema: { properties: { messageId: { type: 'string' }, attachmentId: { type: 'string' } }, required: ['messageId', 'attachmentId'] } },
                    { name: 'fetch', outputSample: { status: 200, body: BODY } },
                    { name: 'flag', inputSchema: { properties: { reasonCode: { type: 'string' } }, required: ['reasonCode'] } },
                ],
            }],
            triggerOutputs: { __manual: { fields: [], sample: {} } },
        } as Catalog;
        const chain = (tool: string, first = 'gmail_search', second: string | null = 'gmail_read'): FlowDefinition => ({
            trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
            steps: [
                { id: 's1', type: 'integration_action', tool: first, inputs: {} },
                ...(second ? [{ id: 's2', type: 'integration_action', tool: second, inputs: {}, forEach: { overRef: 'steps.s1.output.results', itemVar: 'result', maxIterations: 100 } }] : []),
                { id: 's3', type: 'integration_action', tool, inputs: {} },
            ],
            edges: [{ from: 'trg', to: 's1' }, ...(second ? [{ from: 's1', to: 's2' }, { from: 's2', to: 's3' }] : [{ from: 's1', to: 's3' }])],
        });
        for (const def of [chain('gmail_mark_read'), chain('gmail_read_attachment'), chain('flag', 'fetch', null)]) {
            expect(applyAutoMapToStep(def, 's3', catalog)).toStrictEqual(web.am.applyAutoMapToStep?.(def, 's3', catalog));
        }
        const markRead = applyAutoMapToStep(chain('gmail_mark_read'), 's3', catalog).definition.steps?.find((s) => s.id === 's3');
        expect(markRead?.forEach).toEqual({ overRef: 'steps.s2.output.results', itemVar: 'result', maxIterations: 100 });
        const flag = applyAutoMapToStep(chain('flag', 'fetch', null), 's3', catalog).definition.steps?.find((s) => s.id === 's3');
        expect(flag?.inputs).toEqual({ reasonCode: { kind: 'ref', path: 'loop.item.meta.ai.verdict["reason code"]' } });
    });
});

describe('a list path in words', () => {
    it('reads the same on the phone', () => {
        const label = requireWeb(`${BUILDER}/mapping/listPathLabel.ts`);
        const labels = new Map([['s1', 'Read the purchasing inbox']]);
        for (const p of [
            'steps.s1.output.value[*].attachments', 'steps.s1.output.results[*].output.attachments', 'trigger.output.data.object.lines.data',
            'steps.s1.output.payload.headers[name="Subject"].value', 'loop.order.line_items[*].properties', 'steps.gone.output.items[0].lines',
            'steps.s1.output.body["line-items"]', 'trigger.output.a.b.c.d.e.f', 'not a path',
        ]) {
            expect(listPathLabel(p, labels)).toBe(label.listPathLabel?.(p, labels));
        }
        expect(listPathLabel('steps.s1.output.value[*].attachments', labels)).toBe('Read the purchasing inbox ▸ Value ▸ Attachments (inside each row)');
    });

    it('names a Condition’s outputs and the canvas’s compact form the same on the phone', () => {
        const label = requireWeb(`${BUILDER}/mapping/listPathLabel.ts`);
        const labels = new Map([['s1', 'Read many'], ['split', 'Split'], ['keep', 'Keep']]);
        const stepTypeById = new Map([['split', 'switch'], ['keep', 'filter'], ['s1', 'integration_action']]);
        const t = (key: string, en: string, vars?: Record<string, unknown>) => `[${key}|${en}|${JSON.stringify(vars ?? {})}]`;
        for (const p of [
            'steps.split.output.matchesByCase.pdf', 'steps.split.output.matchesByCase.default', 'steps.split.output.matchesByCase["High priority"]',
            'steps.keep.output.items', 'steps.keep.output.items[*].attachments', 'steps.s1.output.items', 'steps.s1.output.messages[*].attachments', 'item.subject',
        ]) {
            for (const opts of [{}, { stepTypeById }, { compact: true, stepTypeById }]) {
                expect(listPathLabel(p, labels, null, opts)).toBe(label.listPathLabel?.(p, labels, null, opts));
                expect(listPathLabel(p, labels, t, opts)).toBe(label.listPathLabel?.(p, labels, t, opts));
            }
        }
        expect(listPathLabel('steps.split.output.matchesByCase.default', labels)).toBe('Split ▸ Otherwise');
        expect(listPathLabel('steps.keep.output.items[*].attachments', labels, null, { compact: true, stepTypeById })).toBe('Keep ▸ Attachments');
    });
});

describe('a value from a list inside a list, picked into one field', () => {
    it('plans the same move on the phone', () => {
        const pick = requireWeb(`${BUILDER}/mapping/deepPick.ts`);
        const root = { steps: { shop: { output: { orders: [{ id: 1, line_items: [{ sku: 'A' }] }] } } }, loop: { order: { id: 1, line_items: [{ sku: 'A' }] } } };
        const apply = () => null;
        for (const [path, opts] of [
            ['loop.order.line_items[*].sku', { deepenForEach: { itemVar: 'order', apply }, sampleRoot: root }],
            ['steps.shop.output.orders[*].line_items[*].sku', { deepenForEach: { itemVar: 'order', forEach: { overRef: 'steps.shop.output.orders', itemVar: 'order' }, apply }, sampleRoot: root }],
            ['steps.shop.output.orders[*].line_items[*].sku', { canForEach: true, sampleRoot: root }],
            ['steps.shop.output.orders[*].id', { canForEach: true, sampleRoot: root }],
        ] as const) {
            expect(planDeepPick(path, opts)).toStrictEqual(pick.planDeepPick?.(path, opts));
        }
    });
});
