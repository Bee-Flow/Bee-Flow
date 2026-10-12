/**
 * "Flatten a list" (flatten.mjs): the column plan, the rows, the checks and
 * the names. The FLATTEN_CASES corpus is the contract the phone's vendored
 * copy runs too.
 *
 * Run: node --test shared/expr/flatten.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeFlattenRoute, routeFromParts, joinKey, childVarOf, childNounOf, defaultParents, flattenPlan, flattenRows,
    flattenShape, checkFlattenParents, listNounKey, flattenSentenceParts,
} from './flatten.mjs';
import { FLATTEN_CASES, FLATTEN_MAIL_STEP, flattenMailRoot, flattenOrdersRoot } from './corpus.mjs';

/** Compare one corpus expectation with a flattenRows output. */
export function checkCase(out, expect) {
    for (const [key, want] of Object.entries(expect)) {
        if (key === 'keys') assert.deepEqual(Object.keys(out.items[0]), want, key);
        else if (key === 'first') assert.deepEqual(out.items[0], want, key);
        else if (key === 'last') assert.deepEqual(out.items[out.items.length - 1], want, key);
        else if (key.startsWith('row')) assert.deepEqual(out.items[Number(key.slice(3))], want, key);
        else assert.deepEqual(out[key], want, key);
    }
}

for (const c of FLATTEN_CASES) {
    test(`corpus: ${c.name}`, () => {
        const out = flattenRows(c.root, c.step, c.opts);
        assert.ok(out, 'resolves');
        checkCase(out, c.expect);
        assert.equal(out.count, out.items.length);
    });
}

const MAIL_ROUTE = FLATTEN_MAIL_STEP.arrayRef;
const ORDER_ROUTE = 'steps.http.output.body.orders[*].lines';

test('F13: the Gmail plan is exactly the stored J1 step', () => {
    const plan = flattenPlan(flattenMailRoot(), MAIL_ROUTE);
    assert.deepEqual(plan.parents, FLATTEN_MAIL_STEP.parents);
    assert.deepEqual(plan.left, [{ level: 0, key: 'body', reason: 'long_text' }]);
    assert.deepEqual(plan.clashes, []);
});

test('F11/F12: fill when the child has the same value, rename when it differs', () => {
    const root = { messages: [{ id: 'm1', date: '2026-09-01', ref: 'R1', attachments: [{ messageId: 'x', date: '2026-08-01', ref: 'R1' }] }] };
    const plan = flattenPlan(root, 'messages[*].attachments');
    assert.deepEqual(plan.parents[0].fields, [
        { from: 'id', to: 'messageId2', mode: 'copy' },
        { from: 'date', to: 'messageDate', mode: 'copy' },
        { from: 'ref', to: 'ref', mode: 'fill' },
    ]);
    assert.deepEqual(plan.clashes, [{ level: 0, from: 'id', to: 'messageId2' }, { level: 0, from: 'date', to: 'messageDate' }]);
});

test('J2: orders get orderId and orderStatus, shipping is left out as an object', () => {
    const plan = flattenPlan(flattenOrdersRoot(), ORDER_ROUTE);
    assert.deepEqual(plan.parents[0].fields.map(f => `${f.from}>${f.to}:${f.mode}`), [
        'id>orderId:copy', 'number>number:copy', 'customer>customer:copy', 'status>orderStatus:copy', 'total>total:copy', 'notes>notes:copy',
    ]);
    assert.deepEqual(plan.left, [{ level: 0, key: 'shipping', reason: 'object' }]);
    assert.equal(plan.parents[0].itemVar, 'order');
});

test('F8: a sample string over 1000 characters is long text whatever its key', () => {
    const root = { m: [{ memo: 'x'.repeat(1001), tag: 'a', files: [{ name: 'f' }] }] };
    const plan = flattenPlan(root, 'm[*].files');
    assert.deepEqual(plan.left, [{ level: 0, key: 'memo', reason: 'long_text' }]);
    assert.deepEqual(plan.parents[0].fields, [{ from: 'tag', to: 'tag', mode: 'copy' }]);
});

