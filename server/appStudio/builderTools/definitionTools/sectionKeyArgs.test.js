'use strict';

// app_add_section / app_update_section and the optional section keys (title, name,
// collapsible, maxWidth, visibleWhen, visibleToRoles) they carry beside `style`.

const test = require('node:test');
const assert = require('node:assert/strict');

const { sectionKeyPatch, SECTION_KEY_NAMES } = require('./sectionKeyArgs.mts');
const { applyAddSection, applyUpdateSection } = require('./screens');
const { emptyDefinition } = require('../../componentSpecs');

const freshWrap = () => ({ userId: 'u1', orgId: null, appId: null, version: null, builderSessionId: 'bs_test', def: emptyDefinition('Test app') });
const sectionOf = (wrap, id) => wrap.def.screens[0].sections.find((s) => s.id === id);

test('sectionKeyPatch keeps only the section keys the canonicalizer knows, null included', () => {
    assert.deepEqual([...SECTION_KEY_NAMES].sort(), ['collapsible', 'maxWidth', 'name', 'theme', 'title', 'visibleToRoles', 'visibleWhen']);
    assert.deepEqual(sectionKeyPatch({ sectionId: 'sec_a', style: { gap: 1 }, title: 'A', name: null, bogus: 1, children: [] }), { title: 'A', name: null });
    assert.equal(sectionKeyPatch({ sectionId: 'sec_a', style: { gap: 1 } }), null);
    assert.equal(sectionKeyPatch(null), null);
    assert.equal(sectionKeyPatch(['title']), null);
});

test('app_add_section takes the section keys and reports a value it had to drop', () => {
    const wrap = freshWrap();
    const r = applyAddSection(wrap, { screenId: wrap.def.screens[0].id, title: 'Open orders', collapsible: true, maxWidth: 'huge' });
    assert.ok(!r.error, JSON.stringify(r));
    const section = sectionOf(wrap, r.sectionId);
    assert.equal(section.title, 'Open orders');
    assert.equal(section.collapsible, true);
    assert.ok(!('maxWidth' in section));
    assert.ok(r._hints.some((h) => h.includes('maxWidth')), JSON.stringify(r._hints));
    assert.equal(wrap.def.schemaVersion, 3, 'a definition using a section key is stored as schema version 3');
});

test('app_update_section sets and clears section keys without a style, and still refuses an empty call', () => {
    const wrap = freshWrap();
    const { sectionId } = applyAddSection(wrap, { screenId: wrap.def.screens[0].id, title: 'Draft' });
    const set = applyUpdateSection(wrap, {
        sectionId, style: {}, title: null, name: 'Results', maxWidth: 'narrow',
        visibleWhen: { kind: 'formula', expr: "vars.view == 'all'" }, visibleToRoles: [],
    });
    assert.ok(!set.error, JSON.stringify(set));
    assert.deepEqual(sectionOf(wrap, sectionId), {
        id: sectionId, style: { padding: 4, gap: 3, background: 'none' }, children: [],
        name: 'Results', maxWidth: 'narrow', visibleWhen: { kind: 'formula', expr: "vars.view == 'all'" },
    });
    const empty = applyUpdateSection(wrap, { sectionId, style: {} });
    assert.match(empty.error, /Nothing to change/);
    assert.match(empty.error, /title/);
    const styled = applyUpdateSection(wrap, { sectionId, style: { padding: 0 } });
    assert.ok(!styled.error);
    assert.equal(sectionOf(wrap, sectionId).style.padding, 0);
    assert.equal(sectionOf(wrap, sectionId).name, 'Results', 'a style change leaves the keys alone');
});

test('a plain app_add_section writes no section key and keeps the base schema version', () => {
    const wrap = freshWrap();
    const before = wrap.def.schemaVersion;
    const r = applyAddSection(wrap, { screenId: wrap.def.screens[0].id, style: { padding: 2 } });
    assert.deepEqual(Object.keys(sectionOf(wrap, r.sectionId)), ['id', 'style', 'children']);
    assert.equal(wrap.def.schemaVersion, before);
});
