/**
 * App Studio template — CRM pipeline — companies/contacts/deals; kanban by stage + a
 * record-detail screen reached via navigate params.
 *
 * Entry of the gallery in ../templates.js, which documents the template
 * shape and the order the gallery lists them in.
 */

'use strict';

const { THEME_DEFAULTS } = require('./themeDefaults');

module.exports = {
    id: 'app-crm-pipeline',
    version: 1,
    title: 'CRM pipeline',
    description: 'A sales pipeline over your own data: drag deals across stages on a kanban, filter by name, and drill into a deal. Ships with companies, contacts and deals.',
    category: 'Data',
    icon: 'Kanban',
    tags: ['crm', 'sales', 'pipeline', 'kanban'],
    dataModel: {
        modelVersion: 1,
        tables: [
            {
                id: 'tbl_crmco', key: 'companies', name: 'Companies', icon: 'Building2',
                fields: [
                    { id: 'fld_crmconame', key: 'name', name: 'Name', type: 'text', required: true },
                    { id: 'fld_crmcoind', key: 'industry', name: 'Industry', type: 'text' },
                    { id: 'fld_crmcoweb', key: 'website', name: 'Website', type: 'text' },
                ],
                access: { default: 'app' },
            },
            {
                id: 'tbl_crmct', key: 'contacts', name: 'Contacts', icon: 'User',
                fields: [
                    { id: 'fld_crmctname', key: 'name', name: 'Name', type: 'text', required: true },
                    { id: 'fld_crmctmail', key: 'email', name: 'Email', type: 'text' },
                    { id: 'fld_crmctco', key: 'company', name: 'Company', type: 'relation', relation: { table: 'tbl_crmco' } },
                ],
                access: { default: 'app' },
            },
            {
                id: 'tbl_crmdl', key: 'deals', name: 'Deals', icon: 'Handshake',
                fields: [
                    { id: 'fld_crmdltitle', key: 'title', name: 'Title', type: 'text', required: true },
                    {
                        id: 'fld_crmdlstage', key: 'stage', name: 'Stage', type: 'select',
                        options: [
                            { value: 'lead', label: 'Lead' },
                            { value: 'qualified', label: 'Qualified' },
                            { value: 'proposal', label: 'Proposal' },
                            { value: 'won', label: 'Won' },
                            { value: 'lost', label: 'Lost' },
                        ],
                    },
                    { id: 'fld_crmdlamt', key: 'amount', name: 'Amount', type: 'number', subtype: 'integer' },
                    { id: 'fld_crmdlco', key: 'company', name: 'Company', type: 'relation', relation: { table: 'tbl_crmco' } },
                ],
                access: { default: 'app' },
            },
        ],
        roles: [],
        roleMapping: { default: 'app', byGroup: {} },
    },
    seed: {
        tbl_crmco: [
            { $id: 'acme', name: 'Acme Corp', industry: 'Manufacturing', website: 'https://acme.example' },
            { $id: 'globex', name: 'Globex', industry: 'Energy', website: 'https://globex.example' },
            { $id: 'initech', name: 'Initech', industry: 'Software', website: 'https://initech.example' },
        ],
        tbl_crmct: [
            { name: 'Jane Doe', email: 'jane@acme.example', company: { $ref: 'acme' } },
            { name: 'John Roe', email: 'john@globex.example', company: { $ref: 'globex' } },
            { name: 'Mia Ng', email: 'mia@initech.example', company: { $ref: 'initech' } },
        ],
        tbl_crmdl: [
            { title: 'Acme renewal', stage: 'qualified', amount: 12000, company: { $ref: 'acme' } },
            { title: 'Globex rollout', stage: 'proposal', amount: 45000, company: { $ref: 'globex' } },
            { title: 'Initech pilot', stage: 'lead', amount: 8000, company: { $ref: 'initech' } },
            { title: 'Acme upsell', stage: 'won', amount: 22000, company: { $ref: 'acme' } },
            { title: 'Globex expansion', stage: 'lost', amount: 15000, company: { $ref: 'globex' } },
        ],
    },
    datasets: [
        {
            id: 'ds_crmstage', name: 'Deals by stage', tableId: 'tbl_crmdl',
            source: { kind: 'table', tableId: 'tbl_crmdl' },
            descriptor: { groupBy: [{ field: 'stage' }], aggregates: [{ fn: 'count' }] },
        },
    ],
    definition: {
        schemaVersion: 2,
        meta: { name: 'CRM pipeline', description: 'Track companies, contacts and deals.', icon: 'Kanban' },
        theme: { primary: '#1D4ED8', ...THEME_DEFAULTS, radius: 'lg' },
        // Identity: the "cloud" B2B-SaaS look — blue, Inter, soft raised
        // cards, full motion — so the sales tool feels like a sales tool.
        design: { preset: 'cloud', font: 'inter', surface: 'soft', motion: 'full', chartPalette: 'brand', logoUrl: null },
        homeScreenId: 'scr_crmpipe',
        roles: [],
        screens: [
            {
                id: 'scr_crmpipe', name: 'Pipeline', icon: 'Kanban', showInNav: true, maxWidth: 'wide',
                sections: [
                    {
                        id: 'sec_crmhead', style: { padding: 4, gap: 2, background: 'none' },
                        children: [
                            { id: 'cmp_crmh1', type: 'heading', props: { text: 'Sales pipeline', level: 1, accent: 'bar' }, style: { span: 12 } },
                            {
                                id: 'cmp_crmfil', type: 'filter_bar',
                                props: { fields: [{ name: 'q', label: 'Search deals', type: 'search' }] },
                                style: { span: 12 },
                            },
                        ],
                    },
                    {
                        id: 'sec_crmboard', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            {
                                id: 'cmp_crmkan', type: 'kanban',
                                props: {
                                    source: { kind: 'records', tableId: 'tbl_crmdl', filter: [{ field: 'title', op: 'contains', value: { kind: 'formula', expr: 'vars.filters.q' } }] },
                                    groupByField: 'stage',
                                    columns: [
                                        { value: 'lead', label: 'Lead', color: 'neutral' },
                                        { value: 'qualified', label: 'Qualified', color: 'info' },
                                        { value: 'proposal', label: 'Proposal', color: 'primary' },
                                        { value: 'won', label: 'Won', color: 'success' },
                                        { value: 'lost', label: 'Lost', color: 'danger' },
                                    ],
                                    titleKey: 'title',
                                    subtitleKey: 'stage',
                                    cardLook: 'raised',
                                },
                                style: { span: 12 },
                                onRowClick: 'act_crmopen',
                                onCardMove: 'act_crmmove',
                            },
                        ],
                    },
                ],
            },
            {
                id: 'scr_crmdeal', name: 'Deal', icon: 'Handshake', showInNav: false, maxWidth: 'medium',
                sections: [
                    {
                        id: 'sec_crmdetail', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            { id: 'cmp_crmback', type: 'button', props: { label: 'Back to pipeline', variant: 'ghost', iconLeft: 'ArrowLeft' }, style: { span: 4 }, onClick: 'act_crmback' },
                            {
                                id: 'cmp_crmrd', type: 'record_detail',
                                props: {
                                    source: { kind: 'record', tableId: 'tbl_crmdl', filter: [{ field: 'id', op: 'eq', value: { kind: 'formula', expr: 'screen.params.id' } }] },
                                    fields: [
                                        { key: 'title', label: 'Title', format: 'text' },
                                        { key: 'stage', label: 'Stage', format: 'badge' },
                                        { key: 'amount', label: 'Amount', format: 'number' },
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
            act_crmopen: { kind: 'navigate', screenId: 'scr_crmdeal', params: { id: { kind: 'formula', expr: 'item.id' } } },
            act_crmback: { kind: 'navigate', screenId: 'scr_crmpipe' },
            act_crmmove: {
                kind: 'sequence',
                steps: [
                    { kind: 'update_record', tableId: 'tbl_crmdl', recordId: { kind: 'formula', expr: 'item.id' }, values: { stage: { kind: 'formula', expr: 'value' } } },
                    { kind: 'toast', message: 'Deal moved.', tone: 'success' },
                ],
            },
        },
    },
};
