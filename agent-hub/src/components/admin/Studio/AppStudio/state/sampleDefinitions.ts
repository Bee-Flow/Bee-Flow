/**
 * App Studio — fixture definitions for tests, Storybook-style previews and
 * the renderer while the backend is being wired.
 *
 * The schema is owned by server/appStudio/componentSpecs.js (authoritative).
 * BLANK_APP mirrors the server's emptyDefinition() with deterministic ids;
 * KITCHEN_SINK is a valid definition exercising all 19 component types, all
 * four action kinds, a form wired to a run_automation action and a table
 * bound to that action's result, across two screens.
 *
 * Both fixtures are deep-frozen: definition ops are immutable by contract,
 * so any accidental mutation throws loudly in tests and dev.
 */


import { deepFreeze } from './sampleFixtureFreeze';

/** Mirror of server emptyDefinition('Untitled app') with stable fixture ids. */
export const BLANK_APP = deepFreeze({
    schemaVersion: 1,
    meta: { name: 'Untitled app', description: '', icon: 'LayoutGrid' },
    theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' },
    homeScreenId: 'scr_home01',
    screens: [{
        id: 'scr_home01',
        name: 'Home',
        icon: 'Home',
        showInNav: true,
        maxWidth: 'medium',
        sections: [{ id: 'sec_home01', style: { padding: 4, gap: 3, background: 'none' }, children: [] }],
    }],
    actions: {},
});

