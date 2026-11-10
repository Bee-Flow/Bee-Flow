// @typecheck
/**
 * knobGroupExtensions.js and expandStyleKnobs: style knobs granted by rule.
 *
 * A fixture directory written per test proves the mechanism; what the registry ships (nothing,
 * or any number of files) is only held to the rules every group follows.
 * Run: node --test appStudio/componentSpecs/knobGroupExtensions.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const specs = require('../componentSpecs');
const { loadKnobGroupExtensions } = require('./knobGroupExtensions');
const { cleanStyle } = require('../canonicalize/style');

const { STYLE_KNOBS, BASE_STYLE_KNOB_GROUPS, EXTENSION_STYLE_KNOB_GROUPS, STYLE_KNOB_GROUPS, expandStyleKnobs } = specs;
const CTX = { styleKnobs: STYLE_KNOBS, baseGroupNames: BASE_STYLE_KNOB_GROUPS.map((g) => g.name) };

const made = [];
after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

function fixtureDir(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-knob-groups-'));
    made.push(dir);
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), `module.exports = ${JSON.stringify(body)};\n`);
    return dir;
}

const glowKnob = { type: 'enum', values: ['none', 'soft', 'strong'], default: 'none', since: 3 };

test('the base groups expand exactly as before, and the shipped groups come after them', () => {
    assert.deepEqual(STYLE_KNOB_GROUPS, [...BASE_STYLE_KNOB_GROUPS, ...EXTENSION_STYLE_KNOB_GROUPS]);
    // The order the base has always produced: span earns width then visibility, height its pair.
    const baseExpansion = ['span', 'height', 'widthMode', 'widthValue', 'hideBelow', 'hideAbove', 'heightMode', 'heightValue'];
    assert.deepEqual(expandStyleKnobs(['span', 'height'], BASE_STYLE_KNOB_GROUPS), baseExpansion);
    // Nothing earned: the same array back (canonicalize and validate key off it).
    const gapOnly = ['gap'];
    assert.equal(expandStyleKnobs(gapOnly, BASE_STYLE_KNOB_GROUPS), gapOnly);

    // Whatever ships: the base expansion is a prefix, and everything after it is a knob of a shipped group.
    const shippedKnobs = EXTENSION_STYLE_KNOB_GROUPS.flatMap((g) => [...g.knobs]);
    const live = expandStyleKnobs(['span', 'height']);
    assert.deepEqual(live.slice(0, baseExpansion.length), baseExpansion);
    for (const knob of live.slice(baseExpansion.length)) assert.ok(shippedKnobs.includes(knob), `${knob} is not a knob of a shipped group`);

    // The shipped directory, read against the base knobs only (the way styleKnobs.js reads it), is what the hub serves.
    const baseKnobs = Object.fromEntries(Object.entries(STYLE_KNOBS).filter(([name]) => !shippedKnobs.includes(name)));
    const shipped = loadKnobGroupExtensions(path.join(__dirname, 'styleKnobGroups'), { ...CTX, styleKnobs: baseKnobs });
    assert.deepEqual(shipped.map((g) => g.name), EXTENSION_STYLE_KNOB_GROUPS.map((g) => g.name));
    for (const group of shipped) {
        for (const knob of group.knobs) {
            assert.equal(STYLE_KNOBS[knob], group.specs[knob], `${knob}: the vocabulary holds the group file's own object`);
            assert.ok(STYLE_KNOBS[knob].since >= 3, `${knob}: since 3 or more`);
        }
    }
});

test('an extension group is granted by rule, after the base groups, without duplicates', () => {
    const loaded = loadKnobGroupExtensions(fixtureDir({
        'shadow.js': { since: 3, grantedBy: 'span', knobs: { glow: glowKnob } },
        'outline.js': { since: 3, grantedBy: '*', knobs: { outlineTone: { type: 'colorOrRole', roles: ['primary'], default: null, since: 3 } } },
    }), CTX);
    assert.deepEqual(loaded.map((g) => g.name), ['outline', 'shadow']);
    const groups = [...BASE_STYLE_KNOB_GROUPS, ...loaded];
    assert.deepEqual(expandStyleKnobs(['span'], groups), ['span', 'widthMode', 'widthValue', 'hideBelow', 'hideAbove', 'outlineTone', 'glow']);
    // '*' reaches a list with neither span nor height (a modal, a section's own list).
    assert.deepEqual(expandStyleKnobs(['gap', 'padding'], groups), ['gap', 'padding', 'outlineTone']);
    // A knob the list already names is not added twice.
    assert.deepEqual(expandStyleKnobs(['span', 'glow'], groups).filter((k) => k === 'glow'), ['glow']);
});

test('refuses a group that is unsafe or incomplete', () => {
    const cases = [
        [{ 'advanced_width.js': { since: 3, grantedBy: 'span', knobs: { glow: glowKnob } } }, /base knob group/],
        [{ 'g.js': { since: 2, grantedBy: 'span', knobs: { glow: glowKnob } } }, /since/],
        [{ 'g.js': { since: 3, grantedBy: 'glow', knobs: { glow: glowKnob } } }, /grantedBy/],
        [{ 'g.js': { since: 3, grantedBy: 'span', knobs: {} } }, /at least one knob/],
        [{ 'g.js': { since: 3, grantedBy: 'span', knobs: { padding: glowKnob } } }, /already exists/],
        [{ 'g.js': { since: 3, grantedBy: 'span', knobs: { glow: { ...glowKnob, since: undefined } } } }, /since/],
        [{ 'g.js': { since: 3, grantedBy: 'span', knobs: { glow: { ...glowKnob, default: 'soft' } } } }, /default \(the identity\) first/],
        [{ 'g.js': { since: 3, grantedBy: 'span', knobs: { glow: { ...glowKnob, type: 'unitInt' } } } }, /has type/],
        [{ 'a.js': { since: 3, grantedBy: 'span', knobs: { glow: glowKnob } }, 'b.js': { since: 3, grantedBy: '*', knobs: { glow: glowKnob } } }, /already exists/],
    ];
    for (const [files, message] of cases) {
        assert.throws(() => loadKnobGroupExtensions(fixtureDir(files), CTX), message, JSON.stringify(files));
    }
});

test('an extension knob is never written out unless the definition sets it', () => {
    STYLE_KNOBS.glow = glowKnob;
    try {
        const notes = [];
        const push = (code) => notes.push(code);
        const allowed = ['span', 'padding', 'glow'];
        // A stored style without the knob comes back without it: no default appears.
        assert.deepEqual(cleanStyle({ span: 6 }, allowed, { span: 12 }, 'x', push), { span: 6 });
        assert.deepEqual(cleanStyle({ span: 6, glow: 'soft' }, allowed, { span: 12 }, 'x', push), { span: 6, glow: 'soft' });
        assert.deepEqual(notes, []);
    } finally {
        delete STYLE_KNOBS.glow;
    }
});
