/**
 * The apps module's producer of the one Finding shape (./finding.js): App Studio's control_inert validator record
 * converts into Findings without a per-producer adapter. The shape itself is
 * finding.test.js.
 *
 * Run: node --test --test-force-exit core/findings/finding.apps.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { fromLegacy, isFinding } = require('./finding');

test('App Studio: component.control_inert carries kind + targetRef, and converts', () => {
    const { canonicalizeAppDefinition } = require('../../appStudio/canonicalize');
    const { validateAppDefinition } = require('../../appStudio/validate');
    const def = canonicalizeAppDefinition(structuredClone(require('../../appStudio/fixtures/calculatorApp.json'))).def;

    // Cut the wire of the first button that has one, and remember where it sat.
    let cut = null;
    const walk = (nodes, at) => {
        for (let i = 0; i < (nodes || []).length && !cut; i++) {
            const n = nodes[i];
            if (n?.type === 'button' && n.onClick) { delete n.onClick; cut = { id: n.id, path: `${at}.children[${i}]` }; return; }
            if (Array.isArray(n?.children)) walk(n.children, `${at}.children[${i}]`);
        }
    };
    def.screens.forEach((s, si) => s.sections.forEach((sec, ci) => walk(sec.children, `screens[${si}].sections[${ci}]`)));
    assert.ok(cut, 'the calculator fixture has a wired button to cut');

    const rec = validateAppDefinition(def).warnings.find((w) => w.code === 'component.control_inert');
    assert.ok(rec, 'the cut button is reported');
    assert.equal(rec.kind, 'app');
    assert.deepEqual(rec.targetRef, { kind: 'app', id: null, path: cut.path, nodeId: cut.id });
    assert.equal(rec.path, cut.path, 'the legacy path stays for existing callers');
    assert.equal(typeof rec.hint, 'string', 'the legacy hint stays for existing callers');

    const f = fromLegacy('app', rec, { id: 'app_calc', title: 'Calculator' });
    assert.equal(isFinding(f), true);
    assert.equal(f.targetRef.id, 'app_calc', 'the caller fills in the id the validator never saw');
    assert.equal(f.targetRef.nodeId, cut.id);
    assert.equal(f.remediation, rec.hint);
});
