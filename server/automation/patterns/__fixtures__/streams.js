// @typecheck
'use strict';
/**
 * Golden event streams for the miner, hand-labelled.
 *
 * Each fixture: { name, label: 'positive'|'negative', now, events, expect, coldStart? }.
 * `expect` lists the patterns a positive stream holds; a surfaced candidate
 * matches one when its kind (if given) is equal and its verbs include every
 * verb listed. A negative stream must surface nothing at all.
 */

const {
    NOW, MIN, rng, at, daysOn, mailIn, mailOut, fileNew, meeting, session, noise, heavyUse,
} = require('./builders');

const MON = 1, TUE = 2, WED = 3, THU = 4, FRI = 5;
const WEEKDAYS = [MON, TUE, WED, THU, FRI];

/** @type {Array<{ name: string, label: 'positive'|'negative', now: number, events: any[], expect: any[], coldStart?: boolean }>} */
const fixtures = [];
const pos = (name, events, expect, extra = {}) => fixtures.push({ name, label: 'positive', now: NOW, events, expect, ...extra });
const neg = (name, events, extra = {}) => fixtures.push({ name, label: 'negative', now: NOW, events, expect: [], ...extra });

// ── Positives ───────────────────────────────────────────────────────────────

/** Invoice mail every week, then the user files it in a sheet. */
function invoiceToSheet({ seed, app, weekday, subject, hour = 8, domains = ['d1'] }) {
    const r = rng(seed);
    const out = [];
    let n = 4000 + seed;
    for (const d of daysOn([weekday])) {
        const ts = at(d, hour, Math.floor(r() * 30));
        out.push(mailIn(ts, app, subject(n++), { attachment: true, domain: domains[n % domains.length] }));
        const searchTool = app === 'gmail' ? ['gmail_search', 'gmail'] : ['outlook_search_messages', 'outlook'];
        const attTool = app === 'gmail' ? ['gmail_get_attachment', 'gmail'] : ['outlook_get_attachment', 'outlook'];
        out.push(...session(ts + (30 + Math.floor(r() * 60)) * MIN, `inv-${seed}-${d}`, [searchTool, attTool, ['sheets_append_rows', 'google-sheets']], 4));
    }
    return out;
}
pos('invoice_gmail_to_sheet_monday', [
    ...invoiceToSheet({ seed: 1, app: 'gmail', weekday: MON, subject: (n) => `Factuur INV-2026-${n} van leverancier` }),
    ...noise(101),
], [{ verbs: ['sheets_append_rows'] }]);
pos('invoice_outlook_to_sheet_thursday', [
    ...invoiceToSheet({ seed: 2, app: 'outlook', weekday: THU, hour: 13, subject: (n) => `RE: Invoice #${n} for September services` }),
    ...noise(102),
], [{ verbs: ['sheets_append_rows'] }]);
pos('invoice_multi_supplier_domains', [
    ...invoiceToSheet({ seed: 3, app: 'gmail', weekday: WED, subject: (n) => `Invoice ${n} due 2026-10-${10 + (n % 15)}`, domains: ['d1', 'd2', 'd3'] }),
    ...noise(103, { mailsPerDay: 4 }),
], [{ verbs: ['sheets_append_rows'] }]);

/** A report saved to the same folder every Monday morning. */
function mondayUpload({ seed, app, name, folder, weekday = MON, source = 'files' }) {
    const r = rng(seed);
    let week = 30;
    return daysOn([weekday]).reverse().map((d) => fileNew(at(d, 9, Math.floor(r() * 50)), app, name(week++), folder, source));
}
pos('monday_report_upload_nextcloud', [
    ...mondayUpload({ seed: 4, app: 'nextcloud', name: (w) => `Weekly report week ${w}.xlsx`, folder: 'f-reports' }),
    ...noise(104),
], [{ kind: 'file_drop' }]);
pos('monday_report_upload_drive', [
    ...mondayUpload({ seed: 5, app: 'google_drive', name: (w) => `Sales_report-2026-${String(w % 12 + 1).padStart(2, '0')}-0${w % 9 + 1}.pdf`, folder: 'f-sales' }),
    ...noise(105),
], [{ kind: 'file_drop' }]);
pos('friday_kb_upload_documents', [
    ...mondayUpload({ seed: 6, app: 'beeflow', weekday: FRI, name: (w) => `Teamupdate wk${w}.docx`, folder: 'kb-team', source: 'documents' }),
    ...noise(106),
], [{ kind: 'file_drop' }]);

/** An expense mail the user sends at the end of every month. */
function monthlyOut({ app, subject, daysAgo }) {
    return daysAgo.map((d, i) => mailOut(at(d, 16, 10 + i), app, subject(i), { attachment: true }));
}
const MONTHS = ['juli', 'augustus', 'september'];
const MONTHS_EN = ['July', 'August', 'September'];
pos('monthly_expense_mail_gmail', [
    ...monthlyOut({ app: 'gmail', subject: (i) => `Declaratie ${MONTHS[i]} 2026`, daysAgo: [65, 35, 4] }),
    ...noise(107),
], [{ kind: 'mail_template', verbs: ['mail.sent'] }]);
pos('monthly_expense_mail_outlook', [
    ...monthlyOut({ app: 'outlook', subject: (i) => `Expense report ${MONTHS_EN[i]}`, daysAgo: [64, 34, 3] }),
    ...noise(108),
], [{ kind: 'mail_template', verbs: ['mail.sent'] }]);

