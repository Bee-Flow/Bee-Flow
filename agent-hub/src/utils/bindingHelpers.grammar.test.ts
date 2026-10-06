/**
 * The binding helpers read and write paths with the ONE grammar the runtime
 * resolves (shared/expr/path.mjs), so a path the builder previews, classifies
 * or converts means exactly what the run will do with it.
 */
import { describe, expect, it } from 'vitest';
import { evaluate } from '@shared/expr/engine.mjs';
import { getPath, getRelativePath } from '@shared/expr/path.mjs';
import * as BH from './bindingHelpers';

type Fn = (...args: unknown[]) => unknown;
const h = BH as unknown as Record<string, Fn>;

const ROOT = {
    trigger: { output: { headers: { 'content-type': 'application/json' }, 'Größe': 'XL', status: 'open' } },
    steps: {
        jira: { output: { fields: { 'Story Points': 5, summary: 'Fix login', 'a > b': 1, 'x}y': 2, 'p]q': 3 } } },
        graph: { output: { '@odata.nextLink': 'https://next', value: [{ id: 'm1', from: { a: 'a@x.nl' } }, { id: 'm2', from: { a: 'b@x.nl' } }] } },
        http: { output: { body: '{"data":{"items":[{"id":7}]}}' } },
        m: { output: { rows: [[1, 2], [3]], withNull: [1, null, 3] } },
        mail: { output: { headers: [{ name: 'From', value: 'ann@x.nl' }, { name: 'Subject', value: 'Hello' }] } },
    },
};

describe('walkPath resolves exactly like the run (shared getPath)', () => {
    const paths = [
        'steps.jira.output.fields["Story Points"]',
        "steps.jira.output.fields['Story Points']",
        'steps.graph.output["@odata.nextLink"]',
        'steps.graph.output.value[0].from.a',
        'steps.graph.output.value.0.from.a',
        'steps.graph.output.value[-1].id',
        'steps.graph.output.value[*].from.a',
        'steps.http.output.body.data.items[0].id',
        'steps.m.output.rows[*]',
        'steps.m.output.withNull[*]',
        'trigger.output.headers.content-type',
        'trigger.output.Größe',
        'steps.jira.output.fields["x}y"]',
        'steps.jira.output.fields["p]q"]',
        'steps.mail.output.headers[name="Subject"].value',
        // Lax spellings the old builder walker previewed and the run never got.
        'steps.jira.output.fields.Story Points',
        'steps.graph.output.value[0x1].id',
        'steps.graph.output.value[0]id',
        'steps.graph.output.value.constructor',
    ];
    it.each(paths)('%s', (p) => {
        expect(BH.walkPath(p, ROOT)).toStrictEqual(getPath(ROOT, p));
    });

    it('reads JSON text, keeps rows of a table, keeps explicit nulls', () => {
        expect(BH.walkPath('steps.http.output.body.data.items[0].id', ROOT)).toBe(7);
        expect(BH.walkPath('steps.m.output.rows[*]', ROOT)).toEqual([[1, 2], [3]]);
        expect(BH.walkPath('steps.m.output.withNull[*]', ROOT)).toEqual([1, null, 3]);
        expect(BH.walkPath('steps.jira.output.fields.Story Points', ROOT)).toBeUndefined();
    });

    it('walkRelativePath is the run\'s getRelativePath', () => {
        for (const p of ['', '$', 'a', '[0].x', '[*].sku', '0', 'a-b', '["a-b"]', '$.a', 'a.']) {
            for (const v of [{ a: { b: 1 }, 'a-b': 2 }, [{ x: 1, sku: 's1' }, { sku: 's2' }], 'text', null]) {
                expect(BH.walkRelativePath(p, v)).toStrictEqual(getRelativePath(v, p));
            }
        }
    });

    it('still previews an expanded flowlet sub-step path', () => {
        const root = { steps: { 'call/sub': { output: { n: 1, 'a b': 2 } } } };
        expect(BH.walkPath('steps.call/sub.output.n', root)).toBe(1);
        expect(BH.walkPath('steps.call/sub.output["a b"]', root)).toBe(2);
    });
});

