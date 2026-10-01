// @vitest-environment node
/**
 * The golden binding corpus, on the web.
 *
 * server/shared/mapping/corpus.mjs was recorded from the server runtime
 * (automation/bind.js); src/shared/mapping/ is its generated copy
 * (`npm run gen:shared`). Running the same cases here, through the copy and
 * through the builder's own entry points in utils/bindingHelpers, is what
 * makes "the preview shows what the run gets" a tested fact rather than a
 * comment. The server runs the corpus under node --test, the phone under jest.
 */
import { describe, it, expect } from 'vitest';
import { evaluate } from '@shared/expr/index.mjs';
import * as parse from '@shared/expr/parse.mjs';
import {
    createLegacyResolver, createResolver, isCompose, manyItems, sourceBase, walk, walkPath, walkRelativePath, walkSource,
} from '@shared/mapping/index.mjs';
import type { MappingSource } from '@shared/mapping/index.mjs';
import {
    COMPOSE, DEEP, DEEP_V2, EACH, INPUTS, INPUTS_V2, PICKS, RELATIVE, RESOLVE, TEMPLATE, WALK, WALK_ROOTS, WALK_V2,
    makeMappingState, makeState,
} from '@shared/mapping/corpus.mjs';
import * as preview from '../utils/bindingHelpers';

const resolver = createLegacyResolver({ evaluate });
const label = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

describe('golden binding corpus (web copy of shared/mapping)', () => {
    it('walkPath, through the core and through the builder preview', () => {
        for (const { path, expected } of WALK) {
            expect(walkPath(path, makeState()), `path: ${label(path)}`).toStrictEqual(expected);
            expect(preview.walkPath(path, makeState()), `preview: ${label(path)}`).toStrictEqual(expected);
        }
        for (const { path, root, expected } of WALK_ROOTS) {
            expect(preview.walkPath(path, root), `path: ${label(path)}`).toStrictEqual(expected);
        }
    });

    it('walkRelativePath, through the core and through the builder preview', () => {
        for (const { path, value, expected } of RELATIVE) {
            expect(walkRelativePath(path, value), `path: ${label(path)}`).toStrictEqual(expected);
            expect(preview.walkRelativePath(path, value), `preview: ${label(path)}`).toStrictEqual(expected);
        }
    });

    it('interpolateTemplate, with the warnings it records', () => {
        for (const { template, opts, expected, warnings } of TEMPLATE) {
            const state = { ...makeState(), _templateWarnings: [] as string[] };
            expect(resolver.interpolateTemplate(template, state, opts), `template: ${label(template)}`).toBe(expected);
            expect(state._templateWarnings, `warnings of: ${label(template)}`).toStrictEqual(warnings);
        }
    });

    it('resolveValue, resolveDeep and resolveInputs', () => {
        for (const { binding, opts, expected } of RESOLVE) {
            expect(resolver.resolveValue(binding, makeState(), opts), `binding: ${label(binding)}`).toStrictEqual(expected);
        }
        for (const { structure, opts, expected } of DEEP) {
            expect(resolver.resolveDeep(structure, makeState(), opts), `structure: ${label(structure)}`).toStrictEqual(expected);
        }
        for (const { inputs, opts, expected } of INPUTS) {
            expect(resolver.resolveInputs(inputs, makeState(), opts), `inputs: ${label(inputs)}`).toStrictEqual(expected);
        }
    });

    it('is not empty: an empty corpus would pass everything', () => {
        expect(WALK.length).toBeGreaterThan(100);
        expect(TEMPLATE.length).toBeGreaterThan(50);
        expect(RESOLVE.length).toBeGreaterThan(50);
    });
});

