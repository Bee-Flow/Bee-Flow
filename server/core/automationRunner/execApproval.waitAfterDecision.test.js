// @typecheck
/**
 * How long a form page waits when it becomes due right after an approval
 * (WI-12, D4c): the visitor was told they could close the page and comes back
 * from the link we mail them, so the step default of 1 h would reap the run
 * first. AUTOMATION_FORM_WAIT_AFTER_DECISION_MS (default 7 days, 0 = the step
 * default); an explicit waitSeconds on the step always wins; a test run's
 * pause stays capped by its profile.
 *
 * Run: cd server && node --test core/automationRunner/execApproval.waitAfterDecision.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

require('../../automation/runnerPorts');
process.env.NODE_ENV = 'test';

const {
    execFormPage, FormInputRequiredError, resolveFormWaitMs, formWaitAfterDecisionMs,
    FORM_WAIT_DEFAULT_MS, FORM_WAIT_MAX_MS, FORM_WAIT_MIN_MS, FORM_WAIT_AFTER_DECISION_DEFAULT_MS,
} = require('./execApproval');

const HOUR = 3600_000;
const DAY = 24 * HOUR;

test('the env value: unset or unreadable 7 days, 0 = the step default, a floor of one minute', () => {
    assert.strictEqual(FORM_WAIT_AFTER_DECISION_DEFAULT_MS, 7 * DAY);
    assert.strictEqual(formWaitAfterDecisionMs({}), 7 * DAY);
    assert.strictEqual(formWaitAfterDecisionMs({ AUTOMATION_FORM_WAIT_AFTER_DECISION_MS: '' }), 7 * DAY);
    assert.strictEqual(formWaitAfterDecisionMs({ AUTOMATION_FORM_WAIT_AFTER_DECISION_MS: 'soon' }), 7 * DAY);
    assert.strictEqual(formWaitAfterDecisionMs({ AUTOMATION_FORM_WAIT_AFTER_DECISION_MS: '-5' }), 7 * DAY);
    assert.strictEqual(formWaitAfterDecisionMs({ AUTOMATION_FORM_WAIT_AFTER_DECISION_MS: '0' }), null);
    assert.strictEqual(formWaitAfterDecisionMs({ AUTOMATION_FORM_WAIT_AFTER_DECISION_MS: String(2 * DAY) }), 2 * DAY);
    assert.strictEqual(formWaitAfterDecisionMs({ AUTOMATION_FORM_WAIT_AFTER_DECISION_MS: '10' }), FORM_WAIT_MIN_MS);
});

test('resolveFormWaitMs: after a decision the long default; otherwise 1 h; an explicit waitSeconds always wins', () => {
    assert.strictEqual(resolveFormWaitMs({}), FORM_WAIT_DEFAULT_MS);
    assert.strictEqual(resolveFormWaitMs({}, { afterDecision: true, env: {} }), 7 * DAY);
    assert.strictEqual(resolveFormWaitMs({}, { afterDecision: true, env: { AUTOMATION_FORM_WAIT_AFTER_DECISION_MS: '0' } }), FORM_WAIT_DEFAULT_MS);
    assert.strictEqual(resolveFormWaitMs({ waitSeconds: 1800 }, { afterDecision: true, env: {} }), 1800_000);
    assert.strictEqual(resolveFormWaitMs({ waitSeconds: 30 * 24 * 3600 }), FORM_WAIT_MAX_MS, 'the step value keeps its clamp');
});

const DEFINITION = {
    steps: [
        { id: 'gate', type: 'approval', approval: {} },
        { id: 'fp1', type: 'form_page' },
        { id: 'fp2', type: 'form_page', mode: 'input', form: { title: 'Page two', fields: [{ name: 'address', type: 'text', label: 'Address' }] } },
    ],
};
const PRODUCTION = { kind: 'production', pauses: 'real', pauseTtlMs: null };

/** The deadline (ms from now) the page paused with. */
async function pausedFor(ctx, step = DEFINITION.steps[2]) {
    const before = Date.now();
    try {
        await execFormPage(step, { layerStack: [], definition: DEFINITION, profile: PRODUCTION, ...ctx }, { trigger: { output: {} }, steps: {}, vars: {}, secrets: {} }, 'live');
    } catch (e) {
        assert.ok(e instanceof FormInputRequiredError, String(e));
        return Date.parse(String(e.expiresAt)) - before;
    }
    throw new Error('the page did not pause');
}

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 5000, `${actual} ≉ ${expected}`);

test('a page due in the leg that continued from an approval waits 7 days', async () => {
    delete process.env.AUTOMATION_FORM_WAIT_AFTER_DECISION_MS;
    near(await pausedFor({ resumedFromStepId: 'gate' }), 7 * DAY);
});

test('a first leg, or a leg that continued from another page, keeps the 1 h default', async () => {
    near(await pausedFor({}), HOUR);
    near(await pausedFor({ resumedFromStepId: 'fp1' }), HOUR);
});

test('the step\'s own waitSeconds wins after a decision too', async () => {
    near(await pausedFor({ resumedFromStepId: 'gate' }, { ...DEFINITION.steps[2], waitSeconds: 600 }), 600_000);
});

test('a test run stays capped by its profile\'s pause TTL', async () => {
    near(await pausedFor({ resumedFromStepId: 'gate', profile: { kind: 'test', pauses: 'real', pauseTtlMs: DAY } }), DAY);
});
