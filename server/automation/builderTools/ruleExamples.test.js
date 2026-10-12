/**
 * The rule shapes taught to the AI builder: every example is valid grammar
 * and evaluates on a sample item. (That each one also opens as clickable
 * rows is asserted on the web, with the editor's own parser.)
 *
 * Run: node --test automation/builderTools/ruleExamples.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { CONDITION_RULE_EXAMPLES, CONDITION_RULES_HINT, SWITCH_RULES_EXAMPLE } = require('./ruleExamples');
const { parseExpr, evaluate } = require('../expr');

const ITEM = {
    subject: 'Invoice F-2026-0917', from: 'Fabrikam billing <billing@fabrikam.example>', filename: 'F-2026-0917.pdf',
    status: 'Open', amount: 1250, notes: '', mimeType: 'application/pdf',
    attachments: [{ filename: 'F-2026-0917.pdf', mimeType: 'application/pdf' }, { filename: 'logo.png', mimeType: 'image/png' }],
    lines: [{ qty: 2 }, { qty: 1 }], labels: [{ name: 'INBOX' }],
};

test('every example parses and evaluates to a yes/no on a sample item', () => {
    assert.strictEqual(CONDITION_RULE_EXAMPLES.length, 13);
    for (const expr of CONDITION_RULE_EXAMPLES) {
        assert.doesNotThrow(() => parseExpr(expr), expr);
        assert.strictEqual(typeof evaluate(expr, { item: ITEM }), 'boolean', expr);
    }
    assert.strictEqual(evaluate(CONDITION_RULE_EXAMPLES[12], { item: ITEM }), true);
});

test('no example wraps a field in lower() or upper()', () => {
    for (const expr of CONDITION_RULE_EXAMPLES) assert.ok(!/\b(lower|upper)\(/.test(expr), expr);
});

test('the hint lists every example and tells where the next step reads', () => {
    for (const expr of CONDITION_RULE_EXAMPLES) assert.ok(CONDITION_RULES_HINT.includes(expr), expr);
    assert.ok(CONDITION_RULES_HINT.includes('steps.<id>.output.items'));
    assert.ok(CONDITION_RULES_HINT.includes('steps.<id>.output.matchesByCase.<output>'));
    assert.ok(CONDITION_RULES_HINT.includes('never wrap a field in lower() or upper()'));
});

test('the switch example works through attachments with File type rules', () => {
    assert.match(SWITCH_RULES_EXAMPLE.arrayRef, /\[\*\]\.attachments$/);
    for (const c of SWITCH_RULES_EXAMPLE.cases) assert.doesNotThrow(() => parseExpr(c.expr));
    assert.deepStrictEqual(SWITCH_RULES_EXAMPLE.cases.map((c) => c.name), ['pdf', 'word']);
});
