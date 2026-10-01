// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { MappingSource, PickBinding } from '@shared/mapping/index.mjs';
import {
    acceptPick, columnChoice, crossesList, draggedFrom, formulaInput, formulaOutput, groupLabelOf, isStale, itemShapeAt, lowerable, makePick,
    manyForOne, matchColumn, pickFor, slotFor, storedPathOf, storePick, viewOf, withItemScope,
} from './slotModel';

const SAMPLE = {
    trigger: {
        output: {
            customer: { name: 'Anna', email: 'anna@voorbeeld.nl' },
            orders: [
                { id: 'A-100', total: 129.5, lines: [{ product: 'Stoel' }, { product: 'Lamp' }] },
                { id: 'A-101', total: 49, lines: [{ product: 'Muismat' }] },
            ],
            people: [{ Naam: 'Ada', 'E-mail': 'ada@x.nl' }, { Naam: 'Bo', 'E-mail': 'bo@x.nl' }],
            tags: ['vip', 'nieuw'],
        },
    },
    steps: { s1: { output: { rows: [], note: 'x' } } },
};
const src = (...path: Array<string | number>): MappingSource => ({ root: 'trigger', path });
const TEXT = { as: 'text' as const, multiLine: true };
const LINE = { as: 'text' as const, multiLine: false };
const LIST = { as: 'list' as const, multiLine: false, items: 'single' as const };
const NUMBER = { as: 'number' as const, multiLine: false };

describe('viewOf — what a stored value is shown as', () => {
    it('empty, typed, picked, composed', () => {
        expect(viewOf(null, 'binding', SAMPLE)).toEqual({ kind: 'empty' });
        expect(viewOf({ kind: 'literal', value: '' }, 'binding', SAMPLE)).toEqual({ kind: 'empty' });
        expect(viewOf({ kind: 'literal', value: 'Hi' }, 'binding', SAMPLE)).toEqual({ kind: 'literal', text: 'Hi' });
        expect(viewOf({ kind: 'literal', value: 3 }, 'binding', SAMPLE)).toEqual({ kind: 'literal', text: '3' });
        const pick = makePick(src('customer', 'email'), { take: 'one', as: 'native' });
        expect(viewOf(pick, 'binding', SAMPLE)).toEqual({ kind: 'pick', pick, lifted: false });
        const compose = { kind: 'compose', v: 1, parts: ['Hi ', { from: src('customer', 'name'), take: 'one', as: 'text' }] };
        expect(viewOf(compose, 'binding', SAMPLE).kind).toBe('compose');
    });

    it('a legacy ref shows as the pick it lifts to, marked as lifted; the rest is a Formula', () => {
        const view = viewOf({ kind: 'ref', path: 'trigger.output.customer.email' }, 'binding', SAMPLE);
        expect(view).toMatchObject({ kind: 'pick', lifted: true, pick: { from: src('customer', 'email'), take: 'one' } });
        expect(viewOf({ kind: 'expr', value: 'first(trigger.output.tags)' }, 'binding', SAMPLE))
            .toMatchObject({ kind: 'pick', lifted: true, pick: { take: 'first' } });
        expect(viewOf({ kind: 'template', value: 'Hi {{trigger.output.customer.name}}' }, 'binding', SAMPLE).kind).toBe('formula');
        expect(viewOf({ kind: 'expr', value: 'upper(trigger.output.customer.name)' }, 'binding', SAMPLE).kind).toBe('formula');
        expect(viewOf({ kind: 'literal', value: { a: 1 } }, 'binding', SAMPLE).kind).toBe('formula');
    });

    it('a path field: a path is a chip, anything else (a fixed date) is text', () => {
        expect(viewOf('trigger.output.orders', 'path', SAMPLE)).toMatchObject({ kind: 'pick', pick: { from: src('orders') } });
        expect(viewOf('2026-07-01', 'path', SAMPLE)).toEqual({ kind: 'literal', text: '2026-07-01' });
        expect(viewOf('', 'path', SAMPLE)).toEqual({ kind: 'empty' });
    });
});

