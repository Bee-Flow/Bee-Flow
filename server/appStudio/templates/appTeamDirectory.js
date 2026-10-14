/**
 * App Studio template — Team directory — searchable list + filter bar + a record-detail
 * panel, all over one people table.
 *
 * Entry of the gallery in ../templates.js, which documents the template
 * shape and the order the gallery lists them in.
 */

'use strict';

const { THEME_DEFAULTS } = require('./themeDefaults');

module.exports = {
    id: 'app-team-directory',
    version: 1,
    title: 'Team directory',
    description: 'A searchable directory of people with a filter bar and a detail panel. Backed by your own people table — no spreadsheet to keep in sync.',
    category: 'Data',
    icon: 'Contact',
    tags: ['directory', 'people', 'hr'],
    dataModel: {
        modelVersion: 1,
        tables: [
            {
                id: 'tbl_tmppl', key: 'people', name: 'People', icon: 'Users',
                fields: [
                    { id: 'fld_tmname', key: 'name', name: 'Name', type: 'text', required: true },
                    { id: 'fld_tmrole', key: 'role', name: 'Role', type: 'text' },
                    { id: 'fld_tmmail', key: 'email', name: 'Email', type: 'text' },
                    {
                        id: 'fld_tmdept', key: 'department', name: 'Department', type: 'select',
                        options: [
                            { value: 'engineering', label: 'Engineering' },
                            { value: 'sales', label: 'Sales' },
                            { value: 'design', label: 'Design' },
                            { value: 'ops', label: 'Ops' },
                        ],
                    },
                    { id: 'fld_tmloc', key: 'location', name: 'Location', type: 'text' },
                ],
                access: { default: 'app' },
            },
        ],
        roles: [],
        roleMapping: { default: 'app', byGroup: {} },
    },
    seed: {
        tbl_tmppl: [
            { name: 'Jane Doe', role: 'Engineer', email: 'jane@example.com', department: 'engineering', location: 'Amsterdam' },
            { name: 'John Roe', role: 'Account Executive', email: 'john@example.com', department: 'sales', location: 'Berlin' },
            { name: 'Mia Ng', role: 'Product Designer', email: 'mia@example.com', department: 'design', location: 'Lisbon' },
            { name: 'Sam Poe', role: 'Ops Lead', email: 'sam@example.com', department: 'ops', location: 'Dublin' },
            { name: 'Lee Fox', role: 'Engineer', email: 'lee@example.com', department: 'engineering', location: 'Porto' },
        ],
    },
    definition: {
        schemaVersion: 2,
        meta: { name: 'Team directory', description: 'Find people across the team.', icon: 'Contact' },
        theme: { primary: '#0891B2', ...THEME_DEFAULTS },
        homeScreenId: 'scr_tmdir',
        roles: [],
        screens: [
            {
                id: 'scr_tmdir', name: 'Directory', icon: 'Contact', showInNav: true, maxWidth: 'wide',
                sections: [
                    {
                        id: 'sec_tmhead', style: { padding: 4, gap: 2, background: 'none' },
                        children: [
                            { id: 'cmp_tmh1', type: 'heading', props: { text: 'Team directory', level: 1 }, style: { span: 12 } },
                            {
                                id: 'cmp_tmfil', type: 'filter_bar',
                                props: {
                                    fields: [
                                        { name: 'q', label: 'Search by name', type: 'search' },
                                        {
                                            name: 'dept', label: 'Department', type: 'select',
                                            options: [
                                                { value: 'engineering', label: 'Engineering' },
                                                { value: 'sales', label: 'Sales' },
                                                { value: 'design', label: 'Design' },
                                                { value: 'ops', label: 'Ops' },
                                            ],
                                        },
                                    ],
                                },
                                style: { span: 12 },
                            },
                        ],
                    },
                    {
                        id: 'sec_tmbody', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            {
                                id: 'cmp_tmlist', type: 'list',
                                props: {
                                    source: { kind: 'records', tableId: 'tbl_tmppl', filter: [{ field: 'name', op: 'contains', value: { kind: 'formula', expr: 'vars.filters.q' } }], sort: [{ field: 'name', dir: 'asc' }] },
                                    titleKey: 'name',
                                    subtitleKey: 'role',
                                    icon: 'User',
                                    emptyText: 'No people match your search.',
                                },
                                style: { span: 7 },
                            },
                            {
                                id: 'cmp_tmrd', type: 'record_detail',
                                props: {
                                    // A read-only spotlight on the first person (by name).
                                    source: { kind: 'record', tableId: 'tbl_tmppl', sort: [{ field: 'name', dir: 'asc' }] },
                                    fields: [
                                        { key: 'name', label: 'Name', format: 'text' },
                                        { key: 'role', label: 'Role', format: 'text' },
                                        { key: 'email', label: 'Email', format: 'link' },
                                        { key: 'department', label: 'Department', format: 'badge' },
                                        { key: 'location', label: 'Location', format: 'text' },
                                    ],
                                    columns: 1,
                                },
                                style: { span: 5 },
                            },
                        ],
                    },
                ],
            },
        ],
        actions: {},
    },
};