test('F15: keepFields names exactly those keys, plus the fills, and lists the unknown', () => {
    const plan = flattenPlan(flattenMailRoot(), MAIL_ROUTE, { keepFields: ['from', 'subject', 'nope'] });
    assert.deepEqual(plan.parents[0].fields, [
        { from: 'from', to: 'from', mode: 'copy' },
        { from: 'subject', to: 'subject', mode: 'copy' },
        { from: 'id', to: 'messageId', mode: 'fill' },
        { from: 'threadId', to: 'threadId', mode: 'fill' },
    ]);
    assert.equal(plan.parents[0].auto, false);
    assert.deepEqual(plan.unknown, ['nope']);
});

test('F16: no sample gives empty fields, still auto', () => {
    const plan = flattenPlan({}, MAIL_ROUTE);
    assert.deepEqual(plan.parents, [{ overRef: 'steps.g_read_many.output.messages', itemVar: 'message', auto: true, fields: [] }]);
    assert.deepEqual(flattenPlan({}, 'no route'), { parents: [], left: [], clashes: [], unknown: [] });
});

test('F20: fill entries are written on keepEmpty rows', () => {
    const root = flattenMailRoot();
    root.steps.g_read_many.output.messages[1].attachments = [];
    const out = flattenRows(root, { ...FLATTEN_MAIL_STEP, keepEmpty: true });
    const empty = out.items[16];
    assert.equal(empty.attachmentId, null);
    assert.equal(empty.messageId, '19a06b2e91c4d877');
    assert.equal(empty.threadId, 't9a06b2e91c4d877');
    assert.equal(out.count, 49);
    assert.equal(out.emptyCount, 1);
});

test('F21: the clash never happens on the sample the plan was made from', () => {
    for (const root of [flattenMailRoot(), flattenOrdersRoot(), flattenOrdersRoot({ taxes: true })]) {
        for (const route of [MAIL_ROUTE, ORDER_ROUTE, `${ORDER_ROUTE}[*].taxes`]) {
            const plan = flattenPlan(root, route);
            const out = flattenRows(root, { arrayRef: route, parents: plan.parents });
            if (out) assert.equal(out.warning, undefined, route);
        }
    }
});

test('F27: two datasets through one stored plan give identical keys', () => {
    const a = flattenRows(flattenMailRoot(), FLATTEN_MAIL_STEP);
    const other = flattenMailRoot();
    for (const m of other.steps.g_read_many.output.messages) for (const att of m.attachments) { delete att.messageId; delete att.threadId; }
    const b = flattenRows(other, FLATTEN_MAIL_STEP);
    assert.deepEqual(Object.keys(b.items[0]).sort(), Object.keys(a.items[0]).sort());
    assert.equal(b.items[20].messageId, '19a06b2e91c4d877');
});

test('F28: a level without stored fields is planned from this run', () => {
    const { parents, ...rest } = FLATTEN_MAIL_STEP;
    const out = flattenRows(flattenMailRoot(), { ...rest, parents: [{ overRef: parents[0].overRef, itemVar: 'message' }] });
    assert.deepEqual(out.items[0], flattenRows(flattenMailRoot(), FLATTEN_MAIL_STEP).items[0]);
});

test('F43: a refresh only appends new keys, never renames or removes', () => {
    const prior = [{ ...FLATTEN_MAIL_STEP.parents[0], fields: FLATTEN_MAIL_STEP.parents[0].fields.filter(f => f.from !== 'to') }];
    const root = flattenMailRoot();
    for (const m of root.steps.g_read_many.output.messages) m.cc = 'archief@contoso.example';
    const plan = flattenPlan(root, MAIL_ROUTE, { prior });
    const tos = plan.parents[0].fields.map(f => f.to);
    assert.deepEqual(tos.slice(0, 5), prior[0].fields.map(f => f.to));
    assert.deepEqual(tos.slice(5), ['to', 'cc']);
});

test('levels are named nearest first, rows carry the line before the order', () => {
    const plan = flattenPlan(flattenOrdersRoot({ taxes: true }), `${ORDER_ROUTE}[*].taxes`);
    assert.deepEqual(plan.parents.map(p => p.itemVar), ['order', 'line']);
    assert.deepEqual(plan.parents[1].fields.map(f => f.to), ['lineId', 'sku', 'quantity', 'price', 'lineStatus']);
    assert.deepEqual(plan.left.map(l => `${l.level}:${l.key}`), ['1:description', '0:shipping']);
});