export const KITCHEN_SINK = deepFreeze({
    schemaVersion: 1,
    meta: {
        name: 'Kitchen sink',
        description: 'Every v1 component, wired to every action kind.',
        icon: 'LayoutGrid',
    },
    theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' },
    homeScreenId: 'scr_dash01',
    screens: [
        {
            id: 'scr_dash01',
            name: 'Dashboard',
            icon: 'LayoutDashboard',
            showInNav: true,
            maxWidth: 'wide',
            sections: [
                {
                    id: 'sec_dash01',
                    style: { padding: 4, gap: 3, background: 'none' },
                    children: [
                        {
                            id: 'cmp_headg1', type: 'heading', visible: true,
                            props: { text: 'Team dashboard', level: 1 },
                            style: { span: 12, align: 'start', color: null },
                        },
                        {
                            id: 'cmp_intro1', type: 'text', visible: true,
                            props: { text: 'Live overview of **open requests**, refreshed by an automation.', muted: true },
                            style: { span: 12, align: 'start', color: null, weight: 'regular' },
                        },
                        {
                            id: 'cmp_stat01', type: 'stat', visible: true,
                            props: {
                                label: 'Open requests',
                                value: { kind: 'actionResult', actionId: 'act_fetch1', path: 'stats.open' },
                                caption: 'right now', icon: 'Activity',
                            },
                            style: { span: 3, size: 'md', align: 'start', color: 'primary' },
                        },
                        {
                            id: 'cmp_stat02', type: 'stat', visible: true,
                            props: {
                                label: 'Resolved this week',
                                value: { kind: 'static', value: '12' },
                                caption: null, icon: 'CheckCircle2',
                            },
                            style: { span: 3, size: 'md', align: 'start', color: 'success' },
                        },
                        {
                            id: 'cmp_refre1', type: 'button', visible: true, onClick: 'act_fetch1',
                            props: { label: 'Refresh', variant: 'secondary', iconLeft: 'RefreshCw', role: 'button' },
                            style: { span: 3, size: 'md', align: 'end' },
                        },
                        {
                            id: 'cmp_divid1', type: 'divider', visible: true,
                            props: {},
                            style: { span: 12 },
                        },
                        {
                            id: 'cmp_table1', type: 'table', visible: true,
                            props: {
                                source: { kind: 'actionResult', actionId: 'act_fetch1', path: 'rows' },
                                columns: [
                                    { key: 'title', label: 'Title', format: 'text' },
                                    { key: 'status', label: 'Status', format: 'badge' },
                                    { key: 'createdAt', label: 'Created', format: 'date' },
                                ],
                                emptyText: 'Nothing to show yet.',
                                rowLimit: 25,
                            },
                            style: { span: 12, size: 'md' },
                        },
                    ],
                },
                {
                    id: 'sec_dash02',
                    style: { padding: 4, gap: 3, background: 'none' },
                    children: [
                        {
                            id: 'cmp_list01', type: 'list', visible: true,
                            props: {
                                source: { kind: 'static', value: [{ title: 'Welcome', subtitle: 'Start here' }] },
                                titleKey: 'title', subtitleKey: 'subtitle', icon: 'FileText',
                                emptyText: 'Nothing to show yet.',
                            },
                            style: { span: 6, size: 'md' },
                        },
                        {
                            id: 'cmp_keyva1', type: 'keyValue', visible: true,
                            props: {
                                source: { kind: 'actionResult', actionId: 'act_fetch1', path: 'rows.0' },
                                fields: [
                                    { key: 'title', label: 'Title' },
                                    { key: 'owner', label: 'Owner' },
                                ],
                                emptyText: 'No data yet.',
                            },
                            style: { span: 6, size: 'md' },
                        },
                    ],
                },
                {
                    id: 'sec_dash03',
                    style: { padding: 4, gap: 3, background: 'surface' },
                    children: [
                        {
                            id: 'cmp_card01', type: 'card', visible: true,
                            props: { title: 'Getting started', description: 'A container on its own 12-column grid.' },
                            style: { span: 12, padding: 3, gap: 3, radius: 'md', background: 'surface' },
                            children: [
                                {
                                    id: 'cmp_image1', type: 'image', visible: true,
                                    props: { src: 'https://beeflow.nl/logo.png', alt: 'Bee Flow', fit: 'cover' },
                                    style: { span: 4, height: 'md', radius: 'md', align: 'start' },
                                },
                                {
                                    id: 'cmp_callo1', type: 'callout', visible: true,
                                    props: {
                                        title: 'Heads up',
                                        text: 'Submit a request on the *New request* screen.',
                                        tone: 'info',
                                    },
                                    style: { span: 8 },
                                },
                                {
                                    id: 'cmp_space1', type: 'spacer', visible: true,
                                    props: { steps: 2 },
                                    style: { span: 12 },
                                },
                                {
                                    id: 'cmp_docsb1', type: 'button', visible: true, onClick: 'act_docs01',
                                    props: { label: 'Open the docs', variant: 'ghost', iconLeft: 'BookOpen', role: 'button' },
                                    style: { span: 3, size: 'sm', align: 'start' },
                                },
                                {
                                    id: 'cmp_gofrm1', type: 'button', visible: true, onClick: 'act_gonav1',
                                    props: { label: 'New request', variant: 'primary', iconLeft: 'Plus', role: 'button' },
                                    style: { span: 3, size: 'md', align: 'end' },
                                },
                            ],
                        },
                    ],
                },
            ],
        },
        {
            id: 'scr_form01',
            name: 'New request',
            icon: 'FilePlus2',
            showInNav: true,
            maxWidth: 'narrow',
            sections: [
                {
                    id: 'sec_form01',
                    style: { padding: 4, gap: 3, background: 'none' },
                    children: [
                        {
                            id: 'cmp_head21', type: 'heading', visible: true,
                            props: { text: 'New request', level: 2 },
                            style: { span: 12, align: 'start', color: null },
                        },
                        {
                            id: 'cmp_form01', type: 'form', visible: true, onSubmit: 'act_submit',
                            props: { name: 'request', submitLabel: 'Send request', showReset: false },
                            style: { span: 12, gap: 3, padding: 0 },
                            children: [
                                {
                                    id: 'cmp_insub1', type: 'input_text', visible: true,
                                    props: {
                                        name: 'subject', label: 'Subject', placeholder: 'Short summary',
                                        required: true, defaultValue: null, inputType: 'text',
                                    },
                                    style: { span: 12, size: 'md' },
                                },
                                {
                                    id: 'cmp_indet1', type: 'input_textarea', visible: true,
                                    props: {
                                        name: 'details', label: 'Details', placeholder: 'What do you need?',
                                        required: false, rows: 4,
                                    },
                                    style: { span: 12 },
                                },
                                {
                                    id: 'cmp_inqty1', type: 'input_number', visible: true,
                                    props: {
                                        name: 'quantity', label: 'Quantity', min: 1, max: 100, step: 1,
                                        required: false, defaultValue: 1,
                                    },
                                    style: { span: 6, size: 'md' },
                                },
                                {
                                    id: 'cmp_inpri1', type: 'input_select', visible: true,
                                    props: {
                                        name: 'priority', label: 'Priority',
                                        options: [
                                            { value: 'low', label: 'Low' },
                                            { value: 'normal', label: 'Normal' },
                                            { value: 'high', label: 'High' },
                                        ],
                                        required: true, defaultValue: 'normal', placeholder: null,
                                    },
                                    style: { span: 6, size: 'md' },
                                },
                                {
                                    id: 'cmp_indue1', type: 'input_date', visible: true,
                                    props: { name: 'due', label: 'Due date', required: false, defaultValue: null },
                                    style: { span: 6, size: 'md' },
                                },
                                {
                                    id: 'cmp_intfy1', type: 'input_checkbox', visible: true,
                                    props: { name: 'notify', label: 'Email me when done', defaultChecked: true },
                                    style: { span: 6 },
                                },
                            ],
                        },
                        {
                            id: 'cmp_toast1', type: 'button', visible: true, onClick: 'act_toast1',
                            props: { label: 'Test notification', variant: 'ghost', iconLeft: null, role: 'button' },
                            style: { span: 4, size: 'sm', align: 'start' },
                        },
                    ],
                },
            ],
        },
    ],
    actions: {
        // Feeds the dashboard stat/table/key-value bindings. automationId is
        // null until one is picked in the inspector (valid per the spec).
        act_fetch1: {
            kind: 'run_automation',
            automationId: null,
            onError: { toast: { message: 'Could not refresh the dashboard.', tone: 'danger' } },
        },
        act_submit: {
            kind: 'run_automation',
            automationId: null,
            inputMapping: {
                subject: { kind: 'field', name: 'subject' },
                details: { kind: 'field', name: 'details' },
                quantity: { kind: 'field', name: 'quantity' },
                priority: { kind: 'field', name: 'priority' },
                due: { kind: 'field', name: 'due' },
                notify: { kind: 'field', name: 'notify' },
                origin: { kind: 'static', value: 'app-studio' },
            },
            onSuccess: {
                toast: { message: 'Request sent.', tone: 'success' },
                navigateTo: 'scr_dash01',
            },
            onError: { toast: { message: 'Something went wrong — try again.', tone: 'danger' } },
        },
        act_gonav1: { kind: 'navigate', screenId: 'scr_form01' },
        act_docs01: { kind: 'open_url', url: 'https://beeflow.nl', newTab: true },
        act_toast1: { kind: 'toast', message: 'Notifications look like this.', tone: 'info' },
    },
});

/** The v2 fixtures live in their own module to keep this file under the size budget. */
export { V2_SHOWCASE, V2_RICH, V21_BATCH } from './sampleDefinitionsV2';
