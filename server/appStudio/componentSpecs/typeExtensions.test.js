// @typecheck
/**
 * typeExtensions.js: component types added as files in componentSpecs/types/.
 *
 * A fixture directory written per test proves the mechanism; what the registry ships (nothing,
 * or any number of files) is only held to the rules every entry follows.
 * Run: node --test appStudio/componentSpecs/typeExtensions.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const specs = require('../componentSpecs');
const { loadTypeExtensions } = require('./typeExtensions');
const { canonicalizeAppDefinition } = require('../canonicalize');
const { validateAppDefinition } = require('../validate');

const CTX = { baseSpecs: specs.COMPONENT_SPECS, styleKnobs: specs.STYLE_KNOBS, eventNames: specs.EVENT_NAMES };

/** A test-only extension type: never written into the shipped registry. */
function fixtureSpec(overrides = {}) {
    return {
        since: 3,
        mobile: { reason: 'Fixture: not drawn on the phone.' },
        label: 'Fixture widget',
        category: 'Content',
        description: 'A test-only type.',
        props: { title: { type: 'string', maxLen: 80, default: 'Hello' } },
        styleKnobs: ['span', 'padding'],
        defaultStyle: { span: 12 },
        ...overrides,
    };
}

const made = [];
after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

/** A fresh registry directory holding `files` ({ name: spec | source text }). */
function fixtureDir(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-types-'));
    made.push(dir);
    for (const [name, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : `module.exports = ${JSON.stringify(body)};\n`);
    }
    return dir;
}

test('the catalog is the base types, then the registry files in file-name order', () => {
    const base = [...specs.BASE_COMPONENT_TYPES];
    assert.deepEqual(specs.COMPONENT_TYPES.slice(0, base.length), base, 'the base types come first, in their own order');
    // Read the shipped directory against the base only, the way the hub does.
    const baseSpecs = Object.fromEntries(base.map((type) => [type, specs.COMPONENT_SPECS[type]]));
    const shipped = loadTypeExtensions(path.join(__dirname, 'types'), { ...CTX, baseSpecs });
    assert.deepEqual(specs.COMPONENT_TYPES.slice(base.length), Object.keys(shipped));
    for (const [type, spec] of Object.entries(shipped)) {
        assert.equal(specs.COMPONENT_SPECS[type], spec, `${type}: the hub serves the registry file's own object`);
        assert.ok(Number.isInteger(spec.since) && spec.since >= 3, `componentSpecs/types/${type}.js: since is an integer of 3 or more`);
        assert.ok(spec.mobile && spec.mobile.reason.trim(), `componentSpecs/types/${type}.js: mobile.reason says why the phone leaves it to the browser`);
    }
    for (const type of base) assert.equal(specs.COMPONENT_SPECS[type].since, undefined, `${type} is base: no since`);
});

test('a missing directory is an empty registry', () => {
    assert.deepEqual(Object.keys(loadTypeExtensions(path.join(os.tmpdir(), 'no-such-registry-dir-x9'), CTX)), []);
});

test('loads one type per file, in file-name order, skipping tests and other files', () => {
    const dir = fixtureDir({
        'zeta_widget.js': fixtureSpec({ label: 'Zeta' }),
        'alpha_widget.js': fixtureSpec({ label: 'Alpha' }),
        'alpha_widget.test.js': 'throw new Error("a test file is not a registry item");\n',
        'README.md': '# not a type\n',
    });
    const out = loadTypeExtensions(dir, CTX);
    assert.deepEqual(Object.keys(out), ['alpha_widget', 'zeta_widget']);
    assert.equal(out.alpha_widget.label, 'Alpha');
    assert.equal(Object.getPrototypeOf(out), null);
});

test('refuses an extension that is unsafe or incomplete', () => {
    const cases = [
        [{ 'heading.js': fixtureSpec() }, /base type/],
        [{ 'x_widget.js': fixtureSpec({ since: undefined }) }, /since/],
        [{ 'x_widget.js': fixtureSpec({ since: 2 }) }, /since/],
        [{ 'x_widget.js': fixtureSpec({ mobile: undefined }) }, /mobile\.reason/],
        [{ 'x_widget.js': fixtureSpec({ mobile: { reason: ' ' } }) }, /mobile\.reason/],
        [{ 'x_widget.js': fixtureSpec({ styleKnobs: ['span', 'glow'] }) }, /unknown style knob "glow"/],
        [{ 'x_widget.js': fixtureSpec({ events: ['onHover'] }) }, /unknown event "onHover"/],
        [{ 'x_widget.js': fixtureSpec({ label: '' }) }, /label/],
        [{ 'X-Widget.js': fixtureSpec() }, /lower_snake_case/],
    ];
    for (const [files, message] of cases) {
        assert.throws(() => loadTypeExtensions(fixtureDir(files), CTX), message, JSON.stringify(Object.keys(files)));
    }
});

test('an extension type runs through canonicalize and validate like a base type', () => {
    const { fixture_widget: spec } = loadTypeExtensions(fixtureDir({ 'fixture_widget.js': fixtureSpec() }), CTX);
    // In-process only (each test file has its own process): the spec-driven pipeline reads
    // COMPONENT_SPECS at call time, which is what the hub fills from the registry.
    specs.COMPONENT_SPECS.fixture_widget = spec;
    try {
        const def = specs.emptyDefinition('extension');
        def.screens[0].sections[0].children = [{ id: 'cmp_fixt01', type: 'fixture_widget', props: {} }];
        const { def: canon } = canonicalizeAppDefinition(def);
        const node = canon.screens[0].sections[0].children[0];
        assert.equal(node.props.title, 'Hello');
        const res = validateAppDefinition(canon);
        assert.deepEqual(res.errors, [], JSON.stringify(res.errors));
    } finally {
        delete specs.COMPONENT_SPECS.fixture_widget;
    }
});