describe('slotFor — what a field wants', () => {
    it('reads the schema, the step table, then the kind word', () => {
        expect(slotFor({ schema: { type: 'array', items: { type: 'string' } } })).toMatchObject({ as: 'list' });
        expect(slotFor({ schema: { type: 'string' }, field: 'body' })).toMatchObject({ as: 'text', multiLine: true });
        expect(slotFor({ expectKind: 'number' })).toEqual({ as: 'number', multiLine: false });
        expect(slotFor({ expectKind: 'email' })).toEqual({ as: 'text', multiLine: false });
        expect(slotFor({})).toEqual({ as: 'native', multiLine: false });
        expect(slotFor({ slot: { as: 'json' } })).toMatchObject({ as: 'json' });
    });
});

describe('pickFor — the defaults decided at pick time', () => {
    const ctx = (slot: object) => ({ storage: 'binding' as const, slot: slot as never, sample: SAMPLE });

    it('one value is the value; a list into text is all of it, by lines or commas', () => {
        expect(pickFor({ source: src('customer', 'email') }, ctx(LINE)).pick).toMatchObject({ take: 'one', as: 'text' });
        expect(pickFor({ source: src('orders', 'lines', 'product') }, ctx(TEXT)).pick).toMatchObject({ take: 'all', as: 'text', join: 'lines' });
        expect(pickFor({ source: src('tags') }, ctx(LINE)).pick).toMatchObject({ take: 'all', as: 'text', join: 'comma' });
    });

    it('many values into a number take the first, and say so in amber', () => {
        const { pick, shape } = pickFor({ source: src('orders', 'total') }, ctx(NUMBER));
        expect(pick).toMatchObject({ take: 'first', as: 'number' });
        expect(manyForOne(pick, shape, NUMBER)).toBe(true);
        // A stored ref that hands the whole list to a number field says so too; the count fits.
        expect(manyForOne({ take: 'all', as: 'native' }, shape, NUMBER)).toBe(true);
        expect(manyForOne({ take: 'count', as: 'number' }, shape, NUMBER)).toBe(false);
    });

    it('a whole table into a list field takes the column named like the field', () => {
        const { pick } = pickFor({ source: src('people') }, { ...ctx(LIST), names: ['email', 'Ontvangers'] });
        expect(pick).toMatchObject({ from: src('people', 'E-mail'), take: 'all', as: 'list' });
        // No column matches: the table itself, and the sentence asks (amber).
        const none = pickFor({ source: src('people') }, { ...ctx(LIST), names: ['cc'] }).pick;
        expect(none.from).toEqual(src('people'));
        expect(columnChoice(none, SAMPLE, LIST)).toMatchObject({ column: null, columns: [{ key: 'Naam' }, { key: 'E-mail' }] });
        expect(columnChoice(pick, SAMPLE, LIST)).toMatchObject({ column: 'E-mail', table: src('people') });
    });

    it('matchColumn compares names without case and punctuation', () => {
        expect(matchColumn(['Naam', 'E-mail'], ['email'])).toBe('E-mail');
        expect(matchColumn(['first_name'], ['First name'])).toBe('first_name');
        expect(matchColumn(['id'], ['cc'])).toBeNull();
    });
});

