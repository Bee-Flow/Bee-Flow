/**
 * The approval step's runtime contract.
 *
 * The question an approver reads is the only thing standing between them and a
 * decision they are accountable for, so it has to arrive RENDERED: an approval
 * whose prompt quotes {{steps.total.output.amount}} and reaches a person as
 * literal braces is asking them to approve something they cannot see.
 * automation/templates.js already shipped an approval with bindings in its
 * prompt, so this was reaching real approvers.
 *
 * Run: node --test core/automationRunner/engine.approval.test.js
 *
 * No DB needed.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    execApproval, renderApprovalPrompt, resolveApprovalTtlMs, renderApprovalExtras,
    APPROVAL_DEFAULT_TTL_MS, APPROVAL_MAX_TTL_MS,
} = require('./engine');
const entitlements = require('../entitlements/entitlements');

// execApproval is gated on the Enterprise `approvals` capability BEFORE the
// run pauses — hasCapability fails closed without a real entitlements
// snapshot, so the harness grants it. The refusal is its own test below.
const realHasCapability = entitlements.hasCapability;
entitlements.hasCapability = async () => true;

const HOUR = 3600_000;

function runState(over = {}) {
    return {
        trigger: { output: { client: 'Acme BV' } },
        steps: { total: { output: { amount: 250 } } },
        vars: {},
        secrets: { apiKey: 'sk-live-do-not-leak' },
        ...over,
    };
}

/** Run execApproval and hand back whatever it threw. */
async function pauseOf(step, state = runState(), ctx = {}) {
    try {
        await execApproval(step, ctx, state, 'live');
    } catch (e) {
        return e;
    }
    throw new Error('execApproval did not pause');
}

test('the approver reads a rendered question, not braces', async () => {
    const step = { id: 'appr_1', type: 'approval', prompt: 'Send the {{steps.total.output.amount}} invoice to {{trigger.output.client}}?' };
    const err = await pauseOf(step);
    assert.strictEqual(err.name, 'ApprovalRequiredError');
    assert.strictEqual(err.prompt, 'Send the 250 invoice to Acme BV?');
    assert.strictEqual(err.stepId, 'appr_1');
});

test('secrets never reach the approval question', async () => {
    // This text is read by a person and leaves the platform in the approval
    // email, so it gets the same secrets-stripped state a form page does.
    const step = { id: 'appr_2', type: 'approval', prompt: 'Key is {{secrets.apiKey}} — ok?' };
    const err = await pauseOf(step);
    assert.ok(!err.prompt.includes('sk-live-do-not-leak'), `secret leaked into the prompt: ${err.prompt}`);
});

test('dry-run previews the rendered question too', async () => {
    // Previewing an approval is largely about checking the question reads
    // correctly once its bindings resolve.
    const step = { id: 'appr_3', type: 'approval', prompt: 'Pay {{steps.total.output.amount}}?' };
    const res = await execApproval(step, {}, runState(), 'dry_run');
    assert.strictEqual(res.output.approved, true);
    assert.strictEqual(res.output._dryRun, true);
    assert.strictEqual(res.output.prompt, 'Pay 250?');
});

test('a legacy `title` still works when there is no prompt', async () => {
    // Imported and pre-editor definitions carry `title`; the builder never
    // writes it, but dropping the read would break stored routines.
    const err = await pauseOf({ id: 'appr_4', type: 'approval', title: 'Old-style approval' });
    assert.strictEqual(err.prompt, 'Old-style approval');
});

test('a blank prompt falls back rather than rendering empty', async () => {
    for (const step of [
        { id: 'a', type: 'approval' },
        { id: 'a', type: 'approval', prompt: '' },
        { id: 'a', type: 'approval', prompt: '   ' },
    ]) {
        const err = await pauseOf(step);
        assert.strictEqual(err.prompt, 'Approval requested');
    }
});

test('renderApprovalPrompt is pure and reusable', () => {
    assert.strictEqual(
        renderApprovalPrompt({ prompt: 'Hi {{trigger.output.client}}' }, runState()),
        'Hi Acme BV',
    );
});

test('deadline resolution follows the documented precedence', () => {
    // nested expiresInMs  >  nested expiresInHours  >  legacy top-level  >  default
    assert.strictEqual(resolveApprovalTtlMs({ approval: { expiresInMs: 5000, expiresInHours: 99 }, expiresInHours: 1 }), 5000);
    assert.strictEqual(resolveApprovalTtlMs({ approval: { expiresInHours: 2 }, expiresInHours: 99 }), 2 * HOUR);
    assert.strictEqual(resolveApprovalTtlMs({ expiresInHours: 3 }), 3 * HOUR);
    assert.strictEqual(resolveApprovalTtlMs({}), APPROVAL_DEFAULT_TTL_MS);
});

