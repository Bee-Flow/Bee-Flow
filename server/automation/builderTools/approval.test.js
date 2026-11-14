// @typecheck
'use strict';

/**
 * normalizeApprovalConfig, rule by rule: the exact object (key order included,
 * since the stored step is compared and diffed as JSON) for each input shape.
 *
 * Run: node --test automation/builderTools/approval.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { normalizeApprovalConfig } = require('./approval');

/** @param {string} id */
const u = (id) => ({ userId: id });
/** @param {string} id */
const g = (id) => ({ groupId: id });
/** @param {number} n */
const seats = (n) => Array.from({ length: n }, (_, i) => u('u' + i));
const base = { expiresInHours: 168 };

/** @type {Array<[string, any, Record<string, any>]>} [case, input, exact output] */
const CASES = [
    ['nothing', undefined, base],
    ['not an object', 'x', base],
    ['deadline null', { expiresInHours: null }, base],
    ['deadline blank', { expiresInHours: '' }, base],
    ['deadline 0', { expiresInHours: 0 }, { expiresInHours: 0 }],
    ['deadline above cap', { expiresInHours: 1000 }, { expiresInHours: 720 }],
    ['deadline negative', { expiresInHours: -5 }, { expiresInHours: 0 }],
    ['deadline rounded', { expiresInHours: 2.6 }, { expiresInHours: 3 }],
    ['deadline text number', { expiresInHours: '12' }, { expiresInHours: 12 }],
    ['deadline junk', { expiresInHours: 'abc' }, base],
    ['assignee user trimmed', { assignee: { userId: ' u ' } }, { ...base, assignee: u('u') }],
    ['assignee group', { assignee: { userId: '', groupId: ' g ' } }, { ...base, assignee: g('g') }],
    ['assignee both prefers user', { assignee: { userId: 'u', groupId: 'g' } }, { ...base, assignee: u('u') }],
    ['assignee empty', { assignee: {} }, base],
    ['assignee string', { assignee: 'x' }, base],
    ['details blank', { details: ' ' }, base],
    ['details kept as written', { details: ' d ' }, { ...base, details: ' d ' }],
    ['panel deduped, junk dropped, assignee dropped', { assignee: u('z'), approvers: [u('a'), u('a'), g('a'), null, {}, { userId: ' b ' }] },
        { ...base, approvers: [u('a'), g('a'), u('b')], rule: 'all' }],
    ['panel capped at 10', { approvers: seats(12), rule: 'first' }, { ...base, approvers: seats(10), rule: 'first' }],
    ['panel bad rule', { approvers: [u('a')], rule: 'most' }, { ...base, approvers: [u('a')], rule: 'all' }],
    ['panel quorum above seats', { approvers: seats(2), rule: 'quorum', quorum: 5 }, { ...base, approvers: seats(2), rule: 'quorum', quorum: 2 }],
    ['panel quorum 0', { approvers: seats(3), rule: 'quorum', quorum: 0 }, { ...base, approvers: seats(3), rule: 'quorum', quorum: 1 }],
    ['panel quorum junk', { approvers: seats(3), rule: 'quorum', quorum: 'x' }, { ...base, approvers: seats(3), rule: 'quorum', quorum: 2 }],
    ['panel quorum junk, one seat', { approvers: seats(1), rule: 'quorum' }, { ...base, approvers: seats(1), rule: 'quorum', quorum: 1 }],
    ['panel quorum rounded', { approvers: seats(3), rule: 'quorum', quorum: '2.4' }, { ...base, approvers: seats(3), rule: 'quorum', quorum: 2 }],
    ['panel of junk keeps assignee', { assignee: u('z'), approvers: [null, {}], rule: 'first' }, { ...base, assignee: u('z') }],
    ['panel not a list', { approvers: 'x' }, base],
    ['stages empty', { stages: [] }, base],
    ['stages keys', { stages: [{ approvers: [u('a')], key: ' k ' }, { approvers: [u('b')], key: 'k' }, { approvers: [u('c')] }] }, {
        ...base, stages: [{ key: 'k', approvers: [u('a')], rule: 'all' }, { key: 's2', approvers: [u('b')], rule: 'all' }, { key: 's3', approvers: [u('c')], rule: 'all' }],
    }],
    ['stages positional key collides', { stages: [{ approvers: [u('a')], key: 's2' }, { approvers: [u('b')] }] }, {
        ...base, stages: [{ key: 's2', approvers: [u('a')], rule: 'all' }, { key: 's2_1', approvers: [u('b')], rule: 'all' }],
    }],
    ['stage key capped at 40', { stages: [{ approvers: [u('a')], key: 'k'.repeat(50) }] }, {
        ...base, stages: [{ key: 'k'.repeat(40), approvers: [u('a')], rule: 'all' }],
    }],
    ['stages capped at 5 before the empty ones drop', { stages: [null, { approvers: [] }, ...Array.from({ length: 5 }, () => ({ approvers: [u('a')] }))] }, {
        ...base, stages: [{ key: 's1', approvers: [u('a')], rule: 'all' }, { key: 's2', approvers: [u('a')], rule: 'all' }, { key: 's3', approvers: [u('a')], rule: 'all' }],
    }],
    ['stage fields', { stages: [{ approvers: [...seats(11), u('u0')], name: ` ${'n'.repeat(70)} `, description: ` ${'d'.repeat(250)}`, rule: 'quorum', quorum: 30, when: ' x > 1 ' }] }, {
        ...base, stages: [{ key: 's1', approvers: seats(10), rule: 'quorum', name: 'n'.repeat(60), description: 'd'.repeat(200), quorum: 10, when: 'x > 1' }],
    }],
    ['stage blanks dropped', { stages: [{ approvers: [u('a')], name: ' ', description: ' ', rule: 'nope', when: ' ' }] }, {
        ...base, stages: [{ key: 's1', approvers: [u('a')], rule: 'all' }],
    }],
    ['stage quorum junk', { stages: [{ approvers: seats(3), rule: 'quorum', quorum: 'x' }] }, {
        ...base, stages: [{ key: 's1', approvers: seats(3), rule: 'quorum', quorum: 2 }],
    }],
    ['stages drop the legacy fields', {
        assignee: u('z'), approvers: [u('a')], rule: 'quorum', quorum: 1, finalApprover: u('f'), escalateTo: u('e'), escalateAfterHours: 2, remindAfterHours: 3,
        stages: [{ approvers: [u('b')] }],
    }, { ...base, stages: [{ key: 's1', approvers: [u('b')], rule: 'all' }], remindAfterHours: 3 }],
    ['stages of nobody keep the legacy fields', { approvers: [u('a')], finalApprover: u('f'), stages: [{ approvers: [] }] }, {
        ...base, approvers: [u('a')], rule: 'all', finalApprover: u('f'),
    }],
    ['final approver', { finalApprover: { groupId: ' g ' } }, { ...base, finalApprover: g('g') }],
    ['final approver junk', { finalApprover: {} }, base],
    ['reminder 0', { remindAfterHours: 0 }, base],
    ['reminder rounded', { remindAfterHours: 2.4 }, { ...base, remindAfterHours: 2 }],
    ['reminder capped', { remindAfterHours: 1000 }, { ...base, remindAfterHours: 720 }],
    ['reminder junk', { remindAfterHours: 'x' }, base],
    ['escalation', { escalateTo: { userId: ' e ' }, escalateAfterHours: '5' }, { ...base, escalateTo: u('e'), escalateAfterHours: 5 }],
    ['escalation to a group', { escalateTo: { userId: ' ', groupId: 'g' }, escalateAfterHours: 900 }, { ...base, escalateTo: g('g'), escalateAfterHours: 720 }],
    ['escalation without delay', { escalateTo: u('e') }, base],
    ['escalation without target', { escalateTo: 'x', escalateAfterHours: 4 }, base],
    ['escalation with a panel', { approvers: [u('a')], escalateTo: u('e'), escalateAfterHours: 4 }, { ...base, approvers: [u('a')], rule: 'all' }],
    ['attachments', { attachments: [{ binding: '{{a}}', label: ' ' }, { binding: ' ' }, null, { binding: 'b', label: 'L' }, 5] }, {
        ...base, attachments: [{ binding: '{{a}}' }, { binding: 'b', label: 'L' }],
    }],
    ['attachments capped at 5', { attachments: Array.from({ length: 7 }, (_, i) => ({ binding: `{{a${i}}}` })) }, {
        ...base, attachments: Array.from({ length: 5 }, (_, i) => ({ binding: `{{a${i}}}` })),
    }],
    ['attachments empty', { attachments: [null] }, base],
    ['fields', { fields: [{ type: 'file' }, { type: 'text', name: 'a' }, null, 'x', { type: 'app_pick' }] }, { ...base, fields: [{ type: 'text', name: 'a' }] }],
    ['fields capped at 20', { fields: Array.from({ length: 25 }, (_, i) => ({ type: 'text', name: 'f' + i })) }, {
        ...base, fields: Array.from({ length: 20 }, (_, i) => ({ type: 'text', name: 'f' + i })),
    }],
    ['fields only refused types', { fields: [{ type: 'file' }] }, base],
    ['invented keys dropped', { cc: 'x', reminderHours: 3 }, base],
];

test('normalizeApprovalConfig builds exactly this object', () => {
    for (const [name, input, want] of CASES) {
        const got = normalizeApprovalConfig(input);
        assert.deepStrictEqual(got, want, name);
        assert.strictEqual(JSON.stringify(got), JSON.stringify(want), `${name}: key order`);
    }
});
