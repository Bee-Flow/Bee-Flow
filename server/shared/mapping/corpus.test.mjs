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
import * as parse from '../expr/parse.mjs';
import { createLegacyResolver, createResolver, walk, sourceBase, walkSource, manyItems, isCompose, walkPath, walkRelativePath } from './index.mjs';
import {
    makeState, WALK, WALK_ROOTS, RELATIVE, TEMPLATE, RESOLVE, DEEP, INPUTS,
    makeMappingState, WALK_V2, PICKS, EACH, COMPOSE, DEEP_V2, INPUTS_V2,
} from './corpus.mjs';

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

// ── v2: pick and compose, through the core (with the warning codes) and
// through bind.js (the values the runtime gets) ──────────────────────────

const warned = [];
const v2 = createResolver({ evaluate, parse, onWarning: (w) => warned.push(w.code) });
const codes = (fn) => { warned.length = 0; const value = fn(); return { value, warnings: [...warned] }; };

/** makeMappingState() with the repeat scope an EACH case runs in. */
function eachState({ over, item }) {
    const state = makeMappingState();
    return { ...state, _mappingScope: { over, item: manyItems(walkSource(over, state)).items[item], index: item } };
}

test('v2 walk: a key on a list maps over it, nesting and holes kept', () => {
    for (const { source, expected } of WALK_V2) {
        assert.deepStrictEqual(walk(sourceBase(source, makeMappingState()), source.path), expected, `source: ${label(source)}`);
    }
});

for (const [name, impl, withCodes] of [['shared core', v2, true], ['bind.js facade', bind, false]]) {
    test(`${name}: v2 picks`, () => {
        for (const { binding, expected, warnings = [] } of PICKS) {
            const got = codes(() => impl.resolveValue(binding, makeMappingState()));
            assert.deepStrictEqual(got.value, expected, `binding: ${label(binding)}`);
            if (withCodes) assert.deepStrictEqual(got.warnings, warnings, `warnings of: ${label(binding)}`);
        }
    });

    test(`${name}: v2 picks of the current item (take each)`, () => {
        for (const c of EACH) {
            const got = codes(() => impl.resolveValue(c.binding, eachState(c)));
            assert.deepStrictEqual(got.value, c.expected, `binding: ${label(c.binding)} item ${c.item}`);
            if (withCodes) assert.deepStrictEqual(got.warnings, c.warnings || [], `warnings of: ${label(c.binding)}`);
        }
    });

    test(`${name}: v2 compose, as a text field and as a binding`, () => {
        for (const { template, expected, warnings = [] } of COMPOSE) {
            const got = codes(() => impl.interpolateTemplate(template, makeMappingState()));
            assert.equal(got.value, expected, `template: ${label(template)}`);
            if (withCodes) assert.deepStrictEqual(got.warnings, warnings, `warnings of: ${label(template)}`);
            if (isCompose(template)) assert.equal(impl.resolveValue(template, makeMappingState()), expected);
        }
    });

    test(`${name}: v2 inside plain data, and what stays data`, () => {
        for (const { structure, expected } of DEEP_V2) {
            assert.deepStrictEqual(impl.resolveDeep(structure, makeMappingState()), expected, `structure: ${label(structure)}`);
        }
        for (const { inputs, opts, expected, warnings = [] } of INPUTS_V2) {
            const got = codes(() => impl.resolveInputs(inputs, makeMappingState(), opts));
            assert.deepStrictEqual(got.value, expected, `inputs: ${label(inputs)}`);
            if (withCodes) assert.deepStrictEqual(got.warnings, warnings, `warnings of: ${label(inputs)}`);
        }
    });
}

test('the v2 corpus covers what M2 promised: about 120 cases and more', () => {
    const total = WALK_V2.length + PICKS.length + EACH.length + COMPOSE.length + DEEP_V2.length + INPUTS_V2.length;
    assert.ok(total >= 160, `v2 corpus has ${total}`);
    assert.ok(PICKS.length >= 90 && WALK_V2.length >= 40 && EACH.length >= 10 && COMPOSE.length >= 10);
});

test('makeMappingState hands out a fresh object every call', () => {
    const a = makeMappingState();
    a.steps.orders.output.orders.length = 0;
    assert.equal(makeMappingState().steps.orders.output.orders.length, 4);
});

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
