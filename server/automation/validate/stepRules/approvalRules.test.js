// @typecheck
'use strict';

/**
 * checkApproval, finding by finding: for each approval shape, the exact list of
 * findings (severity, code, path, in order) the validator reports, and the
 * exact text of the ones that carry a number or a name. The builder model
 * reads these, so a refactor that reorders or rewords one fails here.
 *
 * Run: node --test automation/validate/stepRules/approvalRules.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { checkApproval } = require('./approvalRules');

/** @param {string} id */
const u = (id) => ({ userId: id });
/** @param {string} id */
const g = (id) => ({ groupId: id });
/** @param {number} n */
const seats = (n) => Array.from({ length: n }, (_, i) => u('u' + i));
const stage = (/** @type {Record<string, any>} */ o = {}) => ({ approvers: [u('a')], ...o });
/** @param {number} n */
const textFields = (n) => Array.from({ length: n }, (_, i) => ({ name: 'f' + i, label: 'F', type: 'text' }));

/** @param {Record<string, any>} over */
function run(over) {
    /** @type {{ kind: string, code: string, severity: string, path: string, message: string, hint: string }[]} */
    const found = [];
    const ctx = {
        pushE: (/** @type {any} */ f) => found.push({ kind: 'E', ...f }),
        pushW: (/** @type {any} */ f) => found.push({ kind: 'W', ...f }),
    };
    checkApproval(ctx, { id: 'ap', type: 'approval', prompt: 'Send?', ...over }, 'steps[0]');
    for (const f of found) assert.strictEqual(f.severity, f.kind === 'E' ? 'error' : 'warning', f.code);
    return found;
}

