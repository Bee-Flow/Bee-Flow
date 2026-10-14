/**
 * App Studio template — Asset inventory — data_grid + record_detail (via navigate params)
 * + a badge_list coloured by status.
 *
 * Entry of the gallery in ../templates.js, which documents the template
 * shape and the order the gallery lists them in.
 */

'use strict';

const { THEME_DEFAULTS } = require('./themeDefaults');

module.exports = {
    id: 'app-asset-inventory',
    version: 1,
    title: 'Asset inventory',
    description: 'Keep track of equipment and licenses: browse a searchable grid, see everything at a glance as coloured badges, and open any asset for its full details.',
    category: 'Data',
    icon: 'Boxes',
    tags: ['inventory', 'assets', 'it'],
    dataModel: {
        modelVersion: 1,
        tables: [
            {
                id: 'tbl_asast', key: 'assets', name: 'Assets', icon: 'Box',
                fields: [
                    { id: 'fld_asname', key: 'name', name: 'Name', type: 'text', required: true },
                    {
                        id: 'fld_ascat', key: 'category', name: 'Category', type: 'select',
                        options: [
                            { value: 'hardware', label: 'Hardware' },
                            { value: 'software', label: 'Software' },
                            { value: 'furniture', label: 'Furniture' },
                        ],
                    },
                    {
                        id: 'fld_asstat', key: 'status', name: 'Status', type: 'select',
                        options: [
                            { value: 'in_use', label: 'In use' },
                            { value: 'available', label: 'Available' },
                            { value: 'retired', label: 'Retired' },
                        ],
                    },
                    {
                        id: 'fld_astags', key: 'tags', name: 'Tags', type: 'multiselect',
                        options: [
                            { value: 'laptop', label: 'Laptop' },
                            { value: 'monitor', label: 'Monitor' },
                            { value: 'phone', label: 'Phone' },
                            { value: 'desk', label: 'Desk' },
                            { value: 'license', label: 'License' },
                        ],
                    },
                    { id: 'fld_asassign', key: 'assigned_to', name: 'Assigned to', type: 'text' },
                ],
                access: { default: 'app' },
            },
        ],
        roles: [],
        roleMapping: { default: 'app', byGroup: {} },
    },
    seed: {
        tbl_asast: [
            { name: 'MacBook Pro 14', category: 'hardware', status: 'in_use', tags: ['laptop'], assigned_to: 'Jane Doe' },
            { name: 'Dell 27" Monitor', category: 'hardware', status: 'available', tags: ['monitor'], assigned_to: '' },
            { name: 'Figma license', category: 'software', status: 'in_use', tags: ['license'], assigned_to: 'Mia Ng' },
            { name: 'Standing desk', category: 'furniture', status: 'available', tags: ['desk'], assigned_to: '' },
            { name: 'iPhone 14', category: 'hardware', status: 'retired', tags: ['phone'], assigned_to: 'John Roe' },
        ],
    },
    definition: {
        schemaVersion: 2,
        meta: { name: 'Asset inventory', description: 'Track equipment and licenses.', icon: 'Boxes' },
        theme: { primary: '#047857', ...THEME_DEFAULTS },
        homeScreenId: 'scr_asinv',
        roles: [],
        screens: [
            {
                id: 'scr_asinv', name: 'Inventory', icon: 'Boxes', showInNav: true, maxWidth: 'wide',
                sections: [
                    {
                        id: 'sec_asinv', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            { id: 'cmp_ash1', type: 'heading', props: { text: 'Asset inventory', level: 1 }, style: { span: 12 } },
                            {
                                id: 'cmp_asgrid', type: 'data_grid',
                                props: {
                                    source: { kind: 'records', tableId: 'tbl_asast', sort: [{ field: 'name', dir: 'asc' }] },
                                    columns: [
                                        { key: 'name', label: 'Name', format: 'text' },
                                        { key: 'category', label: 'Category', format: 'badge' },
                                        { key: 'status', label: 'Status', format: 'badge' },
                                        { key: 'assigned_to', label: 'Assigned to', format: 'text' },
                                    ],
                                    searchable: true,
                                },
                                style: { span: 12 },
                                onRowClick: 'act_asopen',
                            },
                            {
                                id: 'cmp_asbadge', type: 'badge_list',
                                props: {
                                    source: { kind: 'records', tableId: 'tbl_asast' },
                                    labelKey: 'name',
                                    colorKey: 'status',
                                    colorMap: [
                                        { value: 'in_use', color: 'info' },
                                        { value: 'available', color: 'success' },
                                        { value: 'retired', color: 'neutral' },
                                    ],
                                },
                                style: { span: 12 },
                            },
                        ],
                    },
                ],
            },
            {
                id: 'scr_asdet', name: 'Asset', icon: 'Box', showInNav: false, maxWidth: 'medium',
                sections: [
                    {
                        id: 'sec_asdet', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            { id: 'cmp_asback', type: 'button', props: { label: 'Back to inventory', variant: 'ghost', iconLeft: 'ArrowLeft' }, style: { span: 4 }, onClick: 'act_asback' },
                            {
                                id: 'cmp_asrd', type: 'record_detail',
                                props: {
                                    source: { kind: 'record', tableId: 'tbl_asast', filter: [{ field: 'id', op: 'eq', value: { kind: 'formula', expr: 'screen.params.id' } }] },
                                    fields: [
                                        { key: 'name', label: 'Name', format: 'text' },
                                        { key: 'category', label: 'Category', format: 'badge' },
                                        { key: 'status', label: 'Status', format: 'badge' },
                                        { key: 'assigned_to', label: 'Assigned to', format: 'text' },
                                    ],
                                    columns: 2,
                                },
                                style: { span: 12 },
                            },
                        ],
                    },
                ],
            },
        ],
        actions: {
            act_asopen: { kind: 'navigate', screenId: 'scr_asdet', params: { id: { kind: 'formula', expr: 'item.id' } } },
            act_asback: { kind: 'navigate', screenId: 'scr_asinv' },
        },
    },
};
