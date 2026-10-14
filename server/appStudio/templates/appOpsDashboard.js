/**
 * App Studio template — Ops dashboard — KPI tiles + table fed by one refresh automation.
 *
 * Entry of the gallery in ../templates.js, which documents the template
 * shape and the order the gallery lists them in.
 */

'use strict';

const { THEME_DEFAULTS } = require('./themeDefaults');

module.exports = {
    id: 'app-ops-dashboard',
    version: 1,
    title: 'Ops dashboard',
    description: 'Four KPI tiles and a work-queue table, all fed by a single "refresh" Automation, plus a maintenance screen with a run button.',
    category: 'Dashboards',
    icon: 'Gauge',
    tags: ['dashboard', 'kpi', 'operations'],
    definition: {
        schemaVersion: 1,
        meta: { name: 'Ops dashboard', description: 'Team operations at a glance.', icon: 'Gauge' },
        theme: { primary: '#047857', ...THEME_DEFAULTS },
        homeScreenId: 'scr_opshome',
        screens: [
            {
                id: 'scr_opshome',
                name: 'Overview',
                icon: 'Gauge',
                showInNav: true,
                maxWidth: 'wide',
                sections: [
                    {
                        id: 'sec_opshdr',
                        style: { padding: 4, gap: 2, background: 'none' },
                        children: [
                            { id: 'cmp_opstitle', type: 'heading', props: { text: 'Operations', level: 1 }, style: { span: 9 }, visible: true },
                            { id: 'cmp_opsrefresh', type: 'button', props: { label: 'Refresh', variant: 'ghost', iconLeft: 'RefreshCw', role: 'button' }, style: { span: 3, align: 'end' }, visible: true, onClick: 'act_opsrefresh' },
                        ],
                    },
                    {
                        id: 'sec_opskpis',
                        style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            { id: 'cmp_opsk1', type: 'stat', props: { label: 'Open items', value: { kind: 'actionResult', actionId: 'act_opsrefresh', path: 'open' }, icon: 'Inbox' }, style: { span: 3 }, visible: true },
                            { id: 'cmp_opsk2', type: 'stat', props: { label: 'In progress', value: { kind: 'actionResult', actionId: 'act_opsrefresh', path: 'inProgress' }, icon: 'Loader' }, style: { span: 3 }, visible: true },
                            { id: 'cmp_opsk3', type: 'stat', props: { label: 'Done today', value: { kind: 'actionResult', actionId: 'act_opsrefresh', path: 'doneToday' }, icon: 'CheckCircle2', caption: 'since midnight' }, style: { span: 3 }, visible: true },
                            { id: 'cmp_opsk4', type: 'stat', props: { label: 'Overdue', value: { kind: 'actionResult', actionId: 'act_opsrefresh', path: 'overdue' }, icon: 'AlertTriangle' }, style: { span: 3, color: 'danger' }, visible: true },
                        ],
                    },
                    {
                        id: 'sec_opsqueue',
                        style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            {
                                id: 'cmp_opstable',
                                type: 'table',
                                props: {
                                    source: { kind: 'actionResult', actionId: 'act_opsrefresh', path: 'queue' },
                                    columns: [
                                        { key: 'title', label: 'Item', format: 'text' },
                                        { key: 'assignee', label: 'Assignee', format: 'text' },
                                        { key: 'due', label: 'Due', format: 'date' },
                                        { key: 'status', label: 'Status', format: 'badge' },
                                    ],
                                    emptyText: 'Hit Refresh to load the queue.',
                                    rowLimit: 50,
                                },
                                style: { span: 12 },
                                visible: true,
                            },
                        ],
                    },
                ],
            },
            {
                id: 'scr_opsmaint',
                name: 'Maintenance',
                icon: 'Wrench',
                showInNav: true,
                maxWidth: 'narrow',
                sections: [
                    {
                        id: 'sec_opsmaint',
                        style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            { id: 'cmp_opsmhead', type: 'heading', props: { text: 'Maintenance', level: 2 }, style: { span: 12 }, visible: true },
                            { id: 'cmp_opsmwarn', type: 'callout', props: { title: 'Careful', text: 'This triggers the maintenance automation for the whole team. Run it only when needed.', tone: 'warning' }, style: { span: 12 }, visible: true },
                            { id: 'cmp_opsmrun', type: 'button', props: { label: 'Run maintenance', variant: 'danger', iconLeft: 'Wrench', role: 'button' }, style: { span: 5 }, visible: true, onClick: 'act_opsmaint' },
                        ],
                    },
                ],
            },
        ],
        actions: {
            act_opsrefresh: {
                kind: 'run_automation',
                automationId: null,
                inputMapping: {},
                onError: { toast: { message: 'Could not load dashboard data.', tone: 'danger' } },
            },
            act_opsmaint: {
                kind: 'run_automation',
                automationId: null,
                inputMapping: {},
                onSuccess: { toast: { message: 'Maintenance automation started.', tone: 'success' } },
                onError: { toast: { message: 'Maintenance failed to start.', tone: 'danger' } },
            },
        },
    },
};