test('0 hours means no deadline, and the ceiling is enforced', () => {
    // 0 is a real choice offered in the editor ("No deadline"), not an empty
    // value: a null TTL is what stops the reaper expiring the run.
    assert.strictEqual(resolveApprovalTtlMs({ approval: { expiresInHours: 0 } }), null);
    // Above the ceiling the engine clamps silently, which is why the validator
    // warns at save time rather than letting someone discover it a month later.
    assert.strictEqual(resolveApprovalTtlMs({ approval: { expiresInHours: 9999 } }), APPROVAL_MAX_TTL_MS);
});

test('a paused approval carries its deadline, and no-deadline carries null', async () => {
    const withDeadline = await pauseOf({ id: 'a', type: 'approval', prompt: 'q', approval: { expiresInHours: 1 } });
    const at = new Date(withDeadline.expiresAt).getTime();
    assert.ok(Math.abs(at - (Date.now() + HOUR)) < 60_000, 'deadline should be about an hour out');

    const none = await pauseOf({ id: 'a', type: 'approval', prompt: 'q', approval: { expiresInHours: 0 } });
    assert.strictEqual(none.expiresAt, null);
});

test('an approval inside a flowlet is refused at run time', async () => {
    // The resume path replays the PARENT graph by step id, so a pause inside a
    // layer's sub-graph has no resumable address. validate.js rejects this at
    // save time; this is the backstop for a definition that got in anyway.
    await assert.rejects(
        () => execApproval({ id: 'a', type: 'approval', prompt: 'q' }, { layerStack: ['flowlet_1'] }, runState(), 'live'),
        /not supported inside layers/,
    );
});

test('renderApprovalExtras carries the v2 clocks — and drops a half escalation', () => {
    const state = { trigger: { output: {} }, steps: {}, secrets: {} };
    const full = renderApprovalExtras({ approval: {
        remindAfterHours: 24, escalateTo: { userId: 'u9' }, escalateAfterHours: 48,
    } }, state);
    assert.strictEqual(full.remindAfterHours, 24);
    assert.deepStrictEqual(full.escalateTo, { userId: 'u9' });
    assert.strictEqual(full.escalateAfterHours, 48);

    // A target without a delay (or vice versa) is no escalation at all.
    const half = renderApprovalExtras({ approval: { escalateTo: { userId: 'u9' } } }, state);
    assert.strictEqual(half.escalateTo, null);
    assert.strictEqual(half.escalateAfterHours, null);
    const noTarget = renderApprovalExtras({ approval: { escalateAfterHours: 48 } }, state);
    assert.strictEqual(noTarget.escalateTo, null);

    // Junk hours never become a clock.
    const junk = renderApprovalExtras({ approval: { remindAfterHours: 0, escalateTo: { userId: 'u' }, escalateAfterHours: 'x' } }, state);
    assert.strictEqual(junk.remindAfterHours, null);
    assert.strictEqual(junk.escalateAfterHours, null);
});

test('renderApprovalExtras carries the panel — seats, rule, quorum, final approver', () => {
    const state = { trigger: { output: {} }, steps: {}, secrets: {} };
    const full = renderApprovalExtras({ approval: {
        approvers: [{ userId: 'u1' }, { groupId: 'g1' }, { userId: '', groupId: '' }],
        rule: 'quorum', quorum: 2, finalApprover: { userId: 'cfo' },
    } }, state);
    assert.deepStrictEqual(full.approvers, [{ userId: 'u1' }, { groupId: 'g1' }]);
    assert.strictEqual(full.rule, 'quorum');
    assert.strictEqual(full.quorum, 2);
    assert.deepStrictEqual(full.finalApprover, { userId: 'cfo' });

    // No panel: everything panel-shaped stays null, rule included.
    const none = renderApprovalExtras({ approval: { rule: 'all' } }, state);
    assert.strictEqual(none.approvers, null);
    assert.strictEqual(none.rule, null);
    // An invalid rule with a real panel falls back to 'all'.
    const bad = renderApprovalExtras({ approval: { approvers: [{ userId: 'u1' }], rule: 'majority' } }, state);
    assert.strictEqual(bad.rule, 'all');
});


test('an unlicensed org cannot pause a run on an approval — it fails the step instead', async () => {
    entitlements.hasCapability = async () => false;
    try {
        await assert.rejects(
            () => execApproval({ id: 's1', type: 'approval', prompt: 'Ship it?' }, { userId: 'u1', orgId: 'org1' }, {}, 'live'),
            (e) => {
                // Not an ApprovalRequiredError: the run must NOT park in
                // awaiting_approval with no record and nobody able to list it.
                assert.strictEqual(e.errorClass, 'license_required');
                assert.match(e.message, /Enterprise/);
                return true;
            },
        );
    } finally {
        entitlements.hasCapability = async () => true;
    }
});

test('a dry run previews an approval without needing the licence', async () => {
    entitlements.hasCapability = async () => false;
    try {
        const res = await execApproval({ id: 's1', type: 'approval', prompt: 'Ship it?' }, { userId: 'u1' }, {}, 'dry_run');
        assert.strictEqual(res.output.approved, true);
        assert.strictEqual(res.output._dryRun, true);
    } finally {
        entitlements.hasCapability = async () => true;
    }
});

test.after(() => { entitlements.hasCapability = realHasCapability; });
