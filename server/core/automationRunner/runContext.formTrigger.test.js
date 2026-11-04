/**
 * A form trigger entered with no answers in a dry run counts as synthetic
 * (RM-4): every trigger.output.* read is blank, so a read step that binds it
 * must synthesise instead of running live with an empty query (a mail search
 * for `from:` returned the owner's latest real mail).
 *
 * Run: node --test core/automationRunner/runContext.formTrigger.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { buildRunContext, isEmptyPayload } = require('./runContext');

const FORM = { id: 'trig', kind: 'form', form: { fields: [{ name: 'email', type: 'email' }] } };
const ctxOf = ({ mode = 'dry_run', trigger = FORM, payload = null } = {}) => buildRunContext({
    automation: { id: 'a1', userId: 'u1', definition: {} },
    runOrgId: null, isResume: false, session: null,
    run: { id: 'r1', triggerPayload: payload },
    tokenVault: null, runPolicy: null, stepRecord: null,
    effectiveMode: mode, onlyStepId: null, fromStepId: null, emitLifecycle: () => {},
    enteredTrigger: trigger,
    identity: { runUserGroupIds: [], runUserOrgRole: null, runUserHomeOrgId: null, runIdentityError: null },
});

test('a dry run of a form trigger without answers is synthetic', () => {
    assert.strictEqual(ctxOf().triggerSynthetic, true);
    assert.strictEqual(ctxOf({ payload: {} }).triggerSynthetic, true);
    assert.strictEqual(ctxOf({ payload: { _studioAppId: 'x' } }).triggerSynthetic, true, 'meta keys are not answers');
});

test('answers given (or a pinned sample, which arrives as the payload) are real', () => {
    assert.strictEqual(ctxOf({ payload: { email: 'a@example.test' } }).triggerSynthetic, false);
});

test('a live form run, and a manual trigger without a payload, are never synthetic', () => {
    assert.strictEqual(ctxOf({ mode: 'live' }).triggerSynthetic, false);
    assert.strictEqual(ctxOf({ trigger: { id: 't', kind: 'manual' } }).triggerSynthetic, false);
});

test('isEmptyPayload', () => {
    for (const v of [null, undefined, 'x', [], {}, { _meta: 1 }]) assert.strictEqual(isEmptyPayload(v), true, JSON.stringify(v));
    assert.strictEqual(isEmptyPayload({ a: '' }), false);
});

test('a form_page inherits the theme and the style of the trigger the run entered through', () => {
    const trigger = { ...FORM, form: { ...FORM.form, theme: { primary: '#1D4ED8' }, style: { font: 'serif' } } };
    const ctx = ctxOf({ trigger });
    assert.deepStrictEqual(ctx.formBaseTheme, { primary: '#1D4ED8' });
    assert.deepStrictEqual(ctx.formBaseStyle, { font: 'serif' });
    assert.strictEqual(ctxOf().formBaseStyle, null, 'no style: nothing to inherit');
});