describe('acceptPick — what a slot holds after a pick', () => {
    const email = makePick(src('customer', 'email'), { take: 'one', as: 'text' });
    const products = makePick(src('orders', 'lines', 'product'), { take: 'all', as: 'text', join: 'lines' });
    const ctx = { storage: 'binding' as const, slot: TEXT, sample: SAMPLE };

    it('an empty slot takes the pick; a lone chip is replaced (and says so)', () => {
        expect(acceptPick(null, email, ctx)).toEqual({ value: email, replaced: false });
        expect(acceptPick(email, products, ctx)).toEqual({ value: products, replaced: true });
    });

    // Confirmed bug: "Picking a list into ValueBuilder text that already holds
    // typed words wipes that text". The text is kept; the value comes after it.
    it('typed text in a text field is kept: the pick is added after it', () => {
        const { value, replaced } = acceptPick({ kind: 'literal', value: 'Dear customer, your orders: ' }, products, ctx);
        expect(replaced).toBe(false);
        expect(value).toEqual({
            kind: 'compose', v: 1,
            parts: ['Dear customer, your orders: ', { from: products.from, take: 'all', as: 'text', join: 'lines' }],
        });
        const again = acceptPick(value, email, ctx).value as { parts: unknown[] };
        expect(again.parts).toHaveLength(3);
    });

    it('a field that holds a formula only: the pick in the legacy spelling', () => {
        const first = makePick(src('orders', 'total'), { take: 'first', as: 'number' });
        expect(acceptPick(null, first, { ...ctx, storage: 'legacy' }).value).toEqual({ kind: 'expr', value: 'first(trigger.output.orders[*].total)' });
        expect(acceptPick(null, email, { ...ctx, storage: 'legacy' }).value).toEqual({ kind: 'ref', path: 'trigger.output.customer.email' });
    });

    it('a path field: the path of the list itself', () => {
        const lines = makePick(src('orders', 'lines'), { take: 'all', as: 'native' });
        expect(acceptPick('', lines, { ...ctx, storage: 'path' }).value).toBe('trigger.output.orders[*].lines');
        expect(storePick(lines, 'path', SAMPLE)).toBe('trigger.output.orders[*].lines');
    });

    it('a formula-only field offers only what it can store', () => {
        expect(lowerable({ take: 'all', as: 'text', join: 'bullets' })).toBe(false);
        expect(lowerable({ take: 'each', as: 'native' })).toBe(false);
        expect(lowerable({ take: 'first', as: 'native' })).toBe(true);
    });
});

describe('the current item — a step that runs once per item', () => {
    const over = src('people');
    const currentItem = { take: 'each' as const, over, noun: 'Person' };
    const email = makePick(src('people', 'E-mail'), { take: 'each', as: 'text' });

    it('a value of the current item arrives as an each pick, as the field wants it', () => {
        const dragged = draggedFrom('trigger.output.people[*]["E-mail"]', { source: src('people', 'E-mail'), take: 'each' });
        expect(dragged?.take).toBe('each');
        expect(pickFor(dragged!, { storage: 'binding', slot: LINE, sample: SAMPLE }).pick).toEqual(email);
        const number = pickFor({ source: src('orders', 'total'), take: 'each' }, { storage: 'binding', slot: NUMBER, sample: SAMPLE }).pick;
        expect(number).toMatchObject({ take: 'each', as: 'number' });
    });

    it('a field that only holds a path or a formula cannot read the current item: it keeps what it has', () => {
        const ctx = { slot: LINE, sample: SAMPLE };
        expect(acceptPick({ kind: 'literal', value: 'x' }, email, { ...ctx, storage: 'legacy' })).toEqual({ value: { kind: 'literal', value: 'x' }, replaced: false });
        expect(acceptPick('trigger.output.tags', email, { ...ctx, storage: 'path' })).toEqual({ value: 'trigger.output.tags', replaced: false });
        expect(acceptPick(null, email, { ...ctx, storage: 'binding' })).toEqual({ value: email, replaced: false });
    });

    it('previews on the first item, and is shaped as one item holds it', () => {
        const scoped = withItemScope(SAMPLE, currentItem) as { _mappingScope?: unknown };
        expect(scoped._mappingScope).toEqual({ over, item: { Naam: 'Ada', 'E-mail': 'ada@x.nl' }, index: 0 });
        expect(itemShapeAt(email, SAMPLE, currentItem)).toBe('single');
        expect(itemShapeAt({ ...email, take: 'all' }, SAMPLE, currentItem)).toBeNull();
        expect(itemShapeAt(makePick(src('orders', 'lines'), { take: 'each', as: 'list' }), SAMPLE, { ...currentItem, over: src('orders') })).toBe('table');
        // No repeat, or nothing in the list: the sample as it is.
        expect(withItemScope(SAMPLE, null)).toBe(SAMPLE);
        expect(withItemScope(SAMPLE, { ...currentItem, over: src('nothing') })).toBe(SAMPLE);
    });
});

