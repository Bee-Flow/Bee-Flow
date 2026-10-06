/**
 * routeRules.js: the validator findings about what a Condition / Filter /
 * Switch reads and what reads it (spec V2, BFSF-485 F3/F4).
 *
 * Run: node --test automation/validate/stepRules/routeRules.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDefinition } = require('../../validate');

const MESSAGES = [
    { id: 'm1', subject: 'Invoice', from: 'ap@fabrikam.example', attachments: [{ filename: 'a.pdf', mimeType: 'application/pdf' }] },
    { id: 'm2', subject: 'Quote', from: 'sales@contoso.example', attachments: [{ filename: 'b.docx', mimeType: 'application/msword' }] },
];

const readMany = (extra = {}) => ({
    id: 'mc_read_many', type: 'integration_action', tool: 'mail_read_many', inputs: {},
    pinnedOutput: { messages: MESSAGES }, ...extra,
});
const readAttachment = (overRef) => ({
    id: 'mc_read_attachment', type: 'integration_action', tool: 'mail_read_attachment', label: 'Read attachment',
    forEach: { overRef, itemVar: 'att' },
    inputs: { attachmentId: { kind: 'ref', path: 'loop.att.filename' } },
});

function filterDef({ expr = 'contains(item.from, "fabrikam")', overRef = 'steps.flt.output.items[*].attachments', source = readMany() } = {}) {
    return {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [
            source,
            { id: 'flt', type: 'filter', arrayRef: 'steps.mc_read_many.output.messages', expr },
            readAttachment(overRef),
        ],
        edges: [
            { from: 'trg', to: 'mc_read_many' },
            { from: 'mc_read_many', to: 'flt' },
            { from: 'flt', to: 'mc_read_attachment' },
        ],
    };
}

const all = (r) => [...r.errors, ...r.warnings];
const findings = (r, code) => all(r).filter((x) => x.code === code);

test('route.reads_source: a successor that still reads the source list', () => {
    const r = validateDefinition(filterDef({ overRef: 'steps.mc_read_many.output.messages[*].attachments' }));
    const f = findings(r, 'route.reads_source');
    assert.equal(f.length, 1, JSON.stringify(all(r)));
    assert.equal(f[0].severity, 'warning');
    assert.match(f[0].path, /steps\[2\]|mc_read_attachment/);
    assert.match(f[0].hint, /steps\.flt\.output\.items/);
});

test('route.reads_source: silent when the successor reads the output', () => {
    assert.deepEqual(findings(validateDefinition(filterDef()), 'route.reads_source'), []);
});

test('route.item_field_unknown: a near miss against the pinned sample', () => {
    const r = validateDefinition(filterDef({ expr: '!isEmpty(item.atachments)' }));
    const f = findings(r, 'route.item_field_unknown');
    assert.equal(f.length, 1);
    assert.match(f[0].message, /did you mean “attachments”/);
    const col = findings(validateDefinition(filterDef({ expr: 'contains(item.attachments[*].mimetype, "pdf")' })), 'route.item_field_unknown');
    assert.equal(col.length, 1);
    assert.match(col[0].message, /attachments\[\*\]\.mimeType/);
});

test('route.item_field_unknown: silent without a candidate, and for known fields', () => {
    assert.deepEqual(findings(validateDefinition(filterDef({ expr: 'contains(item.zzzzzzzz, "x")' })), 'route.item_field_unknown'), []);
    assert.deepEqual(findings(validateDefinition(filterDef({ expr: 'anyOf(fileType(item.attachments[*]), "equals", "pdf")' })), 'route.item_field_unknown'), []);
});

test('route.item_field_unknown: the curated sample of an integration source', () => {
    const gmail = { id: 'mc_read_many', type: 'integration_action', tool: 'gmail_search', inputs: {} };
    const def = filterDef({ expr: 'contains(item.Subjet, "x")', source: gmail });
    def.steps[1].arrayRef = 'steps.mc_read_many.output.results';
    def.steps[2] = readAttachment('steps.flt.output.items');
    const f = findings(validateDefinition(def), 'route.item_field_unknown');
    assert.equal(f.length, 1);
    assert.match(f[0].message, /“subject”/);
});

test('condition.list_compare: endsWith and == on a [*] path', () => {
    const r = validateDefinition(filterDef({ expr: 'endsWith(item.attachments[*].filename, ".pdf")' }));
    const f = findings(r, 'condition.list_compare');
    assert.equal(f.length, 1);
    assert.match(f[0].hint, /anyOf\(item\.attachments\[\*\]\.filename, "endsWith", "\.pdf"\)/);
    assert.equal(findings(validateDefinition(filterDef({ expr: 'item.attachments[*].mimeType == "application/pdf"' })), 'condition.list_compare').length, 1);
    assert.deepEqual(findings(validateDefinition(filterDef({ expr: 'anyOf(item.attachments[*].filename, "endsWith", ".pdf")' })), 'condition.list_compare'), []);
    assert.deepEqual(findings(validateDefinition(filterDef({ expr: 'endsWith(item.subject, "x")' })), 'condition.list_compare'), []);
});

test('condition.quantifier_test_unknown: unknown test and wrong arity are errors', () => {
    const r = validateDefinition(filterDef({ expr: 'anyOf(item.attachments[*].filename, "endswith", ".pdf")' }));
    const f = findings(r, 'condition.quantifier_test_unknown');
    assert.equal(f.length, 1);
    assert.equal(f[0].severity, 'error');
    assert.match(f[0].hint, /"endsWith"/);
    assert.equal(findings(validateDefinition(filterDef({ expr: 'anyOf(item.attachments[*].filename, "isEmpty", "x")' })), 'condition.quantifier_test_unknown').length, 1);
    assert.equal(findings(validateDefinition(filterDef({ expr: 'noneOf(item.attachments[*].filename, "contains")' })), 'condition.quantifier_test_unknown').length, 1);
    assert.equal(findings(validateDefinition(filterDef({ expr: 'everyOf(item.attachments[*].filename, ".pdf")' })), 'condition.quantifier_test_unknown').length, 1);
    for (const ok of ['anyOf(item.attachments[*].filename, "!isEmpty")', 'everyOf(item.attachments[*].filename, "endsWith", ".pdf")', 'noneOf(fileType(item.attachments[*]), "equals", "pdf")']) {
        assert.deepEqual(findings(validateDefinition(filterDef({ expr: ok })), 'condition.quantifier_test_unknown'), [], ok);
    }
});

// BFSF-485: the issue's own example, a whole-run Condition over a list of sheets.
function sheetsDef(expr) {
    return {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [
            { id: 'sheets', type: 'integration_action', tool: 'sheets_list', inputs: {}, pinnedOutput: { results: [{ id: 'f1', name: 'Reiskosten maart' }, { id: 'f2', name: 'Begroting' }] } },
            { id: 'cond', type: 'condition', expr },
            { id: 'each', type: 'integration_action', tool: 'sheets_read', label: 'Read sheet', forEach: { overRef: 'steps.sheets.output.results', itemVar: 'sheet' }, inputs: { id: { kind: 'ref', path: 'loop.sheet.id' } } },
            { id: 'other', type: 'notification', title: 'x', body: 'x', channels: ['notification'] },
        ],
        edges: [
            { from: 'trg', to: 'sheets' },
            { from: 'sheets', to: 'cond' },
            { from: 'cond', to: 'each', label: 'then' },
            { from: 'cond', to: 'other', label: 'else' },
        ],
    };
}

test('condition.whole_list and condition.loop_not_filtered on the issue example', () => {
    const r = validateDefinition(sheetsDef('contains(steps.sheets.output.results[*].name, "Reiskosten")'));
    const whole = findings(r, 'condition.whole_list');
    assert.equal(whole.length, 1, JSON.stringify(all(r)));
    assert.match(whole[0].message, /checks the whole list steps\.sheets\.output\.results once/);
    assert.equal(whole[0].hint, 'To keep only the matching items, make it work through the list (one output = Filter).');
    const loop = findings(r, 'condition.loop_not_filtered');
    assert.equal(loop.length, 1);
    assert.match(loop[0].message, /^“Read sheet” runs once per item of steps\.sheets\.output\.results/);
    assert.equal(loop[0].hint, 'Make the Condition work through the list (one output = Filter) and loop over its output.items.');
});

test('condition.whole_list: a list read without [*] counts through the sample; emptiness checks do not', () => {
    assert.equal(findings(validateDefinition(sheetsDef('contains(steps.sheets.output.results, "Reiskosten")')), 'condition.whole_list').length, 1);
    const empty = validateDefinition(sheetsDef('!isEmpty(steps.sheets.output.results)'));
    assert.deepEqual(findings(empty, 'condition.whole_list'), []);
    assert.deepEqual(findings(empty, 'condition.loop_not_filtered'), []);
});

test('condition.whole_list: a list of plain values read whole is a membership test, not a missed filter', () => {
    const def = sheetsDef('contains(steps.sheets.output.labels, "urgent")');
    def.steps[0].pinnedOutput.labels = ['urgent', 'x'];
    def.steps[2].forEach.overRef = 'steps.sheets.output.labels';
    const r = validateDefinition(def);
    assert.deepEqual(findings(r, 'condition.whole_list'), []);
    assert.deepEqual(findings(r, 'condition.loop_not_filtered'), []);
    // Its items read through [*] are still a list read: the skip is for the list passed whole.
    def.steps[1].expr = 'contains(steps.sheets.output.labels[*], "urgent")';
    assert.equal(findings(validateDefinition(def), 'condition.whole_list').length, 1);
});

test('condition.parse hint no longer says "no function calls"', () => {
    const r = validateDefinition(sheetsDef('contains(('));
    const f = findings(r, 'condition.expr_parse');
    assert.equal(f.length, 1);
    assert.equal(f[0].hint, 'Restricted grammar: comparisons, && / ||, and the listed helpers (contains, equals, anyOf, fileType, …).');
});
