import {
    countAt, groupLabelOf, isStale, makePick, manyForOne, partFromPath, pickFromPath, previewText, resolvePreview, shapeAt, slotFor, slotView,
} from './slotModel';

const SAMPLE = {
    trigger: { output: { naam: 'Jan' } },
    steps: {
        s1: { output: { total: 2, orders: [{ product: 'Stoel', n: 2 }, { product: 'Tafel', n: 1 }], tags: ['a', 'b'] } },
    },
};
const ORDERS = { root: 'steps' as const, id: 's1', path: ['orders'] };
const PRODUCTS = { root: 'steps' as const, id: 's1', path: ['orders', 'product'] };
const TOTAL = { root: 'steps' as const, id: 's1', path: ['total'] };

describe('slotView: what a stored value is shown as', () => {
    const pick = { kind: 'pick', v: 1, from: TOTAL, take: 'one', as: 'native' };
    const compose = { kind: 'compose', v: 1, parts: ['Hi ', { from: TOTAL, take: 'one', as: 'text' }] };

    it('a pick and a composed text, whoever stored them, in a binding or a text field', () => {
        for (const mode of ['binding', 'template'] as const) {
            expect(slotView(pick, { mode })).toEqual({ kind: 'pick', pick, lifted: false });
            expect(slotView(compose, { mode })).toEqual({ kind: 'compose', compose });
        }
        expect(slotView(pick, { mode: 'path' })).toEqual({ kind: 'text' });
    });

    it('a pick that does not validate is not one (a literal that happens to say kind: pick)', () => {
        expect(slotView({ kind: 'pick', v: 2, from: TOTAL, take: 'one', as: 'native' }, { mode: 'binding' })).toEqual({ kind: 'text' });
        expect(slotView({ kind: 'pick', v: 1, from: TOTAL, take: 'some', as: 'native' }, { mode: 'binding' })).toEqual({ kind: 'text' });
    });

    it('lifts a legacy ref or one-call formula only where the field stores picks', () => {
        const ref = { kind: 'ref', path: 'steps.s1.output.total' };
        expect(slotView(ref, { mode: 'binding' })).toEqual({ kind: 'text' });
        expect(slotView(ref, { mode: 'binding', storesPicks: true, sample: SAMPLE })).toEqual({
            kind: 'pick', lifted: true, pick: { kind: 'pick', v: 1, from: TOTAL, take: 'one', as: 'native' },
        });
        const join = { kind: 'expr', value: 'join(steps.s1.output.orders[*].product, "\\n")' };
        expect(slotView(join, { mode: 'binding', storesPicks: true, sample: SAMPLE })).toEqual({
            kind: 'pick', lifted: true, pick: { kind: 'pick', v: 1, from: PRODUCTS, take: 'all', as: 'text', join: 'lines' },
        });
    });

    it('lifts a [*] ref only on evidence: without a sample it stays the pill it was', () => {
        const each = { kind: 'ref', path: 'steps.s1.output.orders[*].product' };
        expect(slotView(each, { mode: 'binding', storesPicks: true })).toEqual({ kind: 'text' });
        expect(slotView(each, { mode: 'binding', storesPicks: true, sample: SAMPLE })).toMatchObject({ kind: 'pick', lifted: true });
    });

    it('a formula the core cannot lift is a Formula; a JSON pick and a bare path are the text editor’s', () => {
        const formula = { kind: 'expr', value: 'upper(steps.s1.output.total)' };
        expect(slotView(formula, { mode: 'binding', storesPicks: true, sample: SAMPLE })).toEqual({ kind: 'formula', binding: formula });
        expect(slotView({ kind: 'expr', value: 'parseJson(steps.s1.output.body, "a")' }, { mode: 'binding', storesPicks: true })).toEqual({ kind: 'text' });
        expect(slotView({ kind: 'expr', value: 'item.name' }, { mode: 'binding', storesPicks: true })).toEqual({ kind: 'text' });
        expect(slotView({ kind: 'literal', value: 'x' }, { mode: 'binding', storesPicks: true })).toEqual({ kind: 'text' });
        expect(slotView({ kind: 'template', value: 'Hi {{trigger.output.naam}}' }, { mode: 'binding', storesPicks: true })).toEqual({ kind: 'text' });
    });
});

