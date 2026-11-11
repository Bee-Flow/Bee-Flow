// @typecheck strict
/**
 * App Studio template — Sales dashboard.
 *
 * One of the four schema-3 templates (see ../templates.js). A dashboard over
 * the app's own deals and accounts, read with aggregate bindings only, so it
 * stays fast and never ships a row it does not need.
 *
 *   period    a select writes `period` (a variable kept in the browser, so a
 *             reload starts on the period the viewer picked); `periodStart` is
 *             derived from it with dateAdd, and every read of the dashboard
 *             filters on it.
 *   charts    the schema-3 chart kinds: a combo (revenue as bars, deal count as
 *             a line on a second axis), a funnel of the stages and a radar of
 *             the regions, plus a gauge of the pipeline's confidence.
 *   format    app-level value formatting (language, currency, dates) with
 *             per-chart and per-tile refinements (compact numbers).
 *   look      a dark "pipeline wall" screen with its own theme, design tokens
 *             (colours used by name in style knobs) and a dark palette for the
 *             rest of the app when the viewer's host theme is dark.
 *   data      accounts in a hierarchy (a relation to the same table) drawn as a
 *             tree, rollups of won revenue per account, a groupBy through the
 *             account relation (deals per region), and a saved dataset with
 *             parameters for the dataset builder.
 */

'use strict';

const { THEME_DEFAULTS } = require('./themeDefaults');

const STAGES = [
    { value: 'lead', label: 'Lead' },
    { value: 'qualified', label: 'Qualified' },
    { value: 'proposal', label: 'Proposal' },
    { value: 'negotiation', label: 'Negotiation' },
    { value: 'won', label: 'Won' },
    { value: 'lost', label: 'Lost' },
];
const REGIONS = [
    { value: 'north', label: 'North' },
    { value: 'south', label: 'South' },
    { value: 'east', label: 'East' },
    { value: 'west', label: 'West' },
];
const SEGMENTS = [
    { value: 'enterprise', label: 'Enterprise' },
    { value: 'mid', label: 'Mid-market' },
    { value: 'small', label: 'Small business' },
];
const PERIODS = [
    { value: '30', label: 'Last 30 days' },
    { value: '90', label: 'Last 90 days' },
    { value: '180', label: 'Last 6 months' },
    { value: '365', label: 'Last 12 months' },
];
const STAGE_TONES = [
    { value: 'lead', label: 'Lead', tone: 'neutral' },
    { value: 'qualified', label: 'Qualified', tone: 'info' },
    { value: 'proposal', label: 'Proposal', tone: 'primary' },
    { value: 'negotiation', label: 'Negotiation', tone: 'warning' },
    { value: 'won', label: 'Won', tone: 'success' },
    { value: 'lost', label: 'Lost', tone: 'danger' },
];

const DEALS = 'tbl_sddeal';
/** Closed inside the chosen period. */
const IN_PERIOD = { field: 'closed_on', op: 'gte', value: { kind: 'formula', expr: 'vars.periodStart' } };
const WON = { field: 'stage', op: 'eq', value: 'won' };
const OPEN = [{ field: 'stage', op: 'neq', value: 'won' }, { field: 'stage', op: 'neq', value: 'lost' }];

/**
 * One number out of the deals table.
 * @param {unknown[]} filter
 * @param {string} fn
 * @param {string} [field]
 */
const total = (filter, fn, field) => ({
    kind: 'aggregate', tableId: DEALS, filter,
    aggregates: [field ? { fn, field, as: 'v' } : { fn, as: 'v' }],
    pick: { row: 'first', column: 'v' },
});

/**
 * A KPI tile.
 * @param {string} id
 * @param {string} label
 * @param {string} icon
 * @param {unknown} value
 * @param {{ props?: Record<string, unknown>, style?: Record<string, unknown> }} [extra]
 */
const stat = (id, label, icon, value, extra = {}) => ({
    id, type: 'stat',
    props: { label, icon, look: 'tile', value, ...extra.props },
    style: { span: 3, spanMd: 6, spanSm: 12, ...extra.style },
});