/** Ticket triage every working morning: list, update, note. */
function triage({ seed, days = 90, steps, weekdaysOnly = true }) {
    const r = rng(seed);
    const out = [];
    const ds = weekdaysOnly ? daysOn(WEEKDAYS, days) : [...Array(days).keys()];
    for (const d of ds) out.push(...session(at(d, 8, 20 + Math.floor(r() * 25)), `tri-${seed}-${d}`, steps, 2 + Math.floor(r() * 4)));
    return out;
}
const TRIAGE = [['zammad_list_tickets', 'zammad'], ['zammad_update_ticket', 'zammad'], ['zammad_add_note', 'zammad']];
pos('daily_ticket_triage', [...triage({ seed: 7, steps: TRIAGE }), ...noise(109)], [{ kind: 'sequence', verbs: ['zammad_update_ticket'] }]);
pos('daily_mail_labelling_all_week', [
    ...triage({ seed: 8, weekdaysOnly: false, steps: [['gmail_search', 'gmail'], ['gmail_modify_labels', 'gmail']] }),
    ...noise(110),
], [{ kind: 'sequence', verbs: ['gmail_modify_labels'] }]);

/** A weekly meeting the user always follows up on. */
function meetingFollowup({ seed, app, weekday, every = 1, follow }) {
    const r = rng(seed);
    const out = [];
    const ds = daysOn([weekday]).filter((_, i) => i % every === 0);
    for (const d of ds) {
        const ts = at(d, 10, 0);
        out.push(meeting(ts, app, `series-${seed}`));
        out.push(...follow(ts + (60 + Math.floor(r() * 60)) * MIN, d));
    }
    return out;
}
pos('meeting_followup_teams_actions_mail', [
    ...meetingFollowup({
        seed: 9, app: 'teams', weekday: TUE,
        follow: (ts, d) => [mailOut(ts, 'outlook', `Actiepunten weekoverleg ${new Date(ts).toISOString().slice(0, 10)}`), ...session(ts + 5 * MIN, `mf-${d}`, [['planner_create_task', 'planner']])],
    }),
    ...noise(111),
], [{ kind: 'meeting_followup' }]);
pos('meeting_followup_gmeet_biweekly_doc', [
    ...meetingFollowup({
        seed: 10, app: 'gmeet', weekday: WED, every: 2,
        follow: (ts, d) => session(ts, `mg-${d}`, [['docs_create_document', 'google-docs'], ['gmail_send', 'gmail']]),
    }),
    ...noise(112),
], [{ kind: 'meeting_followup' }]);

pos('friday_status_mail', [
    ...daysOn([FRI]).map((d, i) => mailOut(at(d, 15, 30 + (i % 20)), 'gmail', `Status update week ${41 - i}`)),
    ...noise(113),
], [{ kind: 'mail_template', verbs: ['mail.sent'] }]);

pos('friday_crm_export_sequence', [
    ...daysOn([FRI]).flatMap((d) => session(at(d, 14, 5), `crm-${d}`, [['hubspot_list_deals', 'hubspot'], ['sheets_append_rows', 'google-sheets'], ['gmail_send', 'gmail']], 6)),
    ...noise(114),
], [{ kind: 'sequence', verbs: ['hubspot_list_deals', 'sheets_append_rows'] }]);

pos('nextcloud_orders_three_times_a_week', (() => {
    const r = rng(15);
    const out = [];
    let n = 77000;
    for (const d of daysOn([MON, WED, FRI])) {
        const ts = at(d, 11, Math.floor(r() * 40));
        out.push(mailIn(ts, 'nextcloud_mail', `Bestelling #${n++} ontvangen`, { domain: 'd7' }));
        out.push(...session(ts + 25 * MIN, `ord-${d}`, [['nextcloud_tables_create_row', 'nextcloud_tables']]));
    }
    return [...out, ...noise(115)];
})(), [{ verbs: ['nextcloud_tables_create_row'] }]);

pos('two_habits_in_one_stream', [
    ...invoiceToSheet({ seed: 16, app: 'gmail', weekday: MON, subject: (n) => `Factuur ${n}` }),
    ...mondayUpload({ seed: 17, app: 'nextcloud', weekday: THU, name: (w) => `Omzet rapportage week ${w}.xlsx`, folder: 'f-omzet' }),
    ...noise(116),
], [{ verbs: ['sheets_append_rows'] }, { kind: 'file_drop' }]);

