// @vitest-environment node
/**
 * Pills come from the runtime's path grammar: a bracket right after `output`
 * or the loop item, quoted keys holding `}` or `]`, match segments — every
 * path the run resolves is one reference, and the round trip stays exact.
 */
import { describe, expect, it } from 'vitest';
import { classifyRef, fieldTailLabel, parseRefTokens, scanExprPaths, serializeRefTokens } from './refTokens';

type Tok = { type: string; text?: string; raw?: string; path?: string; source?: string; stepId?: string; itemVar?: string; fieldPath?: string };
const toks = (s: string, mode: string) => parseRefTokens(s, { mode }) as Tok[];
const refs = (s: string, mode: string) => toks(s, mode).filter(t => t.type === 'ref');

describe('templates', () => {
    it.each([
        ['{{steps.graph.output["@odata.nextLink"]}}', 'graph', '["@odata.nextLink"]'],
        ['{{steps.list.output[0].id}}', 'list', '[0].id'],
        ['{{ steps.s1.output.odd["x{y}"] }}', 's1', 'odd["x{y}"]'],
        ['{{steps.s1.output.odd["a}}b"]}}', 's1', 'odd["a}}b"]'],
        ['{{steps.mail.output.headers[name="Subject"].value}}', 'mail', 'headers[name="Subject"].value'],
        ['{{steps.s1.output["line-items"][*].sku}}', 's1', '["line-items"][*].sku'],
    ])('%s is one pill', (tpl, stepId, fieldPath) => {
        const r = refs(`Hi ${tpl}!`, 'fixed');
        expect(r).toHaveLength(1);
        expect(r[0]).toMatchObject({ source: 'steps', stepId, fieldPath, wrapped: true, raw: tpl });
        expect(serializeRefTokens(toks(`Hi ${tpl}!`, 'fixed'))).toBe(`Hi ${tpl}!`);
    });

    it('a loop item with a quoted key and the trigger root', () => {
        expect(refs('{{loop.line["SKU code"]}}', 'fixed')[0]).toMatchObject({ source: 'loop', itemVar: 'line', fieldPath: '["SKU code"]' });
        expect(refs('{{trigger.output["content-type"]}}', 'fixed')[0]).toMatchObject({ source: 'trigger', fieldPath: '["content-type"]' });
    });

    it('a non-path placeholder stays text', () => {
        expect(refs('{{a + 1}} and {{steps.x}}', 'fixed')).toHaveLength(0);
    });
});

describe('formulas', () => {
    it('a bracket after output is part of the pill, so replacing the pill replaces the whole reference', () => {
        const t = toks('first(steps.graph.output["value"])', 'expression');
        expect(t.map(x => x.type)).toEqual(['literal', 'ref', 'literal']);
        expect(t[1]).toMatchObject({ raw: 'steps.graph.output["value"]', stepId: 'graph', fieldPath: 'value' });
    });

    it('a stored ref with a dashed key is one pill', () => {
        expect(refs('steps.a.output.headers.content-type', 'expression')).toHaveLength(1);
        expect(refs(' steps.a.output.headers["x"] ', 'expression')).toHaveLength(1);
        expect(serializeRefTokens(toks(' steps.a.output.headers["x"] ', 'expression'))).toBe(' steps.a.output.headers["x"] ');
    });

    it('a subtraction of two references is two pills', () => {
        const r = refs('steps.a.output.total-steps.b.output.tax', 'expression');
        expect(r.map(x => x.raw)).toEqual(['steps.a.output.total', 'steps.b.output.tax']);
    });

    it('text inside a string literal is never a pill', () => {
        const r = refs('concat("steps.a.output.x", steps.b.output.y)', 'expression');
        expect(r.map(x => x.raw)).toEqual(['steps.b.output.y']);
    });

    it('a match segment and an expanded flowlet sub-step', () => {
        expect(refs('steps.mail.output.headers[name="Subject"].value == "x"', 'expression')[0])
            .toMatchObject({ raw: 'steps.mail.output.headers[name="Subject"].value' });
        expect(refs('steps.call/sub.output.x + 1', 'expression')[0]).toMatchObject({ stepId: 'call/sub', fieldPath: 'x' });
    });

    it.each([
        'first(steps.graph.output["value"])', 'steps.a.output.total-steps.b.output.tax',
        'concat("steps.a.output.x", steps.b.output.y)', 'count(loop.row["a b"][*]) > 2 && trigger.output.x',
        'steps.s1.output.items[i].x', 'mysteps.x + vars.trigger.y',
    ])('round-trips %s', (s) => {
        expect(serializeRefTokens(toks(s, 'expression'))).toBe(s);
    });

    it('scanExprPaths names every rooted path in a formula', () => {
        const parts = scanExprPaths('join(item["Order date"], ", ") + vars.x', ['item', 'vars']);
        expect(parts.filter(p => 'path' in p).map(p => (p as { path: string }).path)).toEqual(['item["Order date"]', 'vars.x']);
    });
});

describe('classifyRef and labels', () => {
    it('classifies any spelling of a reference', () => {
        expect(classifyRef("steps.graph.output['@odata.nextLink']")).toMatchObject({ source: 'steps', stepId: 'graph', fieldPath: '["@odata.nextLink"]' });
        expect(classifyRef('steps["my-step"].output.x')).toMatchObject({ source: 'steps', stepId: 'my-step', fieldPath: 'x' });
        expect(classifyRef('steps.a.outputs')).toBeNull();
        expect(classifyRef('steps.a')).toBeNull();
    });

    it.each([
        ['fields["Story Points"]', 'Story points'],
        ['headers["content-type"]', 'Content type'],
        ['headers[name="Subject"].value', 'Subject'],
        ['results[*].from_email', 'From email'],
        ['items[0].id', 'Items ▸ Id'],
        // A generic key says whose it is, so two addresses never read the same.
        ['value[*].from.emailAddress.address', 'From ▸ Address'],
        ['value[*].ccRecipients[*].emailAddress.address', 'Cc recipients ▸ Address'],
        ['customer.name', 'Customer ▸ Name'],
        ['name', 'Name'],
        // An index says which one.
        ['data.items[0]', 'Items ▸ 1st'],
        ['data.items[1]', 'Items ▸ 2nd'],
        ['data.items[-1]', 'Items ▸ last'],
        ['[2]', '3rd'],
        ['', ''],
    ])('fieldTailLabel(%s)', (tail, label) => {
        expect(fieldTailLabel(tail)).toBe(label);
    });
});
