const { test } = require('node:test');
const assert = require('node:assert');
const { attachmentBlockAudit } = require('./attachmentBlockAudit');
const { withholdSpecialCategories } = require('../privacy/specialCategories');
const { decodeCategories } = require('../privacy/piiCategories');

test('pii block keeps categories and is blocked', () => {
    assert.deepEqual(attachmentBlockAudit('pii', ['Email', 'IBAN']), { cause: 'pii', violation_categories: 'Email,InternationalBankingAccountNumber', action_taken: 'blocked' });
    assert.equal(attachmentBlockAudit(undefined, []).violation_categories, null);
});

test('user_blocked is a decision, not a scan failure, and keeps categories', () => {
    const r = attachmentBlockAudit('user_blocked', ['Person', 'IBAN']);
    assert.equal(r.action_taken, 'blocked');
    assert.equal(r.violation_categories, 'InternationalBankingAccountNumber,Person,user_blocked');
});

test('ask_timeout is blocked (content was stopped) and labelled', () => {
    const r = attachmentBlockAudit('ask_timeout', ['Person']);
    assert.equal(r.action_taken, 'blocked');
    assert.equal(r.violation_categories, 'Person,ask_timeout');
    assert.equal(attachmentBlockAudit('ask_timeout', []).violation_categories, 'ask_timeout');
});

test('overflow / timeout / degraded stay held scan failures', () => {
    for (const reason of ['overflow', 'timeout', 'degraded']) {
        assert.deepEqual(attachmentBlockAudit(reason, ['X']), { cause: reason, violation_categories: `scan_${reason}`, action_taken: 'held' });
    }
});

test('the reason is a comma-separated marker, never fused into a category with a pipe', () => {
    for (const reason of ['user_blocked', 'ask_timeout']) {
        const r = attachmentBlockAudit(reason, ['Person', 'MedicalCondition']);
        assert.ok(!r.violation_categories.includes('|'));
        assert.deepEqual(decodeCategories(r.violation_categories), ['MedicalCondition', 'Person', reason]);
    }
});

test('withholdSpecialCategories strips a special category from a user_blocked / ask_timeout row', () => {
    for (const reason of ['user_blocked', 'ask_timeout']) {
        const { violation_categories } = attachmentBlockAudit(reason, ['Person', 'MedicalCondition']);
        const out = withholdSpecialCategories([{ violation_categories }], 'violation_categories');
        assert.equal(out.length, 1);
        assert.ok(!out[0].violation_categories.includes('MedicalCondition'));
        assert.ok(out[0].violation_categories.includes('Person'));
        assert.ok(out[0].violation_categories.includes(reason));
    }
});
