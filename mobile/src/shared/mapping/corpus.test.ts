/**
 * The golden binding corpus, on the phone.
 *
 * vendor/corpus.mjs is server/shared/mapping/corpus.mjs, recorded from the
 * server runtime (automation/bind.js). Every case runs through the vendored
 * core and through the walkers the flow editor imports (the bindings barrel,
 * which re-exports the core's: the port it kept of them is gone), so a
 * preview on the phone is held to what the run gets. The server runs the same
 * file under node --test, the web under vitest.
 */

import * as editor from '@/features/flow-editor/bindings';
import { evaluate } from '@/shared/expr';

import { createLegacyResolver, walkPath, walkRelativePath } from './index';
import * as core from './vendor/index.mjs';
import type { MappingSource } from './vendor/index.mjs';

interface V2Case { expected: unknown; warnings?: string[] }
interface Corpus {
    makeState: () => Record<string, unknown>;
    makeMappingState: () => Record<string, unknown>;
    WALK_V2: { source: MappingSource; expected: unknown }[];
    PICKS: (V2Case & { binding: unknown })[];
    EACH: (V2Case & { over: MappingSource; item: number; binding: unknown })[];
    COMPOSE: (V2Case & { template: unknown })[];
    DEEP_V2: { structure: unknown; expected: unknown }[];
    INPUTS_V2: (V2Case & { inputs: unknown; opts?: object })[];
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

// The v2 mapping on the phone: the same cases the server and the web run,
// with the warning codes. The number and date readers are the vendored
// shared/expr parse.mjs, as on the server.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const parse = require('../expr/vendor/parse.mjs') as object;

describe('the golden binding corpus: v2 pick and compose', () => {
    const warned: string[] = [];
    const v2 = core.createResolver({ evaluate, parse, onWarning: (w) => { warned.push(w.code); } });
    const codes = (fn: () => unknown) => { warned.length = 0; const value = fn(); return { value, warnings: [...warned] }; };
    const fresh = () => corpus.makeMappingState();

    it('walks a Source: a key on a list maps over it, nesting and holes kept', () => {
        for (const { source, expected } of corpus.WALK_V2) {
            expect(core.walk(core.sourceBase(source, fresh()), source.path)).toStrictEqual(expected);
        }
    });

    it.each(corpus.PICKS.map((c) => [label(c.binding), c] as const))('pick %s', (_label, { binding, expected, warnings = [] }) => {
        const got = codes(() => v2.resolveValue(binding, fresh()));
        expect(got.value).toStrictEqual(expected);
        expect(got.warnings).toStrictEqual(warnings);
    });

    it('a pick of the current item (take each)', () => {
        for (const c of corpus.EACH) {
            const state = fresh();
            const scope = { over: c.over, item: core.manyItems(core.walkSource(c.over, state)).items[c.item], index: c.item };
            const got = codes(() => v2.resolveValue(c.binding, { ...state, _mappingScope: scope }));
            expect(got.value).toStrictEqual(c.expected);
            expect(got.warnings).toStrictEqual(c.warnings ?? []);
        }
    });

    it('a compose, as a text field and as a binding', () => {
        for (const { template, expected, warnings = [] } of corpus.COMPOSE) {
            const got = codes(() => v2.interpolateTemplate(template, fresh()));
            expect(got.value).toBe(expected);
            expect(got.warnings).toStrictEqual(warnings);
            if (core.isCompose(template)) expect(v2.resolveValue(template, fresh())).toBe(expected);
        }
    });

    it('v2 inside plain data, and what stays data', () => {
        for (const { structure, expected } of corpus.DEEP_V2) expect(v2.resolveDeep(structure, fresh())).toStrictEqual(expected);
        for (const { inputs, opts, expected, warnings = [] } of corpus.INPUTS_V2) {
            const got = codes(() => v2.resolveInputs(inputs, fresh(), opts));
            expect(got.value).toStrictEqual(expected);
            expect(got.warnings).toStrictEqual(warnings);
        }
    });
});

// REGRESSION (confirmed bug "Preview shows a value for paths the runtime
// rejects"): the old bindings/walkPath.ts port skipped REF_RE, so `items.0.x` and `body.content-type`
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
