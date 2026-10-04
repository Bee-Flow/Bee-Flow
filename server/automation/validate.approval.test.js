/**
 * Validation rules for approval steps.
 *
 * Until approvals became authorable the validator read NO field off them, so an
 * approval could go live asking nothing at all — the approver saw "Approval
 * requested" and had to open the automation to find out what they were agreeing
 * to. These rules close that, without stranding the definitions that already
 * exist: the two new codes are COMPLETENESS codes, which warn while you build
 * and block only at activation.
 *
 * Run: node --test automation/validate.approval.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { validateDefinition } = require('./validate');

const TRIGGER = { id: 'trg', kind: 'manual', label: 'Manual' };

function def(steps, edges) {
    return {
        trigger: TRIGGER,
        steps,
        edges: edges || steps.map((s, i) => (i === 0
            ? { from: 'trg', to: s.id }
            : { from: steps[i - 1].id, to: s.id })),
    };
}

function approval(over = {}) {
    return { id: 'appr_1', type: 'approval', prompt: 'Send the invoice?', ...over };
}

/** Codes reported for a definition, at draft stage and at activation. */
function codes(definition, stage) {
    const res = validateDefinition(definition, { stage });
    return [
        ...(res.errors || []).map(e => e.code),
        ...(res.warnings || []).map(w => w.code),
    ];
}

test('a well-formed approval validates clean', () => {
    const found = codes(def([approval({ approval: { expiresInHours: 168 } })]), 'activate');
    assert.ok(!found.some(c => c.startsWith('approval.')), `unexpected: ${found.filter(c => c.startsWith('approval.')).join(', ')}`);
});

test('an approval with no question is reported', () => {
    for (const prompt of [undefined, '', '   ']) {
        const found = codes(def([approval({ prompt })]), 'activate');
        assert.ok(found.includes('approval.prompt_missing'), `prompt ${JSON.stringify(prompt)} should be reported`);
    }
});

test('a legacy approval carrying only `title` is NOT reported', () => {
    // The engine falls back to `title`, so such a step reaches its approver
    // with a real question. Flagging it would tell people their working
    // automations are broken — the validator mirrors renderApprovalPrompt.
    const found = codes(def([approval({ prompt: undefined, title: 'Sign off on the quote' })]), 'activate');
    assert.ok(!found.includes('approval.prompt_missing'), `got: ${found.join(', ')}`);
});

test('the missing question blocks activation but not the draft', () => {
    // A freshly dropped node is seeded blank on purpose, so autosave must go
    // amber rather than red — the same treatment loop.overRef_missing gets.
    const d = def([approval({ prompt: '' })]);
    const draft = validateDefinition(d, { stage: 'draft' });
    const activate = validateDefinition(d, { stage: 'activate' });

    assert.ok(!(draft.errors || []).some(e => e.code === 'approval.prompt_missing'),
        'a blank question must not be a draft ERROR');
    assert.ok((draft.warnings || []).some(w => w.code === 'approval.prompt_missing'),
        'a blank question must still be reported while drafting');
    assert.ok((activate.errors || []).some(e => e.code === 'approval.prompt_missing'),
        'a blank question must block activation');
});

test('a deadline outside the engine ceiling warns', () => {
    // The engine clamps silently at 30 days, so the point of this rule is to
    // TELL the author rather than let them discover it a month later.
    for (const hours of [9999, -1, Number.NaN]) {
        const found = codes(def([approval({ approval: { expiresInHours: hours } })]), 'activate');
        assert.ok(found.includes('approval.expiry_invalid'), `${hours} hours should warn`);
    }
});

test('0 and 720 hours are both legal', () => {
    // 0 = no deadline; 720 = the ceiling exactly.
    for (const hours of [0, 720, 168, 4]) {
        const found = codes(def([approval({ approval: { expiresInHours: hours } })]), 'activate');
        assert.ok(!found.includes('approval.expiry_invalid'), `${hours} hours should be accepted`);
    }
});

test('an approval that runs once per item is refused', () => {
    // execForEachStep rethrows the pause, so the run stops on item 1 and items
    // 2..n never run.
    const found = codes(def([approval({ forEach: { overRef: 'trigger.output.rows', itemVar: 'row' } })]), 'activate');
    assert.ok(found.includes('approval.forEach_forbidden'));
});

