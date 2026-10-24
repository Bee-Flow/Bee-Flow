// @typecheck
/**
 * App Studio template — Lookup console — search form → automation result in a table + stat.
 *
 * Entry of the gallery in ../templates.js, which documents the template
 * shape and the order the gallery lists them in.
 */

'use strict';

const { THEME_DEFAULTS } = require('./themeDefaults');

module.exports = {
    id: 'app-lookup-console',
    version: 1,
    title: 'Lookup console',
    description: 'A search box wired to an Automation, with the results in a table and a match counter. Point it at any automation that returns rows.',
    category: 'Data',
    icon: 'Search',
    tags: ['search', 'lookup', 'table'],
    definition: {
        schemaVersion: 1,
        meta: { name: 'Lookup console', description: 'Search records via an automation.', icon: 'Search' },
        theme: { primary: '#0369A1', ...THEME_DEFAULTS },
        homeScreenId: 'scr_lookup',
        screens: [
            {
                id: 'scr_lookup',
                name: 'Search',
                icon: 'Search',
                showInNav: true,
                maxWidth: 'medium',
                sections: [
                    {
                        id: 'sec_lookhdr',
                        style: { padding: 4, gap: 2, background: 'none' },
                        children: [
                            { id: 'cmp_looktitle', type: 'heading', props: { text: 'Lookup', level: 1 }, style: { span: 12 }, visible: true },
                            {
                                id: 'cmp_lookfrm',
                                type: 'form',
                                props: { name: 'search', submitLabel: 'Search', showReset: false },
                                style: { span: 12, gap: 2, padding: 0 },
                                visible: true,
                                onSubmit: 'act_looksearch',
                                children: [
                                    { id: 'cmp_lookq', type: 'input_text', props: { name: 'query', label: 'Name or email', placeholder: 'e.g. jane@acme.com', required: true, inputType: 'text' }, style: { span: 8 }, visible: true },
                                ],
                            },
                        ],
                    },
                    {
                        id: 'sec_lookres',
                        style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            {
                                id: 'cmp_lookcount',
                                type: 'stat',
                                props: { label: 'Matches', value: { kind: 'actionResult', actionId: 'act_looksearch', path: 'count' }, icon: 'Hash' },
                                style: { span: 3 },
                                visible: true,
                            },
                            {
                                id: 'cmp_looktable',
                                type: 'table',
                                props: {
                                    source: { kind: 'actionResult', actionId: 'act_looksearch', path: 'rows' },
                                    columns: [
                                        { key: 'name', label: 'Name', format: 'text' },
                                        { key: 'email', label: 'Email', format: 'text' },
                                        { key: 'status', label: 'Status', format: 'badge' },
                                    ],
                                    emptyText: 'Run a search to see results.',
                                    rowLimit: 25,
                                },
                                style: { span: 12 },
                                visible: true,
                            },
                        ],
                    },
                ],
            },
        ],
        actions: {
            act_looksearch: {
                kind: 'run_automation',
                automationId: null,
                inputMapping: { query: { kind: 'field', name: 'query' } },
                onError: { toast: { message: 'Search failed — try again.', tone: 'danger' } },
            },
        },
    },
};
