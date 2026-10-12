// @typecheck
'use strict';
/**
 * Run: node --test automation/patterns/suppress.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { patternSignature, suppressCandidates, WRONG_GROUPING_FACTOR } = require('./suppress');

const NOW = Date.UTC(2026, 9, 3, 18);
const mail = {
    kind: 'mail_template', apps: ['gmail', 'google-sheets'], templateIds: ['aaaaaaaaaaaa'], verbs: ['mail.received', 'sheets_append_rows'],
    cadence: { kind: 'weekly' }, score: 2, draft: { trigger: { kind: 'app' }, steps: [] },
};
const seq = { kind: 'sequence', apps: ['zammad'], templateIds: [], verbs: ['zammad_list', 'zammad_update'], cadence: { kind: 'weekdays' }, score: 3 };

test('patternSignature is stable, order-insensitive and ignores wording', () => {
    const s = patternSignature(mail);
    assert.match(s, /^[0-9a-f]{32}$/);
    assert.strictEqual(patternSignature(/** @type {any} */ ({ ...mail, apps: ['google-sheets', 'gmail'], title: 'Something else' })), s);
    assert.strictEqual(patternSignature({ ...mail, apps: ['gmail', 'google_sheets'] }), s);
    assert.notStrictEqual(patternSignature({ ...mail, cadence: { kind: 'monthly' } }), s);
    assert.notStrictEqual(patternSignature({ ...seq, verbs: ['zammad_list', 'zammad_close'] }), patternSignature(seq));
});

test('nothing to suppress keeps every candidate and stamps its signature', () => {
    const { kept, suppressed } = suppressCandidates({ candidates: [mail, seq] });
    assert.strictEqual(kept.length, 2);
    assert.strictEqual(suppressed.length, 0);
    assert.strictEqual(kept[0].signature, patternSignature(mail));
});

test('tools that already run in an automation suppress', () => {
    const { kept, suppressed } = suppressCandidates({ candidates: [mail, seq], automatedToolNames: new Set(['sheets_append_rows']) });
    assert.deepStrictEqual(kept.map((c) => c.kind), ['sequence']);
    assert.deepStrictEqual(suppressed.map((s) => s.reason), ['automated_tools']);
});

test("the user's own automation over the same apps with a compatible trigger suppresses", () => {
    const automations = [{ title: 'Invoices', triggerKind: 'app_event', apps: ['gmail', 'google-sheets', 'slack'] }];
    assert.strictEqual(suppressCandidates({ candidates: [mail], automations }).kept.length, 0);
    // A schedule cannot serve an app-event draft.
    const schedule = [{ title: 'Invoices', triggerKind: 'schedule', apps: ['gmail', 'google-sheets'] }];
    assert.strictEqual(suppressCandidates({ candidates: [mail], automations: schedule }).kept.length, 1);
    // Both spellings of an app id are the same app.
    const hyphen = [{ triggerKind: 'app_event', apps: ['gmail', 'google-sheets'] }];
    assert.strictEqual(suppressCandidates({ candidates: [{ ...mail, apps: ['gmail', 'google_sheets'] }], automations: hyphen }).kept.length, 0);
    // Missing an app: not the same work.
    assert.strictEqual(suppressCandidates({ candidates: [mail], automations: [{ triggerKind: 'app_event', apps: ['gmail'] }] }).kept.length, 1);
});

test('feedback: built, dismissed, do_myself, already_automated, privacy and snoozed suppress', () => {
    const sig = patternSignature(mail);
    /** @type {Array<[any, string]>} */
    const cases = [
        [{ action: 'built' }, 'built'],
        [{ action: 'dismissed' }, 'dismissed'],
        [{ action: 'dismissed', reasonCode: 'do_myself' }, 'do_myself'],
        [{ action: 'dismissed', reasonCode: 'already_automated' }, 'already_automated'],
        [{ action: 'dismissed', reasonCode: 'privacy' }, 'privacy'],
        [{ action: 'snoozed', snoozeUntil: NOW + 86_400_000 }, 'snoozed'],
        [{ action: 'snoozed' }, 'snoozed'],
    ];
    for (const [fb, reason] of cases) {
        const { kept, suppressed } = suppressCandidates({ candidates: [mail], feedback: [{ signature: sig, ...fb }], now: NOW });
        assert.strictEqual(kept.length, 0, JSON.stringify(fb));
        assert.strictEqual(suppressed[0].reason, reason);
    }
});

test('an expired snooze, asked and opened do not suppress', () => {
    const sig = patternSignature(mail);
    for (const fb of [{ action: 'snoozed', snoozeUntil: NOW - 1 }, { action: 'asked' }, { action: 'opened' }]) {
        assert.strictEqual(suppressCandidates({ candidates: [mail], feedback: [{ signature: sig, ...fb }], now: NOW }).kept.length, 1);
    }
});

test('wrong_grouping halves the score instead of hiding the pattern', () => {
    const sig = patternSignature(mail);
    const { kept } = suppressCandidates({ candidates: [mail], feedback: [{ signature: sig, action: 'dismissed', reasonCode: 'wrong_grouping' }] });
    assert.strictEqual(kept.length, 1);
    assert.strictEqual(kept[0].score, mail.score * WRONG_GROUPING_FACTOR);
    assert.strictEqual(kept[0].downWeighted, true);
});

test('feedback on another signature does nothing', () => {
    assert.strictEqual(suppressCandidates({ candidates: [mail], feedback: [{ signature: 'other', action: 'built' }] }).kept.length, 1);
});
