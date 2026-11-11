import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SAMPLE_DEFINITION } from './lockstep.fixture.mjs';
import { collectIds, findSection, findScreen } from './tree.mjs';
import { updateSection, moveSection, duplicateSection, moveScreen, duplicateScreen } from './structureOps.mjs';
import * as definitionOps from './definitionOps.mjs';

function frozenSample() {
    const deepFreeze = (v) => {
        if (v && typeof v === 'object' && !Object.isFrozen(v)) {
            Object.freeze(v);
            for (const x of Object.values(v)) deepFreeze(x);
        }
        return v;
    };
    return deepFreeze(structuredClone(SAMPLE_DEFINITION));
}

const sectionIds = (def, screenId) => findScreen(def, screenId).sections.map((s) => s.id);
const nodeIdsOf = (nodes, out = []) => {
    for (const n of nodes || []) { out.push(n.id); nodeIdsOf(n.children, out); }
    return out;
};

test('definitionOps.mjs re-exports every structure op', () => {
    for (const name of ['updateSection', 'moveSection', 'duplicateSection', 'moveScreen', 'duplicateScreen']) {
        assert.equal(typeof definitionOps[name], 'function', name);
    }
});

test('updateSection sets keys, removes them with null, and never touches id, style or children', () => {
    const def = frozenSample();
    const set = updateSection(def, 'sec_bot001', { title: 'Totals', maxWidth: 'narrow' });
    assert.notEqual(set, def);
    assert.deepEqual(findSection(set, 'sec_bot001').section, { ...findSection(def, 'sec_bot001').section, title: 'Totals', maxWidth: 'narrow' });
    assert.equal(set.screens[1], def.screens[1], 'the untouched screen keeps its identity');

    const removed = updateSection(set, 'sec_bot001', { title: null, maxWidth: undefined });
    assert.deepEqual(findSection(removed, 'sec_bot001').section, findSection(def, 'sec_bot001').section);
    assert.ok(!('title' in findSection(removed, 'sec_bot001').section));

    assert.equal(updateSection(def, 'sec_bot001', { id: 'sec_other0', style: { gap: 1 }, children: [] }), def);
    assert.equal(updateSection(def, 'sec_bot001', { title: null }), def);
    assert.equal(updateSection(def, 'sec_none00', { title: 'x' }), def);
    assert.equal(updateSection(def, 'sec_bot001', null), def);
    assert.equal(updateSection(def, 'sec_bot001', ['title']), def);
});

test('updateSection with an equal list or formula is a no-op (same reference)', () => {
    const def = updateSection(frozenSample(), 'sec_det001', { visibleToRoles: ['manager'], visibleWhen: { kind: 'formula', expr: 'vars.a' } });
    assert.equal(updateSection(def, 'sec_det001', { visibleToRoles: ['manager'], visibleWhen: { kind: 'formula', expr: 'vars.a' } }), def);
});

test('moveSection reorders within the screen, clamps the index and is a no-op in place', () => {
    const def = frozenSample();
    assert.deepEqual(sectionIds(moveSection(def, 'sec_top001', 1), 'scr_home01'), ['sec_bot001', 'sec_top001']);
    assert.deepEqual(sectionIds(moveSection(def, 'sec_top001', 99), 'scr_home01'), ['sec_bot001', 'sec_top001']);
    assert.deepEqual(sectionIds(moveSection(def, 'sec_bot001', -1), 'scr_home01'), ['sec_bot001', 'sec_top001']);
    assert.equal(moveSection(def, 'sec_top001', 0), def);
    assert.equal(moveSection(def, 'sec_det001', 0), def, 'the only section of a screen stays put');
    assert.equal(moveSection(def, 'sec_none00', 0), def);
});

test('duplicateSection copies with fresh ids everywhere and keeps the action wiring', () => {
    const def = frozenSample();
    const { def: next, sectionId } = duplicateSection(def, 'sec_top001');
    assert.deepEqual(sectionIds(next, 'scr_home01'), ['sec_top001', sectionId, 'sec_bot001']);
    const original = findSection(def, 'sec_top001').section;
    const copy = findSection(next, sectionId).section;
    const before = collectIds(def);
    for (const id of [sectionId, ...nodeIdsOf(copy.children)]) assert.ok(!before.has(id), `${id} is fresh`);
    assert.equal(new Set(nodeIdsOf(copy.children)).size, nodeIdsOf(original.children).length);
    assert.equal(collectIds(next).size, before.size + 1 + nodeIdsOf(original.children).length);
    const strip = (nodes) => nodes.map(({ id: _id, children, ...rest }) => ({ ...rest, ...(children ? { children: strip(children) } : {}) }));
    assert.deepEqual(strip(copy.children), strip(original.children), 'everything but the ids is the same');
    assert.deepEqual(copy.style, original.style);
    assert.notEqual(copy.style, original.style, 'a deep copy, not a shared object');
    assert.deepEqual(duplicateSection(def, 'sec_none00'), { def, sectionId: null });
});

test('moveScreen reorders the screens and is a no-op in place', () => {
    const def = frozenSample();
    const next = moveScreen(def, 'scr_detl01', 0);
    assert.deepEqual(next.screens.map((s) => s.id), ['scr_detl01', 'scr_home01']);
    assert.equal(next.screens[0], def.screens[1]);
    assert.equal(next.homeScreenId, def.homeScreenId, 'home stays home');
    assert.equal(moveScreen(def, 'scr_home01', 0), def);
    assert.equal(moveScreen(def, 'scr_none00', 1), def);
});

test('duplicateScreen copies the screen after itself with fresh ids, its keys and an optional name', () => {
    const def = frozenSample();
    const { def: named, screenId } = duplicateScreen(def, 'scr_detl01', { name: '  Detail copy ' });
    assert.deepEqual(named.screens.map((s) => s.id), ['scr_home01', 'scr_detl01', screenId]);
    const copy = findScreen(named, screenId);
    assert.equal(copy.name, 'Detail copy');
    assert.deepEqual(copy.visibleToRoles, ['manager']);
    assert.equal(copy.maxWidth, 'wide');
    assert.ok(!collectIds(def).has(copy.sections[0].id));

    const { def: plain, screenId: plainId } = duplicateScreen(def, 'scr_home01');
    const home = findScreen(plain, plainId);
    assert.equal(home.name, 'Home');
    assert.deepEqual(plain.screens.map((s) => s.id), ['scr_home01', plainId, 'scr_detl01']);
    const buttons = nodeIdsOf(home.sections.flatMap((s) => s.children));
    assert.equal(buttons.length, 9);
    const btn = home.sections[0].children[2].children[0];
    assert.equal(btn.onClick, 'act_save01', 'a copied button runs the same action');
    assert.equal(plain.homeScreenId, 'scr_home01');
    assert.deepEqual(duplicateScreen(def, 'scr_none00'), { def, screenId: null });
});
