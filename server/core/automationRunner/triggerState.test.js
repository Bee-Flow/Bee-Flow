/**
 * runState.trigger carries WHICH trigger fired, beside the payload.
 *
 * Pins the contract every multi-trigger automation relies on: `output` is the raw
 * payload and nothing else; the meta (kind / source / id / provider / event /
 * firedAt / schedule) sits next to it; `kind` is what the definition declares
 * for the trigger the run entered through, `source` is how the run was
 * dispatched — so a manual test of the Gmail branch reads kind 'app_event',
 * source 'manual'.
 *
 * Run: node --test core/automationRunner/triggerState.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { buildTriggerState, TRIGGER_META_KEYS } = require('./triggerState');
const { walkPath, interpolateTemplate } = require('../../automation/bind');
const { evaluate } = require('../../automation/expr');

const GMAIL = { id: 'trg', type: 'trigger', kind: 'app_event', label: 'New mail', appEvent: { provider: 'gmail', event: 'mail.new', filter: {} } };
const DAILY = { id: 'trig_ab12cd', type: 'trigger', kind: 'schedule', label: 'Daily briefing', schedule: { cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam' } };

test('the payload is `output`, untouched, and the meta sits beside it', () => {
    const payload = { messageId: 'm1', from: 'a@b.nl', kind: 'a body field called kind' };
    const t = buildTriggerState({ enteredTrigger: GMAIL, triggerKind: 'app_event', triggerPayload: payload, startedAt: Date.UTC(2026, 8, 3, 7, 0, 0) });
    assert.strictEqual(t.output, payload, 'output is the payload object itself');
    assert.strictEqual(t.output.kind, 'a body field called kind', 'a payload field never collides with the meta');
    assert.strictEqual(t.kind, 'app_event');
    assert.strictEqual(t.source, 'app_event');
    assert.strictEqual(t.id, 'trg');
    assert.strictEqual(t.label, 'New mail');
    assert.strictEqual(t.provider, 'gmail');
    assert.strictEqual(t.event, 'mail.new');
    assert.strictEqual(t.firedAt, '2026-09-03T07:00:00.000Z');
    assert.strictEqual(t.schedule, null);
    assert.ok(!('headers' in t), 'no headers key unless headers were given');
    for (const k of TRIGGER_META_KEYS) assert.ok(k in t, `meta key ${k} present`);
});

test('kind is the entered trigger; source is how the run was started', () => {
    const t = buildTriggerState({ enteredTrigger: GMAIL, triggerKind: 'manual', triggerPayload: null });
    assert.strictEqual(t.kind, 'app_event', 'a manual test of the Gmail root still reads as the Gmail root');
    assert.strictEqual(t.source, 'manual');
    assert.deepStrictEqual(t.output, {}, 'no payload → empty output, never null');
});

test('a secondary schedule trigger carries its declared cron, and the fired slot when the scheduler passes it', () => {
    const declared = buildTriggerState({ enteredTrigger: DAILY, triggerKind: 'schedule', triggerPayload: { now: 'x' } });
    assert.deepStrictEqual(declared.schedule, { cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam', scheduledFor: null });
    assert.strictEqual(declared.provider, null);
    const fired = buildTriggerState({
        enteredTrigger: DAILY, triggerKind: 'schedule', triggerPayload: { now: 'x' },
        schedule: { id: 'sch_1', cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam', scheduledFor: new Date(Date.UTC(2026, 8, 4, 5, 0, 0)) },
    });
    assert.strictEqual(fired.schedule.scheduledFor, '2026-09-04T05:00:00.000Z');
    assert.strictEqual(fired.id, 'trig_ab12cd');
});

test('headers ride beside output, never inside it', () => {
    const t = buildTriggerState({ enteredTrigger: { id: 'trg', kind: 'webhook' }, triggerKind: 'webhook', triggerPayload: { a: 1 }, triggerHeaders: { 'x-sig': 'y' } });
    assert.deepStrictEqual(t.headers, { 'x-sig': 'y' });
    assert.deepStrictEqual(t.output, { a: 1 });
});

test('a definition without a trigger still yields a well-formed slot', () => {
    const t = buildTriggerState({ enteredTrigger: null, triggerKind: 'manual' });
    assert.strictEqual(t.kind, null);
    assert.strictEqual(t.source, 'manual');
    assert.deepStrictEqual(t.output, {});
});

test('templates, refs and expressions can read the meta the moment it exists', () => {
    const runState = { trigger: buildTriggerState({ enteredTrigger: GMAIL, triggerKind: 'app_event', triggerPayload: { subject: 'Hi' } }), steps: {}, vars: {} };
    assert.strictEqual(interpolateTemplate('{{trigger.kind}}/{{trigger.event}}/{{trigger.output.subject}}', runState), 'app_event/mail.new/Hi');
    assert.strictEqual(walkPath('trigger.provider', runState), 'gmail');
    assert.strictEqual(evaluate('trigger.kind == "app_event" && trigger.event == "mail.new"', runState), true);
    assert.strictEqual(evaluate('trigger.kind == "schedule"', runState), false);
});
