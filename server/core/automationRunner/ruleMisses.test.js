/**
 * ruleMisses.js: which rule paths found nothing on every item.
 *
 * Run: node --test core/automationRunner/ruleMisses.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseExpr } = require('../../automation/expr');
const { withBindingLog, describeBindingMiss } = require('../../automation/bind');
const { rulePaths, createRuleMissCounter } = require('./ruleMisses');

const MAILS = [
    { subject: 'Invoice 1', from: 'ap@fabrikam.example', attachments: [{ filename: 'a.pdf', mimeType: 'application/pdf' }] },
    { subject: 'Invoice 2', from: 'ap@fabrikam.example', attachments: [{ filename: 'b.docx', mimeType: 'application/msword' }] },
    { subject: 'Hello', from: 'info@contoso.example', attachments: [] },
    { subject: 'Logo', from: 'ap@fabrikam.example', attachments: [{ filename: 'logo.png', mimeType: 'image/png' }] },
];

function countOver(expr, rows, field, opts) {
    const entries = [];
    withBindingLog(entries, () => {
        const counter = createRuleMissCounter([{ ast: parseExpr(expr), field }]);
        rows.forEach((item, i) => counter.observe({ steps: {}, item, _index: i }));
        counter.report(rows.length, null, opts);
    });
    return entries;
}

test('rulePaths reads the rooted paths once each, and stops at a computed index', () => {
    const ast = parseExpr('contains(item.subject, "x") && item.subject != "" && steps.s1.output.list[item.n].a > loop.row.n && _index > 0');
    assert.deepEqual(rulePaths(ast).map((p) => p.path), ['item.subject', 'steps.s1.output.list', 'item.n', 'loop.row.n']);
    assert.deepEqual(rulePaths(parseExpr('item["Story Points"] > 3 && item.list[0].x')).map((p) => p.path),
        ['item["Story Points"]', 'item.list[0].x']);
});

test('a typo on every item is one rule entry counted per item', () => {
    const entries = countOver('!isEmpty(item.atachments)', MAILS);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, 'rule');
    assert.equal(entries[0].path, 'item.atachments');
    assert.equal(entries[0].reason, 'missing');
    assert.equal(entries[0].count, 4);
    assert.equal(entries[0].at, 'item');
    assert.equal(entries[0].missing, 'atachments');
    assert.equal(describeBindingMiss(entries[0]), 'the rule read item.atachments, but item has no "atachments" (4×)');
});

test('a field that some items have is not a miss', () => {
    const rows = [{ subject: 'a' }, { title: 'b' }, { title: 'c' }];
    assert.deepEqual(countOver('contains(item.subject, "a")', rows), []);
});

test('a list column that no element has is a miss; empty lists do not count', () => {
    const entries = countOver('contains(item.attachments[*].mimetype, "pdf")', MAILS);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].path, 'item.attachments[*].mimetype');
    assert.equal(entries[0].count, 3);
    assert.equal(entries[0].at, 'item.attachments[*]');
    assert.equal(entries[0].missing, 'mimetype');
    assert.match(describeBindingMiss(entries[0]), /item\.attachments\[\*\] has no "mimetype"/);
    assert.deepEqual(countOver('contains(item.attachments[*].mimeType, "pdf")', MAILS), []);
    assert.deepEqual(countOver('anyOf(fileType(item.attachments[*]), "equals", "pdf")', MAILS), []);
});

test('a list part that is absent is a miss of the whole path', () => {
    const entries = countOver('contains(item.atachments[*].mimeType, "pdf")', MAILS);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].missing, 'atachments');
    assert.equal(entries[0].count, 4);
});

test('a switch case names its output', () => {
    const entries = countOver('equals(item.frm, "x")', MAILS, 'pdf');
    assert.equal(entries[0].field, 'pdf');
    assert.match(describeBindingMiss(entries[0]), /^the rule of output "pdf" read item\.frm/);
});

test('nothing is recorded outside a binding log, or for zero items', () => {
    const counter = createRuleMissCounter([{ ast: parseExpr('item.nope') }]);
    counter.observe({ item: {} });
    assert.doesNotThrow(() => counter.report(1));
    assert.deepEqual(countOver('item.nope', []), []);
});

test('a duplicate miss adds its count', () => {
    const entries = [];
    withBindingLog(entries, () => {
        for (let round = 0; round < 2; round++) {
            const counter = createRuleMissCounter([{ ast: parseExpr('item.nope') }]);
            counter.observe({ item: {} });
            counter.observe({ item: {} });
            counter.report(2);
        }
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].count, 4);
});

test('rulePaths tags how each path is read: strict, tolerant or fallback', () => {
    const uses = (expr) => Object.fromEntries(rulePaths(parseExpr(expr)).map((p) => [p.path, p.use]));
    assert.deepEqual(uses('isEmpty(item.cc)'), { 'item.cc': 'tolerant' });
    assert.deepEqual(uses('!item.flagged && item.n > 1'), { 'item.flagged': 'tolerant', 'item.n': 'strict' });
    assert.deepEqual(uses('contains(item.replyTo || item.from, "x")'), { 'item.replyTo': 'fallback', 'item.from': 'tolerant' });
    assert.deepEqual(uses('item.a ? 1 : 2'), { 'item.a': 'tolerant' });
    // the strictest occurrence wins
    assert.deepEqual(uses('isEmpty(item.cc) || contains(item.cc, "x")'), { 'item.cc': 'strict' });
});

test('an absence check on a field no item has is silent when the rule kept items', () => {
    const rows = [{ from: 'a' }, { from: 'b' }];
    assert.deepEqual(countOver('isEmpty(item.cc)', rows, undefined, { matched: 2 }), []);
    assert.deepEqual(countOver('!item.flagged', rows, undefined, { matched: 2 }), []);
    // ... and still named when the rule kept nothing (the typo case)
    const typo = countOver('!isEmpty(item.atachments)', MAILS, undefined, { matched: 0 });
    assert.equal(typo.length, 1);
    assert.equal(typo[0].path, 'item.atachments');
});

test('the left side of a fallback (a || b) is never a miss on its own', () => {
    const rows = [{ from: 'a@y' }, { from: 'b@y' }];
    assert.deepEqual(countOver('contains(item.replyTo || item.from, "@y")', rows, undefined, { matched: 2 }), []);
    assert.deepEqual(countOver('contains(item.replyTo || item.from, "@z")', rows, undefined, { matched: 0 }), []);
});

test('a strict read is a miss whatever the rule kept', () => {
    const entries = countOver('equals(item.frm, "x") || isEmpty(item.subject)', MAILS, undefined, { matched: 4 });
    assert.deepEqual(entries.map((e) => e.path), ['item.frm']);
});

test('per-case matched counts gate each switch case on its own', () => {
    const rows = [{ from: 'a' }];
    assert.deepEqual(countOver('isEmpty(item.cc)', rows, 'nocc', { matched: { nocc: 1 } }), []);
    assert.equal(countOver('isEmpty(item.cc)', rows, 'nocc', { matched: { other: 1 } }).length, 1);
});

test('a step that has not run in this run is not a miss', () => {
    const entries = [];
    withBindingLog(entries, () => {
        const counter = createRuleMissCounter([{ ast: parseExpr('equals(steps.reply.output.ok, true)') }]);
        counter.observe({ steps: { other: { output: {} } }, trigger: {} });
        counter.report(1, null, { matched: 0 });
    });
    assert.deepEqual(entries, []);
});
