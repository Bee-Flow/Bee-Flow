// @vitest-environment node
/**
 * The example line says what the RUN writes: the same walker, the same
 * placeholder scan and the same templateText the runtime's interpolateTemplate
 * uses, with the slot's listAs ('json' for tool, AI, code and table inputs).
 */
import { describe, expect, it } from 'vitest';
import { getPath, replaceTemplate } from '@shared/expr/path.mjs';
import { templateText } from '@shared/expr/templateText.mjs';
import previewBinding, { previewBindingShape } from './bindingPreview';

const ROOT = {
    steps: {
        graph: { output: { value: [{ from: 'a@x.nl' }, { from: 'b@x.nl' }], '@odata.nextLink': 'https://n' } },
        hub: { output: { properties: { firstname: 'Ann', city: 'Utrecht' } } },
        http: { output: { body: '{"data":{"items":[{"id":7}]}}' } },
        jira: { output: { fields: { 'x}y': 'brace' } } },
    },
};

/** What server/automation/bind.js interpolateTemplate writes (text and json slots). */
const run = (tpl: string, listAs: 'text' | 'json') => replaceTemplate(tpl, (inner: string) => {
    const v = getPath(ROOT, inner);
    return v === undefined ? '' : templateText(v, { lists: listAs === 'json' ? 'json' : 'join' });
});

describe('template preview = interpolateTemplate', () => {
    it.each([
        'To: {{steps.graph.output.value[*].from}}',
        'Contact: {{steps.hub.output.properties}}',
        'Mails: {{steps.graph.output.value}}',
        'Id {{steps.http.output.body.data.items[0].id}}',
        'Next {{steps.graph.output["@odata.nextLink"]}}',
        'B {{steps.jira.output.fields["x}y"]}}',
    ])('%s', (tpl) => {
        for (const listAs of ['text', 'json'] as const) {
            const want = run(tpl, listAs);
            const got = previewBinding({ kind: 'template', value: tpl }, ROOT, { listAs }) as string;
            // The example line is clipped to one short line; the start is the run's text.
            const shown = got.endsWith('…') ? got.slice(0, -1) : got;
            expect(want.replace(/\n/g, ' · ').startsWith(shown)).toBe(true);
        }
    });

    it('a data slot shows the JSON the tool receives', () => {
        expect(previewBinding({ kind: 'template', value: 'To: {{steps.graph.output.value[*].from}}' }, ROOT, { listAs: 'json' }))
            .toBe('To: ["a@x.nl","b@x.nl"]');
        expect(previewBinding({ kind: 'template', value: 'To: {{steps.graph.output.value[*].from}}' }, ROOT))
            .toBe('To: a@x.nl, b@x.nl');
    });

    it('a record reads "key: value" in text, not {firstname, city}', () => {
        expect(previewBinding({ kind: 'template', value: 'Contact: {{steps.hub.output.properties}}' }, ROOT))
            .toBe('Contact: firstname: Ann, city: Utrecht');
    });
});

describe('refs resolve like the run, nothing laxer', () => {
    it('JSON text is read as the value it encodes', () => {
        expect(previewBinding({ kind: 'ref', path: 'steps.http.output.body.data.items[0].id' }, ROOT)).toBe('7');
        expect(previewBindingShape({ kind: 'ref', path: 'steps.http.output.body.data.items' }, ROOT))
            .toMatchObject({ isList: true, count: 1 });
    });

    it('a spelling the run rejects previews as missing', () => {
        expect(previewBinding({ kind: 'ref', path: 'steps.graph.output.value[0x1].from' }, ROOT))
            .toBe('(no sample for steps.graph.output.value[0x1].from)');
    });
});
