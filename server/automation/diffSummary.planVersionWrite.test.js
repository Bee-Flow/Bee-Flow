/**
 * automation/diffSummary.js planVersionWrite — what a definition write does
 * about versions (handoff 5): layout-only writes make none, a restore forces
 * one (marked layout-only when that is all it is), and every version carries
 * its plain-language description unless the caller brings its own.
 *
 * Run: cd server && node --test automation/diffSummary.planVersionWrite.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { planVersionWrite } = require('./diffSummary');

const DEF = {
    trigger: { id: 't', kind: 'manual', position: { x: 0, y: 0 } },
    steps: [{ id: 'a', type: 'code', code: '1', label: 'Calc', position: { x: 1, y: 1 } }],
    edges: [{ from: 't', to: 'a' }],
};
const clone = (x) => JSON.parse(JSON.stringify(x));

test('a layout-only write creates no version', () => {
    const next = clone(DEF);
    next.steps[0].position = { x: 400, y: 80 };
    const p = planVersionWrite(DEF, next);
    assert.strictEqual(p.createVersion, false);
    assert.strictEqual(p.isLayoutOnly, true);
});

test('an identical write creates no version either', () => {
    assert.strictEqual(planVersionWrite(DEF, clone(DEF)).createVersion, false);
});

test('a structural write creates a described version', () => {
    const next = clone(DEF);
    next.steps[0].code = '2';
    const p = planVersionWrite(DEF, next);
    assert.strictEqual(p.createVersion, true);
    assert.strictEqual(p.isLayoutOnly, false);
    assert.deepStrictEqual(p.descriptionJson, [{ code: 'setting_changed', params: { setting: 'Code', settingKey: 'code', step: 'Calc' } }]);
    assert.strictEqual(p.description, 'Code changed in "Calc"');
    assert.strictEqual(p.changeSummary, '1 step changed');
    assert.strictEqual(p.name, null);
});

test('a forced (restore) write of positions only is a version marked layout-only', () => {
    const next = clone(DEF);
    next.steps[0].position = { x: 9, y: 9 };
    const p = planVersionWrite(DEF, next, {
        forceVersion: true,
        versionMeta: { description: 'Restored from v2', descriptionJson: [{ code: 'restored', params: { version: 2 } }] },
    });
    assert.strictEqual(p.createVersion, true);
    assert.strictEqual(p.isLayoutOnly, true);
    assert.strictEqual(p.description, 'Restored from v2');
    assert.deepStrictEqual(p.descriptionJson, [{ code: 'restored', params: { version: 2 } }]);
});

test('caller meta wins; English text is derived from its codes when no text is given; a name is trimmed', () => {
    const next = clone(DEF);
    next.steps[0].code = '3';
    const p = planVersionWrite(DEF, next, { versionMeta: { name: '  Go-live  ', descriptionJson: [{ code: 'restored', params: { version: 4 } }] } });
    assert.strictEqual(p.description, 'Restored from v4');
    assert.strictEqual(p.name, 'Go-live');
});

test('garbage never throws and counts as structural', () => {
    const p = planVersionWrite({ steps: 5 }, { steps: [{ id: 'x' }] });
    assert.strictEqual(p.createVersion, true);
});

test('a settings-only write is a version described "Settings changed", marked layout-only so it is never pending', () => {
    for (const [key, value] of [
        ['notificationSettings', { onFailure: { enabled: true, channels: ['email'] } }],
        ['runPolicy', { retry: { max: 2 } }],
    ]) {
        const next = { ...clone(DEF), [key]: value };
        const p = planVersionWrite(DEF, next);
        assert.strictEqual(p.createVersion, true, key);
        assert.strictEqual(p.isLayoutOnly, true, key);
        assert.deepStrictEqual(p.descriptionJson, [{ code: 'settings_changed', params: {} }], key);
        assert.strictEqual(p.description, 'Settings changed', key);
    }
});

test('settings plus moved nodes is still settings-only; removing a setting counts too', () => {
    const prev = { ...clone(DEF), runPolicy: { retry: { max: 1 } } };
    const next = clone(prev);
    next.steps[0].position = { x: 50, y: 50 };
    next.notificationSettings = { onSuccess: { enabled: true } };
    assert.strictEqual(planVersionWrite(prev, next).isLayoutOnly, true);
    const removed = clone(prev);
    delete removed.runPolicy;
    const p = planVersionWrite(prev, removed);
    assert.strictEqual(p.isLayoutOnly, true);
    assert.strictEqual(p.description, 'Settings changed');
});

test('settings together with a step change is a normal pending version', () => {
    const next = { ...clone(DEF), runPolicy: { retry: { max: 2 } } };
    next.steps[0].code = '2';
    const p = planVersionWrite(DEF, next);
    assert.strictEqual(p.createVersion, true);
    assert.strictEqual(p.isLayoutOnly, false);
    assert.notDeepStrictEqual(p.descriptionJson, [{ code: 'settings_changed', params: {} }]);
});

test('caller meta still wins over the settings-only description', () => {
    const next = { ...clone(DEF), runPolicy: { retry: { max: 2 } } };
    const p = planVersionWrite(DEF, next, { versionMeta: { description: 'Restored from v2', descriptionJson: [{ code: 'restored', params: { version: 2 } }] } });
    assert.strictEqual(p.description, 'Restored from v2');
    assert.strictEqual(p.isLayoutOnly, true);
});
