// @typecheck
'use strict';
/**
 * Run: node --test automation/patterns/builderMapping.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { toDraft, normaliseApp, resolveAppTrigger, humaniseTool, APP_TRIGGERS, DECLARED_EVENTS } = require('./builderMapping');

test('every app trigger in the table names a declared provider and event', () => {
    for (const [key, t] of Object.entries(APP_TRIGGERS)) {
        assert.ok(DECLARED_EVENTS.get(t.provider)?.has(t.event), `${key} → ${t.provider}/${t.event} is not declared`);
    }
});

test('normaliseApp settles both id spellings', () => {
    assert.strictEqual(normaliseApp('google_drive'), 'google-drive');
    assert.strictEqual(normaliseApp('nextcloud_mail'), 'nextcloud-mail');
    assert.strictEqual(normaliseApp('nextcloud_tables'), 'nextcloud-tables');
    assert.strictEqual(normaliseApp('ms_teams'), 'teams');
    assert.strictEqual(normaliseApp('gmail'), 'gmail');
    assert.strictEqual(resolveAppTrigger('google_drive', 'file_drop').provider, 'google-drive');
    assert.strictEqual(resolveAppTrigger('nextcloud_mail', 'mail_template'), null);
});

test('humaniseTool strips the app prefix', () => {
    assert.strictEqual(humaniseTool('sheets_append_rows'), 'Append rows');
    assert.strictEqual(humaniseTool('zammad_list_tickets', 'zammad'), 'List tickets');
    assert.strictEqual(humaniseTool('web_search'), 'Web search');
    // The longest prefix naming the app goes.
    assert.strictEqual(humaniseTool('nextcloud_tables_create_row', 'nextcloud-tables'), 'Create row');
    assert.strictEqual(humaniseTool('docs_create_document', 'google-docs'), 'Create document');
});

test('inbound invoice mail → Gmail trigger, extraction before the write', () => {
    const d = toDraft({
        kind: 'mail_template', direction: 'in', structured: true,
        verbs: ['mail.received', 'gmail_get_attachment', 'sheets_append_rows'], verbApps: ['gmail', 'gmail', 'google-sheets'],
        apps: ['gmail', 'google-sheets'], cadence: { kind: 'weekly', weekday: 1 },
    });
    assert.deepStrictEqual(d.trigger, { kind: 'app', app: 'gmail', provider: 'gmail', event: 'mail.new', label: 'New email in Gmail' });
    assert.deepStrictEqual(d.steps, [
        { family: 'app', app: 'gmail', label: 'Get attachment' },
        { family: 'ai', label: 'Extract the details' },
        { family: 'app', app: 'google-sheets', label: 'Append rows' },
    ]);
});

test('outlook mail and arriving onedrive files map onto msgraph', () => {
    const mail = toDraft({ kind: 'mail_template', direction: 'in', verbs: ['mail.received', 'outlook_reply'], verbApps: ['outlook', 'outlook'], apps: ['outlook'] });
    assert.strictEqual(mail.trigger.provider, 'msgraph');
    const file = toDraft({ kind: 'file_drop', direction: 'in', verbs: ['file.created'], verbApps: ['onedrive'], apps: ['onedrive'] });
    assert.deepStrictEqual([file.trigger.provider, file.trigger.event], ['msgraph', 'file.new']);
    assert.strictEqual(file.steps.length, 2);
});

test("a file the user creates on a cadence is scheduled work, saved where they saved it", () => {
    const d = toDraft({ kind: 'file_drop', verbs: ['file.created'], verbApps: ['google_drive'], apps: ['google_drive'], cadence: { kind: 'weekly', weekday: 1, hourBand: [9, 10] } });
    assert.deepStrictEqual(d.trigger, { kind: 'schedule', label: 'Every week on Monday at 09:00' });
    assert.deepStrictEqual(d.steps.map((s) => s.family), ['data', 'ai', 'app']);
    assert.deepStrictEqual(d.steps[2], { family: 'app', app: 'google-drive', label: 'Save it in the same folder' });
    const kb = toDraft({ kind: 'file_drop', verbs: ['doc.uploaded'], verbApps: ['beeflow'], apps: ['beeflow'], cadence: { kind: 'irregular' } });
    assert.strictEqual(kb.trigger.kind, 'manual');
    assert.strictEqual(kb.steps[2].label, 'Add it to the knowledge base');
});

test('after a mail trigger, searching for that mail is not a step', () => {
    const d = toDraft({
        kind: 'mail_template', direction: 'in', structured: false,
        verbs: ['mail.received', 'gmail_search', 'gmail_get_attachment', 'nextcloud_tables_create_row', 'gmail_search'],
        verbApps: ['gmail', 'gmail', 'gmail', 'nextcloud_tables', 'gmail'], apps: ['gmail', 'nextcloud_tables'],
    });
    assert.deepStrictEqual(d.steps.map((s) => `${s.app}:${s.label}`), [
        'gmail:Get attachment', 'nextcloud-tables:Create row', 'gmail:Search',
    ]);
});

test('weekly on several fixed days names them', () => {
    const d = toDraft({
        kind: 'sequence', verbs: ['crm_list_orders', 'sheets_append_rows'], verbApps: ['crm', 'google_sheets'], apps: ['crm', 'google_sheets'],
        cadence: { kind: 'weekly', hourBand: [11, 12], weekdayHistogram: [0, 13, 0, 13, 0, 12, 0] },
    });
    assert.strictEqual(d.trigger.label, 'Every Monday, Wednesday and Friday at 11:00');
});

test('a sent mail or a tool sequence gets a schedule from its cadence', () => {
    const out = toDraft({ kind: 'mail_template', direction: 'out', verbs: ['mail.sent'], verbApps: ['gmail'], apps: ['gmail'], cadence: { kind: 'monthly', hourBand: [16, 17] } });
    assert.deepStrictEqual(out.trigger, { kind: 'schedule', label: 'Every month at 16:00' });
    assert.deepStrictEqual(out.steps.map((s) => s.label), ['Draft the email', 'Send the email']);
    const seq = toDraft({ kind: 'sequence', verbs: ['zammad_list_tickets', 'zammad_update_ticket'], verbApps: ['zammad', 'zammad'], apps: ['zammad'], cadence: { kind: 'weekly', weekday: 5 } });
    assert.deepStrictEqual(seq.trigger, { kind: 'schedule', label: 'Every week on Friday' });
    assert.strictEqual(seq.steps.length, 2);
});

test('irregular without an app trigger is manual; meetings map to meeting notes', () => {
    const d = toDraft({ kind: 'sequence', verbs: ['a_get', 'b_set'], verbApps: ['a', 'b'], apps: ['a', 'b'], cadence: { kind: 'irregular' } });
    assert.strictEqual(d.trigger.kind, 'manual');
    const m = toDraft({ kind: 'meeting_followup', verbs: ['meeting.held', 'mail.sent'], verbApps: ['teams', 'outlook'], apps: ['teams', 'outlook'] });
    assert.deepStrictEqual([m.trigger.provider, m.trigger.event], ['meeting-notes', 'meeting.processed']);
    assert.strictEqual(m.steps[0].family, 'ai');
});

test('no verbs, no draft', () => {
    assert.strictEqual(toDraft(null), null);
    assert.strictEqual(toDraft({ kind: 'sequence', verbs: [] }), null);
});
