/**
 * Reminder + escalation clocks — the pure half.
 *
 * approvalClocks turns hours into timestamps with ONE rule worth pinning: a
 * clock that would fire at or after the deadline is dropped — nudging (or
 * escalating) an approval that already expired is worse than silence.
 *
 * Run: node --test core/automationRunner/approvalLifecycle.clocks.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { approvalClocks } = require('./approvalLifecycle');

const NOW = Date.parse('2026-08-22T12:00:00Z');
const H = 3_600_000;

test('hours become timestamps measured from the pause', () => {
    const { remindAt, escalateAt } = approvalClocks({ remindAfterHours: 24, escalateAfterHours: 48 }, NOW);
    assert.strictEqual(Date.parse(remindAt), NOW + 24 * H);
    assert.strictEqual(Date.parse(escalateAt), NOW + 48 * H);
});

test('a clock at or past the deadline is dropped', () => {
    const expiresAt = new Date(NOW + 24 * H).toISOString();
    const c = approvalClocks({ remindAfterHours: 24, escalateAfterHours: 12, expiresAt }, NOW);
    assert.strictEqual(c.remindAt, null, 'reminder AT the deadline never fires');
    assert.strictEqual(Date.parse(c.escalateAt), NOW + 12 * H, 'escalation before the deadline survives');
});

test('no deadline = clocks run free; junk hours = no clock', () => {
    const free = approvalClocks({ remindAfterHours: 700, escalateAfterHours: 700, expiresAt: null }, NOW);
    assert.ok(free.remindAt && free.escalateAt);
    for (const bad of [0, -1, 'soon', null, undefined, NaN]) {
        const c = approvalClocks({ remindAfterHours: bad, escalateAfterHours: bad }, NOW);
        assert.strictEqual(c.remindAt, null, `${bad} is not a reminder`);
        assert.strictEqual(c.escalateAt, null, `${bad} is not an escalation`);
    }
});

test('hours cap at 720 (30 days), mirroring the deadline ceiling', () => {
    const { remindAt } = approvalClocks({ remindAfterHours: 9999 }, NOW);
    assert.strictEqual(Date.parse(remindAt), NOW + 720 * H);
});

test('the reminder bell text puts the nudge on its own line, with no dash as punctuation', () => {
    const { _approvalLifecycleTest: { reminderBellMessage } } = require('./approvalLifecycle');
    const withPrompt = reminderBellMessage({ prompt: 'Pay it?' }, ' It expires tomorrow.');
    assert.strictEqual(withPrompt, 'Pay it?\nNobody has decided yet. It expires tomorrow.');
    assert.strictEqual(reminderBellMessage({ prompt: '' }), 'Nobody has decided yet.');
    for (const text of [withPrompt, reminderBellMessage({})]) {
        assert.ok(!/[–—]/.test(text), `no en or em dash in "${text}"`);
    }
});
