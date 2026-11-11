// @typecheck strict
/**
 * App Studio template — Request and approval flow.
 *
 * One of the four schema-3 templates (see ../templates.js). One app, two
 * audiences: a public intake page anyone with the link can use, and a review
 * screen for the team that decides.
 *
 *   public    two screens are public (publicAccess). A visitor carries the
 *             reserved role `public`, which may only CREATE a request: it reads
 *             no rows, and the triage table does not grant it anything.
 *   trigger   a record trigger on new requests, with the public opt-in
 *             (allowPublicWrites). Its action holds one create_record that
 *             writes a triage row, which is all such a trigger may do: no mail,
 *             no automation, no approval, no delete, no outside call.
 *   approval  the reviewer sends a request for approval: a sequence that runs
 *             on the server (runOn "server") and waits with `await_approval`
 *             (questions, a reminder, a time-out). An approved request then
 *             waits a week on the server (a durable `wait`) and flags itself
 *             for a follow-up. The run reports what it is doing through a
 *             progress variable the review screen shows.
 *   look      rich markdown (a table, a task list, a quote) on the help screen,
 *             an accordion of questions on the thank-you page, a wizard-free
 *             form that checks fields on blur.
 *
 * Nothing is armed on install: the trigger runs once the app is published.
 */

'use strict';

const { THEME_DEFAULTS } = require('./themeDefaults');

const CATEGORY_OPTIONS = [
    { value: 'equipment', label: 'Equipment' },
    { value: 'software', label: 'Software' },
    { value: 'training', label: 'Training' },
    { value: 'travel', label: 'Travel' },
    { value: 'other', label: 'Something else' },
];
const STATUS_OPTIONS = [
    { value: 'new', label: 'New' },
    { value: 'in_review', label: 'In review' },
    { value: 'approved', label: 'Approved' },
    { value: 'rejected', label: 'Rejected' },
    { value: 'expired', label: 'Expired' },
];
const STATUS_TONES = [
    { value: 'new', label: 'New', tone: 'info' },
    { value: 'in_review', label: 'In review', tone: 'warning' },
    { value: 'approved', label: 'Approved', tone: 'success' },
    { value: 'rejected', label: 'Rejected', tone: 'danger' },
    { value: 'expired', label: 'Expired', tone: 'neutral' },
];
const ROUTE_OPTIONS = [
    { value: 'fast_track', label: 'Fast track' },
    { value: 'standard', label: 'Standard' },
    { value: 'finance', label: 'Finance check' },
];

const HELP_MARKDOWN = [
    '## How a request travels',
    '',
    'Anyone with the link can send a request. It lands here, is **triaged by itself**, and a reviewer sends it on for a decision.',
    '',
    '| Step | Who | How long |',
    '| --- | --- | --- |',
    '| Request sent | Anyone with the link | A minute |',
    '| Triage | The app, on its own | Seconds |',
    '| Review | A reviewer of this app | Within two working days |',
    '| Decision | The approver | Reminded after a day, closed after five |',
    '',
    '> A request of 1,000 or more is routed to the finance check. Keep the amount honest: it decides the route.',
    '',
    '### Before you send one on',
    '',
    '- [ ] The request says what is needed and why',
    '- [ ] The amount is filled in, or zero',
    '- [x] The requester left an e-mail address',
    '',
    'An approved request comes back a week later with a **follow-up** flag, so nothing that was promised is forgotten.',
].join('\n');

const FAQ = [
    { q: 'What happens to my request?', a: 'It is checked and sorted straight away, and a reviewer looks at it within two working days.' },
    { q: 'Will I hear back?', a: 'Yes. You hear from the team at the e-mail address you gave, whatever the decision.' },
    { q: 'Can I change what I sent?', a: 'Send a new request that names the first one. The team keeps the two together.' },
    { q: 'Who can see my request?', a: 'Only the reviewers of this app. Nobody who opens this page sees anything that others have sent.' },
];

/** The request the review screen is looking at. */
const PICKED = [{ field: 'id', op: 'eq', value: { kind: 'formula', expr: 'vars.requestId' } }];

/**
 * One update of the picked request.
 * @param {Record<string, unknown>} values
 */
const setRequest = (values) => ({
    kind: 'update_record', tableId: 'tbl_rarq', recordId: { kind: 'formula', expr: 'vars.requestId' }, values,
});
/** @param {string} text what the run says it is doing */
const progress = (text) => ({ kind: 'set_variable', name: 'runStatus', value: { kind: 'static', value: text } });