/** @type {Array<[string, Record<string, any>, string[]]>} [case, step fields, 'E|W code path-after-steps[0]'] */
const CASES = [
    ['clean', {}, []],
    ['no question', { prompt: undefined }, ['E approval.prompt_missing .prompt']],
    ['blank question', { prompt: '  ' }, ['E approval.prompt_missing .prompt']],
    ['title only', { prompt: undefined, title: 'Ok?' }, []],
    ['expiry -1', { approval: { expiresInHours: -1 } }, ['W approval.expiry_invalid .approval']],
    ['expiry 721', { approval: { expiresInHours: 721 } }, ['W approval.expiry_invalid .approval']],
    ['expiry string', { approval: { expiresInHours: '5' } }, ['W approval.expiry_invalid .approval']],
    ['expiry 720', { approval: { expiresInHours: 720 } }, []],
    ['expiry 0', { approval: { expiresInHours: 0 } }, []],
    ['forEach', { forEach: { overRef: 'x' } }, ['E approval.forEach_forbidden .forEach']],
    ['assignee user', { approval: { assignee: u('u') } }, []],
    ['assignee group', { approval: { assignee: g('g') } }, []],
    ['assignee both', { approval: { assignee: { userId: 'u', groupId: 'g' } } }, ['E approval.assignee_invalid .approval.assignee']],
    ['assignee empty', { approval: { assignee: {} } }, ['E approval.assignee_invalid .approval.assignee']],
    ['assignee string', { approval: { assignee: 'x' } }, ['E approval.assignee_invalid .approval.assignee']],
    ['assignee blank user', { approval: { assignee: { userId: ' ' } } }, ['E approval.assignee_invalid .approval.assignee']],
    ['assignee null', { approval: { assignee: null } }, []],
    ['details number', { approval: { details: 5 } }, ['E approval.details_invalid .approval.details']],
    ['details text', { approval: { details: 'x' } }, []],
    ['panel empty', { approval: { approvers: [] } }, ['E approval.approvers_invalid .approval.approvers']],
    ['panel 11', { approval: { approvers: seats(11) } }, ['E approval.approvers_invalid .approval.approvers']],
    ['panel 10', { approval: { approvers: seats(10) } }, []],
    ['panel bad seat', { approval: { approvers: [{ userId: 'u', groupId: 'g' }] } }, ['E approval.approvers_invalid .approval.approvers']],
    ['panel string, quorum', { approval: { approvers: 'x', rule: 'quorum', quorum: 5 } }, ['E approval.approvers_invalid .approval.approvers']],
    ['panel + assignee', { approval: { approvers: [u('a')], assignee: u('b') } }, ['E approval.approvers_invalid .approval.assignee']],
    ['panel + escalateTo', { approval: { approvers: [u('a')], escalateTo: u('b'), escalateAfterHours: 2 } }, ['E approval.approvers_invalid .approval.escalateTo']],
    ['panel rule bad', { approval: { approvers: [u('a')], rule: 'most' } }, ['E approval.rule_invalid .approval.rule']],
    ['panel quorum 3 of 2', { approval: { approvers: seats(2), rule: 'quorum', quorum: 3 } }, ['E approval.rule_invalid .approval.quorum']],
    ['panel quorum 1.5', { approval: { approvers: seats(2), rule: 'quorum', quorum: 1.5 } }, ['E approval.rule_invalid .approval.quorum']],
    ['panel quorum ok', { approval: { approvers: seats(2), rule: 'quorum', quorum: '2' } }, []],
    ['rule without panel', { approval: { rule: 'all' } }, ['W approval.rule_invalid .approval.rule']],
    ['quorum without panel', { approval: { quorum: 2 } }, ['W approval.rule_invalid .approval.rule']],
    ['final ok', { approval: { finalApprover: g('g') } }, []],
    ['final bad', { approval: { finalApprover: {} } }, ['E approval.final_approver_invalid .approval.finalApprover']],
    ['stages string', { approval: { stages: 'x' } }, ['E approval.stages_invalid .approval.stages']],
    ['stages empty', { approval: { stages: [] } }, ['E approval.stages_invalid .approval.stages']],
    ['stages 6', { approval: { stages: Array.from({ length: 6 }, () => stage()) } }, ['E approval.stages_invalid .approval.stages']],
    ['stages ok', { approval: { stages: [stage(), stage({ key: 'b', name: 'Finance', description: 'd', rule: 'first', when: 'x > 1' })] } }, []],
    ['stage null + array', { approval: { stages: [null, [], stage()] } }, [
        'E approval.stages_invalid .approval.stages[0]', 'E approval.stages_invalid .approval.stages[1]']],
    ['stage approvers', { approval: { stages: [stage({ approvers: [] }), stage({ approvers: seats(11) }), stage({ approvers: [{}] })] } }, [
        'E approval.stages_invalid .approval.stages[0].approvers', 'E approval.stages_invalid .approval.stages[1].approvers',
        'E approval.stages_invalid .approval.stages[2].approvers']],
    ['stage key blank', { approval: { stages: [stage({ key: ' ' }), stage({ key: 5 })] } }, [
        'E approval.stages_invalid .approval.stages[0].key', 'E approval.stages_invalid .approval.stages[1].key']],
    ['stage key dup', { approval: { stages: [stage({ key: ' k ' }), stage({ key: 'k' })] } }, ['E approval.stages_invalid .approval.stages[1].key']],
    ['stage name', { approval: { stages: [stage({ name: 5 }), stage({ name: 'n'.repeat(61) }), stage({ name: 'n'.repeat(60) })] } }, [
        'E approval.stage_name_invalid .approval.stages[0].name', 'E approval.stage_name_invalid .approval.stages[1].name']],
    ['stage description', { approval: { stages: [stage({ description: 5 }), stage({ description: 'd'.repeat(201) }), stage({ description: 'd'.repeat(200) })] } }, [
        'E approval.stage_description_invalid .approval.stages[0].description', 'E approval.stage_description_invalid .approval.stages[1].description']],
    ['stage rule', { approval: { stages: [stage({ rule: 'most' }), stage({ rule: 'quorum', quorum: 3, approvers: seats(2) }), stage({ rule: 'quorum', quorum: 2, approvers: 'x' }), stage({ rule: 'quorum', quorum: 0 })] } }, [
        'E approval.stage_rule_invalid .approval.stages[0].rule', 'E approval.stage_rule_invalid .approval.stages[1].quorum',
        'E approval.stages_invalid .approval.stages[2].approvers', 'E approval.stage_rule_invalid .approval.stages[3].quorum']],
    ['stage when', { approval: { stages: [stage({ when: 5 }), stage({ when: null })] } }, ['E approval.stages_invalid .approval.stages[0].when']],
    ['stages seats 30', { approval: { stages: [stage({ approvers: seats(10) }), stage({ approvers: seats(10) }), stage({ approvers: seats(10) })] } }, []],
    ['stages seats 31', { approval: { stages: [stage({ approvers: seats(10) }), stage({ approvers: seats(10) }), stage({ approvers: seats(10) }), stage()] } }, [
        'E approval.stages_invalid .approval.stages']],
    ['stages + legacy', { approval: { stages: [stage()], assignee: u('a'), approvers: [u('b')], finalApprover: u('c'), escalateTo: u('d'), escalateAfterHours: 3 } }, [
        'E approval.approvers_invalid .approval.assignee', 'E approval.approvers_invalid .approval.escalateTo',
        'E approval.stages_conflict .approval.assignee', 'E approval.stages_conflict .approval.approvers',
        'E approval.stages_conflict .approval.finalApprover', 'E approval.stages_conflict .approval.escalateTo']],
    ['reminder 0', { approval: { remindAfterHours: 0 } }, ['W approval.reminder_invalid .approval.remindAfterHours']],
    ['reminder string', { approval: { remindAfterHours: 'x' } }, ['W approval.reminder_invalid .approval.remindAfterHours']],
    ['reminder after deadline', { approval: { remindAfterHours: 5, expiresInHours: 4 } }, ['W approval.reminder_invalid .approval.remindAfterHours']],
    ['reminder at deadline', { approval: { remindAfterHours: 4, expiresInHours: 4 } }, ['W approval.reminder_invalid .approval.remindAfterHours']],
    ['reminder no deadline', { approval: { remindAfterHours: 5, expiresInHours: 0 } }, []],
    ['reminder ok', { approval: { remindAfterHours: '3', expiresInHours: 4 } }, []],
    ['escalate hours only', { approval: { escalateAfterHours: 5 } }, ['E approval.escalation_invalid .approval.escalateTo']],
    ['escalate target only', { approval: { escalateTo: g('g') } }, ['E approval.escalation_invalid .approval.escalateAfterHours']],
    ['escalate bad target, hours', { approval: { escalateTo: { userId: 'u', groupId: 'g' }, escalateAfterHours: 721 } }, [
        'E approval.escalation_invalid .approval.escalateTo', 'E approval.escalation_invalid .approval.escalateAfterHours']],
    ['escalate after deadline', { approval: { escalateTo: u('u'), escalateAfterHours: 3, expiresInHours: 3 } }, ['W approval.escalation_invalid .approval.escalateAfterHours']],
    ['escalate ok', { approval: { escalateTo: u('u'), escalateAfterHours: 2, expiresInHours: 3 } }, []],
    ['attachments string', { approval: { attachments: 'x' } }, ['E approval.attachments_invalid .approval.attachments']],
    ['attachments blank binding', { approval: { attachments: [{ binding: ' ' }] } }, ['E approval.attachments_invalid .approval.attachments']],
    ['attachments 6', { approval: { attachments: Array.from({ length: 6 }, () => ({ binding: '{{a}}' })) } }, ['E approval.attachments_invalid .approval.attachments']],
    ['attachments 5', { approval: { attachments: Array.from({ length: 5 }, () => ({ binding: '{{a}}' })) } }, []],
    ['attachments null item', { approval: { attachments: [null] } }, ['E approval.attachments_invalid .approval.attachments']],
    ['fields string', { approval: { fields: 'x' } }, ['E approval.fields_invalid .approval.fields']],
    ['fields 21', { approval: { fields: textFields(21) } }, ['E approval.fields_invalid .approval.fields']],
    ['fields 20', { approval: { fields: textFields(20) } }, []],
    ['fields empty', { approval: { fields: [] } }, []],
    ['fields file + app_pick', { approval: { fields: [{ name: 'f', label: 'F', type: 'file' }, { name: 'p', label: 'P', type: 'app_pick' }] } }, [
        'E approval.fields_invalid .approval.fields', 'E approval.fields_invalid .approval.fields', 'E approval.fields_invalid .approval.fields']],
    ['fields bad', { approval: { fields: [{ name: '', type: 'nope' }] } }, ['E approval.fields_invalid .approval.fields', 'E approval.fields_invalid .approval.fields']],
    ['not an approval', { type: 'wait', prompt: undefined, forEach: { overRef: 'x' } }, []],
];

