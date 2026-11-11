// @typecheck strict
/**
 * App Studio template — Field service planner.
 *
 * One of the four schema-3 templates (see ../templates.js): built only from
 * vocabulary that schema version 3 added, so a new app starts from what the
 * product can do now instead of from the base catalogue.
 *
 *   data      jobs with a single relation to their customer and their lead
 *             technician (lookups show the names), a MANY relation to the crew,
 *             rollups on customers and technicians, field rules (lengths,
 *             ranges, e-mail and phone formats) and an autonumber.
 *   rights    two roles. The cost price of a job, the margin computed from it
 *             and a technician's hourly cost are column-gated to the planner:
 *             a technician's rows come back without them (field.access).
 *   look      a board whose cards are drawn by an item template, a jobs grid
 *             that marks overdue rows (column cellStyle and node styleWhen),
 *             app-level value formatting.
 *   logic     a wizard inside a form to book a job; a schedule trigger that
 *             works out a morning summary with a code step and hands it to an
 *             automation of the owner's choice (which sends the e-mail).
 *
 * Nothing is armed on install: a trigger only runs once the app is published,
 * and the summary's automation is left unset (`action.automation_unset`) like
 * every other template that hands work to an automation.
 *
 * The sample jobs carry a crew: a many relation is seeded as a list of
 * { $ref }, linked in a pass after every row exists (seedLinks.mts).
 */

'use strict';

const { THEME_DEFAULTS } = require('./themeDefaults');

const STATUS_OPTIONS = [
    { value: 'new', label: 'New' },
    { value: 'scheduled', label: 'Scheduled' },
    { value: 'in_progress', label: 'In progress' },
    { value: 'done', label: 'Done' },
];
const PRIORITY_OPTIONS = [
    { value: 'low', label: 'Low' },
    { value: 'normal', label: 'Normal' },
    { value: 'urgent', label: 'Urgent' },
];
const SKILL_OPTIONS = [
    { value: 'electrical', label: 'Electrical' },
    { value: 'plumbing', label: 'Plumbing' },
    { value: 'heating', label: 'Heating' },
    { value: 'general', label: 'General' },
];

/** Planner: everything. Technician: reads everything, updates jobs, creates and deletes nothing. */
const ROLE_ACCESS = {
    default: 'role',
    roles: {
        planner: { read: 'all', create: true, update: 'all', delete: 'all' },
        technician: { read: 'all', create: false, update: 'none', delete: 'none' },
    },
};

/** An open job whose due date has passed: the one rule the board, the grid and the summary share. */
const OVERDUE = "item.status != 'done' && item.due_on != null && item.due_on < today";
const NOT_DONE = { field: 'status', op: 'neq', value: 'done' };

const STATUS_TONES = [
    { value: 'new', label: 'New', tone: 'info' },
    { value: 'scheduled', label: 'Scheduled', tone: 'primary' },
    { value: 'in_progress', label: 'In progress', tone: 'warning' },
    { value: 'done', label: 'Done', tone: 'success' },
];
const PRIORITY_TONES = [
    { value: 'low', label: 'Low', tone: 'neutral' },
    { value: 'normal', label: 'Normal', tone: 'info' },
    { value: 'urgent', label: 'Urgent', tone: 'danger' },
];

/** The morning summary, worked out on the server over the open jobs. */
const SUMMARY_CODE = [
    'function main(inputs) {',
    '  const today = String(inputs.today || "").slice(0, 10);',
    '  const jobs = Array.isArray(inputs.jobs) ? inputs.jobs : [];',
    '  const dueToday = jobs.filter((j) => String(j.scheduled_on || "").slice(0, 10) === today);',
    '  const overdue = jobs.filter((j) => j.due_on && String(j.due_on).slice(0, 10) < today);',
    '  const line = (j) => "- " + (j.title || "Job") + (j.customer_name ? " at " + j.customer_name : "") + (j.lead_name ? " (" + j.lead_name + ")" : "");',
    '  const parts = ["Good morning. " + jobs.length + " open jobs, " + dueToday.length + " planned for today, " + overdue.length + " overdue."];',
    '  if (dueToday.length) parts.push("", "Today:", ...dueToday.map(line));',
    '  if (overdue.length) parts.push("", "Overdue:", ...overdue.map(line));',
    '  return { text: parts.join("\\n"), open: jobs.length, today: dueToday.length, overdue: overdue.length };',
    '}',
].join('\n');

