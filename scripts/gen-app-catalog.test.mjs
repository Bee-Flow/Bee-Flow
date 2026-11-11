/**
 * gen-app-catalog: the snapshot is a pure function of the spec (only the keys
 * the web reads, optional per-type fields only when the spec has them, a
 * `since` on a step only when the spec has one), typeEventLists.ts renders
 * from it, the demo catalog narrows components and refuses a type the catalog
 * lacks, and run() is a gate: --check names a stale or missing file and
 * writes nothing, write mode makes --check clean again.
 *
 * Sandbox style: a throwaway tree under os.tmpdir() with a tiny fake spec.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
    OUT, DEMO_TYPES, buildSnapshot, buildDemoCatalog, defaultPropsOf, renderMobileExtensions, renderTypeEventLists, run, toolNamesOf, toolVerbsOutput,
} from './gen-app-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fakeSpecs(extra = {}) {
    const COMPONENT_SPECS = {
        heading: { label: 'Heading', category: 'Content', props: { text: { type: 'string', default: 'Hi' }, level: { type: 'number' } }, styleKnobs: ['span'], defaultStyle: { span: 12 }, description: 'not bundled' },
        form: { label: 'Form', category: 'Input', container: true, events: ['onSubmit'], props: {}, styleKnobs: ['span', 'gap'], defaultStyle: { span: 6 } },
        'odd-type': { label: 'Odd', category: 'Data', isInput: true, events: [], since: 3, mobile: { reason: 'Needs a desktop.' }, props: {}, styleKnobs: [], defaultStyle: {} },
        ...extra,
    };
    return {
        COMPONENT_SPECS,
        SCHEMA_VERSION_CURRENT: 2,
        LIMITS: { MAX_SCREENS: 40 },
        COLOR_ROLES: ['primary'],
        STYLE_KNOBS: { span: { type: 'int', min: 1, max: 12, step: 1, default: 12 } },
        ADVANCED_WIDTH_KNOBS: ['widthMode'],
        ADVANCED_HEIGHT_KNOBS: ['heightMode'],
        RESPONSIVE_VISIBILITY_KNOBS: ['hideBelow'],
        THEME_SPEC: { primary: { type: 'color', default: '#000000' }, radius: { type: 'enum', values: ['sm', 'md'], default: 'md' } },
        SCREEN_SPEC: { name: { type: 'string', default: 'Screen' }, icon: { type: 'icon' }, maxWidth: { type: 'enum', values: ['narrow', 'wide'], default: 'wide' } },
        TOAST_TONES: ['info'],
        FORMULA_SCOPE_ROOTS: ['vars'],
        INPUT_TYPES: ['odd-type'],
        EVENT_NAMES: ['onSubmit'],
        STEP_KINDS: ['toast', 'create_record', 'later'],
        STEP_SPECS: { toast: { mutatesData: false, fields: {} }, create_record: { mutatesData: true, fields: {} }, later: { since: 3, fields: {} } },
        CLIENT_STEP_KINDS: ['toast'],
        buildCatalog: () => ({ schemaVersion: 2, components: COMPONENT_SPECS, limits: { MAX_SCREENS: 40 } }),
    };
}

test('the snapshot holds the trimmed slice, absent defaults as null', () => {
    const s = buildSnapshot(fakeSpecs());
    assert.deepStrictEqual(s.types.heading, { label: 'Heading', category: 'Content', defaultProps: { text: 'Hi', level: null }, defaultStyle: { span: 12 } });
    assert.deepStrictEqual(s.types.form, { label: 'Form', category: 'Input', container: true, defaultProps: {}, defaultStyle: { span: 6 } });
    assert.deepStrictEqual(s.types['odd-type'], { label: 'Odd', category: 'Data', isInput: true, defaultProps: {}, defaultStyle: {}, since: 3, mobile: { reason: 'Needs a desktop.' } });
    assert.deepStrictEqual(s.typeEvents, { form: ['onSubmit'] }, 'an empty events list is no entry');
    assert.deepStrictEqual(s.typeStyleKnobs, { heading: ['span'], form: ['span', 'gap'], 'odd-type': [] });
    assert.deepStrictEqual(s.themeEnums, { radius: ['sm', 'md'] });
    assert.deepStrictEqual(s.screenEnums, { maxWidth: ['narrow', 'wide'] });
    assert.deepStrictEqual(s.screenDefaults, { name: 'Screen', icon: null, maxWidth: 'wide' });
    assert.deepStrictEqual(s.steps, {
        toast: { client: true, mutatesData: false },
        create_record: { client: false, mutatesData: true },
        later: { client: false, mutatesData: false, since: 3 },
    });
    assert.ok(!JSON.stringify(s).includes('not bundled'), 'descriptions stay out of the bundle');
});

test('a prop or screen key added after the base is not a default: a new node or screen does not carry it', () => {
    const specs = fakeSpecs();
    specs.COMPONENT_SPECS.heading.props.kicker = { type: 'string', default: 'Above', since: 3 };
    specs.COMPONENT_SPECS.heading.props.old = { type: 'string', default: 'x', since: 2 };
    specs.SCREEN_SPEC.layout = { type: 'enum', values: [null, 'split'], default: null, since: 3 };
    const s = buildSnapshot(specs);
    assert.deepStrictEqual(s.types.heading.defaultProps, { text: 'Hi', level: null, old: 'x' });
    assert.deepStrictEqual(s.screenDefaults, { name: 'Screen', icon: null, maxWidth: 'wide' });
    // Its values are still listed: the inspector offers them.
    assert.deepStrictEqual(s.screenEnums.layout, [null, 'split']);
});

test('extension knob groups ride in the snapshot; the phone file lists each extension type with its reason', () => {
    const groups = [{ name: 'glow', since: 3, grantedBy: '*', knobs: ['glow'] }];
    assert.deepStrictEqual(buildSnapshot({ ...fakeSpecs(), EXTENSION_STYLE_KNOB_GROUPS: groups }).extensionKnobGroups, groups);
    const text = renderMobileExtensions(buildSnapshot(fakeSpecs()));
    assert.match(text, /^\/\/ GENERATED by scripts\/gen-app-catalog\.mjs/);
    assert.ok(text.includes("    'odd-type': 'Needs a desktop.',\n};"), text);
    assert.ok(!text.includes('heading'), 'a base type is not an extension');
    const baseOnly = fakeSpecs();
    delete baseOnly.COMPONENT_SPECS['odd-type'];
    const empty = renderMobileExtensions(buildSnapshot(baseOnly));
    assert.ok(empty.includes('Readonly<Record<string, string>> = {};'), empty);
});

test('defaultPropsOf: every prop, undefined default as null', () => {
    assert.deepStrictEqual(defaultPropsOf({ props: { a: { default: 0 }, b: {} } }), { a: 0, b: null });
    assert.deepStrictEqual(defaultPropsOf({}), {});
    assert.deepStrictEqual(defaultPropsOf({ props: { a: { default: 1 }, later: { default: null, since: 3 } } }), { a: 1 }, 'a later prop is never filled in');
});

test('typeEventLists.ts quotes a type that is not an identifier', () => {
    const text = renderTypeEventLists({ typeEvents: { button: ['onClick'], 'odd-type': ['onChange', "it's"] } });
    assert.match(text, /^\/\/ GENERATED by scripts\/gen-app-catalog\.mjs/);
    assert.ok(text.includes("    button: ['onClick'],\n"));
    assert.ok(text.includes("    'odd-type': ['onChange', 'it\\'s'],\n"));
    assert.ok(text.endsWith('};\n'));
});

test('the demo catalog narrows components and refuses a type the catalog lacks', () => {
    const demo = buildDemoCatalog(fakeSpecs(), ['form']);
    assert.deepStrictEqual(Object.keys(demo.components), ['form']);
    assert.strictEqual(demo.limits.MAX_SCREENS, 40);
    assert.throws(() => buildDemoCatalog(fakeSpecs(), ['nope']), /DEMO_TYPES names nope/);
});

test('the real spec generates, and every DEMO_TYPES entry exists', () => {
    const specs = createRequire(import.meta.url)(path.join(ROOT, 'server/appStudio/componentSpecs.js'));
    const s = buildSnapshot(specs);
    assert.deepStrictEqual(Object.keys(s.types), specs.COMPONENT_TYPES);
    assert.deepStrictEqual(Object.keys(buildDemoCatalog(specs).components), DEMO_TYPES);
});

test('toolNamesOf keeps the server order', () => {
    assert.deepStrictEqual(toolNamesOf([{ function: { name: 'b' } }, { function: { name: 'a' } }]), ['b', 'a']);
});

test('toolVerbsOutput writes the registry verbs, and {} when none ship', () => {
    assert.equal(toolVerbsOutput(undefined).file, OUT.toolVerbs);
    assert.equal(toolVerbsOutput(undefined).text, '{}\n');
    const verbs = { app_zz_echo: { key: 'zz.act_echo', en: 'Echoed' } };
    assert.deepStrictEqual(JSON.parse(toolVerbsOutput(verbs).text), verbs);
});

function sandbox() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-app-catalog-'));
    fs.mkdirSync(path.join(dir, 'server/appStudio'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    const s = fakeSpecs({});
    const types = Object.fromEntries(DEMO_TYPES.map((t) => [t, { label: t, category: 'Data', props: {}, styleKnobs: [], defaultStyle: {} }]));
    const source = `'use strict';
const base = ${JSON.stringify({ ...s, buildCatalog: undefined, COMPONENT_SPECS: { ...s.COMPONENT_SPECS, ...types } })};
module.exports = { ...base, buildCatalog: () => ({ schemaVersion: 2, components: base.COMPONENT_SPECS }) };
`;
    fs.writeFileSync(path.join(dir, 'server/appStudio/componentSpecs.js'), source);
    return dir;
}

test('run: --check fails on missing files and writes nothing; write mode makes it clean', () => {
    const dir = sandbox();
    const logs = [];
    const quiet = { log: (m) => logs.push(m), error: (m) => logs.push(m) };
    try {
        assert.strictEqual(run({ root: dir, check: true, ...quiet }), 1);
        assert.ok(!fs.existsSync(path.join(dir, OUT.snapshot)), '--check wrote nothing');
        assert.ok(logs.some((l) => l.includes(OUT.snapshot)), 'the stale file is named');

        assert.strictEqual(run({ root: dir, ...quiet }), 0);
        assert.strictEqual(run({ root: dir, check: true, ...quiet }), 0);

        fs.appendFileSync(path.join(dir, OUT.typeEvents), '// hand edit\n');
        logs.length = 0;
        assert.strictEqual(run({ root: dir, check: true, ...quiet }), 1);
        assert.ok(logs.some((l) => l.includes(OUT.typeEvents)), 'a hand edit is named');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