test('regression: an approval inside a loop body is still refused', () => {
    const d = def([{
        id: 'loop_1', type: 'loop', overRef: 'trigger.output.rows', itemVar: 'row',
        body: [approval()],
    }]);
    const found = codes(d, 'activate');
    assert.ok(found.includes('approval.nested_forbidden'), `got: ${found.join(', ')}`);
});

test('regression: an approval inside a parallel branch is still refused', () => {
    const d = def([{
        id: 'par_1', type: 'parallel',
        branches: [[approval()]],
    }]);
    const found = codes(d, 'activate');
    assert.ok(found.includes('approval.nested_forbidden'), `got: ${found.join(', ')}`);
});

// ── Rich-approval rules (assignee / details / attachments / fields) ──────

test('assignee must be exactly one person or one group', () => {
    const bad = [
        {},                                    // neither
        { userId: 'u1', groupId: 'g1' },       // both
        { userId: '' },                        // blank
        'u1',                                  // not an object
    ];
    for (const assignee of bad) {
        const found = codes(def([approval({ approval: { assignee } })]), 'activate');
        assert.ok(found.includes('approval.assignee_invalid'), `${JSON.stringify(assignee)} should be rejected`);
    }
    for (const assignee of [{ userId: 'u1' }, { groupId: 'g1' }, null]) {
        const found = codes(def([approval({ approval: { assignee } })]), 'activate');
        assert.ok(!found.includes('approval.assignee_invalid'), `${JSON.stringify(assignee)} should be accepted`);
    }
});

test('attachments are bounded and must carry bindings', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ binding: `{{steps.d.output.f${i}}}` }));
    assert.ok(codes(def([approval({ approval: { attachments: six } })]), 'activate')
        .includes('approval.attachments_invalid'), 'more than 5 should be rejected');
    assert.ok(codes(def([approval({ approval: { attachments: [{ label: 'no binding' }] } })]), 'activate')
        .includes('approval.attachments_invalid'), 'a row without a binding should be rejected');
    assert.ok(!codes(def([approval({ approval: { attachments: [{ binding: '{{steps.d.output.fileId}}', label: 'Quote' }] } })]), 'activate')
        .includes('approval.attachments_invalid'), 'a proper binding should pass');
});

test('approver questions use the form vocabulary — and never type "file"', () => {
    const ok = [{ name: 'po', label: 'PO number', type: 'text', required: true }];
    assert.ok(!codes(def([approval({ approval: { fields: ok } })]), 'activate')
        .includes('approval.fields_invalid'));
    const withFile = [{ name: 'doc', label: 'Upload', type: 'file' }];
    assert.ok(codes(def([approval({ approval: { fields: withFile } })]), 'activate')
        .includes('approval.fields_invalid'), 'file uploads from approvers are refused');
    const tooMany = Array.from({ length: 21 }, (_, i) => ({ name: `q${i}`, label: `Q${i}`, type: 'text' }));
    assert.ok(codes(def([approval({ approval: { fields: tooMany } })]), 'activate')
        .includes('approval.fields_invalid'), 'more than 20 questions is refused');
});

test('a details block must be text', () => {
    assert.ok(codes(def([approval({ approval: { details: 42 } })]), 'activate')
        .includes('approval.details_invalid'));
    assert.ok(!codes(def([approval({ approval: { details: '**Total:** {{steps.q.output.total}}' } })]), 'activate')
        .includes('approval.details_invalid'));
});

// ── Reminder + escalation clocks (v2) ─────────────────────────────────────

test('a reminder must be sane hours, and earlier than the deadline', () => {
    for (const remindAfterHours of [0, -3, 'soon', 9999]) {
        const found = codes(def([approval({ approval: { remindAfterHours } })]), 'activate');
        assert.ok(found.includes('approval.reminder_invalid'), `${JSON.stringify(remindAfterHours)} should warn`);
    }
    // At/after the deadline it never fires — say so.
    assert.ok(codes(def([approval({ approval: { expiresInHours: 24, remindAfterHours: 24 } })]), 'activate')
        .includes('approval.reminder_invalid'));
    // Legal shapes stay quiet.
    for (const cfg of [{ remindAfterHours: 4 }, { expiresInHours: 168, remindAfterHours: 24 }, {}]) {
        assert.ok(!codes(def([approval({ approval: cfg })]), 'activate').includes('approval.reminder_invalid'),
            `${JSON.stringify(cfg)} should be accepted`);
    }
});