describe('where a source comes from', () => {
    const groups = [
        { id: 't', label: 'Bestelling ontvangen', basePath: 'trigger.output' },
        { id: 's1', label: 'Orders ophalen', basePath: 'steps.s1.output', hasRealData: true },
    ];

    it('names its step or trigger', () => {
        expect(groupLabelOf(src('customer'), groups)).toBe('Bestelling ontvangen');
        expect(groupLabelOf({ root: 'steps', id: 's1', path: ['rows'] }, groups)).toBe('Orders ophalen');
        expect(groupLabelOf({ root: 'steps', id: 'gone', path: [] }, [], new Map([['gone', 'Old step']]))).toBe('Old step');
    });

    it('is stale when its step is gone, or the last real run lacks its key', () => {
        expect(isStale({ root: 'steps', id: 'gone', path: ['x'] }, groups, SAMPLE)).toBe(true);
        expect(isStale({ root: 'steps', id: 's1', path: ['renamed'] }, groups, SAMPLE)).toBe(true);
        expect(isStale({ root: 'steps', id: 's1', path: ['note'] }, groups, SAMPLE)).toBe(false);
        // A design-time sample is no evidence of a missing key.
        expect(isStale(src('not', 'here'), groups, SAMPLE)).toBe(false);
        // Outside the step drawer (no groups) nothing is called stale…
        expect(isStale({ root: 'steps', id: 'gone', path: [] }, [], SAMPLE)).toBe(false);
        // …except a `trigger.<key>` without `.output` that reads nothing: it
        // looked like a working chip and resolved to undefined.
        expect(isStale({ root: 'run', path: ['subject'] }, [], SAMPLE)).toBe(true);
        expect(isStale({ root: 'run', path: ['firedAt'] }, [], SAMPLE)).toBe(false);
    });

    it('draggedFrom reads a path, or takes the Source that came with it', () => {
        expect(draggedFrom('trigger.output.orders[*].id')).toEqual({ source: src('orders', 'id') });
        const given: PickBinding['from'] = { root: 'item', path: ['x'] };
        expect(draggedFrom('item.x', { source: given, shape: 'scalar', count: 2 })).toEqual({ source: given, shape: 'scalar', count: 2 });
        expect(draggedFrom('not a path')).toBeNull();
    });
});

describe('crossesList — is a value read off a list on its way?', () => {
    it('says so for a column, not for a list that is the value itself', () => {
        expect(crossesList(src('orders', 'lines', 'product'), SAMPLE)).toBe(true);
        expect(crossesList(src('tags'), SAMPLE)).toBe(false);
        expect(crossesList(src('customer', 'email'), SAMPLE)).toBe(false);
        expect(crossesList(src('tags'), null)).toBeUndefined();
    });
});

