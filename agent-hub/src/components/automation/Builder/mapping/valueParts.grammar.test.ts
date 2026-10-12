// @vitest-environment node
/**
 * The visual value model reads every path spelling the runtime reads, and
 * whatever it writes into a formula is the canonical spelling the expression
 * engine resolves to the same value.
 */
import { describe, expect, it } from 'vitest';
import { evaluate } from '@shared/expr/engine.mjs';
import * as vp from './valueParts';

type Fn = (...args: unknown[]) => unknown;
const buildValue = vp.buildValue as unknown as Fn;
const describeDataPath = vp.describeDataPath as unknown as Fn;
const parseValue = vp.parseValue as unknown as Fn;

type Parsed = { supported: boolean; parts: Array<Record<string, unknown>>; transform: string | null };
const parse = (b: unknown) => parseValue(b) as Parsed;

const ROOT = {
    trigger: { output: { headers: { 'content-type': 'Application/JSON' } } },
    steps: {
        jira: { output: { fields: { 'Story Points': 5, 'first name': 'Ann' } } },
        http: { output: { body: '{"first-name":"Bo","a\\"b":1}' } },
    },
};

describe('parseValue', () => {
    it.each([
        { kind: 'ref', path: 'steps.jira.output.fields["Story Points"]' },
        { kind: 'expr', value: 'steps.jira.output.fields["Story Points"]' },
        { kind: 'template', value: '{{steps.jira.output.fields["Story Points"]}}' },
        { kind: 'template', value: '{{ steps.jira.output.odd["x}}y"] }}' },
        { kind: 'ref', path: 'steps.mail.output.headers[name="Subject"].value' },
        { kind: 'ref', path: 'steps.list.output[0].id' },
    ])('one picked value: %j', (b) => {
        const p = parse(b);
        expect(p.supported).toBe(true);
        expect(p.parts).toHaveLength(1);
        expect(p.parts[0].type).toBe('data');
    });

    it('text around a quoted-key pick stays a chip with text', () => {
        const p = parse({ kind: 'template', value: 'Points: {{steps.jira.output.fields["Story Points"]}}!' });
        expect(p.parts.map(x => x.type)).toEqual(['text', 'data', 'text']);
    });

    it('a formula the engine reads as a subtraction is not shown as a field', () => {
        expect(parse({ kind: 'expr', value: 'trigger.output.headers.content-type' }).supported).toBe(false);
    });

    it('a transform over a quoted key is a chip with that transform', () => {
        const p = parse({ kind: 'expr', value: 'lower(steps.jira.output.fields["first name"])' });
        expect(p).toMatchObject({ supported: true, transform: 'lower' });
        expect(p.parts[0]).toEqual({ type: 'data', path: 'steps.jira.output.fields["first name"]' });
    });

    it('a JSON pick with an escaped quoted path keeps its chip', () => {
        const value = 'parseJson(steps.http.output.body, "[\\"first-name\\"]")';
        const p = parse({ kind: 'expr', value });
        expect(p.supported).toBe(true);
        expect(p.parts[0]).toEqual({ type: 'json', path: 'steps.http.output.body', jsonPath: '["first-name"]' });
        const b = buildValue(p.parts) as { kind: string; value: string };
        expect(b).toEqual({ kind: 'expr', value });
        expect(evaluate(b.value, ROOT)).toBe('Bo');
    });
});

describe('buildValue writes what the engine reads', () => {
    it('a transform over a dashed key uses the bracket spelling', () => {
        const b = buildValue([{ type: 'data', path: 'trigger.output.headers.content-type' }], 'lower') as { kind: string; value: string };
        expect(b).toEqual({ kind: 'expr', value: 'lower(trigger.output.headers["content-type"])' });
        expect(evaluate(b.value, ROOT)).toBe('application/json');
    });

    it('a lone pick is a canonical ref', () => {
        expect(buildValue([{ type: 'data', path: "steps.jira.output.fields['Story Points']" }]))
            .toEqual({ kind: 'ref', path: 'steps.jira.output.fields["Story Points"]' });
    });

    it('a JSON path holding both quote styles is written as an escaped literal', () => {
        const b = buildValue([{ type: 'json', path: 'steps.http.output.body', jsonPath: '["a\\"b"]' }]) as { value: string };
        expect(evaluate(b.value, ROOT)).toBe(1);
        expect(parse({ kind: 'expr', value: b.value }).parts[0]).toEqual({ type: 'json', path: 'steps.http.output.body', jsonPath: '["a\\"b"]' });
    });
});

describe('describeDataPath names the key, never the spelling', () => {
    const labels = new Map([['graph', 'Graph'], ['mail', 'Mail']]);
    it.each([
        ['steps.graph.output["@odata.nextLink"]', 'Graph', '@odata next link'],
        ['steps.mail.output.headers[name="Subject"].value', 'Mail', 'Subject'],
        ['item["Order date"]', 'Current row', 'Order date'],
        ['vars["my-var"]', 'Variable', 'My var'],
    ])('%s', (path, name, suffix) => {
        expect(describeDataPath(path, labels)).toMatchObject({ name, suffix });
    });
});