test('normalizeFlattenRoute and routeFromParts', () => {
    assert.equal(normalizeFlattenRoute(`${MAIL_ROUTE}[*]`), MAIL_ROUTE);
    assert.equal(normalizeFlattenRoute(MAIL_ROUTE), MAIL_ROUTE);
    assert.equal(normalizeFlattenRoute('steps.g.output.messages'), null);
    assert.equal(normalizeFlattenRoute('steps.g.output.messages[*]'), null);
    assert.equal(normalizeFlattenRoute(''), null);
    assert.equal(routeFromParts('steps.g_read_many.output.messages', 'attachments'), MAIL_ROUTE);
    assert.equal(routeFromParts('steps.x.output.rows', 'line items'), 'steps.x.output.rows[*]["line items"]');
    assert.equal(routeFromParts('steps.g.output.messages[*]', 'attachments'), null);
    assert.equal(routeFromParts('steps.g.output.messages', ''), null);
});

test('joinKey, childVarOf, defaultParents', () => {
    assert.equal(joinKey('message', 'id'), 'messageId');
    assert.equal(joinKey('order', 'due_date'), 'order_due_date');
    assert.equal(joinKey('order', 'Due_Date'), 'orderDue_Date');
    assert.equal(childVarOf(MAIL_ROUTE), 'attachment');
    assert.equal(childVarOf('a[*].data'), 'value');
    assert.deepEqual(defaultParents(`${ORDER_ROUTE}[*].taxes`), [
        { overRef: 'steps.http.output.body.orders', itemVar: 'order' },
        { overRef: 'steps.http.output.body.orders[*].lines', itemVar: 'line' },
    ]);
});

test('flattenShape: one merged record of the row keys', () => {
    const shape = flattenShape(flattenMailRoot(), FLATTEN_MAIL_STEP);
    assert.deepEqual(Object.keys(shape), ['attachmentId', 'filename', 'mimeType', 'size', 'canOCR', 'messageId', 'threadId', 'from', 'to', 'subject', 'date']);
    assert.equal(shape.filename, 'logo-header.png');
    assert.deepEqual(flattenShape({}, FLATTEN_MAIL_STEP), {});
});

test('checkFlattenParents: the reason codes', () => {
    const ok = FLATTEN_MAIL_STEP;
    assert.equal(checkFlattenParents(ok), null);
    assert.equal(checkFlattenParents({ arrayRef: MAIL_ROUTE }), null);
    assert.equal(checkFlattenParents({ arrayRef: MAIL_ROUTE, parents: [] }), 'count');
    assert.equal(checkFlattenParents({ arrayRef: MAIL_ROUTE, parents: 'x' }), 'count');
    const p = ok.parents[0];
    assert.equal(checkFlattenParents({ arrayRef: MAIL_ROUTE, parents: [{ ...p, overRef: 'steps.other' }] }), 'overRef');
    for (const itemVar of ['item', 'attachment', 'not a name', '']) {
        assert.equal(checkFlattenParents({ arrayRef: MAIL_ROUTE, parents: [{ ...p, itemVar }] }), 'itemVar', itemVar);
    }
    const twoLevels = `${ORDER_ROUTE}[*].taxes`;
    const dup = [{ overRef: 'steps.http.output.body.orders', itemVar: 'x' }, { overRef: 'steps.http.output.body.orders[*].lines', itemVar: 'x' }];
    assert.equal(checkFlattenParents({ arrayRef: twoLevels, parents: dup }), 'itemVar');
    const badFields = [
        [{ from: 'id', to: 'a', mode: 'merge' }],
        [{ from: '', to: 'a', mode: 'copy' }],
        [{ from: 'id', to: ' a', mode: 'copy' }],
        [{ from: 'id', to: 'a', mode: 'copy' }, { from: 'x', to: 'a', mode: 'fill' }],
        'x',
    ];
    for (const fields of badFields) assert.equal(checkFlattenParents({ arrayRef: MAIL_ROUTE, parents: [{ ...p, fields }] }), 'fields');
});

