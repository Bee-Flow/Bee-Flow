// @typecheck strict
/**
 * App Studio template — Ticket tracker — intake form (create_record sequence) + status
 * kanban + a "My tickets" screen scoped to currentUser (Wave 1a).
 *
 * Entry of the gallery in ../templates.js, which documents the template
 * shape and the order the gallery lists them in.
 */

'use strict';

const { THEME_DEFAULTS } = require('./themeDefaults');

module.exports = {
    id: 'app-ticket-tracker',
    version: 1,
    title: 'Ticket tracker',
    description: 'Log tickets through an intake form, triage them on a status board, and see just your own on a "My tickets" screen. All backed by your own data table.',
    category: 'Data',
    icon: 'Ticket',
    tags: ['tickets', 'support', 'intake', 'kanban'],
    dataModel: {
        modelVersion: 1,
        tables: [
            {
                // access.default:'app' so the board shows every ticket; the
                // "My tickets" screen narrows to created_by = currentUser.id
                // in its records binding (deliberate own-scoping demo).
                id: 'tbl_tktik', key: 'tickets', name: 'Tickets', icon: 'Ticket',
                fields: [
                    { id: 'fld_tksubj', key: 'subject', name: 'Subject', type: 'text', required: true },
                    {
                        id: 'fld_tkstat', key: 'status', name: 'Status', type: 'select',
                        options: [
                            { value: 'open', label: 'Open' },
                            { value: 'in_progress', label: 'In progress' },
                            { value: 'done', label: 'Done' },
                        ],
                    },
                    {
                        id: 'fld_tkprio', key: 'priority', name: 'Priority', type: 'select',
                        options: [
                            { value: 'low', label: 'Low' },
                            { value: 'medium', label: 'Medium' },
                            { value: 'high', label: 'High' },
                        ],
                    },
                    { id: 'fld_tkdet', key: 'details', name: 'Details', type: 'text' },
                ],
                access: { default: 'app' },
            },
        ],
        roles: [],
        roleMapping: { default: 'app', byGroup: {} },
    },
    seed: {
        tbl_tktik: [
            { subject: 'Laptop will not boot', status: 'open', priority: 'high', details: 'Black screen after update.' },
            { subject: 'VPN keeps dropping', status: 'in_progress', priority: 'medium', details: 'Disconnects every few minutes.' },
            { subject: 'New monitor request', status: 'open', priority: 'low', details: 'Second monitor for the home desk.' },
            { subject: 'Password reset', status: 'done', priority: 'medium', details: 'Reset and confirmed working.' },
            { subject: 'Email quota full', status: 'open', priority: 'high', details: 'Cannot send or receive.' },
        ],
    },
    definition: {
        schemaVersion: 2,
        meta: { name: 'Ticket tracker', description: 'Collect and triage tickets.', icon: 'Ticket' },
        theme: { primary: '#1D4ED8', ...THEME_DEFAULTS },
        homeScreenId: 'scr_tknew',
        roles: [],
        screens: [
            {
                id: 'scr_tknew', name: 'New ticket', icon: 'Plus', showInNav: true, maxWidth: 'narrow',
                sections: [
                    {
                        id: 'sec_tknewf', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            { id: 'cmp_tkh1', type: 'heading', props: { text: 'Log a ticket', level: 1 }, style: { span: 12 } },
                            {
                                id: 'cmp_tkform', type: 'form',
                                props: { name: 'ticket', submitLabel: 'Create ticket', showReset: false },
                                style: { span: 12, gap: 3, padding: 0 },
                                onSubmit: 'act_tksubmit',
                                children: [
                                    { id: 'cmp_tksubj', type: 'input_text', props: { name: 'subject', label: 'Subject', required: true }, style: { span: 12 } },
                                    {
                                        id: 'cmp_tkprio', type: 'input_select',
                                        props: {
                                            name: 'priority', label: 'Priority',
                                            options: [
                                                { value: 'low', label: 'Low' },
                                                { value: 'medium', label: 'Medium' },
                                                { value: 'high', label: 'High' },
                                            ],
                                        },
                                        style: { span: 6 },
                                    },
                                    { id: 'cmp_tkdet', type: 'input_textarea', props: { name: 'details', label: 'Details', rows: 4 }, style: { span: 12 } },
                                ],
                            },
                        ],
                    },
                ],
            },
            {
                id: 'scr_tkboard', name: 'Board', icon: 'Columns3', showInNav: true, maxWidth: 'wide',
                sections: [
                    {
                        id: 'sec_tkboard', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            { id: 'cmp_tkh2', type: 'heading', props: { text: 'All tickets', level: 1 }, style: { span: 12 } },
                            {
                                id: 'cmp_tkkan', type: 'kanban',
                                props: {
                                    source: { kind: 'records', tableId: 'tbl_tktik' },
                                    groupByField: 'status',
                                    columns: [
                                        { value: 'open', label: 'Open', color: 'info' },
                                        { value: 'in_progress', label: 'In progress', color: 'warning' },
                                        { value: 'done', label: 'Done', color: 'success' },
                                    ],
                                    titleKey: 'subject',
                                    subtitleKey: 'priority',
                                    allowDrag: false,
                                },
                                style: { span: 12 },
                            },
                        ],
                    },
                ],
            },
            {
                id: 'scr_tkmine', name: 'My tickets', icon: 'UserCheck', showInNav: true, maxWidth: 'medium',
                sections: [
                    {
                        id: 'sec_tkmine', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            { id: 'cmp_tkh3', type: 'heading', props: { text: 'Tickets I raised', level: 1 }, style: { span: 12 } },
                            {
                                id: 'cmp_tkgrid', type: 'data_grid',
                                props: {
                                    // Own-scoping demo: only the current viewer's rows.
                                    source: { kind: 'records', tableId: 'tbl_tktik', filter: [{ field: 'created_by', op: 'eq', value: { kind: 'formula', expr: 'currentUser.id' } }], sort: [{ field: 'created_at', dir: 'desc' }] },
                                    columns: [
                                        { key: 'subject', label: 'Subject', format: 'text' },
                                        { key: 'status', label: 'Status', format: 'badge' },
                                        { key: 'priority', label: 'Priority', format: 'badge' },
                                    ],
                                    emptyText: 'You have not raised any tickets yet.',
                                },
                                style: { span: 12 },
                            },
                        ],
                    },
                ],
            },
        ],
        actions: {
            act_tksubmit: {
                kind: 'sequence',
                steps: [
                    {
                        kind: 'create_record', tableId: 'tbl_tktik',
                        values: {
                            subject: { kind: 'formula', expr: 'form.subject' },
                            priority: { kind: 'formula', expr: 'form.priority' },
                            details: { kind: 'formula', expr: 'form.details' },
                            status: { kind: 'static', value: 'open' },
                        },
                    },
                    { kind: 'toast', message: 'Ticket created.', tone: 'success' },
                    { kind: 'navigate', screenId: 'scr_tkboard' },
                ],
            },
        },
    },
};
