/**
 * Filter, list-mode Switch and Condition write rule misses to the step's
 * binding log (ruleMisses.js), the same log the run panel reads for
 * "Mappings that found nothing".
 *
 * Run: node --test core/automationRunner/execFilter.ruleMisses.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { withBindingLog } = require('../../automation/bind');
const { execFilter } = require('./execCollections');
const { execSwitch, execCondition } = require('./execControl');

const MAILS = [
    { subject: 'Invoice 1', from: 'ap@fabrikam.example', attachments: [{ filename: 'a.pdf', mimeType: 'application/pdf' }] },
    { subject: 'Invoice 2', from: 'ap@fabrikam.example', attachments: [{ filename: 'b.docx', mimeType: 'application/msword' }] },
    { subject: 'Quote', from: 'sales@contoso.example', attachments: [{ filename: 'q.pdf', mimeType: 'application/pdf' }] },
    { subject: 'Logo', from: 'ap@fabrikam.example', attachments: [{ filename: 'logo.png', mimeType: 'image/png' }] },
];

const state = () => ({ steps: { mc_read_many: { output: { messages: MAILS } } }, vars: {}, trigger: { output: {} } });
const ARRAY_REF = 'steps.mc_read_many.output.messages';

async function logged(fn) {
    const entries = [];
    const result = await withBindingLog(entries, fn);
    return { result, entries };
}

test('filter: a typo in the rule is one entry counted over the 4 mails', async () => {
    const step = { id: 'f', type: 'filter', arrayRef: ARRAY_REF, expr: '!isEmpty(item.atachments)' };
    const { result, entries } = await logged(() => execFilter(step, {}, state()));
    assert.equal(result.output.count, 0);
    assert.equal(entries.length, 1);
    assert.deepEqual(
        { kind: entries[0].kind, path: entries[0].path, reason: entries[0].reason, count: entries[0].count, missing: entries[0].missing },
        { kind: 'rule', path: 'item.atachments', reason: 'missing', count: 4, missing: 'atachments' },
    );
});

test('filter: a field present on some items is not recorded', async () => {
    const rows = [...MAILS, { subject: 'No sender' }].map((m, i) => (i === 0 ? m : { ...m, from: undefined }));
    const s = state();
    s.steps.mc_read_many.output.messages = rows;
    const step = { id: 'f', type: 'filter', arrayRef: ARRAY_REF, expr: 'contains(item.from, "fabrikam")' };
    const { result, entries } = await logged(() => execFilter(step, {}, s));
    assert.equal(result.output.count, 1);
    assert.deepEqual(entries, []);
});

test('filter: a list column typo is recorded; the right column is not', async () => {
    const typo = { id: 'f', type: 'filter', arrayRef: ARRAY_REF, expr: 'contains(item.attachments[*].mimetype, "pdf")' };
    const { entries } = await logged(() => execFilter(typo, {}, state()));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].path, 'item.attachments[*].mimetype');
    assert.equal(entries[0].count, 4);
    const right = { ...typo, expr: 'contains(item.attachments[*].mimeType, "pdf")' };
    const ok = await logged(() => execFilter(right, {}, state()));
    assert.equal(ok.result.output.count, 2);
    assert.deepEqual(ok.entries, []);
});

test('list switch: the miss names the case it belongs to', async () => {
    const step = {
        id: 'sw', type: 'switch', arrayRef: ARRAY_REF, routeStyle: 'rules',
        cases: [
            { name: 'pdf', expr: 'anyOf(fileType(item.attachments[*]), "equals", "pdf")' },
            { name: 'fabrikam', expr: 'contains(item.frm, "fabrikam")' },
        ],
    };
    const { result, entries } = await logged(() => execSwitch(step, {}, state()));
    assert.equal(result.output.counts.pdf, 2);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].field, 'fabrikam');
    assert.equal(entries[0].path, 'item.frm');
    assert.equal(entries[0].count, 4);
});

test('condition (whole run): a path that finds nothing is recorded once', async () => {
    const step = { id: 'c', type: 'condition', expr: 'len(steps.mc_read_many.output.mesages) > 0' };
    const { result, entries } = await logged(() => execCondition(step, {}, state()));
    assert.equal(result.output.branch, 'else');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, 'rule');
    assert.equal(entries[0].path, 'steps.mc_read_many.output.mesages');
    assert.equal(entries[0].count, 1);
    const fine = await logged(() => execCondition({ ...step, expr: 'len(steps.mc_read_many.output.messages) > 0' }, {}, state()));
    assert.equal(fine.result.output.branch, 'then');
    assert.deepEqual(fine.entries, []);
});

test('filter: an absence check on an optional field that kept every mail is not recorded', async () => {
    const step = { id: 'f', type: 'filter', arrayRef: ARRAY_REF, expr: 'isEmpty(item.cc)' };
    const { result, entries } = await logged(() => execFilter(step, {}, state()));
    assert.equal(result.output.count, 4);
    assert.deepEqual(entries, []);
    const fallback = { ...step, expr: 'contains(item.replyTo || item.from, "example")' };
    const fb = await logged(() => execFilter(fallback, {}, state()));
    assert.equal(fb.result.output.count, 4);
    assert.deepEqual(fb.entries, []);
});

test('condition (whole run): a step skipped on another branch is not recorded', async () => {
    const step = { id: 'c', type: 'condition', expr: 'steps.reply.output.ok == true || len(steps.mc_read_many.output.messages) > 0' };
    const { result, entries } = await logged(() => execCondition(step, {}, state()));
    assert.equal(result.output.branch, 'then');
    assert.deepEqual(entries, []);
});

test('list switch: an absence check is gated by its own case', async () => {
    const step = {
        id: 'sw', type: 'switch', arrayRef: ARRAY_REF, routeStyle: 'rules',
        cases: [
            { name: 'nocc', expr: 'isEmpty(item.cc)' },
            { name: 'flagged', expr: 'item.flaged == true' },
        ],
    };
    const { entries } = await logged(() => execSwitch(step, {}, state()));
    assert.deepEqual(entries.map((e) => [e.field, e.path]), [['flagged', 'item.flaged']]);
});