test('checkApproval reports exactly these findings, in this order', () => {
    for (const [name, over, want] of CASES) {
        const got = run(over).map((f) => `${f.kind} ${f.code} ${f.path.replace(/^steps\[0\]/, '')}`);
        assert.deepStrictEqual(got, want, name);
    }
});

/** @param {Record<string, any>} over */
const texts = (over) => run(over).map((f) => `${f.message} || ${f.hint}`);

test('the findings that carry a number or a name read exactly so', () => {
    assert.deepStrictEqual(texts({ approval: { approvers: seats(2), rule: 'quorum', quorum: 3 } }), [
        'Step ap: quorum must be a whole number between 1 and the number of seats (2). || e.g. 2 of 3 approvers.',
    ]);
    assert.deepStrictEqual(texts({ approval: { approvers: 'x', rule: 'quorum', quorum: 0 } }).slice(1), [
        'Step ap: quorum must be a whole number between 1 and the number of seats. || e.g. 2 of 3 approvers.',
    ]);
    assert.deepStrictEqual(texts({ approval: { stages: [stage({ rule: 'most' }), stage({ rule: 'quorum', quorum: 3, approvers: seats(2) }), stage({ rule: 'quorum', quorum: 2, approvers: 'x' }), stage({ rule: 'quorum', quorum: 0 })] } }), [
        'Step ap: stage 1\'s decision rule must be "all", "first" or "quorum". || all = everyone in this stage must approve; first = the first vote moves it on; quorum = N of M.',
        'Step ap: stage 2\'s quorum must be a whole number between 1 and its number of approvers (2). || e.g. 2 of 3.',
        'Step ap: stage 3 needs 1 to 10 approvers, each one person ({ userId }) or one group ({ groupId }). || A stage with nobody in it can never be decided.',
        'Step ap: stage 4\'s quorum must be a whole number between 1 and its number of approvers (1). || e.g. 2 of 3.',
    ]);
    assert.deepStrictEqual(texts({ approval: { stages: [stage({ rule: 'quorum', quorum: 0, approvers: [] })] } }).slice(1), [
        'Step ap: stage 1\'s quorum must be a whole number between 1 and its number of approvers. || e.g. 2 of 3.',
    ]);
    assert.deepStrictEqual(texts({ approval: { stages: [stage({ approvers: seats(10) }), stage({ approvers: seats(10) }), stage({ approvers: seats(10) }), stage()] } }), [
        'Step ap: the stages have 31 approvers between them — the limit across the whole chain is 30. || Use groups instead of listing every person, or drop a stage.',
    ]);
    assert.deepStrictEqual(texts({ approval: { stages: [stage({ key: ' k ' }), stage({ key: 'k' })] } }), [
        'Step ap: two stages share the key "k". || Every stage needs its own key — votes are filed under it, so a duplicate would mix two stages\' votes together.',
    ]);
    assert.deepStrictEqual(texts({ approval: { stages: [stage()], assignee: u('a'), approvers: [u('b')], finalApprover: u('c'), escalateTo: u('d'), escalateAfterHours: 3 } }).slice(2), [
        'Step ap: this approval uses stages, so a single approver set alongside them would never be asked. || Move them into a stage, or remove the stages.',
        'Step ap: this approval uses stages, so a panel set alongside them would never be asked. || Move them into a stage, or remove the stages.',
        'Step ap: this approval uses stages, so a final approver set alongside them would never be asked. || Move them into a stage, or remove the stages.',
        'Step ap: this approval uses stages, so an escalation set alongside them would never be asked. || Move the escalation target into a stage, or remove the stages.',
    ]);
    assert.deepStrictEqual(texts({ approval: { remindAfterHours: 5, expiresInHours: 4, escalateTo: u('u'), escalateAfterHours: 4 } }), [
        'Step ap: the reminder fires at or after the 4h deadline, so it will never be sent. || Set the reminder earlier than the deadline.',
        'Step ap: the escalation fires at or after the 4h deadline, so it will never happen. || Escalate earlier than the deadline.',
    ]);
    assert.deepStrictEqual(texts({ approval: { stages: [null] } }), [
        'Step ap: stage 1 must be an object with its own approvers. || Each stage names who decides at that point in the chain.',
    ]);
});