describe('a new pick', () => {
    it('gets the core default for the shape in the sample and the slot', () => {
        expect(pickFromPath('steps.s1.output.orders[*].product', { as: 'text', multiLine: true }, SAMPLE)).toEqual({
            kind: 'pick', v: 1, from: PRODUCTS, take: 'all', as: 'text', join: 'lines',
        });
        expect(pickFromPath('steps.s1.output.orders[*].product', { as: 'number', multiLine: false }, SAMPLE)).toEqual({
            kind: 'pick', v: 1, from: PRODUCTS, take: 'first', as: 'number',
        });
        expect(pickFromPath('steps.s1.output.total', { as: 'native', multiLine: false }, SAMPLE)).toEqual({
            kind: 'pick', v: 1, from: TOTAL, take: 'one', as: 'native',
        });
        expect(pickFromPath('steps.s1.output.total', { as: 'list', multiLine: false }, SAMPLE)).toEqual({
            kind: 'pick', v: 1, from: TOTAL, take: 'one', as: 'list',
        });
    });

    it('names no Source for a secret or a half-typed path', () => {
        expect(pickFromPath('secrets.api', { as: 'native', multiLine: false }, SAMPLE)).toBeNull();
        expect(partFromPath('steps.', { as: 'text', multiLine: false }, SAMPLE)).toBeNull();
    });

    it('as part of a text: always text, a list laid out as the field reads', () => {
        expect(partFromPath('steps.s1.output.tags', { as: 'native', multiLine: false }, SAMPLE)).toEqual({
            from: { root: 'steps', id: 's1', path: ['tags'] }, take: 'all', as: 'text', join: 'comma',
        });
        expect(partFromPath('trigger.output.naam', { as: 'text', multiLine: true }, SAMPLE)).toEqual({
            from: { root: 'trigger', path: ['naam'] }, take: 'one', as: 'text',
        });
    });

    it('without a sample, one value used as it is', () => {
        expect(pickFromPath('steps.s1.output.orders[*].product', { as: 'text', multiLine: false }, null)).toEqual({
            kind: 'pick', v: 1, from: PRODUCTS, take: 'one', as: 'text',
        });
    });
});

describe('shapes, counts and previews', () => {
    it('reads the sample as the run will', () => {
        expect(shapeAt(ORDERS, SAMPLE)).toBe('table');
        expect(shapeAt(PRODUCTS, SAMPLE)).toBe('list');
        expect(shapeAt(TOTAL, SAMPLE)).toBe('single');
        expect(shapeAt(TOTAL, null)).toBe('unknown');
        expect(countAt(PRODUCTS, SAMPLE)).toBe(2);
        expect(countAt(TOTAL, SAMPLE)).toBeNull();
    });

    it('previews a table one row per line, never JSON or [object Object]', () => {
        expect(previewText(resolvePreview(ORDERS, { take: 'all', as: 'text', join: 'lines' }, SAMPLE))).toBe('Stoel · 2\nTafel · 1');
        expect(previewText(resolvePreview(ORDERS, { take: 'all', as: 'native' }, SAMPLE))).toBe('Stoel · 2, Tafel · 1');
        expect(previewText(resolvePreview(PRODUCTS, { take: 'count', as: 'native' }, SAMPLE))).toBe('2');
        expect(previewText(resolvePreview(TOTAL, { take: 'one', as: 'native' }, null))).toBeNull();
        expect(previewText({ a: 1 })).toBe('a: 1');
        expect(previewText('x'.repeat(200))).toHaveLength(160);
    });

    it('says when many values go into a field for one (the web rule: shared slotView)', () => {
        const number = { as: 'number', multiLine: false } as const;
        const text = { as: 'text', multiLine: false } as const;
        expect(manyForOne({ take: 'one', as: 'native' }, 'list', text)).toBe(true);
        expect(manyForOne({ take: 'first', as: 'number' }, 'table', number)).toBe(true);
        // The phone's old port flagged only `first`; the last of a list and a
        // whole list into a number field are just as much "many into one".
        expect(manyForOne({ take: 'last', as: 'number' }, 'list', number)).toBe(true);
        expect(manyForOne({ take: 'all', as: 'native' }, 'list', number)).toBe(true);
        expect(manyForOne({ take: 'count', as: 'number' }, 'list', number)).toBe(false);
        expect(manyForOne({ take: 'first', as: 'text' }, 'list', text)).toBe(false);
        expect(manyForOne({ take: 'one', as: 'native' }, 'single', text)).toBe(false);
    });

    it('makes a stored pick, join only when there is one', () => {
        expect(makePick(TOTAL, { take: 'one', as: 'native' })).toEqual({ kind: 'pick', v: 1, from: TOTAL, take: 'one', as: 'native' });
        expect(makePick(TOTAL, { take: 'all', as: 'text', join: 'comma' })).toMatchObject({ join: 'comma' });
    });
});