describe('isCleanPath / bindingFromInput accept every path the runtime reads', () => {
    it.each([
        'steps.jira.output.fields["Story Points"]',
        "steps.graph.output['@odata.nextLink']",
        'steps.list.output[0].id',
        'steps.a.output.results[*].x',
        'steps.a.output.items[-1]',
        'trigger.output.Größe',
        'trigger.output.headers.content-type',
        'steps.jira.output.fields["x}y"]',
        'steps.jira.output.fields["p]q"]',
        'steps.mail.output.headers[name="Subject"].value',
        'steps.call/sub.output.x',
    ])('clean: %s', (p) => {
        expect(BH.isCleanPath(p)).toBe(true);
        const b = BH.bindingFromInput(p, 'expression') as { kind: string; path: string };
        expect(b.kind).toBe('ref');
    });

    it.each([
        'x + 1', 'steps.a.output.total-1', 'steps.a.output.total - steps.a.output.tax',
        'steps.a.output.total-steps.a.output.tax', 'lower(trigger.output.x)', '42', '"text"', '',
    ])('not a path: %j', (p) => {
        expect(BH.isCleanPath(p)).toBe(false);
    });

    it('stores a picked path canonically, so every engine reads it', () => {
        expect(BH.bindingFromInput("steps.graph.output['@odata.nextLink']", 'expression'))
            .toEqual({ kind: 'ref', path: 'steps.graph.output["@odata.nextLink"]' });
        expect(BH.bindingFromInput('trigger.output.headers.content-type', 'expression'))
            .toEqual({ kind: 'ref', path: 'trigger.output.headers["content-type"]' });
        expect(BH.bindingFromInput('steps.a.output.items.0.id', 'expression'))
            .toEqual({ kind: 'ref', path: 'steps.a.output.items[0].id' });
        expect(BH.bindingFromInput('steps.a.output.total-1', 'expression'))
            .toEqual({ kind: 'expr', value: 'steps.a.output.total-1' });
    });

    it('a template whose key holds braces is still a template', () => {
        expect(BH.detectTemplate('v={{steps.jira.output.fields["x}y"]}}')).toBe(true);
        expect(BH.bindingFromInput('v={{steps.jira.output.fields["x}}y"]}}', 'fixed'))
            .toEqual({ kind: 'template', value: 'v={{steps.jira.output.fields["x}}y"]}}' });
        expect(BH.detectTemplate('{{ }}')).toBe(false);
    });
});

describe('insertion writes canonical paths and templates', () => {
    it.each([
        ['trigger.output.headers.content-type', '{{trigger.output.headers["content-type"]}}'],
        ["steps.graph.output['@odata.nextLink']", '{{steps.graph.output["@odata.nextLink"]}}'],
        ['steps.jira.output.fields["x}}y"]', '{{steps.jira.output.fields["x}}y"]}}'],
        ['  steps.a.output.x  ', '{{steps.a.output.x}}'],
        ['steps.call/sub.output.a', '{{steps.call/sub.output.a}}'],
    ])('%s', (path, tpl) => {
        expect(BH.formatPathForInsert(path, 'fixed')).toBe(tpl);
        expect(BH.formatPathForInsert(path, 'expression')).toBe(tpl.slice(2, -2));
    });

    it('a canonical insert resolves at run time', () => {
        const p = BH.formatPathForInsert('steps.jira.output.fields["x}y"]', 'expression') as string;
        expect(getPath(ROOT, p)).toBe(2);
    });
});

