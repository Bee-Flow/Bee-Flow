/**
 * The Gmail trigger filter's `subjectRegex` runs on the sender's subject line
 * (automation/triggerBus/filters.js): under RE2, so a pattern with nested
 * quantifiers cannot stall the trigger bus; an invalid or refused pattern
 * fails closed (the trigger does not fire).
 *
 * Run: cd server && node --test automation/triggerBus/filters.gmail.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { pickMatcher } = require('./filters');

const match = pickMatcher('gmail', 'mail.new');
const mail = (subject) => ({ from: 'a@example.org', subject, labelIds: [] });

test('subjectRegex matches the subject case-insensitively', () => {
    assert.strictEqual(match(mail('Invoice INV-2024-001'), { subjectRegex: 'inv-\\d{4}-\\d{3}' }), true);
    assert.strictEqual(match(mail('Hello'), { subjectRegex: 'inv-\\d{4}' }), false);
    assert.strictEqual(match(mail(undefined), { subjectRegex: '^$' }), true);
});

test('the catastrophic shape decides in bounded time on a crafted subject', () => {
    const t0 = Date.now();
    assert.strictEqual(match(mail('a'.repeat(50_000) + '!'), { subjectRegex: '^(a+)+$' }), false);
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});

test('an invalid or refused pattern never fires', () => {
    assert.strictEqual(match(mail('aaab'), { subjectRegex: '[' }), false);
    assert.strictEqual(match(mail('aaab'), { subjectRegex: '(a+)+(?=b)' }), false);
});