// The v2 mapping (pick, compose, take each): the same cases the server runs,
// with the warning codes, so a preview on the web reads a pick as the run does.
describe('golden binding corpus: v2 pick and compose (web copy)', () => {
    const warned: string[] = [];
    const v2 = createResolver({ evaluate, parse, onWarning: (w) => { warned.push(w.code); } });
    const codes = (fn: () => unknown) => { warned.length = 0; const value = fn(); return { value, warnings: [...warned] }; };

    it('walks a Source: a key on a list maps over it, nesting and holes kept', () => {
        for (const { source, expected } of WALK_V2) {
            const src = source as MappingSource;
            expect(walk(sourceBase(src, makeMappingState()), src.path), `source: ${label(source)}`).toStrictEqual(expected);
        }
    });

    it('resolves every pick, with its warnings', () => {
        for (const { binding, expected, warnings = [] } of PICKS) {
            const got = codes(() => v2.resolveValue(binding, makeMappingState()));
            expect(got.value, `binding: ${label(binding)}`).toStrictEqual(expected);
            expect(got.warnings, `warnings of: ${label(binding)}`).toStrictEqual(warnings);
        }
    });

    it('resolves a pick of the current item (take each)', () => {
        for (const c of EACH) {
            const state = makeMappingState();
            const over = c.over as MappingSource;
            const scope = { over, item: manyItems(walkSource(over, state)).items[c.item], index: c.item };
            const got = codes(() => v2.resolveValue(c.binding, { ...state, _mappingScope: scope }));
            expect(got.value, `binding: ${label(c.binding)}`).toStrictEqual(c.expected);
            expect(got.warnings, `warnings of: ${label(c.binding)}`).toStrictEqual(c.warnings || []);
        }
    });

    it('renders a compose, as a text field and as a binding', () => {
        for (const { template, expected, warnings = [] } of COMPOSE) {
            const got = codes(() => v2.interpolateTemplate(template, makeMappingState()));
            expect(got.value, `template: ${label(template)}`).toBe(expected);
            expect(got.warnings, `warnings of: ${label(template)}`).toStrictEqual(warnings);
            if (isCompose(template)) expect(v2.resolveValue(template, makeMappingState())).toBe(expected);
        }
    });

    it('resolves v2 inside plain data, and leaves what is data alone', () => {
        for (const { structure, expected } of DEEP_V2) {
            expect(v2.resolveDeep(structure, makeMappingState()), `structure: ${label(structure)}`).toStrictEqual(expected);
        }
        for (const { inputs, opts, expected, warnings = [] } of INPUTS_V2) {
            const got = codes(() => v2.resolveInputs(inputs, makeMappingState(), opts));
            expect(got.value, `inputs: ${label(inputs)}`).toStrictEqual(expected);
            expect(got.warnings, `warnings of: ${label(inputs)}`).toStrictEqual(warnings);
        }
    });

    it('is not empty', () => {
        expect(PICKS.length).toBeGreaterThan(80);
        expect(WALK_V2.length).toBeGreaterThan(30);
    });
});

// REGRESSION (confirmed bug "Preview shows a value for paths the runtime
// rejects"): the builder's walkPath skipped REF_RE, so a ref the AI normaliser
// had written as `items.0.x`, or a hand-typed `body.content-type`, previewed the
// real value while the run resolved it to undefined, with no warning anywhere.
describe('the preview rejects what the runtime rejects', () => {
    const root = {
        steps: { s1: { output: { items: [{ x: 'A', subject: 'Hi' }] } } },
        trigger: { output: { body: { 'content-type': 'json' } } },
    };

    it('steps.s1.output.items.0.x previews as undefined', () => {
        expect(preview.walkPath('steps.s1.output.items.0.x', root)).toBeUndefined();
        expect(preview.walkPath('steps.s1.output.items.0.subject', root)).toBeUndefined();
        expect(preview.walkPath('trigger.output.body.content-type', root)).toBeUndefined();
        expect(preview.walkPath('steps..s1', root)).toBeUndefined();
    });

    it('the spellings the runtime accepts still preview their value', () => {
        expect(preview.walkPath('steps.s1.output.items[0].x', root)).toBe('A');
        expect(preview.walkPath('trigger.output.body["content-type"]', root)).toBe('json');
        expect(preview.walkPath('steps.s1.output.items[*].x', root)).toStrictEqual(['A']);
    });
});