test('listNounKey: a flatten names its rows by its route, through a filter too', () => {
    const def = { steps: [
        FLATTEN_MAIL_STEP,
        { id: 'mf_filter', type: 'filter', arrayRef: 'steps.mf_flatten.output.items' },
        { id: 'mf_limit', type: 'limit', arrayRef: 'steps.mf_filter.output.items' },
    ] };
    assert.equal(listNounKey(def, 'steps.mf_filter.output.items'), 'attachments');
    assert.equal(listNounKey(def, 'steps.mf_limit.output.items[*]'), 'attachments');
    assert.equal(listNounKey(def, 'steps.mf_flatten.output.items'), 'attachments');
    assert.equal(listNounKey(def, 'steps.g_read_many.output.messages'), 'messages');
    assert.equal(listNounKey(def, 'steps.mf_flatten.output.items[*].filename'), 'filename');
    const loop = { steps: [{ id: 'a', type: 'filter', arrayRef: 'steps.b.output.items' }, { id: 'b', type: 'filter', arrayRef: 'steps.a.output.items' }] };
    assert.equal(listNounKey(loop, 'steps.a.output.items'), null);
});

test('flattenSentenceParts: made, empty, no match, with the data nouns', () => {
    assert.deepEqual(flattenSentenceParts({ items: [], count: 64, inputCount: 4, emptyCount: 0 }, FLATTEN_MAIL_STEP), {
        kind: 'made', count: 64, inputCount: 4, emptyCount: 0, keepEmpty: false, parents: 'messages', children: 'attachments', child: 'attachment',
    });
    assert.equal(flattenSentenceParts({ count: 0, inputCount: 0, emptyCount: 0 }, FLATTEN_MAIL_STEP).kind, 'empty');
    assert.equal(flattenSentenceParts({ count: 0, inputCount: 4, skipped: 'x' }, FLATTEN_MAIL_STEP).kind, 'no_match');
    const lines = flattenSentenceParts({ count: 2, inputCount: 1 }, { arrayRef: 'steps.h.output.orders[*].lineItems', keepEmpty: true });
    assert.deepEqual([lines.parents, lines.children, lines.child, lines.keepEmpty], ['orders', 'line items', 'line item', true]);
});

test('D9: the output has no array key besides items', () => {
    const out = flattenRows(flattenMailRoot(), FLATTEN_MAIL_STEP);
    assert.deepEqual(Object.keys(out).filter(k => Array.isArray(out[k])), ['items']);
    assert.deepEqual(Object.keys(out).slice(0, 4), ['items', 'count', 'inputCount', 'emptyCount']);
});

test('a sample made from a shape (every scalar null) proves no fill: a shared date is renamed', () => {
    const root = { steps: { g: { output: { messages: [{ id: null, subject: null, date: null, attachments: [{ id: null, date: null, filename: null }] }] } } } };
    const plan = flattenPlan(root, 'steps.g.output.messages[*].attachments');
    const date = plan.parents[0].fields.find(f => f.from === 'date');
    assert.deepEqual(date, { from: 'date', to: 'messageDate', mode: 'copy' });
    assert.deepEqual(plan.clashes.filter(c => c.from === 'date'), [{ level: 0, from: 'date', to: 'messageDate' }]);
    const same = { steps: { g: { output: { messages: [{ date: 'd1', attachments: [{ date: 'd1', filename: 'a' }] }] } } } };
    assert.deepEqual(flattenPlan(same, 'steps.g.output.messages[*].attachments').parents[0].fields, [{ from: 'date', to: 'date', mode: 'fill' }]);
});

test('keepEmpty: parents that leave the list out (Outlook) still get their row, not the no-match skip', () => {
    const root = { messages: [{ id: 'a', subject: 'x' }, { id: 'b', subject: 'y' }] };
    const kept = flattenRows(root, { arrayRef: 'messages[*].attachments', keepEmpty: true });
    assert.equal(kept.dead, false);
    assert.deepEqual(kept.items, [{ messageId: 'a', subject: 'x' }, { messageId: 'b', subject: 'y' }]);
    assert.equal(kept.emptyCount, 2);
    assert.equal(flattenRows(root, { arrayRef: 'messages[*].attachments' }).dead, true);
});

test('a child list called items is an item in sentences and labels', () => {
    const route = 'steps.h.output.body.orders[*].items';
    assert.equal(childVarOf(route), 'parent');
    assert.equal(childNounOf(route), 'item');
    assert.equal(childNounOf('steps.s.output.records[*].data'), 'value');
    assert.equal(flattenSentenceParts({}, { arrayRef: route }).child, 'item');
});
