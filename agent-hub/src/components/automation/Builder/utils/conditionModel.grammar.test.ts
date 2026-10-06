// @vitest-environment node
/**
 * The clickable condition builder reads every path spelling the runtime reads
 * and stores the canonical one: a match segment holding a comma
 * (`headers[name="a,b"]`) is one field, not two arguments, and a quoted key
 * in single quotes comes back in the spelling every other editor writes.
 */
import { describe, expect, it } from 'vitest';
import { evaluate } from '@shared/expr/engine.mjs';
import { parseExprToRows, serializeRows } from './conditionModel';

type Row = { field: { kind: string; path?: string }; op: string; value: { kind: string; value?: unknown }; threshold?: number };
const parse = (e: string) => parseExprToRows(e) as { rows: Row[]; join: string } | null;

const MATCH = 'steps.mail.output.headers[name="a,b"].value';
const ROOT = {
    steps: {
        mail: { output: { headers: [{ name: 'a,b', value: 'Invoice 7' }, { name: 'c', value: '' }] } },
        jira: { output: { fields: { 'Story Points': 5 } } },
    },
    trigger: { output: { 'x-y': 'set' } },
};

describe('a match segment holding a comma is one field', () => {
    it.each([
        [`contains(${MATCH}, "Invoice")`, 'contains', 'Invoice'],
        [`!contains(${MATCH}, "Quote")`, 'notContains', 'Quote'],
        [`startsWith(${MATCH}, "Inv")`, 'startsWith', 'Inv'],
        [`endsWith(${MATCH}, "7")`, 'endsWith', '7'],
    ])('%s', (expr, op, value) => {
        const p = parse(expr);
        expect(p?.rows).toEqual([{ field: { kind: 'ref', path: MATCH }, op, value: { kind: 'literal', value } }]);
        expect(serializeRows(p!.rows, p!.join)).toBe(expr);
        expect(evaluate(expr, ROOT)).toBe(true);
    });

    it('is empty / is not empty', () => {
        expect(parse(`!isEmpty(${MATCH})`)?.rows[0]).toMatchObject({ field: { path: MATCH }, op: 'isNotEmpty' });
        expect(parse('isEmpty(steps.mail.output.headers[name="c"].value)')?.rows[0])
            .toMatchObject({ field: { path: 'steps.mail.output.headers[name="c"].value' }, op: 'isEmpty' });
    });

    it('is about, with and without a threshold', () => {
        const expr = `isAbout(${MATCH}, "billing, invoices", 0.7)`;
        const p = parse(expr);
        expect(p?.rows[0]).toEqual({ field: { kind: 'ref', path: MATCH }, op: 'isAbout', value: { kind: 'literal', value: 'billing, invoices' }, threshold: 0.7 });
        expect(serializeRows(p!.rows, p!.join)).toBe(expr);
        expect(parse(`!isAbout(${MATCH}, "spam")`)?.rows[0]).toMatchObject({ op: 'notAbout', value: { value: 'spam' } });
    });

    it('a comma inside the compared text stays in the text', () => {
        expect(parse('contains(trigger.output.subject, "a, b")')?.rows[0].value).toEqual({ kind: 'literal', value: 'a, b' });
    });

    it('a call with more arguments than the operator takes stays a raw expression', () => {
        expect(parse('contains(trigger.output.a, "x", "y")')).toBeNull();
        expect(parse('isEmpty(trigger.output.a, trigger.output.b)')).toBeNull();
        expect(parse('contains(trigger.output.a, "x") + 1')).toBeNull();
    });
});

describe('the field is stored in the canonical spelling', () => {
    it.each([
        ["steps.jira.output.fields['Story Points'] > 3", 'steps.jira.output.fields["Story Points"]', 'steps.jira.output.fields["Story Points"] > 3'],
        ["contains(steps.jira.output.fields['Story Points'], 5)", 'steps.jira.output.fields["Story Points"]', 'contains(steps.jira.output.fields["Story Points"], 5)'],
        ["trigger.output['x-y']", 'trigger.output["x-y"]', 'trigger.output["x-y"]'],
    ])('%s', (expr, path, written) => {
        const p = parse(expr);
        expect(p?.rows[0].field).toEqual({ kind: 'ref', path });
        expect(serializeRows(p!.rows, p!.join)).toBe(written);
        expect(evaluate(written, ROOT)).toBe(evaluate(expr, ROOT));
    });
});
