/**
 * The owner's automations for validate.js (one lookup for the publication gate
 * and app_finalize), and how finalize reports an automation that is not active.
 * The store is passed in; canonicalize / validate run for real.
 *
 * Run: node --test appStudio/ownedAutomations.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadOwnedAutomations, inactiveAutomationsAsWarnings } = require('./ownedAutomations.mts');
const { emptyDefinition } = require('./componentSpecs');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { validateAppDefinition } = require('./validate');
const ops = require('./definitionOps');

const ROWS = [
    { id: 'auto-on', userId: 'u1', title: 'On', isActive: true },
    { id: 'auto-off', userId: 'u1', title: 'Off', isActive: false },
];
const store = { getAutomationsForUser: async (userId) => ROWS.filter((a) => a.userId === userId).map((a) => ({ ...a })) };

function defWith(automationId) {
    const { def } = ops.setAction(emptyDefinition('Automation check'), null, { kind: 'run_automation', automationId });
    return canonicalizeAppDefinition(def).def;
}

test('loadOwnedAutomations keeps the stored status and skips empty rows', async () => {
    const rows = await loadOwnedAutomations('u1', { getAutomationsForUser: async () => [null, { id: 'a', userId: 'u1', isActive: false, title: 'x' }] });
    assert.deepStrictEqual(rows, [{ id: 'a', userId: 'u1', isActive: false }]);
    assert.deepStrictEqual(await loadOwnedAutomations('u1', { getAutomationsForUser: async () => null }), []);
});

test('the publication gate refuses an inactive automation; finalize reports it as a warning', async () => {
    const owned = await loadOwnedAutomations('u1', store);
    const gate = validateAppDefinition(defWith('auto-off'), { ownedAutomations: owned });
    assert.strictEqual(gate.ok, false);
    assert.ok(gate.errors.some((e) => e.code === 'action.automation_inactive'), JSON.stringify(gate.errors));

    const atFinalize = inactiveAutomationsAsWarnings(gate);
    assert.strictEqual(atFinalize.ok, true, JSON.stringify(atFinalize.errors));
    const w = atFinalize.warnings.filter((x) => x.code === 'action.automation_inactive');
    assert.strictEqual(w.length, 1);
    assert.strictEqual(w[0].severity, 'warning');
    assert.match(w[0].message, /auto-off/);
});

test('an active automation passes both; a missing one stays an error at finalize', async () => {
    const owned = await loadOwnedAutomations('u1', store);
    const active = validateAppDefinition(defWith('auto-on'), { ownedAutomations: owned });
    assert.strictEqual(active.ok, true, JSON.stringify(active.errors));
    assert.strictEqual(inactiveAutomationsAsWarnings(active), active, 'nothing to move: the same object');

    const missing = inactiveAutomationsAsWarnings(validateAppDefinition(defWith('auto-elsewhere'), { ownedAutomations: owned }));
    assert.strictEqual(missing.ok, false);
    assert.ok(missing.errors.some((e) => e.code === 'action.automation_missing'), JSON.stringify(missing.errors));
});

test('other errors keep the result failing after the move', () => {
    const v = {
        ok: false,
        errors: [{ code: 'action.automation_inactive', severity: 'error' }, { code: 'meta.name_missing', severity: 'error' }],
        warnings: [],
    };
    const out = inactiveAutomationsAsWarnings(v);
    assert.strictEqual(out.ok, false);
    assert.deepStrictEqual(out.errors.map((e) => e.code), ['meta.name_missing']);
    assert.deepStrictEqual(out.warnings, [{ code: 'action.automation_inactive', severity: 'warning' }]);
});
