/**
 * The Dutch for testing an automation in the builder. Pins the silent failure
 * modes: an English key under the prefixes it owns without Dutch leaves English on a
 * Dutch screen, a Dutch key without an English one is never read.
 *
 * Run: node --test migrations/add-nl-automation-testing-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { NL_TRANSLATIONS, applyNl } = require('./add-nl-automation-testing-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

// The parts of automation_testing.* this catalogue owns: trying a whole
// automation from the builder. The code-step test cases (case., assertions.,
// panel., ...) predate it and have no Dutch catalogue yet.
const OWNED_PREFIXES = ['header.', 'run_live.', 'execute_confirm.', 'run_phase.', 'start.', 'toast.', 'overlay.', 'assistant_images.']
    .map((p) => `automation_testing.${p}`);
// The run bar keys of the same round (automations.canvas.* is otherwise
// add-nl-builder-redesign's, whose test skips the keys seeded here).
const CANVAS_RUN_BAR = [
    'run_waiting_form_title', 'run_waiting_decision', 'run_waiting_decision_test', 'run_waiting_decision_any',
    'run_visitor_on_page', 'run_review_decide', 'run_stop_test', 'run_discard', 'run_version_behind',
    'run_keep_version', 'run_restart_current',
].map((k) => `automations.canvas.${k}`);

test('every English key under the owned prefixes has Dutch, and every Dutch key an English one', () => {
    const english = [
        ...Object.keys(GUI_DEFAULTS).filter((k) => OWNED_PREFIXES.some((p) => k.startsWith(p))),
        ...CANVAS_RUN_BAR,
    ];
    assert.ok(english.length > CANVAS_RUN_BAR.length, 'the owned automation_testing keys are gone');
    assert.deepStrictEqual(english.filter((k) => !(k in NL_TRANSLATIONS)), []);
    assert.deepStrictEqual(Object.keys(NL_TRANSLATIONS).filter((k) => !(k in GUI_DEFAULTS)), []);
});

test('a dry run is a proefrun, and the reader is je, never u', () => {
    assert.match(NL_TRANSLATIONS['automation_testing.header.dry_run'], /^Proefrun/);
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(!/\b(u|uw)\b/.test(v.replace(/\{[^}]*\}/g, '')), `${k} addresses the reader as u/uw`);
    }
});

test('a blob without the keys gets all of them, own wording is kept, a second run changes nothing', () => {
    const { merged, added } = applyNl({});
    assert.strictEqual(added, Object.keys(NL_TRANSLATIONS).length);
    const own = applyNl({ 'automation_testing.run_phase.done': 'Eigen woorden' });
    assert.strictEqual(own.merged['automation_testing.run_phase.done'], 'Eigen woorden');
    assert.strictEqual(applyNl({ ...merged }).added, 0);
});