describe('the slot of a field', () => {
    it('from its schema, a text field, or native', () => {
        expect(slotFor({ schema: { type: 'array', items: { type: 'string' } } })).toEqual({ as: 'list', multiLine: false, items: 'single' });
        expect(slotFor({ schema: { type: 'string' }, multiline: true })).toEqual({ as: 'text', multiLine: true });
        expect(slotFor({ mode: 'template', multiline: true })).toEqual({ as: 'text', multiLine: true });
        expect(slotFor({})).toEqual({ as: 'native', multiLine: false });
        expect(slotFor({ schema: {} })).toEqual({ as: 'native', multiLine: false });
    });
});

describe('where a source comes from', () => {
    const groups = [{ label: 'Orders ophalen', basePath: 'steps.s1.output', hasRealData: true }, { label: 'Start', basePath: 'trigger.output' }];

    it('names its step', () => {
        expect(groupLabelOf(TOTAL, groups)).toBe('Orders ophalen');
        expect(groupLabelOf({ root: 'steps', id: 's9', path: [] }, groups, new Map([['s9', 'Elders']]))).toBe('Elders');
        expect(groupLabelOf({ root: 'vars', path: ['x'] }, groups)).toBe('');
    });

    it('is stale when its step is gone, or a real run lacks the field it reads', () => {
        expect(isStale({ root: 'steps', id: 'gone', path: ['x'] }, groups, SAMPLE)).toBe(true);
        expect(isStale({ root: 'steps', id: 's1', path: ['renamed'] }, groups, SAMPLE)).toBe(true);
        expect(isStale(TOTAL, groups, SAMPLE)).toBe(false);
        // Never cries wolf on a design-time sample, or without the steps.
        expect(isStale({ root: 'trigger', path: ['other'] }, groups, SAMPLE)).toBe(false);
        expect(isStale({ root: 'steps', id: 'gone', path: [] }, [], SAMPLE)).toBe(false);
    });

    it('is stale for a trigger key that is neither the payload nor its metadata, as on the web', () => {
        expect(isStale({ root: 'run', path: ['nope'] }, groups, SAMPLE)).toBe(true);
        expect(isStale({ root: 'run', path: ['firedAt'] }, groups, SAMPLE)).toBe(false);
    });

    it('reads a drag hint when the sample does not hold the value', () => {
        expect(shapeAt({ root: 'steps', id: 's1', path: ['nope'] }, SAMPLE, 'list')).toBe('list');
        expect(shapeAt({ root: 'steps', id: 's1', path: ['nope'] }, SAMPLE)).toBe('missing');
    });
});
