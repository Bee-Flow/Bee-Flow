/**
 * The golden binding corpus, on the phone.
 *
 * vendor/corpus.mjs is server/shared/mapping/corpus.mjs, recorded from the
 * server runtime (automation/bind.js). Every case runs through the vendored
 * core and through the flow editor's own walker (bindings/walkPath.ts), so a
 * preview on the phone is held to what the run gets. The server runs the same
 * file under node --test, the web under vitest.
 */

import * as editor from '@/features/flow-editor/bindings/walkPath';
import { evaluate } from '@/shared/expr';

import { createLegacyResolver, walkPath, walkRelativePath } from './index';

interface Corpus {
    makeState: () => Record<string, unknown>;
    WALK: { path: unknown; expected: unknown }[];
    WALK_ROOTS: { path: unknown; root: unknown; expected: unknown }[];
    RELATIVE: { path: unknown; value: unknown; expected: unknown }[];
    TEMPLATE: { template: unknown; opts?: object; expected: string; warnings: string[] }[];
    RESOLVE: { binding: unknown; opts?: object; expected: unknown }[];
    DEEP: { structure: unknown; opts?: object; expected: unknown }[];
    INPUTS: { inputs: unknown; opts?: object; expected: unknown }[];
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const corpus = require('./vendor/corpus.mjs') as Corpus;
const { makeState } = corpus;
const resolver = createLegacyResolver({ evaluate });
const label = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

describe('the golden binding corpus', () => {
    it('is loaded, and is not empty — an empty corpus would pass everything', () => {
        expect(corpus.WALK.length).toBeGreaterThan(100);
        expect(corpus.TEMPLATE.length).toBeGreaterThan(50);
        expect(corpus.RESOLVE.length).toBeGreaterThan(50);
    });

    it.each(corpus.WALK.map((c) => [label(c.path), c] as const))('walkPath(%s)', (_label, { path, expected }) => {
        expect(walkPath(path, makeState())).toStrictEqual(expected);
        expect(editor.walkPath(path, makeState())).toStrictEqual(expected);
    });

    it('walkPath on odd roots and non-string paths', () => {
        for (const { path, root, expected } of corpus.WALK_ROOTS) {
            expect(editor.walkPath(path, root)).toStrictEqual(expected);
        }
    });

    it('walkRelativePath', () => {
        for (const { path, value, expected } of corpus.RELATIVE) {
            expect(walkRelativePath(path, value)).toStrictEqual(expected);
            expect(editor.walkRelativePath(path, value)).toStrictEqual(expected);
        }
    });

    it.each(corpus.TEMPLATE.map((c) => [label(c.template), c] as const))(
        'interpolateTemplate(%s)',
        (_label, { template, opts, expected, warnings }) => {
            const state = { ...makeState(), _templateWarnings: [] as string[] };
            expect(resolver.interpolateTemplate(template, state, opts)).toBe(expected);
            expect(state._templateWarnings).toStrictEqual(warnings);
        },
    );

    it('resolveValue, resolveDeep and resolveInputs', () => {
        for (const { binding, opts, expected } of corpus.RESOLVE) {
            expect(resolver.resolveValue(binding, makeState(), opts)).toStrictEqual(expected);
        }
        for (const { structure, opts, expected } of corpus.DEEP) {
            expect(resolver.resolveDeep(structure, makeState(), opts)).toStrictEqual(expected);
        }
        for (const { inputs, opts, expected } of corpus.INPUTS) {
            expect(resolver.resolveInputs(inputs, makeState(), opts)).toStrictEqual(expected);
        }
    });
});

// REGRESSION (confirmed bug "Preview shows a value for paths the runtime
// rejects"): walkPath.ts skipped REF_RE, so `items.0.x` and `body.content-type`
// previewed a value the run resolves to undefined.
describe('the flow editor preview rejects what the runtime rejects', () => {
    const root = {
        steps: { s1: { output: { items: [{ x: 'A' }] } } },
        trigger: { output: { body: { 'content-type': 'json' } } },
    };

    it('steps.s1.output.items.0.x previews as undefined', () => {
        expect(editor.walkPath('steps.s1.output.items.0.x', root)).toBeUndefined();
        expect(editor.walkPath('trigger.output.body.content-type', root)).toBeUndefined();
    });

    it('the spellings the runtime accepts still preview their value', () => {
        expect(editor.walkPath('steps.s1.output.items[0].x', root)).toBe('A');
        expect(editor.walkPath('trigger.output.body["content-type"]', root)).toBe('json');
    });
});