// Review M4b findings.
describe('slotModel — review M4b', () => {
    it('draggedFrom drops the WILD of a column Source, and falls back to the path for one a pick cannot hold', () => {
        const column = { root: 'trigger', path: ['people', { wild: true }, 'E-mail'] } as unknown as MappingSource;
        expect(draggedFrom('trigger.output.people[*]["E-mail"]', { source: column })).toEqual({ source: src('people', 'E-mail') });
        const broken = { root: 'nope', path: [] } as unknown as MappingSource;
        expect(draggedFrom('trigger.output.tags', { source: broken })).toEqual({ source: src('tags') });
    });

    it('a pick into a stored template adds a single value to it; a list joined into text still replaces it', () => {
        const ctx = { storage: 'binding' as const, slot: LINE, sample: SAMPLE };
        const template = { kind: 'template', value: 'Beste {{trigger.output.customer.name}}' };
        expect(acceptPick(template, makePick(src('customer', 'email'), { take: 'one', as: 'text' }), ctx)).toEqual({
            value: { kind: 'template', value: 'Beste {{trigger.output.customer.name}}{{trigger.output.customer.email}}' }, replaced: false,
        });
        const joined = makePick(src('tags'), { take: 'all', as: 'text', join: 'comma' });
        expect(acceptPick(template, joined, ctx)).toEqual({ value: joined, replaced: true });
        // Any other formula is replaced as before, with Undo.
        const expr = { kind: 'expr', value: 'upper(trigger.output.customer.name)' };
        expect(acceptPick(expr, makePick(src('customer', 'email'), { take: 'one', as: 'text' }), ctx).replaced).toBe(true);
    });

    it('the legacy spellings keep the clicked path\'s [*] (hint) where the sample says nothing', () => {
        const pick = makePick({ root: 'steps', id: 'g', path: ['messages', 'size'] }, { take: 'first', as: 'number' });
        const hint = 'steps.g.output.messages[*].size';
        expect(acceptPick(null, pick, { storage: 'legacy', slot: NUMBER, sample: null, hint }).value)
            .toEqual({ kind: 'expr', value: `first(${hint})` });
        expect(acceptPick('', pick, { storage: 'path', slot: NUMBER, sample: null, hint }).value).toBe(hint);
        expect(storePick({ ...pick, take: 'last' }, 'legacy', null, storedPathOf({ kind: 'expr', value: `first(${hint})` }, 'legacy')))
            .toEqual({ kind: 'expr', value: `last(${hint})` });
    });

    it('storedPathOf reads the path a stored value reads', () => {
        expect(storedPathOf(' trigger.output.orders ', 'path')).toBe('trigger.output.orders');
        expect(storedPathOf({ kind: 'ref', path: 'a.b' }, 'legacy')).toBe('a.b');
        expect(storedPathOf({ kind: 'expr', value: 'join(x.rows[*].a, ", ")' }, 'legacy')).toBe('x.rows[*].a');
        expect(storedPathOf({ kind: 'expr', value: 'a + b' }, 'legacy')).toBeNull();
        expect(storedPathOf(null, 'binding')).toBeNull();
    });

    it('formulaInput: a pick or compose in its legacy spelling, null when it has none', () => {
        const one = makePick(src('customer', 'name'), { take: 'one', as: 'text' });
        expect(formulaInput(one, 'binding', SAMPLE)).toEqual({ value: { kind: 'ref', path: 'trigger.output.customer.name' } });
        expect(formulaInput(makePick(src('orders', 'total'), { take: 'first', as: 'number' }), 'binding', SAMPLE))
            .toEqual({ value: { kind: 'expr', value: 'first(trigger.output.orders[*].total)' } });
        expect(formulaInput(makePick(src('tags'), { take: 'all', as: 'text', join: 'bullets' }), 'binding', SAMPLE)).toBeNull();
        const compose = { kind: 'compose', v: 1, parts: ['Hallo ', { from: src('customer', 'name'), take: 'one', as: 'text' }, '!'] };
        expect(formulaInput(compose, 'binding', SAMPLE)).toEqual({ value: { kind: 'template', value: 'Hallo {{trigger.output.customer.name}}!' } });
        const joined = { ...compose, parts: ['Tags: ', { from: src('tags'), take: 'all', as: 'text', join: 'comma' }] };
        expect(formulaInput(joined, 'binding', SAMPLE)).toBeNull();
        expect(formulaInput({ ...compose, parts: ['{{ not a value }} ', compose.parts[1]] }, 'binding', SAMPLE)).toBeNull();
        const expr = { kind: 'expr', value: 'x + 1' };
        expect(formulaInput(expr, 'binding', SAMPLE)?.value).toBe(expr);
        expect(formulaInput('trigger.output.orders', 'path', SAMPLE)).toEqual({ value: { kind: 'ref', path: 'trigger.output.orders' } });
        expect(formulaInput('', 'path', SAMPLE)).toEqual({ value: { kind: 'literal', value: '' } });
    });

    it('formulaOutput gives a path field its path, a lone {{ }} unwrapped', () => {
        expect(formulaOutput({ kind: 'ref', path: 'a.b' }, 'path')).toBe('a.b');
        expect(formulaOutput({ kind: 'template', value: '{{ steps.x.output.rows }}' }, 'path')).toBe('steps.x.output.rows');
        expect(formulaOutput({ kind: 'literal', value: '' }, 'path')).toBe('');
        const b = { kind: 'expr', value: 'x' };
        expect(formulaOutput(b, 'binding')).toBe(b);
    });
});