describe('condition helpers are grammar-aware', () => {
    it('a {{…}} value with a bracket key serialises as a reference, not a string', () => {
        const expr = BH.buildConditionExpr('trigger.output.status', '==', {
            kind: 'template', value: '{{steps.jira.output.fields["Story Points"]}}',
        }) as string;
        expect(expr).toBe('trigger.output.status == steps.jira.output.fields["Story Points"]');
        expect(evaluate('steps.jira.output.fields["Story Points"] == 5', ROOT)).toBe(true);
    });

    it('a dotted key with a dash collapses to the bracket form the engine reads', () => {
        const r = BH.renderBindingValue({ kind: 'template', value: '{{trigger.output.headers.content-type}}' }) as string;
        expect(r).toBe('trigger.output.headers["content-type"]');
        expect(evaluate(r, ROOT)).toBe('application/json');
    });

    it('mixed text with quoted keys becomes concat(...)', () => {
        const r = BH.renderBindingValue({ kind: 'template', value: 'Hi {{steps.graph.output["@odata.nextLink"]}}!' }) as string;
        expect(r).toBe('concat("Hi ", steps.graph.output["@odata.nextLink"], "!")');
        expect(evaluate(r, ROOT)).toBe('Hi https://next!');
    });

    it('a quoted key with an operator in it does not split the condition', () => {
        expect(BH.parseSimpleCondition('steps.jira.output.fields["a > b"] > 3'))
            .toEqual({ leftPath: 'steps.jira.output.fields["a > b"]', op: '>', rightRaw: '3' });
        expect(BH.parseSimpleCondition('steps.jira.output.fields["Story Points"] >= 2'))
            .toEqual({ leftPath: 'steps.jira.output.fields["Story Points"]', op: '>=', rightRaw: '2' });
    });
});

describe('names from paths', () => {
    it.each([
        ['steps.jira.output.fields["Story Points"]', 'Story_Points'],
        ['steps.mail.output.headers[name="Subject"].value', 'Subject'],
        ['steps.s1.output.items[*].email', 'email'],
        ['steps.s1.output', 's1'],
        ['trigger.output["content-type"]', 'content_type'],
        ['', 'field'],
    ])('suggestKeyFromPath(%s)', (p, key) => {
        expect(BH.suggestKeyFromPath(p)).toBe(key);
    });

    it.each([
        ['fields["Story Points"]', 'Story Points'],
        ['headers[name="Subject"].value', 'Subject'],
        ['headers[name="Subject"]', 'Subject'],
        ['headers[name="Subject"].id', 'id'],
        ['items[0]', 'items'],
        ['["@odata.nextLink"]', '@odata.nextLink'],
        ['', ''],
    ])('pathLeafKey(%s)', (p, key) => {
        expect(h.pathLeafKey(p)).toBe(key);
    });
});

describe('structured values survive the raw editor', () => {
    const map = { Datum: { kind: 'ref', path: 'steps.a.output.date' }, Bedrag: { kind: 'ref', path: 'steps.a.output.amount' } };

    it('knows a bare map, an array and an object literal from a binding', () => {
        expect(h.isStructuredBinding(map)).toBe(true);
        expect(h.isStructuredBinding([1, 2])).toBe(true);
        expect(h.isStructuredBinding({ kind: 'literal', value: { a: 1 } })).toBe(true);
        expect(h.isStructuredBinding({ kind: 'literal', value: 'x' })).toBe(false);
        expect(h.isStructuredBinding({ kind: 'ref', path: 'a' })).toBe(false);
        expect(h.isStructuredBinding(null)).toBe(false);
    });

    it('edited JSON text comes back in the same shape; anything else is refused', () => {
        const text = JSON.stringify({ ...map, Extra: { kind: 'literal', value: 1 } });
        expect(h.structuredFromText(text, map)).toEqual({ ...map, Extra: { kind: 'literal', value: 1 } });
        expect(h.structuredFromText('[1,2,3]', { kind: 'literal', value: [1] })).toEqual({ kind: 'literal', value: [1, 2, 3] });
        expect(h.structuredFromText('{"Datum": ', map)).toBeNull();
        expect(h.structuredFromText('"just text"', map)).toBeNull();
    });
});
