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
import { createLegacyResolver, walkPath, walkRelativePath } from '@shared/mapping/index.mjs';
import { DEEP, INPUTS, RELATIVE, RESOLVE, TEMPLATE, WALK, WALK_ROOTS, makeState } from '@shared/mapping/corpus.mjs';
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