test('escalation needs BOTH one target and a sane delay', () => {
    const bad = [
        { escalateTo: { userId: 'u1' } },                                  // no delay
        { escalateAfterHours: 24 },                                        // no target
        { escalateTo: { userId: 'u1', groupId: 'g1' }, escalateAfterHours: 24 }, // both
        { escalateTo: {}, escalateAfterHours: 24 },                        // neither key
        { escalateTo: { userId: 'u1' }, escalateAfterHours: 0 },           // zero delay
    ];
    for (const cfg of bad) {
        const found = codes(def([approval({ approval: cfg })]), 'activate');
        assert.ok(found.includes('approval.escalation_invalid'), `${JSON.stringify(cfg)} should be rejected`);
    }
    assert.ok(!codes(def([approval({ approval: { escalateTo: { groupId: 'g1' }, escalateAfterHours: 24 } })]), 'activate')
        .includes('approval.escalation_invalid'));
    // At/after the deadline it never happens — warned, not silently dropped.
    assert.ok(codes(def([approval({ approval: { expiresInHours: 24, escalateTo: { userId: 'u1' }, escalateAfterHours: 48 } })]), 'activate')
        .includes('approval.escalation_invalid'));
});

// ── Panels (multiple approvers) ───────────────────────────────────────────

test('a panel needs 1..10 well-shaped seats', () => {
    const bad = [
        [],                                     // empty list
        [{ userId: 'u1', groupId: 'g1' }],      // both keys on one seat
        [{}],                                   // neither key
        Array.from({ length: 11 }, (_, i) => ({ userId: `u${i}` })),  // too many
        'u1,u2',                                // not an array
    ];
    for (const approvers of bad) {
        const found = codes(def([approval({ approval: { approvers } })]), 'activate');
        assert.ok(found.includes('approval.approvers_invalid'), `${JSON.stringify(approvers)} should be rejected`);
    }
    const found = codes(def([approval({ approval: { approvers: [{ userId: 'u1' }, { groupId: 'g1' }] } })]), 'activate');
    assert.ok(!found.includes('approval.approvers_invalid'));
});

test('a panel excludes the single assignee AND escalation', () => {
    assert.ok(codes(def([approval({ approval: { approvers: [{ userId: 'u1' }], assignee: { userId: 'u2' } } })]), 'activate')
        .includes('approval.approvers_invalid'), 'assignee + panel is ambiguous');
    assert.ok(codes(def([approval({ approval: { approvers: [{ userId: 'u1' }], escalateTo: { userId: 'u2' }, escalateAfterHours: 24 } })]), 'activate')
        .includes('approval.approvers_invalid'), 'escalation + panel is refused — the final approver is the takeover mechanism');
});

test('the rule vocabulary and the quorum bounds are enforced', () => {
    assert.ok(codes(def([approval({ approval: { approvers: [{ userId: 'u1' }], rule: 'majority' } })]), 'activate')
        .includes('approval.rule_invalid'));
    const two = [{ userId: 'u1' }, { userId: 'u2' }];
    for (const quorum of [0, 3, 1.5, 'two']) {
        assert.ok(codes(def([approval({ approval: { approvers: two, rule: 'quorum', quorum } })]), 'activate')
            .includes('approval.rule_invalid'), `quorum ${JSON.stringify(quorum)} of 2 should be rejected`);
    }
    assert.ok(!codes(def([approval({ approval: { approvers: two, rule: 'quorum', quorum: 2 } })]), 'activate')
        .includes('approval.rule_invalid'));
    // A rule without a panel warns — it would silently mean nothing.
    assert.ok(codes(def([approval({ approval: { rule: 'all' } })]), 'activate')
        .includes('approval.rule_invalid'));
});

test('the final approver is one person or one group', () => {
    assert.ok(codes(def([approval({ approval: { finalApprover: { userId: 'u1', groupId: 'g1' } } })]), 'activate')
        .includes('approval.final_approver_invalid'));
    assert.ok(!codes(def([approval({ approval: { finalApprover: { groupId: 'g1' } } })]), 'activate')
        .includes('approval.final_approver_invalid'));
    // Legal WITHOUT a panel too — a single approver plus a final sign-off
    // becomes a one-seat panel at run time.
    assert.ok(!codes(def([approval({ approval: { assignee: { userId: 'u1' }, finalApprover: { userId: 'u2' } } })]), 'activate')
        .includes('approval.final_approver_invalid'));
});
