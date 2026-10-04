/**
 * automation/notificationMessages: what a notification says outside the Bee
 * Flow bell (name + event + link only), the bundle line and the daily summary.
 *
 * Run: cd server && node --test automation/notificationMessages.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { shortMessage, bundleMessage, talkText, composeDigest, automationName, MESSAGE_TEXT } = require('./notificationMessages');

test('the short line is the automation name and the event, from a code', () => {
    assert.deepEqual(shortMessage({ event: 'onError', title: 'Invoices' }), {
        code: 'automation.notify.run_failed', params: { name: 'Invoices' }, text: 'Invoices stopped with an error',
    });
    assert.equal(shortMessage({ event: 'onApproval', title: 'Invoices' }).text, 'Invoices needs an approval');
    assert.equal(shortMessage({ event: 'onSuccess', title: 'Invoices' }).text, 'Invoices finished');
    assert.equal(shortMessage({ event: 'onError', code: 'automation.notify.schedule_disabled', title: 'X' }).code, 'automation.notify.schedule_disabled');
    assert.equal(shortMessage({ event: 'onError', code: 'made.up', title: 'X' }).code, 'automation.notify.run_failed');
});

test('automation names are one tidy line', () => {
    assert.equal(automationName('  Monthly\n\nreport  '), 'Monthly report');
    assert.equal(automationName(''), 'An automation');
    assert.equal(automationName('x'.repeat(200)).length, 120);
});

test('no English template uses a dash as punctuation', () => {
    for (const text of Object.values(MESSAGE_TEXT)) assert.doesNotMatch(text, /[—–]| - /);
});

test('bundle line per event', () => {
    assert.equal(bundleMessage({ event: 'onError', title: 'Invoices', count: 3 }).text, 'Invoices: 3 more errors in the last hour');
    assert.equal(bundleMessage({ event: 'onSuccess', title: 'Invoices', count: 2 }).code, 'automation.notify.bundle.onSuccess');
});

test('a Talk message is the line and the link', () => {
    assert.equal(talkText('Invoices finished', 'https://x/app'), 'Invoices finished\nhttps://x/app');
    assert.equal(talkText('Invoices finished', null), 'Invoices finished');
});

test('the summary: totals, per-automation lines, busiest problems first', () => {
    const d = composeDigest({
        items: [
            { automationId: 'a', title: 'Quiet', runs: 0, failures: 0, waiting: 0 },
            { automationId: 'b', title: 'Invoices', runs: 12, failures: 0, waiting: 1 },
            { automationId: 'c', title: 'Files', runs: 4, failures: 2, waiting: 0 },
        ],
        link: '/app/studio/automations',
    });
    assert.equal(d.code, 'automation.notify.digest');
    assert.deepEqual(d.params, { runs: 16, failures: 2, waiting: 1, automations: 2 });
    assert.equal(d.shortText, 'Your automations today: 16 runs, 2 failed, 1 still waiting');
    assert.deepEqual(d.text.split('\n'), [
        '16 runs, 2 failed, 1 still waiting',
        '',
        'Files: 4 runs, 2 failed',
        'Invoices: 12 runs, 1 waiting',
    ]);
    assert.deepEqual(d.items.map(i => i.automationId), ['c', 'b'], 'the quiet automation is left out');
});

test('no summary when nothing happened and nothing waits', () => {
    assert.equal(composeDigest({ items: [{ title: 'Quiet', runs: 0, failures: 0, waiting: 0 }] }), null);
    assert.equal(composeDigest({ items: [] }), null);
});

test('held notifications alone still make a summary', () => {
    const d = composeDigest({ items: [{ title: 'X', runs: 0, failures: 0, waiting: 0, held: 2 }] });
    assert.ok(d);
    assert.equal(d.shortText, 'Your automations today: 0 runs, none failed');
});
