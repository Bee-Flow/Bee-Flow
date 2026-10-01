// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { usedPathsIn, pathInUse, countInUse, emptySlotsIn } from './boundPaths';

describe('usedPathsIn — the references a step already holds', () => {
    const step = {
        id: 's9', type: 'ai_step', label: 'steps.fake.output',
        prompt: 'Check {{steps.a.output.summary}} against {{trigger.output.company}}',
        inputs: {
            model: { kind: 'ref', path: 'steps.b.output.model.table' },
            rows: { kind: 'expr', value: 'first(steps.a.output.rows[*].id)' },
            item: { kind: 'template', value: 'Bank {{loop.bank.name}}' },
        },
        position: { x: 1, y: 2 },
    };

    it('finds refs in templates, bindings and expressions alike', () => {
        const used = usedPathsIn(step);
        expect(used.has('steps.a.output.summary')).toBe(true);
        expect(used.has('trigger.output.company')).toBe(true);
        expect(used.has('steps.b.output.model.table')).toBe(true);
        expect(used.has('steps.a.output.rows[*].id')).toBe(true);
        expect(used.has('loop.bank.name')).toBe(true);
    });

    it('ignores the label — a name is not a binding', () => {
        expect(usedPathsIn(step).has('steps.fake.output')).toBe(false);
    });

    it('is safe on nothing', () => {
        expect(usedPathsIn(null).size).toBe(0);
        expect(usedPathsIn({}).size).toBe(0);
    });

    it('a parent counts as in use when a child is', () => {
        const used = usedPathsIn(step);
        expect(pathInUse('steps.a.output.rows', used)).toBe(true);
        expect(pathInUse('steps.a.output.rowsXYZ', used)).toBe(false);
        expect(countInUse([{ path: 'steps.a.output.summary' }, { path: 'steps.a.output.rows' }, { path: 'steps.a.output.other' }], used)).toBe(2);
        expect(countInUse([{ path: 'x' }], new Set())).toBe(0);
    });
});

/**
 * The INVERSE — "1 field still empty" in the settings footer (artboard 2b).
 * The rule that keeps the pill worth reading: a DECLARED slot with nothing in
 * it counts; an optional tool parameter nobody filled in does not.
 */
describe('usedPathsIn — picks and composes (the v2 mapping)', () => {
    const step = {
        id: 'n1', type: 'notification',
        title: 'Hi',
        body: {
            kind: 'compose', v: 1,
            parts: ['Beste ', { from: { root: 'trigger', path: ['customer', 'name'] }, take: 'one', as: 'text' }, ', uw orders: ',
                { from: { root: 'steps', id: 'fetch', path: ['orders', 'lines', 'sku'] }, take: 'all', as: 'text', join: 'lines' }],
        },
        inputs: { to: { kind: 'pick', v: 1, from: { root: 'steps', id: 'fetch', path: ['customer', 'E-mail adres'] }, take: 'one', as: 'native' } },
        repeat: { over: { root: 'steps', id: 'rows', path: ['items'] } },
    };

    it('a compose part, a pick and the repeat list count as in use, though no text holds their path', () => {
        const used = usedPathsIn(step);
        expect(used.has('trigger.output.customer.name')).toBe(true);
        expect(used.has('steps.fetch.output.orders.lines.sku')).toBe(true);
        expect(used.has('steps.fetch.output.customer["E-mail adres"]')).toBe(true);
        expect(used.has('steps.rows.output.items')).toBe(true);
    });

    it('the source panel spells a list with [*]; a pick does not: both are the same value', () => {
        const used = usedPathsIn(step);
        expect(pathInUse('steps.fetch.output.orders[*].lines[*].sku', used)).toBe(true);
        expect(pathInUse('steps.fetch.output.orders', used)).toBe(true);
        expect(pathInUse('steps.fetch.output.ordersX', used)).toBe(false);
    });

    it('a compose that holds only blank text is empty; one with a value is not', () => {
        const blank = { inputs: { a: { kind: 'compose', v: 1, parts: ['  '] }, b: step.body } };
        expect(emptySlotsIn(blank).keys).toEqual(['a']);
    });
});

describe('emptySlotsIn — declared slots that hold nothing', () => {
    it('counts a named field left empty, and does not count one that is bound', () => {
        const set = { id: 's1', type: 'set', fields: {
            sender: { kind: 'ref', path: 'steps.a.output.from' },
            note: { kind: 'literal', value: '' },
            blank: null,
        } };
        const r = emptySlotsIn(set);
        expect(r.declared).toBe(3);
        expect(r.empty).toBe(2);
        expect(r.keys).toEqual(['note', 'blank']);
    });

    it('counts a REQUIRED tool parameter with no key at all — clearing one deletes it', () => {
        const step = { id: 's2', type: 'integration_action', inputs: { to: { kind: 'literal', value: 'a@b.nl' } } };
        const schema = { properties: { to: {}, subject: {}, cc: {} }, required: ['to', 'subject'] };
        const r = emptySlotsIn(step, { inputSchema: schema });
        expect(r.keys).toEqual(['subject']);
        expect(r.declared).toBe(2);
    });

    it('leaves optional parameters out — thirty unset options are not thirty problems', () => {
        const schema = { properties: { a: {}, b: {}, c: {} }, required: [] };
        expect(emptySlotsIn({ id: 's3', inputs: {} }, { inputSchema: schema })).toEqual({ declared: 0, empty: 0, keys: [], unknown: false });
    });

    it('never counts a slot twice, and survives a step with nothing on it', () => {
        const step = { id: 's4', inputs: { subject: { kind: 'literal', value: '' } } };
        const schema = { required: ['subject'] };
        expect(emptySlotsIn(step, { inputSchema: schema })).toEqual({ declared: 1, empty: 1, keys: ['subject'], unknown: false });
        expect(emptySlotsIn(null)).toEqual({ declared: 0, empty: 0, keys: [], unknown: false });
        expect(emptySlotsIn({ id: 's5', inputs: 'not an object' })).toEqual({ declared: 0, empty: 0, keys: [], unknown: false });
    });

    it('reports UNKNOWN rather than a number when the schema could not be read', () => {
        // The count is only complete for a tool step when the required list is
        // there, and it can be missing: the catalog fetch is fire-and-forget,
        // so a 401 leaves it null for the session. Counted the same way, the
        // most dangerous step of all — an untouched tool step, whose unfilled
        // required parameters leave NO key behind — came back as zero, i.e.
        // as "nothing wrong". Unknown has to be its own answer.
        const untouched = { id: 's7', type: 'integration_action', tool: 'gmail_send' };
        expect(emptySlotsIn(untouched, { inputSchema: null, schemaKnown: false }))
            .toEqual({ declared: 0, empty: 0, keys: [], unknown: true });
        // It does not invent slots either — what IS written down is still
        // counted, so the caller can say both things if it wants to.
        const partly = { id: 's8', inputs: { body: { kind: 'literal', value: '' } } };
        expect(emptySlotsIn(partly, { schemaKnown: false }))
            .toEqual({ declared: 1, empty: 1, keys: ['body'], unknown: true });
        // Default: a step that declares no tool has no schema to miss.
        expect(emptySlotsIn(partly).unknown).toBe(false);
    });

    it('an expression or template with only whitespace is empty; a real one is not', () => {
        const step = { id: 's6', fields: {
            a: { kind: 'expr', value: '  ' },
            b: { kind: 'template', value: '{{trigger.output.x}}' },
        } };
        expect(emptySlotsIn(step).keys).toEqual(['a']);
    });
});
