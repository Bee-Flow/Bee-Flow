/**
 * The Outlook mail samples carry an attachment, so a flatten after Outlook
 * "Read many" is planned before any run (spec A-7, J4).
 *
 * Run: cd server && node --test automation/outputSchemas.flatten.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { getOutputSchema } = require('./outputSchemas');
const { routeLevels, flattenPlan } = require('./expr');

const root = () => ({ steps: { o: { output: getOutputSchema('outlook_read_many').sample } } });

test('outlook_read_many: routeLevels finds the attachments as a list of records', () => {
    const levels = routeLevels('steps.o.output.messages', root());
    const att = levels.find(l => l.depth === 1 && l.key === 'attachments');
    assert.ok(att, 'attachments level found');
    assert.strictEqual(att.records, true);
    assert.strictEqual(att.count, 1);
});

test('outlook_read_many: the message id is copied as messageId (attachments have their own id)', () => {
    const plan = flattenPlan(root(), 'steps.o.output.messages[*].attachments');
    const id = plan.parents[0].fields.find(f => f.from === 'id');
    assert.deepStrictEqual(id, { from: 'id', to: 'messageId', mode: 'copy' });
    assert.ok(plan.left.some(l => l.key === 'body'));
});

test('outlook_read: the single-mail sample has an attachment too', () => {
    const s = getOutputSchema('outlook_read').sample;
    assert.strictEqual(s.hasAttachments, true);
    assert.strictEqual(s.attachments[0].filename, 'offerte-q4.pdf');
});
