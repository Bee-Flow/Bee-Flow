// @vitest-environment node
/**
 * "In use" reads the step's bindings with the runtime's grammar: a field the
 * run resolves through a quoted key, a match segment or a key holding `}` is
 * marked as used, whichever spelling the binding and the tree happen to use.
 */
import { describe, expect, it } from 'vitest';
import { countInUse, pathInUse, usedPathsIn } from './boundPaths';

const step = {
    id: 'notify',
    label: 'steps.fake.output.x',
    inputs: {
        a: { kind: 'ref', path: 'steps.jira.output.fields["Story Points"]' },
        b: { kind: 'ref', path: "steps.graph.output['@odata.nextLink']" },
        c: { kind: 'template', value: 'Hi {{ steps.s1.output.odd["a}}b"] }} and {{steps.mail.output.headers[name="Subject"].value}}' },
        d: { kind: 'expr', value: 'count(steps.s2.output.items[*]) > 2 && "steps.not.output.this" != ""' },
        e: { kind: 'ref', path: 'trigger.output.headers.content-type' },
    },
    forEach: { overRef: 'steps.list.output.rows ' },
};

describe('usedPathsIn / pathInUse', () => {
    const used = usedPathsIn(step);

    it('collects every reference in its canonical spelling', () => {
        expect([...used].sort()).toEqual([
            'steps.graph.output["@odata.nextLink"]',
            'steps.jira.output.fields["Story Points"]',
            'steps.list.output.rows',
            'steps.mail.output.headers[name="Subject"].value',
            'steps.s1.output.odd["a}}b"]',
            'steps.s2.output.items[*]',
            'trigger.output.headers["content-type"]',
        ]);
    });

    it.each([
        'steps.jira.output.fields["Story Points"]',
        "steps.jira.output.fields['Story Points']",
        'steps.jira.output.fields',
        'steps.graph.output["@odata.nextLink"]',
        'steps.mail.output.headers',
        'steps.s1.output.odd["a}}b"]',
        'trigger.output.headers.content-type',
        'steps.s2.output.items',
    ])('%s is in use', (p) => {
        expect(pathInUse(p, used)).toBe(true);
    });

    it('a string literal in a formula and the step label are not uses', () => {
        expect(pathInUse('steps.not.output.this', used)).toBe(false);
        expect(pathInUse('steps.fake.output.x', used)).toBe(false);
        expect(pathInUse('steps.jira.output.fields["Story"]', used)).toBe(false);
    });

    it('counts a quoted field of a group', () => {
        const fields = [{ path: 'steps.jira.output.fields["Story Points"]' }, { path: 'steps.jira.output.fields.summary' }];
        expect(countInUse(fields, used)).toBe(1);
    });

    it('survives a cycle', () => {
        const cyclic: Record<string, unknown> = { inputs: { a: { kind: 'ref', path: 'steps.a.output.x' } } };
        cyclic.self = cyclic;
        expect([...usedPathsIn(cyclic)]).toEqual(['steps.a.output.x']);
    });
});
