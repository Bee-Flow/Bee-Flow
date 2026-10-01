/**
 * The golden binding corpus under `node --test`, through the shared core AND
 * through server/automation/bind.js, the CommonJS facade the runtime loads.
 * Green on both means the move into shared/mapping changed nothing.
 *
 * The same corpus runs on the web (agent-hub/src/shared/mappingCorpus.test.ts)
 * and on the phone (mobile/src/shared/mapping/corpus.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { evaluate } from '../expr/index.mjs';
import { createLegacyResolver, walkPath, walkRelativePath } from './index.mjs';
import { makeState, WALK, WALK_ROOTS, RELATIVE, TEMPLATE, RESOLVE, DEEP, INPUTS } from './corpus.mjs';

const bind = createRequire(import.meta.url)('../../automation/bind.js');
const core = { walkPath, walkRelativePath, ...createLegacyResolver({ evaluate }) };

const label = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

for (const [name, impl] of [['shared core', core], ['bind.js facade', bind]]) {
    test(`${name}: walkPath`, () => {
        for (const { path, expected } of WALK) {
            assert.deepStrictEqual(impl.walkPath(path, makeState()), expected, `path: ${label(path)}`);
        }
        for (const { path, root, expected } of WALK_ROOTS) {
            assert.deepStrictEqual(impl.walkPath(path, root), expected, `path: ${label(path)} root: ${label(root)}`);
        }
    });

    test(`${name}: walkRelativePath`, () => {
        for (const { path, value, expected } of RELATIVE) {
            assert.deepStrictEqual(impl.walkRelativePath(path, value), expected, `path: ${label(path)}`);
        }
    });

    test(`${name}: interpolateTemplate, with the warnings it records`, () => {
        for (const { template, opts, expected, warnings } of TEMPLATE) {
            const state = { ...makeState(), _templateWarnings: [] };
            assert.equal(impl.interpolateTemplate(template, state, opts), expected, `template: ${label(template)}`);
            assert.deepStrictEqual(state._templateWarnings, warnings, `warnings of: ${label(template)}`);
        }
    });

    test(`${name}: resolveValue`, () => {
        for (const { binding, opts, expected } of RESOLVE) {
            assert.deepStrictEqual(impl.resolveValue(binding, makeState(), opts), expected, `binding: ${label(binding)}`);
        }
    });

    test(`${name}: resolveDeep and resolveInputs`, () => {
        for (const { structure, opts, expected } of DEEP) {
            assert.deepStrictEqual(impl.resolveDeep(structure, makeState(), opts), expected, `structure: ${label(structure)}`);
        }
        for (const { inputs, opts, expected } of INPUTS) {
            assert.deepStrictEqual(impl.resolveInputs(inputs, makeState(), opts), expected, `inputs: ${label(inputs)}`);
        }
    });
}

test('the corpus is the size it was recorded at: a lost case would pass silently', () => {
    assert.ok(WALK.length >= 120, `WALK has ${WALK.length}`);
    assert.ok(TEMPLATE.length >= 70, `TEMPLATE has ${TEMPLATE.length}`);
    assert.ok(RESOLVE.length >= 70, `RESOLVE has ${RESOLVE.length}`);
    assert.ok(RELATIVE.length >= 20 && DEEP.length >= 10 && INPUTS.length >= 5 && WALK_ROOTS.length >= 10);
});

test('makeState hands out a fresh object every call', () => {
    const a = makeState();
    a.trigger.output.name = 'changed';
    assert.equal(makeState().trigger.output.name, 'Jan');
});