pos('timesheet_friday_sequence', [
    ...daysOn([FRI]).flatMap((d) => session(at(d, 16, 0), `ts-${d}`, [['harvest_list_entries', 'harvest'], ['sheets_update_values', 'google-sheets']], 8)),
    ...noise(117),
], [{ kind: 'sequence', verbs: ['harvest_list_entries'] }]);

// A triage habit inside a heavy user's random tool use.
pos('triage_hidden_in_heavy_use', [
    ...triage({ seed: 19, steps: [['freshdesk_list_tickets', 'freshdesk'], ['freshdesk_reply_ticket', 'freshdesk']] }),
    ...heavyUse(120),
], [{ kind: 'sequence', verbs: ['freshdesk_reply_ticket'] }]);

// Cold start: ten days of history, still a clear daily habit.
pos('cold_start_daily_triage', [...triage({ seed: 18, days: 10, steps: TRIAGE }), ...noise(118, { days: 10 })],
    [{ kind: 'sequence', verbs: ['zammad_update_ticket'] }], { coldStart: true });
pos('cold_start_daily_report_mail', [
    ...daysOn(WEEKDAYS, 11).map((d) => mailOut(at(d, 17, 5), 'outlook', `Dagrapport ${new Date(at(d)).toISOString().slice(0, 10)}`)),
    ...noise(119, { days: 11 }),
], [{ kind: 'mail_template' }], { coldStart: true });

// ── Negatives ───────────────────────────────────────────────────────────────

neg('newsletter_weekly_bulk', [
    ...daysOn([THU]).map((d, i) => mailIn(at(d, 6, 0), 'gmail', `Weekly digest #${200 + i}`, { bulk: true, domain: 'dnews' })),
    ...noise(201),
]);
neg('newsletter_daily_bulk', [
    ...[...Array(90).keys()].map((d) => mailIn(at(d, 5, 30), 'outlook', `Your daily briefing - ${new Date(at(d)).toUTCString().slice(5, 16)}`, { bulk: true, domain: 'dbrief' })),
    ...noise(202),
]);
neg('newsletter_bulk_sometimes_followed', (() => {
    const r = rng(203);
    const out = [];
    for (const d of daysOn([TUE])) {
        out.push(mailIn(at(d, 7), 'gmail', `Product news ${d}`, { bulk: true, domain: 'dprod' }));
        if (r() < 0.3) out.push(...session(at(d, 9), `nl-${d}`, [['web_fetch', 'web']]));
    }
    return [...out, ...noise(203)];
})());
neg('bare_daily_standup', [...daysOn(WEEKDAYS).map((d) => meeting(at(d, 9, 0), 'teams', 'standup')), ...noise(204)]);
neg('bare_weekly_meeting', [...daysOn([MON]).map((d) => meeting(at(d, 14, 0), 'gmeet', 'weekly-sync')), ...noise(205)]);
neg('standup_with_everyday_tool_use', [
    ...daysOn(WEEKDAYS).map((d) => meeting(at(d, 9, 0), 'teams', 'standup-2')),
    ...daysOn(WEEKDAYS).flatMap((d) => session(at(d, 10, 30), `daily-${d}`, [['gmail_read_message', 'gmail']])),
    ...noise(206),
]);
neg('auto_synced_camera_folder', [
    ...[...Array(90).keys()].flatMap((d) => [...Array(20).keys()].map((i) => fileNew(at(d, 2, 0) + i * 5000, 'nextcloud', `IMG_${d * 100 + i}.jpg`, 'camera-uploads'))),
    ...noise(207),
]);
neg('hourly_export_folder', [
    ...[...Array(60).keys()].flatMap((d) => [...Array(24).keys()].map((h) => fileNew(at(d, h, 1), 'onedrive', `export_${d}_${h}.csv`, 'exports'))),
    ...noise(208),
]);
neg('random_one_offs', noise(209));
neg('random_one_offs_dense', noise(210, { toolsPerDay: 3, mailsPerDay: 5, filesPerWeek: 5, pairs: 0.6 }));
neg('heavy_random_long_sessions', heavyUse(211));
neg('unknown_source_lookalike', daysOn(WEEKDAYS).flatMap((d) => [0, 1, 2].map((i) => ({
    ts: at(d, 8, i * 3), source: 'chat', objectType: 'tool', app: 'zammad', verb: `zammad_step_${i}`,
    sessionKey: `x-${d}`, templateId: null, template: null,
}))));
neg('automated_server_report_no_action', [
    ...[...Array(90).keys()].map((d) => mailIn(at(d, 3, 0), 'gmail', `Backup report server-01 ${new Date(at(d)).toISOString().slice(0, 10)}`, { domain: 'dsrv' })),
    ...noise(212),
]);
neg('too_few_sends', [
    mailOut(at(40, 16), 'gmail', 'Kwartaalcijfers Q2'), mailOut(at(10, 16), 'gmail', 'Kwartaalcijfers Q3'),
    ...noise(213),
]);
neg('short_history_noise', noise(214, { days: 5 }), { coldStart: true });

module.exports = { fixtures };
