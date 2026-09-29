'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { THEME_SPEC, canonicalizeTheme, validateTheme } = require('./themeSpec');

// The five classic knobs, in spec order — what every theme carried before the
// optional colours existed, and what an untouched theme must still carry.
const CLASSIC = ['primary', 'radius', 'density', 'fontScale', 'appearance'];

test('an empty theme canonicalizes to exactly the five classic knobs — the optional colours stay absent', () => {
    const out = canonicalizeTheme({});
    assert.deepEqual(Object.keys(out), CLASSIC);
    assert.equal('accent' in out, false);
    assert.equal('canvas' in out, false);
});

test('optional colours are emit-when-present: a valid one is kept, an invalid or null one is dropped, never defaulted', () => {
    const out = canonicalizeTheme({ accent: '#009B3E', canvas: 'yellow' });
    assert.equal(out.accent, '#009B3E');
    assert.equal('canvas' in out, false);
    assert.equal('canvas' in canonicalizeTheme({ canvas: null }), false);
    assert.equal(canonicalizeTheme({ canvas: '#ffda00' }).canvas, '#ffda00');
});

test('the optional colours are marked optional in the spec and the classic ones are not', () => {
    assert.equal(THEME_SPEC.accent.optional, true);
    assert.equal(THEME_SPEC.canvas.optional, true);
    for (const k of CLASSIC) assert.equal(!!THEME_SPEC[k].optional, false, k);
});

test('validateTheme: null clears an optional colour but is an error on the primary; a bad hex is an error either way', () => {
    assert.deepEqual(validateTheme({ accent: null, canvas: null }), []);
    assert.deepEqual(validateTheme({ accent: '#009b3e', canvas: '#ffda00' }), []);

    const bad = validateTheme({ canvas: 'yellow', primary: null });
    assert.deepEqual(bad.map((i) => i.path).sort(), ['theme.canvas', 'theme.primary']);
    assert.ok(bad.every((i) => i.code === 'theme_color'));
});