/**
 * A text node of the card template whose text is a formula over the card's row.
 * @param {string} id
 * @param {string} expr
 * @param {Record<string, unknown>} [extra]
 */
const tx = (id, expr, extra = {}) => ({ id, type: 'text', props: { text: 'Item', muted: false }, style: { span: 12 }, computed: { text: { kind: 'formula', expr } }, ...extra });

module.exports = {
    id: 'app-field-service',
    version: 1,
    title: 'Field service planner',
    description: 'Plan jobs for your technicians: a board with cards you design yourself, overdue work marked in red, a step-by-step booking form, and a summary every weekday morning. Cost prices stay visible to planners only.',
    category: 'Data',
    icon: 'Wrench',
    tags: ['field service', 'planning', 'kanban', 'technicians', 'schedule'],
    dataModel: {
        modelVersion: 1,
        tables: [
            {
                id: 'tbl_fstech', key: 'technicians', name: 'Technicians', icon: 'HardHat',
                fields: [
                    { id: 'fld_fstnam', key: 'name', name: 'Name', type: 'text', required: true, validation: { minLength: 2, maxLength: 80 } },
                    { id: 'fld_fstskl', key: 'skill', name: 'Skill', type: 'select', options: SKILL_OPTIONS },
                    { id: 'fld_fstphn', key: 'phone', name: 'Phone', type: 'text', format: 'phone' },
                    { id: 'fld_fstmail', key: 'email', name: 'E-mail', type: 'text', format: 'email' },
                    { id: 'fld_fstrate', key: 'hourly_cost', name: 'Hourly cost', type: 'number', display: { currency: 'EUR', decimals: 2 }, validation: { min: 0, max: 1000 }, access: { read: ['planner'] } },
                    { id: 'fld_fstopen', key: 'open_jobs', name: 'Open jobs', type: 'rollup', rollup: { table: 'tbl_fsjob', relation: 'lead', fn: 'count', filter: [NOT_DONE] } },
                ],
                indexes: [{ fields: ['name'] }],
                access: ROLE_ACCESS,
            },
            {
                id: 'tbl_fscust', key: 'customers', name: 'Customers', icon: 'Building2',
                fields: [
                    { id: 'fld_fscnam', key: 'name', name: 'Name', type: 'text', required: true, validation: { minLength: 2, maxLength: 80 } },
                    { id: 'fld_fscadr', key: 'address', name: 'Address', type: 'text', validation: { maxLength: 160 } },
                    { id: 'fld_fsccty', key: 'city', name: 'City', type: 'text', validation: { maxLength: 80 } },
                    { id: 'fld_fscml', key: 'contact_email', name: 'Contact e-mail', type: 'text', format: 'email' },
                    { id: 'fld_fsccnt', key: 'job_count', name: 'Jobs', type: 'rollup', rollup: { table: 'tbl_fsjob', relation: 'customer', fn: 'count' } },
                    { id: 'fld_fscval', key: 'open_value', name: 'Open value', type: 'rollup', rollup: { table: 'tbl_fsjob', relation: 'customer', fn: 'sum', field: 'price', filter: [NOT_DONE] } },
                ],
                indexes: [{ fields: ['name'] }],
                access: ROLE_ACCESS,
            },
            {
                id: 'tbl_fsjob', key: 'jobs', name: 'Jobs', icon: 'ClipboardList',
                fields: [
                    { id: 'fld_fsjref', key: 'ref', name: 'Job number', type: 'autonumber', unique: true },
                    { id: 'fld_fsjttl', key: 'title', name: 'Title', type: 'text', required: true, validation: { minLength: 3, maxLength: 120, message: 'Give the job a title of 3 to 120 characters.' } },
                    { id: 'fld_fsjcus', key: 'customer', name: 'Customer', type: 'relation', relation: { table: 'tbl_fscust', displayField: 'name', onDelete: 'restrict' } },
                    { id: 'fld_fsjcnm', key: 'customer_name', name: 'Customer name', type: 'lookup', lookup: { relation: 'customer', field: 'name' } },
                    { id: 'fld_fsjcty', key: 'customer_city', name: 'City', type: 'lookup', lookup: { relation: 'customer', field: 'city' } },
                    { id: 'fld_fsjlead', key: 'lead', name: 'Lead technician', type: 'relation', relation: { table: 'tbl_fstech', displayField: 'name', onDelete: 'setNull' } },
                    { id: 'fld_fsjlnm', key: 'lead_name', name: 'Lead', type: 'lookup', lookup: { relation: 'lead', field: 'name' } },
                    { id: 'fld_fsjcrew', key: 'crew', name: 'Crew', type: 'relation', relation: { table: 'tbl_fstech', many: true, displayField: 'name' } },
                    { id: 'fld_fsjsts', key: 'status', name: 'Status', type: 'select', options: STATUS_OPTIONS, validation: { enforceOptions: true } },
                    { id: 'fld_fsjpri', key: 'priority', name: 'Priority', type: 'select', options: PRIORITY_OPTIONS, validation: { enforceOptions: true } },
                    { id: 'fld_fsjpln', key: 'scheduled_on', name: 'Planned for', type: 'date' },
                    { id: 'fld_fsjdue', key: 'due_on', name: 'Due', type: 'date' },
                    { id: 'fld_fsjhrs', key: 'hours', name: 'Hours', type: 'number', display: { unit: 'h', decimals: 1 }, validation: { min: 0.5, max: 24, message: 'A job takes between half an hour and 24 hours.' } },
                    { id: 'fld_fsjprc', key: 'price', name: 'Price', type: 'number', display: { currency: 'EUR', decimals: 2 }, validation: { min: 0 } },
                    { id: 'fld_fsjcost', key: 'cost_price', name: 'Cost price', type: 'number', display: { currency: 'EUR', decimals: 2 }, validation: { min: 0 }, access: { read: ['planner'], write: ['planner'] } },
                    { id: 'fld_fsjmrg', key: 'margin', name: 'Margin', type: 'computed', computed: { expr: 'price - cost_price' } },
                    { id: 'fld_fsjnot', key: 'notes', name: 'Notes', type: 'text', validation: { maxLength: 2000 } },
                ],
                indexes: [{ fields: ['status', 'due_on'] }],
                access: ROLE_ACCESS,
            },
        ],
        roles: [
            { key: 'planner', label: 'Planner' },
            { key: 'technician', label: 'Technician' },
        ],
        roleMapping: { default: 'technician', byGroup: {} },
    },
    seed: {
        tbl_fstech: [
            { $id: 't1', name: 'Alex Morgan', skill: 'electrical', phone: '+31 20 555 0101', email: 'alex@example.com', hourly_cost: 48 },
            { $id: 't2', name: 'Sam Rivera', skill: 'plumbing', phone: '+31 20 555 0102', email: 'sam@example.com', hourly_cost: 45 },
            { $id: 't3', name: 'Jamie Chen', skill: 'heating', phone: '+31 20 555 0103', email: 'jamie@example.com', hourly_cost: 52 },
            { $id: 't4', name: 'Robin Patel', skill: 'general', phone: '+31 20 555 0104', email: 'robin@example.com', hourly_cost: 40 },
        ],
        tbl_fscust: [
            { $id: 'c1', name: 'Harbour Offices', address: 'Quay 12', city: 'Rotterdam', contact_email: 'facilities@example.com' },
            { $id: 'c2', name: 'Green Lane School', address: 'Green Lane 4', city: 'Utrecht', contact_email: 'office@example.com' },
            { $id: 'c3', name: 'Riverside Apartments', address: 'Riverside 88', city: 'Amsterdam', contact_email: 'manager@example.com' },
            { $id: 'c4', name: 'Maple Bakery', address: 'Market Square 3', city: 'Haarlem', contact_email: 'hello@example.com' },
        ],
        tbl_fsjob: [
            { title: 'Replace fuse box', customer: { $ref: 'c1' }, lead: { $ref: 't1' }, crew: [{ $ref: 't4' }], status: 'scheduled', priority: 'urgent', scheduled_on: '2026-11-12', due_on: '2026-11-13', hours: 4, price: 680, cost_price: 410, notes: 'Bring the new three-phase unit.' },
            { title: 'Leaking pipe in the kitchen', customer: { $ref: 'c4' }, lead: { $ref: 't2' }, crew: [{ $ref: 't1' }], status: 'in_progress', priority: 'urgent', scheduled_on: '2026-11-10', due_on: '2026-11-10', hours: 2, price: 240, cost_price: 130 },
            { title: 'Annual boiler service', customer: { $ref: 'c3' }, lead: { $ref: 't3' }, crew: [{ $ref: 't2' }, { $ref: 't4' }], status: 'scheduled', priority: 'normal', scheduled_on: '2026-11-14', due_on: '2026-11-21', hours: 3, price: 320, cost_price: 190 },
            { title: 'Classroom lights flicker', customer: { $ref: 'c2' }, lead: { $ref: 't1' }, crew: [{ $ref: 't4' }], status: 'new', priority: 'normal', due_on: '2026-11-08', hours: 2, price: 210, cost_price: 120, notes: 'Room 2.14 and the corridor.' },
            { title: 'Install radiator valves', customer: { $ref: 'c3' }, lead: { $ref: 't3' }, crew: [{ $ref: 't2' }], status: 'new', priority: 'low', due_on: '2026-11-28', hours: 5, price: 560, cost_price: 340 },
            { title: 'Check the emergency lighting', customer: { $ref: 'c1' }, lead: { $ref: 't4' }, crew: [{ $ref: 't1' }], status: 'scheduled', priority: 'normal', scheduled_on: '2026-11-17', due_on: '2026-11-20', hours: 3, price: 290, cost_price: 160 },
            { title: 'Replace the bathroom tap', customer: { $ref: 'c2' }, lead: { $ref: 't2' }, crew: [{ $ref: 't3' }], status: 'done', priority: 'low', scheduled_on: '2026-11-04', due_on: '2026-11-07', hours: 1, price: 140, cost_price: 70 },
            { title: 'Paint the stairwell', customer: { $ref: 'c4' }, lead: { $ref: 't4' }, crew: [{ $ref: 't1' }, { $ref: 't3' }], status: 'done', priority: 'low', scheduled_on: '2026-11-03', due_on: '2026-11-06', hours: 6, price: 480, cost_price: 300 },
        ],
    },
    definition: {
        schemaVersion: 3,
        meta: { name: 'Field service planner', description: 'Plan jobs for your technicians.', icon: 'Wrench' },
        theme: { primary: '#0F766E', ...THEME_DEFAULTS },
        design: { preset: 'field', font: 'inter', surface: 'soft', motion: 'subtle', chartPalette: 'brand', accentEdge: 'bar', logoUrl: null },
        format: { currency: 'EUR', currencyDecimals: 0, dateFormat: 'd MMM yyyy' },
        homeScreenId: 'scr_fsboard',
        roles: [
            { id: 'planner', name: 'Planner' },
            { id: 'technician', name: 'Technician' },
        ],
        screens: [
            {
                id: 'scr_fsboard', name: 'Board', icon: 'Columns3', showInNav: true, maxWidth: 'full',
                sections: [
                    {
                        id: 'sec_fshead', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            {
                                id: 'cmp_fsph', type: 'page_header',
                                props: { title: 'Field service', subtitle: 'Every open job, by status. Drag a card to move it on.', icon: 'Wrench', showDivider: false },
                                style: { span: 12 },
                                children: [
                                    { id: 'cmp_fsbook', type: 'button', props: { label: 'Book a job', variant: 'primary', iconLeft: 'Plus' }, style: { span: 3 }, visibleToRoles: ['planner'], onClick: 'act_fsgobook' },
                                ],
                            },
                            {
                                id: 'cmp_fsopen', type: 'stat',
                                props: {
                                    label: 'Open jobs', icon: 'ClipboardList', look: 'tile',
                                    value: { kind: 'aggregate', tableId: 'tbl_fsjob', filter: [NOT_DONE], aggregates: [{ fn: 'count', as: 'n' }], pick: { row: 'first', column: 'n' } },
                                },
                                style: { span: 3, spanMd: 6, spanSm: 12 },
                            },
                            {
                                id: 'cmp_fsurg', type: 'stat',
                                props: {
                                    label: 'Urgent', icon: 'Siren', look: 'tile',
                                    value: { kind: 'aggregate', tableId: 'tbl_fsjob', filter: [NOT_DONE, { field: 'priority', op: 'eq', value: 'urgent' }], aggregates: [{ fn: 'count', as: 'n' }], pick: { row: 'first', column: 'n' } },
                                },
                                style: { span: 3, spanMd: 6, spanSm: 12 },
                            },
                            {
                                id: 'cmp_fslate', type: 'stat',
                                props: {
                                    label: 'Overdue', icon: 'AlarmClock', look: 'tile',
                                    value: { kind: 'aggregate', tableId: 'tbl_fsjob', filter: [NOT_DONE, { field: 'due_on', op: 'lt', value: { kind: 'formula', expr: 'today' } }], aggregates: [{ fn: 'count', as: 'n' }], pick: { row: 'first', column: 'n' } },
                                },
                                style: { span: 3, spanMd: 6, spanSm: 12, color: 'danger' },
                            },
                            {
                                id: 'cmp_fsval', type: 'stat',
                                props: {
                                    label: 'Open work', icon: 'Banknote', look: 'tile',
                                    value: { kind: 'aggregate', tableId: 'tbl_fsjob', filter: [NOT_DONE], aggregates: [{ fn: 'sum', field: 'price', as: 'total' }], pick: { row: 'first', column: 'total' } },
                                    formatOptions: { currency: 'EUR', decimals: 0 },
                                },
                                style: { span: 3, spanMd: 6, spanSm: 12 },
                            },
                        ],
                    },
                    {
                        id: 'sec_fsboard', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            {
                                id: 'cmp_fskan', type: 'kanban',
                                props: {
                                    source: { kind: 'records', tableId: 'tbl_fsjob', sort: [{ field: 'due_on', dir: 'asc' }] },
                                    groupByField: 'status',
                                    columns: [
                                        { value: 'new', label: 'New', color: 'info' },
                                        { value: 'scheduled', label: 'Scheduled', color: 'primary' },
                                        { value: 'in_progress', label: 'In progress', color: 'warning' },
                                        { value: 'done', label: 'Done', color: 'success' },
                                    ],
                                    titleKey: 'title',
                                    cardLook: 'raised',
                                    emptyText: 'No jobs here.',
                                },
                                style: { span: 12 },
                                onRowClick: 'act_fsopen',
                                onCardMove: 'act_fsmove',
                                // The card, drawn by its own template: title, where, who and
                                // when; the due line turns red once the job is overdue.
                                children: [
                                    tx('cmp_fscttl', 'item.title', { style: { span: 12, weight: 'semibold' } }),
                                    tx('cmp_fscwhr', "concat(item.customer_name ?? 'No customer', item.customer_city ? ' · ' + item.customer_city : '')", { style: { span: 12, textSize: 'sm' } }),
                                    tx('cmp_fscwho', "item.lead_name ? 'Lead: ' + item.lead_name : 'No technician yet'", { props: { text: 'Item', muted: true }, style: { span: 7, textSize: 'sm' } }),
                                    tx('cmp_fscdue', "item.due_on ? 'Due ' + formatDate(item.due_on, 'DD-MM') : ''", {
                                        style: { span: 5, textSize: 'sm', align: 'end' },
                                        styleWhen: [{ when: OVERDUE, style: { color: 'danger', weight: 'bold' } }],
                                    }),
                                ],
                            },
                        ],
                    },
                ],
            },
            {
                id: 'scr_fsjobs', name: 'Jobs', icon: 'ListChecks', showInNav: true, maxWidth: 'wide',
                sections: [
                    {
                        id: 'sec_fsjobs', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            { id: 'cmp_fsjh', type: 'heading', props: { text: 'All jobs', level: 1, accent: 'bar' }, style: { span: 12 } },
                            {
                                id: 'cmp_fsjfil', type: 'filter_bar',
                                props: {
                                    fields: [
                                        { name: 'q', label: 'Search jobs', type: 'search' },
                                        { name: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS },
                                    ],
                                },
                                style: { span: 12 },
                            },
                            {
                                id: 'cmp_fsjgrd', type: 'data_grid',
                                props: {
                                    source: {
                                        kind: 'records', tableId: 'tbl_fsjob',
                                        filter: [{ field: 'status', op: 'eq', value: { kind: 'formula', expr: 'vars.filters.status' } }],
                                        sort: [{ field: 'due_on', dir: 'asc' }],
                                        search: { value: { kind: 'formula', expr: 'vars.filters.q' }, fields: ['title', 'notes'] },
                                    },
                                    columns: [
                                        { key: 'ref', label: '#', format: 'number', width: 64 },
                                        { key: 'title', label: 'Job', format: 'text', cellStyle: [{ when: OVERDUE, style: { color: 'danger', weight: 'semibold' } }] },
                                        { key: 'customer_name', label: 'Customer', format: 'text' },
                                        { key: 'lead_name', label: 'Lead', format: 'text' },
                                        { key: 'status', label: 'Status', format: 'badge', toneMap: STATUS_TONES },
                                        { key: 'priority', label: 'Priority', format: 'badge', toneMap: PRIORITY_TONES },
                                        { key: 'scheduled_on', label: 'Planned', format: 'date' },
                                        { key: 'due_on', label: 'Due', format: 'date', cellStyle: [{ when: OVERDUE, style: { color: 'danger', weight: 'bold', backgroundColor: 'danger' } }] },
                                        { key: 'price', label: 'Price', format: 'currency', align: 'right' },
                                    ],
                                    pageSize: 25,
                                    density: 'comfortable',
                                    emptyText: 'No jobs match.',
                                },
                                style: { span: 12 },
                                onRowClick: 'act_fsopen',
                            },
                        ],
                    },
                ],
            },
            {
                id: 'scr_fsjob', name: 'Job', icon: 'FileText', showInNav: false, maxWidth: 'medium',
                sections: [
                    {
                        id: 'sec_fsjob', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            { id: 'cmp_fsjback', type: 'button', props: { label: 'Back to the board', variant: 'ghost', iconLeft: 'ArrowLeft' }, style: { span: 4 }, onClick: 'act_fsback' },
                            { id: 'cmp_fsjdone', type: 'button', props: { label: 'Mark as done', variant: 'soft', iconLeft: 'CheckCircle2' }, style: { span: 3 }, onClick: 'act_fsdone' },
                            {
                                id: 'cmp_fsjdet', type: 'record_detail',
                                props: {
                                    source: { kind: 'record', tableId: 'tbl_fsjob', filter: [{ field: 'id', op: 'eq', value: { kind: 'formula', expr: 'screen.params.id' } }], expand: [{ field: 'crew' }] },
                                    fields: [
                                        { key: 'title', label: 'Job', format: 'text', group: 'Job' },
                                        { key: 'ref', label: 'Job number', format: 'number', group: 'Job' },
                                        { key: 'status', label: 'Status', format: 'badge', group: 'Job' },
                                        { key: 'priority', label: 'Priority', format: 'badge', group: 'Job' },
                                        { key: 'customer_name', label: 'Customer', format: 'text', group: 'Where' },
                                        { key: 'customer_city', label: 'City', format: 'text', group: 'Where' },
                                        { key: 'lead_name', label: 'Lead technician', format: 'text', group: 'Who and when' },
                                        { key: 'scheduled_on', label: 'Planned for', format: 'date', group: 'Who and when' },
                                        { key: 'due_on', label: 'Due', format: 'date', group: 'Who and when' },
                                        { key: 'hours', label: 'Hours', format: 'number', group: 'Who and when' },
                                        { key: 'notes', label: 'Notes', format: 'markdown', group: 'Notes' },
                                    ],
                                    columns: 2,
                                },
                                style: { span: 12 },
                            },
                        ],
                    },
                    {
                        // Only planners see the money. The fields themselves are
                        // column-gated as well, so this is presentation, not the guard.
                        id: 'sec_fsjmoney', title: 'Price and margin', visibleToRoles: ['planner'],
                        style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            {
                                id: 'cmp_fsjkv', type: 'record_detail',
                                props: {
                                    source: { kind: 'record', tableId: 'tbl_fsjob', filter: [{ field: 'id', op: 'eq', value: { kind: 'formula', expr: 'screen.params.id' } }] },
                                    fields: [
                                        { key: 'price', label: 'Price', format: 'number' },
                                        { key: 'cost_price', label: 'Cost price', format: 'number' },
                                        { key: 'margin', label: 'Margin', format: 'number' },
                                    ],
                                    columns: 3,
                                    layout: 'rows',
                                },
                                style: { span: 12 },
                            },
                        ],
                    },
                ],
            },
            {
                id: 'scr_fsbook', name: 'Book a job', icon: 'CalendarPlus', showInNav: true, maxWidth: 'narrow', visibleToRoles: ['planner'],
                sections: [
                    {
                        id: 'sec_fsbook', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            { id: 'cmp_fsbh', type: 'heading', props: { text: 'Book a job', level: 1, accent: 'bar' }, style: { span: 12 } },
                            {
                                id: 'cmp_fsbfrm', type: 'form',
                                props: { name: 'booking', submitLabel: 'Book the job', showReset: false, validateOn: 'blur' },
                                style: { span: 12, gap: 3, padding: 0 },
                                onSubmit: 'act_fsbooksave',
                                children: [
                                    {
                                        id: 'cmp_fsbwiz', type: 'wizard',
                                        props: {
                                            steps: [
                                                { title: 'The job', description: 'What and for whom' },
                                                { title: 'When', description: 'Planning and deadline' },
                                                { title: 'Who', description: 'Lead, crew and price' },
                                            ],
                                            nextLabel: 'Continue',
                                            validateSteps: true,
                                        },
                                        style: { span: 12 },
                                        children: [
                                            {
                                                id: 'cmp_fsbst1', type: 'container', props: { look: 'plain' }, style: { span: 12 },
                                                children: [
                                                    { id: 'cmp_fsbttl', type: 'input_text', props: { name: 'title', label: 'What needs doing', required: true, placeholder: 'Replace the fuse box' }, style: { span: 12 } },
                                                    { id: 'cmp_fsbcus', type: 'input_relation', props: { name: 'customer', label: 'Customer', tableId: 'tbl_fscust', displayField: 'name', required: true }, style: { span: 12 } },
                                                    { id: 'cmp_fsbpri', type: 'radio', props: { name: 'priority', label: 'Priority', options: PRIORITY_OPTIONS, defaultValue: 'normal', required: true }, style: { span: 12 } },
                                                ],
                                            },
                                            {
                                                id: 'cmp_fsbst2', type: 'container', props: { look: 'plain' }, style: { span: 12 },
                                                children: [
                                                    { id: 'cmp_fsbpln', type: 'input_date', props: { name: 'scheduled_on', label: 'Planned for', defaultValue: 'today' }, style: { span: 6 } },
                                                    { id: 'cmp_fsbdue', type: 'input_date', props: { name: 'due_on', label: 'Due', required: true }, style: { span: 6 } },
                                                    { id: 'cmp_fsbhrs', type: 'slider', props: { name: 'hours', label: 'Hours on site', min: 1, max: 12, step: 1, defaultValue: 2 }, style: { span: 12 } },
                                                ],
                                            },
                                            {
                                                id: 'cmp_fsbst3', type: 'container', props: { look: 'plain' }, style: { span: 12 },
                                                children: [
                                                    { id: 'cmp_fsblead', type: 'input_relation', props: { name: 'lead', label: 'Lead technician', tableId: 'tbl_fstech', displayField: 'name' }, style: { span: 12 } },
                                                    { id: 'cmp_fsbcrew', type: 'input_relation', props: { name: 'crew', label: 'Crew', tableId: 'tbl_fstech', displayField: 'name', multiple: true }, style: { span: 12 } },
                                                    { id: 'cmp_fsbprc', type: 'input_number', props: { name: 'price', label: 'Price (EUR)', min: 0, step: 10 }, style: { span: 6 } },
                                                    { id: 'cmp_fsbnot', type: 'input_textarea', props: { name: 'notes', label: 'Notes for the technician', rows: 3 }, style: { span: 12 } },
                                                ],
                                            },
                                        ],
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
            {
                id: 'scr_fsteam', name: 'People and places', icon: 'Users', showInNav: true, maxWidth: 'wide',
                sections: [
                    {
                        id: 'sec_fsteam', title: 'Technicians', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            {
                                id: 'cmp_fstgrd', type: 'data_grid',
                                props: {
                                    source: { kind: 'records', tableId: 'tbl_fstech', sort: [{ field: 'name', dir: 'asc' }] },
                                    columns: [
                                        { key: 'name', label: 'Name', format: 'text' },
                                        { key: 'skill', label: 'Skill', format: 'badge' },
                                        { key: 'phone', label: 'Phone', format: 'text' },
                                        { key: 'email', label: 'E-mail', format: 'text' },
                                        { key: 'open_jobs', label: 'Open jobs', format: 'number', align: 'right', cellStyle: [{ when: 'value >= 3', style: { color: 'warning', weight: 'bold' } }] },
                                    ],
                                    look: 'minimal',
                                    emptyText: 'No technicians yet.',
                                },
                                style: { span: 12 },
                            },
                        ],
                    },
                    {
                        id: 'sec_fsrates', title: 'Hourly cost', collapsible: true, visibleToRoles: ['planner'],
                        style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            {
                                id: 'cmp_fsrtbl', type: 'table',
                                props: {
                                    source: { kind: 'records', tableId: 'tbl_fstech', sort: [{ field: 'name', dir: 'asc' }] },
                                    columns: [
                                        { key: 'name', label: 'Technician', format: 'text' },
                                        { key: 'hourly_cost', label: 'Hourly cost', format: 'currency', align: 'right', formatOptions: { decimals: 2 } },
                                    ],
                                    look: 'striped',
                                },
                                style: { span: 6, spanSm: 12 },
                            },
                        ],
                    },
                    {
                        id: 'sec_fscust', title: 'Customers', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            {
                                id: 'cmp_fscgrd', type: 'data_grid',
                                props: {
                                    source: { kind: 'records', tableId: 'tbl_fscust', sort: [{ field: 'name', dir: 'asc' }] },
                                    columns: [
                                        { key: 'name', label: 'Customer', format: 'text' },
                                        { key: 'city', label: 'City', format: 'text' },
                                        { key: 'contact_email', label: 'Contact', format: 'text' },
                                        { key: 'job_count', label: 'Jobs', format: 'number', align: 'right' },
                                        { key: 'open_value', label: 'Open value', format: 'currency', align: 'right' },
                                    ],
                                    look: 'minimal',
                                    emptyText: 'No customers yet.',
                                },
                                style: { span: 12 },
                            },
                        ],
                    },
                ],
            },
        ],
        actions: {
            act_fsgobook: { kind: 'navigate', screenId: 'scr_fsbook' },
            act_fsback: { kind: 'navigate', screenId: 'scr_fsboard' },
            act_fsopen: {
                kind: 'sequence',
                steps: [
                    { kind: 'set_variable', name: 'jobId', value: { kind: 'formula', expr: 'item.id' } },
                    { kind: 'navigate', screenId: 'scr_fsjob', params: { id: { kind: 'formula', expr: 'item.id' } } },
                ],
            },
            act_fsmove: {
                kind: 'sequence',
                steps: [
                    { kind: 'update_record', tableId: 'tbl_fsjob', recordId: { kind: 'formula', expr: 'item.id' }, values: { status: { kind: 'formula', expr: 'value' } } },
                    { kind: 'refresh', tableId: 'tbl_fsjob' },
                ],
            },
            act_fsdone: {
                kind: 'sequence',
                steps: [
                    { kind: 'update_record', tableId: 'tbl_fsjob', recordId: { kind: 'formula', expr: 'vars.jobId' }, values: { status: { kind: 'static', value: 'done' } } },
                    { kind: 'toast', message: 'Job marked as done.', tone: 'success' },
                    { kind: 'navigate', screenId: 'scr_fsboard' },
                ],
            },
            act_fsbooksave: {
                kind: 'sequence',
                steps: [
                    {
                        kind: 'create_record', tableId: 'tbl_fsjob',
                        values: {
                            title: { kind: 'formula', expr: 'form.title' },
                            customer: { kind: 'formula', expr: 'form.customer' },
                            priority: { kind: 'formula', expr: 'form.priority' },
                            scheduled_on: { kind: 'formula', expr: 'form.scheduled_on' },
                            due_on: { kind: 'formula', expr: 'form.due_on' },
                            hours: { kind: 'formula', expr: 'form.hours' },
                            lead: { kind: 'formula', expr: 'form.lead' },
                            crew: { kind: 'formula', expr: 'form.crew ?? []' },
                            price: { kind: 'formula', expr: 'form.price' },
                            notes: { kind: 'formula', expr: 'form.notes' },
                            status: { kind: 'formula', expr: "form.scheduled_on ? 'scheduled' : 'new'" },
                        },
                    },
                    { kind: 'toast', message: 'Job booked.', tone: 'success' },
                    { kind: 'navigate', screenId: 'scr_fsboard' },
                ],
            },
            // Started by the weekday-morning trigger (and by nothing on a page):
            // only steps that run unattended. The code step sums the open jobs
            // up; the automation the owner connects sends the e-mail.
            act_fsmorning: {
                kind: 'sequence',
                steps: [
                    {
                        kind: 'code',
                        code: SUMMARY_CODE,
                        inputs: {
                            jobs: { kind: 'records', tableId: 'tbl_fsjob', filter: [NOT_DONE], sort: [{ field: 'due_on', dir: 'asc' }], limit: 200 },
                            today: { kind: 'formula', expr: 'today' },
                        },
                        resultVar: 'summary',
                    },
                    {
                        kind: 'run_automation', automationId: null,
                        inputMapping: {
                            subject: { kind: 'formula', expr: "'Field service: ' + vars.summary.today + ' jobs today, ' + vars.summary.overdue + ' overdue'" },
                            body: { kind: 'formula', expr: 'vars.summary.text' },
                        },
                    },
                ],
            },
        },
        variables: [
            { name: 'jobId', label: 'Open job', type: 'text', default: '', description: 'The job the Job screen shows' },
            { name: 'summary', label: 'Morning summary', type: 'any', default: null, description: 'What the morning summary worked out' },
        ],
        triggers: [
            { id: 'morning_summary', kind: 'schedule', actionId: 'act_fsmorning', schedule: { cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam' } },
        ],
    },
};