module.exports = {
    id: 'app-request-approval',
    version: 1,
    title: 'Request and approval flow',
    description: 'A public page where anyone can send a request, sorted by itself as it arrives, and a review screen that sends it for approval, reminds the approver, and follows up a week after a yes.',
    category: 'Forms',
    icon: 'Inbox',
    tags: ['requests', 'approval', 'public form', 'intake', 'workflow'],
    dataModel: {
        modelVersion: 1,
        tables: [
            {
                id: 'tbl_rarq', key: 'requests', name: 'Requests', icon: 'Inbox',
                fields: [
                    { id: 'fld_raref', key: 'ref', name: 'Number', type: 'autonumber', unique: true },
                    { id: 'fld_rattl', key: 'title', name: 'Request', type: 'text', required: true, validation: { minLength: 3, maxLength: 120, message: 'Say in 3 to 120 characters what you need.' } },
                    { id: 'fld_ranam', key: 'requester_name', name: 'Name', type: 'text', required: true, validation: { maxLength: 80 } },
                    { id: 'fld_ramail', key: 'requester_email', name: 'E-mail', type: 'text', required: true, format: 'email' },
                    { id: 'fld_racat', key: 'category', name: 'Category', type: 'select', options: CATEGORY_OPTIONS, validation: { enforceOptions: true } },
                    { id: 'fld_raamt', key: 'amount', name: 'Amount', type: 'number', display: { currency: 'EUR', decimals: 2 }, validation: { min: 0, max: 100000, message: 'An amount between 0 and 100,000.' } },
                    { id: 'fld_raneed', key: 'needed_by', name: 'Needed by', type: 'date' },
                    { id: 'fld_radet', key: 'details', name: 'Details', type: 'text', validation: { maxLength: 2000 } },
                    { id: 'fld_rasts', key: 'status', name: 'Status', type: 'select', options: STATUS_OPTIONS, validation: { enforceOptions: true } },
                    { id: 'fld_ranote', key: 'decision_note', name: 'Decision note', type: 'text', validation: { maxLength: 2000 } },
                    { id: 'fld_raby', key: 'decided_by', name: 'Decided by', type: 'text' },
                    { id: 'fld_rafup', key: 'follow_up', name: 'Follow-up due', type: 'bool' },
                    { id: 'fld_raat', key: 'submitted_at', name: 'Sent', type: 'datetime', dynamicDefault: 'now' },
                ],
                indexes: [{ fields: ['status'] }],
                // The public role may create a request and do nothing else; a
                // reviewer reads and updates every request and deletes none.
                access: {
                    default: 'role',
                    roles: {
                        public: { create: true },
                        reviewer: { read: 'all', create: true, update: 'all', delete: 'none' },
                    },
                },
            },
            {
                id: 'tbl_ratri', key: 'triage', name: 'Triage', icon: 'Filter',
                fields: [
                    { id: 'fld_ratreq', key: 'request', name: 'Request', type: 'relation', relation: { table: 'tbl_rarq', displayField: 'title', onDelete: 'cascade' } },
                    { id: 'fld_ratttl', key: 'title', name: 'Request', type: 'text', validation: { maxLength: 120 } },
                    { id: 'fld_ratrte', key: 'route', name: 'Route', type: 'select', options: ROUTE_OPTIONS },
                    { id: 'fld_ratamt', key: 'amount', name: 'Amount', type: 'number', display: { currency: 'EUR', decimals: 2 } },
                    { id: 'fld_ratnot', key: 'note', name: 'Why', type: 'text', validation: { maxLength: 300 } },
                    { id: 'fld_ratat', key: 'received_at', name: 'Received', type: 'datetime', dynamicDefault: 'now' },
                ],
                access: {
                    default: 'role',
                    roles: { reviewer: { read: 'all', create: false, update: 'none', delete: 'none' } },
                },
            },
        ],
        roles: [{ key: 'reviewer', label: 'Reviewer' }],
        roleMapping: { default: 'reviewer', byGroup: {} },
    },
    seed: {
        tbl_rarq: [
            { $id: 'r1', title: 'Noise-cancelling headset', requester_name: 'Alex Morgan', requester_email: 'alex@example.com', category: 'equipment', amount: 240, needed_by: '2026-11-30', details: 'For calls in the open-plan office.', status: 'new' },
            { $id: 'r2', title: 'Data visualisation course', requester_name: 'Sam Rivera', requester_email: 'sam@example.com', category: 'training', amount: 1450, needed_by: '2027-01-15', details: 'Three days, online, with a certificate.', status: 'in_review' },
            { $id: 'r3', title: 'Second monitor', requester_name: 'Jamie Chen', requester_email: 'jamie@example.com', category: 'equipment', amount: 310, status: 'approved', decision_note: 'Order the 27-inch model.', decided_by: 'Robin Patel', follow_up: true },
            { $id: 'r4', title: 'Design tool licence', requester_name: 'Robin Patel', requester_email: 'robin@example.com', category: 'software', amount: 180, status: 'rejected', decision_note: 'Use the team licence we already have.', decided_by: 'Alex Morgan' },
            { $id: 'r5', title: 'Trip to the partner workshop', requester_name: 'Casey Brooks', requester_email: 'casey@example.com', category: 'travel', amount: 620, needed_by: '2026-12-08', details: 'Train and one night.', status: 'new' },
        ],
        tbl_ratri: [
            { request: { $ref: 'r1' }, title: 'Noise-cancelling headset', route: 'fast_track', amount: 240, note: 'Under 1,000: fast track.' },
            { request: { $ref: 'r2' }, title: 'Data visualisation course', route: 'finance', amount: 1450, note: '1,000 or more: finance check.' },
            { request: { $ref: 'r5' }, title: 'Trip to the partner workshop', route: 'standard', amount: 620, note: 'Travel: standard route.' },
        ],
    },
    definition: {
        schemaVersion: 3,
        meta: { name: 'Request and approval flow', description: 'Collect requests and get them decided.', icon: 'Inbox' },
        theme: { primary: '#4338CA', ...THEME_DEFAULTS },
        design: { preset: 'atlas', font: 'general-sans', surface: 'soft', motion: 'subtle', chartPalette: 'brand', accentEdge: 'bar', logoUrl: null },
        format: { currency: 'EUR', currencyDecimals: 0, dateFormat: 'd MMM yyyy' },
        homeScreenId: 'scr_rareview',
        roles: [{ id: 'reviewer', name: 'Reviewer' }],
        publicAccess: {
            entryScreenId: 'scr_raform',
            screenIds: ['scr_raform', 'scr_rathanks'],
            title: 'Send a request',
        },
        variables: [
            { name: 'requestId', label: 'Picked request', type: 'text', default: '', description: 'The request the review screen shows', scope: 'screen' },
            { name: 'request', label: 'Request being decided', type: 'record', default: null, description: 'The request the approval run reads' },
            { name: 'decision', label: 'Decision', type: 'any', default: null, description: 'What the approver decided' },
            { name: 'runStatus', label: 'Approval run', type: 'text', default: '', description: 'What the approval run is doing' },
        ],
        screens: [
            {
                id: 'scr_raform', name: 'Send a request', icon: 'Send', showInNav: false, maxWidth: 'narrow',
                sections: [
                    {
                        id: 'sec_raform', style: { padding: 6, gap: 3, background: 'none' },
                        children: [
                            {
                                id: 'cmp_raphero', type: 'page_header',
                                props: { title: 'Ask for what you need', subtitle: 'Tell us what it is, what it costs and when you need it. We get back to you within two working days.', icon: 'Inbox', look: 'banner', showDivider: false },
                                style: { span: 12 },
                            },
                            {
                                id: 'cmp_rafrm', type: 'form',
                                props: { name: 'request', submitLabel: 'Send my request', showReset: false, validateOn: 'blur' },
                                style: { span: 12, gap: 3, padding: 0 },
                                onSubmit: 'act_rasubmit',
                                children: [
                                    { id: 'cmp_rafttl', type: 'input_text', props: { name: 'title', label: 'What do you need?', required: true, placeholder: 'A second monitor' }, style: { span: 12 } },
                                    { id: 'cmp_rafcat', type: 'radio', props: { name: 'category', label: 'What kind of request is it?', options: CATEGORY_OPTIONS, defaultValue: 'equipment', required: true }, style: { span: 12 } },
                                    { id: 'cmp_rafamt', type: 'input_number', props: { name: 'amount', label: 'Amount (EUR)', min: 0, max: 100000, step: 10, defaultValue: 0 }, style: { span: 6, spanSm: 12 } },
                                    { id: 'cmp_rafneed', type: 'input_date', props: { name: 'needed_by', label: 'Needed by' }, style: { span: 6, spanSm: 12 } },
                                    { id: 'cmp_rafdet', type: 'input_textarea', props: { name: 'details', label: 'Anything we should know', rows: 4 }, style: { span: 12 } },
                                    { id: 'cmp_rafnam', type: 'input_text', props: { name: 'requester_name', label: 'Your name', required: true }, style: { span: 6, spanSm: 12 } },
                                    { id: 'cmp_rafml', type: 'input_text', props: { name: 'requester_email', label: 'Your e-mail address', required: true, inputType: 'email' }, style: { span: 6, spanSm: 12 } },
                                ],
                            },
                        ],
                    },
                ],
            },
            {
                id: 'scr_rathanks', name: 'Thank you', icon: 'CheckCircle2', showInNav: false, maxWidth: 'narrow',
                sections: [
                    {
                        id: 'sec_rathx', style: { padding: 6, gap: 3, background: 'none' },
                        children: [
                            { id: 'cmp_rathh', type: 'heading', props: { text: 'Thank you, your request is in', level: 1, accent: 'tinted' }, style: { span: 12 } },
                            { id: 'cmp_rathtx', type: 'callout', props: { title: 'What happens now', text: 'Your request has been sorted already. A reviewer looks at it within two working days and you hear from us by e-mail.', tone: 'success', variant: 'soft' }, style: { span: 12 } },
                            { id: 'cmp_rafaqh', type: 'heading', props: { text: 'Questions people ask', level: 2 }, style: { span: 12 } },
                            {
                                id: 'cmp_rafaq', type: 'accordion',
                                props: { items: FAQ.map((f) => ({ title: f.q })), multiple: false },
                                style: { span: 12 },
                                children: FAQ.map((f, i) => ({
                                    id: `cmp_rafaqa${i + 1}`, type: 'text', props: { text: f.a, muted: false }, style: { span: 12 },
                                })),
                            },
                            { id: 'cmp_raagain', type: 'button', props: { label: 'Send another request', variant: 'outline', iconLeft: 'Plus' }, style: { span: 4, spanSm: 12 }, onClick: 'act_raagain' },
                        ],
                    },
                ],
            },
            {
                id: 'scr_rareview', name: 'Review', icon: 'ClipboardCheck', showInNav: true, maxWidth: 'full',
                sections: [
                    {
                        id: 'sec_rarvhd', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            { id: 'cmp_rarvph', type: 'page_header', props: { title: 'Requests', subtitle: 'Pick a request, read its triage and send it for a decision.', icon: 'ClipboardCheck', showDivider: false }, style: { span: 12 } },
                            {
                                id: 'cmp_rarvbad', type: 'badge_list',
                                props: {
                                    source: { kind: 'aggregate', tableId: 'tbl_rarq', groupBy: [{ field: 'status' }], aggregates: [{ fn: 'count', as: 'count' }] },
                                    labelKey: 'status', colorKey: 'status', countKey: 'count',
                                    colorMap: STATUS_TONES.map((s) => ({ value: s.value, label: s.label, color: s.tone })),
                                },
                                style: { span: 12 },
                            },
                        ],
                    },
                    {
                        id: 'sec_rarvbody', style: { padding: 4, gap: 4, background: 'none' },
                        children: [
                            {
                                id: 'cmp_rarvgrd', type: 'data_grid',
                                props: {
                                    source: { kind: 'records', tableId: 'tbl_rarq', sort: [{ field: 'submitted_at', dir: 'desc' }] },
                                    columns: [
                                        { key: 'ref', label: '#', format: 'number', width: 56 },
                                        { key: 'title', label: 'Request', format: 'text' },
                                        { key: 'requester_name', label: 'From', format: 'text' },
                                        { key: 'amount', label: 'Amount', format: 'currency', align: 'right', cellStyle: [{ when: 'value >= 1000', style: { weight: 'bold' } }] },
                                        { key: 'status', label: 'Status', format: 'badge', toneMap: STATUS_TONES },
                                        { key: 'follow_up', label: 'Follow up', format: 'check' },
                                    ],
                                    activeWhen: 'item.id == vars.requestId',
                                    pageSize: 25,
                                    emptyText: 'No requests yet. Share the public page to get some.',
                                },
                                style: { span: 7, spanMd: 12 },
                                onRowClick: 'act_rapick',
                            },
                            {
                                id: 'cmp_rarvpane', type: 'container', props: { look: 'panel' },
                                style: { span: 5, spanMd: 12, padding: 4, gap: 3 },
                                visibleWhen: { kind: 'formula', expr: "vars.requestId != ''" },
                                children: [
                                    {
                                        id: 'cmp_rarvdet', type: 'record_detail',
                                        props: {
                                            source: { kind: 'record', tableId: 'tbl_rarq', filter: PICKED },
                                            fields: [
                                                { key: 'title', label: 'Request', format: 'text' },
                                                { key: 'status', label: 'Status', format: 'badge' },
                                                { key: 'category', label: 'Category', format: 'badge' },
                                                { key: 'amount', label: 'Amount', format: 'number' },
                                                { key: 'needed_by', label: 'Needed by', format: 'date' },
                                                { key: 'requester_name', label: 'From', format: 'text' },
                                                { key: 'requester_email', label: 'E-mail', format: 'link' },
                                                { key: 'details', label: 'Details', format: 'markdown' },
                                                { key: 'decision_note', label: 'Decision note', format: 'text' },
                                            ],
                                            columns: 2,
                                        },
                                        style: { span: 12 },
                                    },
                                    {
                                        id: 'cmp_rarvtri', type: 'list',
                                        props: {
                                            source: { kind: 'records', tableId: 'tbl_ratri', filter: [{ field: 'request', op: 'eq', value: { kind: 'formula', expr: 'vars.requestId' } }] },
                                            titleKey: 'note', badgeKey: 'route', timestampKey: 'received_at',
                                            badgeToneMap: [
                                                { value: 'fast_track', label: 'Fast track', tone: 'success' },
                                                { value: 'standard', label: 'Standard', tone: 'info' },
                                                { value: 'finance', label: 'Finance check', tone: 'warning' },
                                            ],
                                            icon: 'Filter',
                                            emptyText: 'No triage for this request yet.',
                                        },
                                        style: { span: 12 },
                                    },
                                    {
                                        id: 'cmp_rarvsend', type: 'button',
                                        props: { label: 'Send for approval', variant: 'primary', iconLeft: 'Send', disabledWhen: "vars.runStatus == 'Waiting for the approver'" },
                                        style: { span: 6, spanSm: 12 },
                                        onClick: 'act_rasend',
                                    },
                                    {
                                        id: 'cmp_rarvrun', type: 'callout',
                                        props: { title: 'Approval run', text: 'Not started.', textFrom: { kind: 'formula', expr: 'vars.runStatus' }, tone: 'info', variant: 'outline' },
                                        style: { span: 12 },
                                        visibleWhen: { kind: 'formula', expr: "vars.runStatus != ''" },
                                    },
                                ],
                            },
                        ],
                    },
                    {
                        id: 'sec_raapr', title: 'Approvals of this app', collapsible: true,
                        style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            { id: 'cmp_raaprl', type: 'approval_list', props: { scope: 'app', show: 'all', limit: 20, showDetails: true, emptyText: 'Nothing has been sent for approval yet.' }, style: { span: 12 } },
                        ],
                    },
                ],
            },
            {
                id: 'scr_rahelp', name: 'How it works', icon: 'BookOpen', showInNav: true, maxWidth: 'medium',
                sections: [
                    {
                        id: 'sec_rahelp', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            { id: 'cmp_rahelpmd', type: 'markdown', props: { content: HELP_MARKDOWN, rich: true }, style: { span: 12 } },
                            {
                                id: 'cmp_rahelpfq', type: 'accordion',
                                props: { items: [{ title: 'Where is the public page?', open: true }, { title: 'Who decides?' }, { title: 'What if nobody decides?' }], multiple: true },
                                style: { span: 12 },
                                children: [
                                    { id: 'cmp_rahlpa1', type: 'text', props: { text: 'Publish the app and share the link of its public page. The page is the request form and the thank-you page, nothing else.', muted: false }, style: { span: 12 } },
                                    { id: 'cmp_rahlpa2', type: 'text', props: { text: 'Without an approver set on the approval step, the owner of the app decides. Set a person or a group on the step to change that.', muted: false }, style: { span: 12 } },
                                    { id: 'cmp_rahlpa3', type: 'text', props: { text: 'The approver is reminded after a day. After five days the request closes as expired and the requester can send it again.', muted: false }, style: { span: 12 } },
                                ],
                            },
                        ],
                    },
                ],
            },
        ],
        actions: {
            // The public form: one create, then the thank-you page. A visitor's
            // page walks these steps itself; the table only lets `public` create.
            act_rasubmit: {
                kind: 'sequence',
                steps: [
                    {
                        kind: 'create_record', tableId: 'tbl_rarq',
                        values: {
                            title: { kind: 'formula', expr: 'form.title' },
                            category: { kind: 'formula', expr: 'form.category' },
                            amount: { kind: 'formula', expr: 'form.amount' },
                            needed_by: { kind: 'formula', expr: 'form.needed_by' },
                            details: { kind: 'formula', expr: 'form.details' },
                            requester_name: { kind: 'formula', expr: 'form.requester_name' },
                            requester_email: { kind: 'formula', expr: 'form.requester_email' },
                            status: { kind: 'static', value: 'new' },
                        },
                    },
                    { kind: 'navigate', screenId: 'scr_rathanks' },
                ],
            },
            act_raagain: { kind: 'navigate', screenId: 'scr_raform' },
            act_rapick: {
                kind: 'sequence',
                steps: [
                    { kind: 'set_variable', name: 'requestId', value: { kind: 'formula', expr: 'item.id' } },
                    { kind: 'set_variable', name: 'runStatus', value: { kind: 'static', value: '' } },
                ],
            },
            // The record trigger's action: it writes the triage row and nothing
            // else, because visitors of the public page write this table.
            act_ratriage: {
                kind: 'sequence',
                steps: [
                    {
                        kind: 'create_record', tableId: 'tbl_ratri',
                        values: {
                            request: { kind: 'formula', expr: 'trigger.record.id' },
                            title: { kind: 'formula', expr: 'trigger.record.row.title' },
                            amount: { kind: 'formula', expr: 'trigger.record.row.amount' },
                            route: { kind: 'formula', expr: "(trigger.record.row.amount ?? 0) >= 1000 ? 'finance' : (trigger.record.row.category == 'travel' || trigger.record.row.category == 'training' ? 'standard' : 'fast_track')" },
                            note: { kind: 'formula', expr: "(trigger.record.row.amount ?? 0) >= 1000 ? '1,000 or more: finance check.' : (trigger.record.row.category == 'travel' || trigger.record.row.category == 'training' ? 'Travel and training: standard route.' : 'Under 1,000: fast track.')" },
                        },
                    },
                ],
            },
            // Sent from the review screen. The whole sequence runs on the server:
            // it can wait for the approver, and after a yes it waits a week
            // before it flags the follow-up. Nobody has to keep the page open.
            act_rasend: {
                kind: 'sequence',
                runOn: 'server',
                progressVar: 'runStatus',
                lockKey: { kind: 'formula', expr: 'vars.requestId' },
                steps: [
                    progress('Waiting for the approver'),
                    { kind: 'set_variable', name: 'request', value: { kind: 'record', tableId: 'tbl_rarq', filter: PICKED } },
                    setRequest({ status: { kind: 'static', value: 'in_review' } }),
                    {
                        kind: 'await_approval',
                        prompt: { kind: 'formula', expr: "'Approve: ' + (vars.request.title ?? 'a request')" },
                        details: { kind: 'formula', expr: "'Amount: ' + (vars.request.amount ?? 0) + '. ' + (vars.request.details ?? '')" },
                        fields: [{ name: 'note', label: 'A note for the requester', type: 'textarea' }],
                        rule: 'first',
                        timeoutHours: 120,
                        remindAfterHours: 24,
                        resultVar: 'decision',
                    },
                    {
                        kind: 'condition',
                        expr: "vars.decision.decision == 'approved'",
                        then: [
                            setRequest({
                                status: { kind: 'static', value: 'approved' },
                                decision_note: { kind: 'formula', expr: "vars.decision.answers.note ?? ''" },
                                decided_by: { kind: 'formula', expr: 'vars.decision.decidedByName' },
                            }),
                            progress('Approved. A follow-up is due in a week.'),
                            { kind: 'wait', seconds: 604800 },
                            setRequest({ follow_up: { kind: 'static', value: true } }),
                            progress('Approved, follow-up due'),
                        ],
                        else: [
                            setRequest({
                                status: { kind: 'formula', expr: "vars.decision.decision == 'rejected' ? 'rejected' : 'expired'" },
                                decision_note: { kind: 'formula', expr: "vars.decision.answers.note ?? vars.decision.reason ?? ''" },
                                decided_by: { kind: 'formula', expr: "vars.decision.decidedByName ?? ''" },
                            }),
                            progress('Not approved'),
                        ],
                    },
                ],
            },
        },
        triggers: [
            { id: 'triage_new_request', kind: 'record', actionId: 'act_ratriage', tableId: 'tbl_rarq', on: ['create'], allowPublicWrites: true },
        ],
    },
};
