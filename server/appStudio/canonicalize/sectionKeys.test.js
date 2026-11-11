'use strict';

// The optional section keys (componentSpecs/keys/section/*): kept when they say something, left
// out when absent or when they restate the default, idempotent, schema version 3 only when used,
// and checked by the validator against the rest of the definition.

const test = require('node:test');
const assert = require('node:assert/strict');

const { canonicalizeAppDefinition } = require('../canonicalize');
const { validateAppDefinition } = require('../validate');
const { emptyDefinition } = require('../componentSpecs');
const { SECTION_OPTIONAL_KEYS } = require('./screens');

function withSection(extra) {
    const def = emptyDefinition('Sections');
    def.roles = [{ id: 'manager', name: 'Manager' }];
    def.screens[0].sections.push({ id: 'sec_extra01', style: { padding: 4, gap: 3, background: 'none' }, children: [], ...extra });
    return def;
}

const canon = (def) => canonicalizeAppDefinition(def);
const extraOf = (out) => out.def.screens[0].sections[1];
const codes = (v) => [...v.errors, ...v.warnings].map((f) => `${f.code} @ ${f.path}`);

test('the cleaners run in the stored key order', () => {
    assert.deepEqual(Object.keys(SECTION_OPTIONAL_KEYS), ['name', 'title', 'collapsible', 'maxWidth', 'visibleWhen', 'visibleToRoles', 'theme']);
});

test('a section without the keys keeps exactly id, style and children and the base version', () => {
    const def = emptyDefinition('Plain');
    const out = canon(def);
    assert.deepEqual(Object.keys(out.def.screens[0].sections[0]), ['id', 'style', 'children']);
    assert.equal(out.def.schemaVersion, def.schemaVersion);
});

test('every key is kept in the stored order and raises the schema version to 3', () => {
    const out = canon(withSection({
        visibleToRoles: ['manager', 'manager'], maxWidth: 'wide', visibleWhen: { kind: 'formula', expr: 'vars.open' },
        collapsible: true, title: '  Open orders  ', name: 'Orders',
    }));
    assert.deepEqual(extraOf(out), {
        id: 'sec_extra01', style: { padding: 4, gap: 3, background: 'none' }, children: [],
        name: 'Orders', title: 'Open orders', collapsible: true, maxWidth: 'wide',
        visibleWhen: { kind: 'formula', expr: 'vars.open' }, visibleToRoles: ['manager'],
    });
    assert.equal(out.def.schemaVersion, 3);
    const again = canon(out.def);
    assert.equal(JSON.stringify(again.def), JSON.stringify(out.def), 'a second pass changes nothing');
});

test('a value that restates the default is left out, silently', () => {
    const out = canon(withSection({ title: '   ', name: '', collapsible: false, maxWidth: 'inherit', visibleToRoles: [] }));
    assert.deepEqual(Object.keys(extraOf(out)), ['id', 'style', 'children']);
    assert.ok(!(out.repairs || []).some((r) => String(r.path || '').includes('sections[1]')));
});

test('a wrong value is dropped and reported; a long title is cut to 80', () => {
    const out = canon(withSection({ title: 7, collapsible: 'yes', maxWidth: 'huge', visibleWhen: 'vars.open', visibleToRoles: 'manager', name: 'n'.repeat(90) }));
    assert.deepEqual(Object.keys(extraOf(out)), ['id', 'style', 'children', 'name']);
    assert.equal(extraOf(out).name.length, 60);
    const long = canon(withSection({ title: 't'.repeat(100) }));
    assert.equal(extraOf(long).title.length, 80);
    const r = canonicalizeAppDefinition(withSection({ maxWidth: 'huge' }));
    assert.deepEqual(r.repairs.map((x) => `${x.code} @ ${x.path}`), ['section.field_invalid @ screens[0].sections[1].maxWidth']);
});

test('the validator checks the formula, the role keys and a collapsible section without a title', () => {
    const bad = canon(withSection({ collapsible: true, visibleWhen: { kind: 'formula', expr: 'vars.x ==' }, visibleToRoles: ['managr'] })).def;
    assert.deepEqual(codes(validateAppDefinition(bad)), [
        'formula.parse_error @ screens[0].sections[1].visibleWhen.expr',
        'roles.ref_unknown @ screens[0].sections[1].visibleToRoles',
        'section.collapsible_untitled @ screens[0].sections[1].collapsible',
    ]);
    const good = canon(withSection({ title: 'History', collapsible: true, visibleWhen: { kind: 'formula', expr: 'vars.x == 1' }, visibleToRoles: ['manager'] })).def;
    assert.deepEqual(codes(validateAppDefinition(good)).filter((c) => c.includes('sections[1]')), []);
});