/** Deals per stage, the biggest first: what the funnel draws. */
const STAGE_COUNTS = {
    kind: 'aggregate', tableId: DEALS, filter: [{ field: 'stage', op: 'neq', value: 'lost' }],
    groupBy: [{ field: 'stage' }], aggregates: [{ fn: 'count', as: 'deals' }],
    sort: [{ field: 'deals', dir: 'desc' }],
};

/** Deals and accounts per region, through the account relation. */
const REGION_COUNTS = {
    kind: 'aggregate', tableId: DEALS,
    groupBy: [{ field: 'account', relatedField: 'region', as: 'region' }],
    aggregates: [{ fn: 'count', as: 'deals' }, { fn: 'countDistinct', field: 'account', as: 'accounts' }],
    sort: [{ field: 'region', dir: 'asc' }],
};

module.exports = {
    id: 'app-sales-dashboard',
    version: 1,
    title: 'Sales dashboard',
    description: 'Revenue, pipeline and win numbers for the period you pick, with a funnel, a radar of your regions, a confidence gauge, a dark wall screen for the office and your accounts as a tree.',
    category: 'Dashboards',
    icon: 'BarChart3',
    tags: ['sales', 'dashboard', 'charts', 'pipeline', 'accounts'],
    dataModel: {
        modelVersion: 1,
        tables: [
            {
                id: 'tbl_sdacct', key: 'accounts', name: 'Accounts', icon: 'Building2',
                fields: [
                    { id: 'fld_sdanam', key: 'name', name: 'Name', type: 'text', required: true, validation: { minLength: 2, maxLength: 80 } },
                    { id: 'fld_sdapar', key: 'parent', name: 'Part of', type: 'relation', relation: { table: 'tbl_sdacct', displayField: 'name', onDelete: 'setNull' } },
                    { id: 'fld_sdareg', key: 'region', name: 'Region', type: 'select', options: REGIONS },
                    { id: 'fld_sdaseg', key: 'segment', name: 'Segment', type: 'select', options: SEGMENTS },
                    { id: 'fld_sdawon', key: 'won_total', name: 'Won', type: 'rollup', rollup: { table: DEALS, relation: 'account', fn: 'sum', field: 'amount', filter: [WON] } },
                    { id: 'fld_sdacnt', key: 'deal_count', name: 'Deals', type: 'rollup', rollup: { table: DEALS, relation: 'account', fn: 'count' } },
                ],
                indexes: [{ fields: ['parent'] }],
                access: { default: 'app' },
            },
            {
                id: DEALS, key: 'deals', name: 'Deals', icon: 'Handshake',
                fields: [
                    { id: 'fld_sddttl', key: 'title', name: 'Deal', type: 'text', required: true, validation: { maxLength: 120 } },
                    { id: 'fld_sddacc', key: 'account', name: 'Account', type: 'relation', relation: { table: 'tbl_sdacct', displayField: 'name', onDelete: 'restrict' } },
                    { id: 'fld_sddanm', key: 'account_name', name: 'Account name', type: 'lookup', lookup: { relation: 'account', field: 'name' } },
                    { id: 'fld_sddstg', key: 'stage', name: 'Stage', type: 'select', options: STAGES, validation: { enforceOptions: true } },
                    { id: 'fld_sddamt', key: 'amount', name: 'Amount', type: 'number', display: { currency: 'EUR', decimals: 0 }, validation: { min: 0 } },
                    { id: 'fld_sddprb', key: 'probability', name: 'Probability', type: 'number', display: { unit: '%', decimals: 0 }, validation: { min: 0, max: 100 } },
                    { id: 'fld_sddown', key: 'owner_name', name: 'Owner', type: 'text', validation: { maxLength: 80 } },
                    { id: 'fld_sddopn', key: 'opened_on', name: 'Opened', type: 'date' },
                    { id: 'fld_sddcls', key: 'closed_on', name: 'Closed', type: 'date' },
                ],
                indexes: [{ fields: ['stage', 'closed_on'] }],
                access: { default: 'app' },
            },
        ],
        roles: [],
        roleMapping: { default: 'app', byGroup: {} },
    },
    seed: {
        tbl_sdacct: [
            { $id: 'a1', name: 'Northwind Group', region: 'north', segment: 'enterprise' },
            { $id: 'a2', name: 'Northwind Logistics', parent: { $ref: 'a1' }, region: 'north', segment: 'enterprise' },
            { $id: 'a3', name: 'Northwind Retail', parent: { $ref: 'a1' }, region: 'west', segment: 'mid' },
            { $id: 'a4', name: 'Bluebird Holdings', region: 'south', segment: 'enterprise' },
            { $id: 'a5', name: 'Bluebird Studios', parent: { $ref: 'a4' }, region: 'south', segment: 'mid' },
            { $id: 'a6', name: 'Cedar & Co', region: 'east', segment: 'small' },
            { $id: 'a7', name: 'Lighthouse Labs', region: 'west', segment: 'mid' },
            { $id: 'a8', name: 'Orchard Foods', region: 'east', segment: 'small' },
        ],
        [DEALS]: [
            { title: 'Fleet tracking rollout', account: { $ref: 'a2' }, stage: 'won', amount: 84000, probability: 100, owner_name: 'Alex Morgan', opened_on: '2026-06-02', closed_on: '2026-09-12' },
            { title: 'Store analytics pilot', account: { $ref: 'a3' }, stage: 'won', amount: 26000, probability: 100, owner_name: 'Sam Rivera', opened_on: '2026-07-14', closed_on: '2026-10-03' },
            { title: 'Studio licences', account: { $ref: 'a5' }, stage: 'won', amount: 18500, probability: 100, owner_name: 'Jamie Chen', opened_on: '2026-08-20', closed_on: '2026-10-28' },
            { title: 'Group-wide renewal', account: { $ref: 'a1' }, stage: 'won', amount: 120000, probability: 100, owner_name: 'Alex Morgan', opened_on: '2026-05-11', closed_on: '2026-08-21' },
            { title: 'Warehouse sensors', account: { $ref: 'a2' }, stage: 'negotiation', amount: 42000, probability: 70, owner_name: 'Alex Morgan', opened_on: '2026-09-30' },
            { title: 'Holding dashboard', account: { $ref: 'a4' }, stage: 'proposal', amount: 56000, probability: 50, owner_name: 'Robin Patel', opened_on: '2026-10-06' },
            { title: 'Lab data platform', account: { $ref: 'a7' }, stage: 'qualified', amount: 33000, probability: 30, owner_name: 'Sam Rivera', opened_on: '2026-10-19' },
            { title: 'Shop till upgrade', account: { $ref: 'a6' }, stage: 'lead', amount: 7800, probability: 10, owner_name: 'Jamie Chen', opened_on: '2026-11-02' },
            { title: 'Seasonal campaign', account: { $ref: 'a8' }, stage: 'proposal', amount: 12500, probability: 45, owner_name: 'Robin Patel', opened_on: '2026-10-22' },
            { title: 'Retail loyalty app', account: { $ref: 'a3' }, stage: 'lost', amount: 39000, probability: 0, owner_name: 'Sam Rivera', opened_on: '2026-06-18', closed_on: '2026-09-25' },
            { title: 'Orchard ordering portal', account: { $ref: 'a8' }, stage: 'won', amount: 14200, probability: 100, owner_name: 'Jamie Chen', opened_on: '2026-08-04', closed_on: '2026-11-04' },
            { title: 'Lab equipment leasing', account: { $ref: 'a7' }, stage: 'negotiation', amount: 61000, probability: 65, owner_name: 'Robin Patel', opened_on: '2026-09-15' },
        ],
    },
    // Installed as a saved dataset the owner can bind or open in the dataset
    // builder: won revenue per month from a date, both given as parameters.
    datasets: [
        {
            id: 'ds_sdmonthly', name: 'Won revenue per month', tableId: DEALS,
            source: { kind: 'aggregate' },
            descriptor: {
                params: [
                    { name: 'since', type: 'date', default: '2026-01-01' },
                    { name: 'stage', type: 'text', default: 'won' },
                ],
                groupBy: [{ field: 'closed_on', bucket: 'month', as: 'month' }],
                aggregates: [{ fn: 'sum', field: 'amount', as: 'revenue' }, { fn: 'count', as: 'deals' }],
                filters: [
                    { field: 'stage', op: 'eq', value: { param: 'stage' } },
                    { field: 'closed_on', op: 'gte', value: { param: 'since' } },
                ],
            },
        },
    ],
    definition: {
        schemaVersion: 3,
        meta: { name: 'Sales dashboard', description: 'Revenue, pipeline and accounts at a glance.', icon: 'BarChart3' },
        theme: { primary: '#2563EB', ...THEME_DEFAULTS, radius: 'lg' },
        design: {
            preset: 'custom', font: 'geist', surface: 'soft', motion: 'subtle', chartPalette: 'brand', accentEdge: 'bar', logoUrl: null,
            tokens: { win: '#16A34A', 'win-soft': '#DCFCE7', pipeline: '#2563EB', wall: '#0B1220', gutter: 24 },
            dark: { primary: '#60A5FA', canvas: '#0B1220' },
        },
        format: { language: 'en-GB', currency: 'EUR', currencyDecimals: 0, dateFormat: 'd MMM yyyy', timeZone: 'Europe/Amsterdam' },
        homeScreenId: 'scr_sdover',
        roles: [],
        variables: [
            { name: 'period', label: 'Period', type: 'text', default: '90', description: 'Days back the dashboard looks, kept per viewer', persist: 'local' },
            { name: 'periodStart', label: 'Period start', type: 'date', default: '', description: 'The first day of the period', derived: { expr: "dateAdd(today, 0 - number(vars.period), 'day')" } },
            { name: 'periodLabel', label: 'Period label', type: 'text', default: '', description: '', derived: { expr: "'since ' + formatDate(vars.periodStart, 'DD-MM-YYYY')" } },
            { name: 'accountId', label: 'Picked account', type: 'text', default: '', description: 'The account the tree has selected', scope: 'screen' },
        ],
        screens: [
            {
                id: 'scr_sdover', name: 'Overview', icon: 'LayoutDashboard', showInNav: true, maxWidth: 'wide',
                sections: [
                    {
                        id: 'sec_sdhead', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            {
                                id: 'cmp_sdph', type: 'page_header',
                                props: { title: 'Sales', subtitle: 'Revenue, pipeline and wins for the period you pick.', subtitleFrom: { kind: 'formula', expr: "'Revenue, pipeline and wins ' + vars.periodLabel + '.'" }, icon: 'BarChart3', showDivider: false },
                                style: { span: 8, spanMd: 12 },
                            },
                            {
                                id: 'cmp_sdpfrm', type: 'form',
                                props: { name: 'period', showSubmit: false, showReset: false },
                                style: { span: 4, spanMd: 12, gap: 2, padding: 0 },
                                children: [
                                    {
                                        id: 'cmp_sdpsel', type: 'input_select',
                                        props: { name: 'period', label: 'Period', options: PERIODS, defaultValue: '90', valueFrom: { kind: 'formula', expr: 'vars.period' } },
                                        style: { span: 12 },
                                        onChange: 'act_sdperiod',
                                    },
                                ],
                            },
                        ],
                    },
                    {
                        id: 'sec_sdkpi', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            stat('cmp_sdwon', 'Won revenue', 'Trophy', total([WON, IN_PERIOD], 'sum', 'amount'), {
                                props: { formatOptions: { compact: true }, captionSegments: [{ text: 'closed in the period', tone: 'muted' }] },
                                style: { borderColor: 'token:win', borderSides: 'left', borderWidth: 3 },
                            }),
                            stat('cmp_sdpipe', 'Open pipeline', 'Layers', total(OPEN, 'sum', 'amount'), {
                                props: { formatOptions: { compact: true } },
                                style: { borderColor: 'token:pipeline', borderSides: 'left', borderWidth: 3 },
                            }),
                            stat('cmp_sdcnt', 'Deals won', 'Handshake', total([WON, IN_PERIOD], 'count')),
                            stat('cmp_sdavg', 'Average won deal', 'Scale', total([WON, IN_PERIOD], 'avg', 'amount'), {
                                props: { formatOptions: { currency: 'EUR', decimals: 0 } },
                            }),
                        ],
                    },
                    {
                        id: 'sec_sdcharts', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            {
                                id: 'cmp_sdcombo', type: 'chart',
                                props: {
                                    chartType: 'combo',
                                    title: 'Won revenue and deals per month',
                                    source: {
                                        kind: 'aggregate', tableId: DEALS, filter: [WON, IN_PERIOD],
                                        groupBy: [{ field: 'closed_on', bucket: 'month', as: 'month' }],
                                        aggregates: [{ fn: 'sum', field: 'amount', as: 'revenue' }, { fn: 'count', as: 'deals' }],
                                        sort: [{ field: 'month', dir: 'asc' }],
                                    },
                                    xKey: 'month',
                                    series: [
                                        { key: 'revenue', label: 'Revenue', type: 'bar' },
                                        { key: 'deals', label: 'Deals', type: 'line', yAxis: 'right' },
                                    ],
                                    valueFormat: 'currency',
                                    formatOptions: { compact: true },
                                },
                                style: { span: 8, spanMd: 12, height: 'lg' },
                            },
                            {
                                id: 'cmp_sdgauge', type: 'gauge',
                                props: {
                                    label: 'Pipeline confidence',
                                    value: total(OPEN, 'avg', 'probability'),
                                    min: 0, max: 100, unit: '%',
                                    thresholds: [
                                        { from: 0, tone: 'danger', label: 'Thin' },
                                        { from: 35, tone: 'warning', label: 'Fair' },
                                        { from: 60, tone: 'success', label: 'Strong' },
                                    ],
                                },
                                style: { span: 4, spanMd: 12 },
                                tooltip: 'The average probability of the open deals.',
                            },
                            {
                                id: 'cmp_sdfunnel', type: 'chart',
                                props: { chartType: 'funnel', title: 'Deals per stage', source: STAGE_COUNTS, xKey: 'stage', series: [{ key: 'deals', label: 'Deals' }] },
                                style: { span: 6, spanMd: 12, height: 'md' },
                            },
                            {
                                id: 'cmp_sdtopgrd', type: 'table',
                                props: {
                                    source: { kind: 'records', tableId: DEALS, filter: OPEN, sort: [{ field: 'amount', dir: 'desc' }], limit: 6, fields: ['title', 'account_name', 'stage', 'amount', 'probability'] },
                                    columns: [
                                        { key: 'title', label: 'Biggest open deals', format: 'text' },
                                        { key: 'account_name', label: 'Account', format: 'text' },
                                        { key: 'stage', label: 'Stage', format: 'badge', toneMap: STAGE_TONES },
                                        { key: 'amount', label: 'Amount', format: 'currency', align: 'right', formatOptions: { compact: true } },
                                        { key: 'probability', label: 'Chance', format: 'percent', align: 'right', cellStyle: [{ when: 'value >= 60', style: { color: 'token:win', weight: 'semibold' } }] },
                                    ],
                                    look: 'minimal',
                                },
                                style: { span: 6, spanMd: 12 },
                            },
                        ],
                    },
                ],
            },
            {
                // The screen for the big monitor in the office: dark, whatever the
                // app's own appearance, in the colours of the wall.
                id: 'scr_sdwall', name: 'Pipeline wall', icon: 'MonitorPlay', showInNav: true, maxWidth: 'full',
                theme: { appearance: 'dark', primary: '#38BDF8', canvas: '#0B1220', fontScale: 'lg' },
                refreshInterval: 300,
                sections: [
                    {
                        id: 'sec_sdwall', style: { padding: 6, gap: 4, background: 'none' },
                        children: [
                            { id: 'cmp_sdwh', type: 'heading', props: { text: 'Pipeline', level: 1, accent: 'tinted' }, style: { span: 12, textSize: '3xl', tracking: 'tight' } },
                            stat('cmp_sdwpipe', 'Open pipeline', 'Layers', total(OPEN, 'sum', 'amount'), { props: { look: 'gradient', formatOptions: { compact: true } }, style: { span: 4, spanMd: 12 } }),
                            stat('cmp_sdwopen', 'Open deals', 'ListChecks', total(OPEN, 'count'), { props: { look: 'plain' }, style: { span: 4, spanMd: 6 } }),
                            stat('cmp_sdwwon', 'Won this period', 'Trophy', total([WON, IN_PERIOD], 'sum', 'amount'), { props: { look: 'plain', formatOptions: { compact: true } }, style: { span: 4, spanMd: 6, color: 'success' } }),
                            {
                                id: 'cmp_sdradar', type: 'chart',
                                props: {
                                    chartType: 'radar', title: 'Deals and accounts per region', source: REGION_COUNTS, xKey: 'region',
                                    series: [{ key: 'deals', label: 'Deals' }, { key: 'accounts', label: 'Accounts' }],
                                },
                                style: { span: 6, spanMd: 12, height: 'lg' },
                            },
                            {
                                id: 'cmp_sdwfun', type: 'chart',
                                props: { chartType: 'funnel', title: 'Where the deals are', source: STAGE_COUNTS, xKey: 'stage', series: [{ key: 'deals', label: 'Deals' }], showLegend: false },
                                style: { span: 6, spanMd: 12, height: 'lg' },
                            },
                        ],
                    },
                ],
            },
            {
                id: 'scr_sdacct', name: 'Accounts', icon: 'Network', showInNav: true, maxWidth: 'wide',
                sections: [
                    {
                        id: 'sec_sdacct', style: { padding: 4, gap: 4, background: 'none' },
                        children: [
                            { id: 'cmp_sdah', type: 'heading', props: { text: 'Accounts', level: 1, accent: 'bar' }, style: { span: 12 } },
                            {
                                id: 'cmp_sdtree', type: 'tree',
                                props: {
                                    source: { kind: 'records', tableId: 'tbl_sdacct', sort: [{ field: 'name', dir: 'asc' }] },
                                    idKey: 'id', parentKey: 'parent', titleKey: 'name', subtitleKey: 'segment', icon: 'Building2',
                                    maxDepth: 4, emptyText: 'No accounts yet.',
                                },
                                style: { span: 4, spanMd: 12 },
                                onRowClick: 'act_sdpick',
                            },
                            {
                                id: 'cmp_sdacpane', type: 'container', props: { look: 'plain' },
                                style: { span: 8, spanMd: 12, gap: 3 },
                                children: [
                                    {
                                        id: 'cmp_sdacdet', type: 'record_detail',
                                        props: {
                                            source: { kind: 'record', tableId: 'tbl_sdacct', filter: [{ field: 'id', op: 'eq', value: { kind: 'formula', expr: 'vars.accountId' } }] },
                                            fields: [
                                                { key: 'name', label: 'Account', format: 'text' },
                                                { key: 'region', label: 'Region', format: 'badge' },
                                                { key: 'segment', label: 'Segment', format: 'badge' },
                                                { key: 'won_total', label: 'Won so far', format: 'number' },
                                                { key: 'deal_count', label: 'Deals', format: 'number' },
                                            ],
                                            columns: 3,
                                            emptyText: 'Pick an account in the tree.',
                                        },
                                        style: { span: 12 },
                                    },
                                    {
                                        id: 'cmp_sdacgrd', type: 'data_grid',
                                        props: {
                                            source: { kind: 'records', tableId: DEALS, filter: [{ field: 'account', op: 'eq', value: { kind: 'formula', expr: 'vars.accountId' } }], sort: [{ field: 'opened_on', dir: 'desc' }] },
                                            columns: [
                                                { key: 'title', label: 'Deal', format: 'text' },
                                                { key: 'stage', label: 'Stage', format: 'badge', toneMap: STAGE_TONES },
                                                { key: 'amount', label: 'Amount', format: 'currency', align: 'right' },
                                                { key: 'owner_name', label: 'Owner', format: 'text' },
                                                { key: 'closed_on', label: 'Closed', format: 'date', formatOptions: { pattern: 'MMM yyyy' } },
                                            ],
                                            look: 'minimal',
                                            emptyText: 'No deals for this account.',
                                        },
                                        style: { span: 12 },
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
        ],
        actions: {
            act_sdperiod: {
                kind: 'sequence',
                steps: [{ kind: 'set_variable', name: 'period', value: { kind: 'formula', expr: "form.period ?? '90'" } }],
            },
            act_sdpick: {
                kind: 'sequence',
                steps: [{ kind: 'set_variable', name: 'accountId', value: { kind: 'formula', expr: 'item.id' } }],
            },
        },
    },
};
