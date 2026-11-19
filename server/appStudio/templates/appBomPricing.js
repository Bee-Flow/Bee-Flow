// @typecheck strict
/**
 * App Studio template — Bill of materials pricing: someone uploads a bill
 * of materials (an Excel or CSV list with per line a quantity, a unit and the
 * supplier's article number and/or the GTIN), picks the supplier (its GLN) and
 * optionally a project number, and gets the same list back with the NET unit
 * price, the line total excluding VAT, the price date, the condition that gave
 * the price and the lines to check, as a calculation with its lines and an
 * Excel download. Every calculation records which condition file upload was in
 * use. A second screen uploads a supplier's condition file and keeps the
 * history of the uploads.
 *
 * Entry of the gallery in ../templates.js, which documents the template shape.
 *
 * ── TWO AUTOMATIONS TO CONNECT (left unset, like every template) ──────────
 * The prices come from the 2BA integration (the connection of the automation's
 * owner), and reading an uploaded spreadsheet is an automation step, so the
 * two actions that need them run an automation with an app trigger:
 *
 *   1. Price the list (act_bpprice): app trigger with the params
 *      bom (file), supplierGln (text), projectNumber (text). Steps:
 *      read_table on trigger.output.bom → table (rename the list's columns to
 *      ref, quantity, unit, tradeItemId, gtin) → twoba_find_trade_items with
 *      items = steps.<table>.output.rows (or a Loop over
 *      steps.<table>.output.table with batchSize 200, the tool's TWOBA_MAX_ITEMS,
 *      for a longer list) → a last `set` step whose output has `items`: the
 *      tool's priced lines (for a Loop:
 *      steps.<loop>.output.results[*].output.items).
 *      The app reads vars.priced.output.items: per line ref, articleNumber,
 *      input { tradeItemId, gtin, quantity, unit }, description, unitNetPrice,
 *      lineTotalExVat, currency, priceDate, conditionId, scenarioName,
 *      termsType, status, flags, review.
 *   2. Upload a condition file (act_bpupload): app trigger with the params
 *      file (file), databaseId (number), process (text), whose last step is
 *      twoba_upload_conditions with sourceHandle = trigger.output.file. The
 *      app reads vars.imported.output: ok, filename, sha256, uploadedAt,
 *      files, importResult.
 *
 * At most 200 lines per calculation are recorded (the action loop's ceiling,
 * LIMITS.MAX_ACTION_LOOP_ITERATIONS). The tables use access.default 'app':
 * everybody who may use the app sees every calculation, as a pricing desk does.
 */

'use strict';

const { THEME_DEFAULTS } = require('./themeDefaults');

const f = (/** @type {string} */ expr) => ({ kind: 'formula', expr });
const S = { padding: 4, gap: 3, background: 'none' };

/** The priced lines the pricing automation returned. */
const ITEMS = 'vars.priced.output.items';
/** How many of the priced lines satisfy `test` (a formula over `it`). */
const countWhere = (/** @type {string} */ test) => f(`reduce(${ITEMS}, acc + (${test} ? 1 : 0), 0)`);

const LINE_STATUS = [
    { value: 'matched', label: 'Matched' },
    { value: 'not_found', label: 'Not found' },
    { value: 'multiple', label: 'Several articles' },
    { value: 'code_mismatch', label: 'Codes disagree' },
];
const PROCESS_MODES = [
    { value: 'DoNotProcess', label: 'Import only (check it in 2BA first)' },
    { value: 'ProcessIfAllOk', label: 'Activate when no row failed' },
    { value: 'ProcessAlways', label: 'Activate, skipping failed rows' },
];

// The columns of the Excel download, in the order of the list that was sent.
const DOWNLOAD_COLUMNS = [
    ['Pos', 'ref'], ['Article no.', 'article_number'], ['GTIN', 'gtin'], ['Description', 'description'],
    ['Quantity', 'quantity'], ['Unit', 'unit'], ['Net unit price', 'unit_net_price'], ['Line total excl. VAT', 'line_total'],
    ['Currency', 'currency'], ['Price date', 'price_date'], ['Condition', 'condition_id'], ['Price basis', 'price_basis'],
    ['Status', 'status'], ['To check', 'review'],
].map(([name, from]) => ({ name, from }));

const dataModel = {
    modelVersion: 1,
    tables: [
        {
            id: 'tbl_bpcond', key: 'condition_uploads', name: 'Condition uploads', icon: 'FileUp',
            fields: [
                { id: 'fld_bpdfile', key: 'file', name: 'Condition file', type: 'file' },
                { id: 'fld_bpdname', key: 'filename', name: 'File name', type: 'text', required: true },
                { id: 'fld_bpddb', key: 'database_id', name: 'Condition database', type: 'number', subtype: 'integer' },
                { id: 'fld_bpdproc', key: 'process', name: 'Processing', type: 'select', options: PROCESS_MODES },
                { id: 'fld_bpdsha', key: 'sha256', name: 'SHA-256', type: 'text' },
                { id: 'fld_bpdimp', key: 'import_id', name: 'Import id', type: 'text' },
                { id: 'fld_bpdrows', key: 'rows_total', name: 'Rows', type: 'number', subtype: 'integer' },
                { id: 'fld_bpdfail', key: 'rows_failed', name: 'Rows failed', type: 'number', subtype: 'integer' },
                { id: 'fld_bpdat', key: 'uploaded_at', name: 'Uploaded', type: 'datetime' },
                { id: 'fld_bpdok', key: 'ok', name: 'Imported', type: 'bool' },
            ],
            access: { default: 'app' },
        },
        {
            id: 'tbl_bpcalc', key: 'calculations', name: 'Calculations', icon: 'Calculator',
            fields: [
                { id: 'fld_bpcname', key: 'name', name: 'Calculation', type: 'text', required: true },
                { id: 'fld_bpcgln', key: 'supplier_gln', name: 'Supplier GLN', type: 'text', required: true },
                { id: 'fld_bpcproj', key: 'project_number', name: 'Project number', type: 'text' },
                { id: 'fld_bpccond', key: 'condition_upload', name: 'Condition upload', type: 'relation', relation: { table: 'tbl_bpcond' } },
                { id: 'fld_bpcbom', key: 'bom_file', name: 'Bill of materials', type: 'file' },
                { id: 'fld_bpcout', key: 'result_file', name: 'Priced list', type: 'file' },
                { id: 'fld_bpcat', key: 'priced_at', name: 'Priced', type: 'datetime' },
                { id: 'fld_bpcby', key: 'priced_by', name: 'Priced by', type: 'text' },
                { id: 'fld_bpctot', key: 'total_ex_vat', name: 'Total excl. VAT', type: 'number' },
                { id: 'fld_bpclin', key: 'line_count', name: 'Lines', type: 'number', subtype: 'integer' },
                { id: 'fld_bpcpri', key: 'priced_lines', name: 'Priced lines', type: 'number', subtype: 'integer' },
                { id: 'fld_bpcchk', key: 'lines_to_check', name: 'Lines to check', type: 'number', subtype: 'integer' },
                { id: 'fld_bpcnf', key: 'not_found', name: 'Not found', type: 'number', subtype: 'integer' },
                { id: 'fld_bpcamb', key: 'ambiguous', name: 'Several articles or codes disagree', type: 'number', subtype: 'integer' },
                { id: 'fld_bpcunit', key: 'unit_check', name: 'Unit to check', type: 'number', subtype: 'integer' },
                { id: 'fld_bpcnop', key: 'no_net_price', name: 'No net price', type: 'number', subtype: 'integer' },
                { id: 'fld_bpcrun', key: 'run_id', name: 'Automation run', type: 'text' },
            ],
            access: { default: 'app' },
        },
        {
            id: 'tbl_bpline', key: 'calculation_lines', name: 'Calculation lines', icon: 'ListOrdered',
            fields: [
                { id: 'fld_bplcalc', key: 'calculation', name: 'Calculation', type: 'relation', relation: { table: 'tbl_bpcalc' } },
                { id: 'fld_bplref', key: 'ref', name: 'Pos', type: 'text' },
                { id: 'fld_bplart', key: 'article_number', name: 'Article no.', type: 'text' },
                { id: 'fld_bplgtin', key: 'gtin', name: 'GTIN', type: 'text' },
                { id: 'fld_bpldesc', key: 'description', name: 'Description', type: 'text' },
                { id: 'fld_bplqty', key: 'quantity', name: 'Quantity', type: 'number' },
                { id: 'fld_bplunit', key: 'unit', name: 'Unit', type: 'text' },
                { id: 'fld_bplnet', key: 'unit_net_price', name: 'Net unit price', type: 'number' },
                { id: 'fld_bpltot', key: 'line_total', name: 'Line total excl. VAT', type: 'number' },
                { id: 'fld_bplcur', key: 'currency', name: 'Currency', type: 'text' },
                { id: 'fld_bpldate', key: 'price_date', name: 'Price date', type: 'text' },
                { id: 'fld_bplcond', key: 'condition_id', name: 'Condition', type: 'text' },
                { id: 'fld_bplbase', key: 'price_basis', name: 'Price basis', type: 'text' },
                { id: 'fld_bplstat', key: 'status', name: 'Status', type: 'select', options: LINE_STATUS },
                { id: 'fld_bplrev', key: 'review', name: 'To check', type: 'text' },
                { id: 'fld_bplchk', key: 'needs_check', name: 'Needs a look', type: 'bool' },
            ],
            access: { default: 'app' },
        },
    ],
    roles: [],
    roleMapping: { default: 'app', byGroup: {} },
};

// Made-up demo rows: a GLN and GTINs with valid check digits that belong to nobody.
const seed = {
    tbl_bpcond: [
        { $id: 'cond1', filename: 'conditions-2026-11.icc', database_id: 3, process: 'ProcessIfAllOk', sha256: '5d41402abc4b2a76b9719d911017c592ae7f1b1e5f3b8a0c9d2e4f6a8b0c1d2e', import_id: '77', rows_total: 1840, rows_failed: 0, uploaded_at: '2026-11-02T09:15:00.000Z', ok: true },
    ],
    tbl_bpcalc: [
        {
            $id: 'calc1', name: 'P-2026-17 kitchen renovation', supplier_gln: '8712345000004', project_number: 'P-2026-17', condition_upload: { $ref: 'cond1' },
            priced_at: '2026-11-03T10:00:00.000Z', priced_by: 'Demo user', total_ex_vat: 101.4, line_count: 4, priced_lines: 3, lines_to_check: 1,
            not_found: 1, ambiguous: 0, unit_check: 0, no_net_price: 0,
        },
    ],
    tbl_bpline: [
        { calculation: { $ref: 'calc1' }, ref: '1', article_number: 'WCD-1', gtin: '8712345678913', description: 'Wall socket, single', quantity: 12, unit: 'st', unit_net_price: 3.25, line_total: 39, currency: 'EUR', price_date: '2026-11-03', condition_id: '9002', price_basis: 'DiscountArticlePercentage', status: 'matched', needs_check: false },
        { calculation: { $ref: 'calc1' }, ref: '2', article_number: 'SCH-2', gtin: '8712345678920', description: 'Two-way switch', quantity: 5, unit: 'st', unit_net_price: 6.4, line_total: 32, currency: 'EUR', price_date: '2026-11-03', condition_id: '9003', price_basis: 'NetPrice', status: 'matched', needs_check: false },
        { calculation: { $ref: 'calc1' }, ref: '3', article_number: 'KAB-3X25', gtin: '8712345678937', description: 'Installation cable 3x2.5 mm2', quantity: 30, unit: 'm', unit_net_price: 0.98, line_total: 29.4, currency: 'EUR', price_date: '2026-11-03', condition_id: '9001', price_basis: 'DiscountGroupPercentage', status: 'matched', needs_check: false },
        { calculation: { $ref: 'calc1' }, ref: '4', article_number: 'NOPE-9', quantity: 1, unit: 'st', status: 'not_found', review: 'not_found', needs_check: true },
    ],
};

const lineGridColumns = [
    { key: 'ref', label: 'Pos', format: 'text' },
    { key: 'article_number', label: 'Article no.', format: 'text' },
    { key: 'description', label: 'Description', format: 'text' },
    { key: 'quantity', label: 'Qty', format: 'number' },
    { key: 'unit', label: 'Unit', format: 'text' },
    { key: 'unit_net_price', label: 'Net unit price', format: 'number' },
    { key: 'line_total', label: 'Line total', format: 'number' },
    { key: 'status', label: 'Status', format: 'badge' },
    { key: 'review', label: 'To check', format: 'text' },
];

const screens = [
    {
        id: 'scr_bpprice', name: 'Price a list', icon: 'Calculator', showInNav: true, maxWidth: 'narrow',
        sections: [{
            id: 'sec_bpprice', style: S,
            children: [
                { id: 'cmp_bph1', type: 'heading', props: { text: 'Price a bill of materials', level: 1 }, style: { span: 12 } },
                { id: 'cmp_bpintro', type: 'text', props: { text: 'Upload the list as Excel or CSV: per line a quantity, a unit and the supplier\'s article number and/or the GTIN. The net prices come from the condition files of your 2BA account.', muted: true }, style: { span: 12 } },
                {
                    id: 'cmp_bpform', type: 'form',
                    props: { name: 'bom', submitLabel: 'Price the list', showReset: false },
                    style: { span: 12, gap: 3, padding: 0 },
                    onSubmit: 'act_bpprice',
                    children: [
                        { id: 'cmp_bpfile', type: 'input_file', props: { name: 'bom', label: 'Bill of materials', accept: '.xlsx,.xls,.ods,.csv', multiple: false, required: true, buttonLabel: 'Choose the list' }, style: { span: 12 } },
                        { id: 'cmp_bpgln', type: 'input_text', props: { name: 'supplier_gln', label: 'Supplier GLN (13 digits)', required: true }, style: { span: 6 } },
                        { id: 'cmp_bpproj', type: 'input_text', props: { name: 'project_number', label: 'Project number (optional)' }, style: { span: 6 } },
                        { id: 'cmp_bpcond', type: 'input_relation', props: { name: 'condition_upload', label: 'Condition file in use', tableId: 'tbl_bpcond', displayField: 'filename', multiple: false, required: false }, style: { span: 12 } },
                    ],
                },
            ],
        }],
    },
    {
        id: 'scr_bpcalcs', name: 'Calculations', icon: 'History', showInNav: true, maxWidth: 'wide',
        sections: [{
            id: 'sec_bpcalcs', style: S,
            children: [
                { id: 'cmp_bph2', type: 'heading', props: { text: 'Calculations', level: 1 }, style: { span: 12 } },
                {
                    id: 'cmp_bpcgrid', type: 'data_grid',
                    props: {
                        source: { kind: 'records', tableId: 'tbl_bpcalc', sort: [{ field: 'priced_at', dir: 'desc' }] },
                        columns: [
                            { key: 'name', label: 'Calculation', format: 'text' },
                            { key: 'supplier_gln', label: 'Supplier GLN', format: 'text' },
                            { key: 'priced_at', label: 'Priced', format: 'date' },
                            { key: 'total_ex_vat', label: 'Total excl. VAT', format: 'number' },
                            { key: 'line_count', label: 'Lines', format: 'number' },
                            { key: 'lines_to_check', label: 'To check', format: 'number' },
                        ],
                        searchable: true,
                        emptyText: 'No calculations yet. Price a list first.',
                    },
                    style: { span: 12 },
                    onRowClick: 'act_bpopen',
                },
            ],
        }],
    },
    {
        id: 'scr_bpcalc', name: 'Calculation', icon: 'Calculator', showInNav: false, maxWidth: 'wide',
        sections: [{
            id: 'sec_bpcalc', style: S,
            children: [
                { id: 'cmp_bpback', type: 'button', props: { label: 'Back to calculations', variant: 'ghost', iconLeft: 'ArrowLeft' }, style: { span: 4 }, onClick: 'act_bpback' },
                { id: 'cmp_bpdl', type: 'button', props: { label: 'Download as Excel', variant: 'secondary', iconLeft: 'Download' }, style: { span: 4 }, onClick: 'act_bpdl' },
                {
                    id: 'cmp_bpcrd', type: 'record_detail',
                    props: {
                        source: { kind: 'record', tableId: 'tbl_bpcalc', filter: [{ field: 'id', op: 'eq', value: f('screen.params.id') }] },
                        fields: [
                            { key: 'name', label: 'Calculation', format: 'text' },
                            { key: 'supplier_gln', label: 'Supplier GLN', format: 'text' },
                            { key: 'project_number', label: 'Project number', format: 'text' },
                            { key: 'priced_at', label: 'Priced', format: 'datetime' },
                            { key: 'priced_by', label: 'Priced by', format: 'text' },
                            { key: 'total_ex_vat', label: 'Total excl. VAT', format: 'number' },
                            { key: 'line_count', label: 'Lines', format: 'number' },
                            { key: 'lines_to_check', label: 'Lines to check', format: 'number' },
                            { key: 'not_found', label: 'Not found', format: 'number' },
                            { key: 'ambiguous', label: 'Several articles or codes disagree', format: 'number' },
                            { key: 'unit_check', label: 'Unit to check', format: 'number' },
                            { key: 'no_net_price', label: 'No net price', format: 'number' },
                        ],
                        columns: 2,
                    },
                    style: { span: 12 },
                },
                { id: 'cmp_bph3', type: 'heading', props: { text: 'Lines, the ones to check first', level: 2 }, style: { span: 12 } },
                {
                    id: 'cmp_bplgrid', type: 'data_grid',
                    props: {
                        source: {
                            kind: 'records', tableId: 'tbl_bpline',
                            filter: [{ field: 'calculation', op: 'eq', value: f('screen.params.id'), required: true }],
                            sort: [{ field: 'needs_check', dir: 'desc' }, { field: 'ref', dir: 'asc' }],
                        },
                        columns: lineGridColumns,
                        searchable: true,
                        emptyText: 'This calculation has no lines.',
                    },
                    style: { span: 12 },
                },
            ],
        }],
    },
    {
        id: 'scr_bpconds', name: 'Condition files', icon: 'FileUp', showInNav: true, maxWidth: 'medium',
        sections: [{
            id: 'sec_bpconds', style: S,
            children: [
                { id: 'cmp_bph4', type: 'heading', props: { text: 'Condition files', level: 1 }, style: { span: 12 } },
                { id: 'cmp_bpcintro', type: 'text', props: { text: 'Upload the condition file a supplier sent you (ICC as .txt or .icc, or INSBOU/DICO as .xml) into your 2BA Online Condition Server. Every calculation records which upload was in use.', muted: true }, style: { span: 12 } },
                {
                    id: 'cmp_bpuform', type: 'form',
                    props: { name: 'conditions', submitLabel: 'Upload', showReset: false },
                    style: { span: 12, gap: 3, padding: 0 },
                    onSubmit: 'act_bpupload',
                    children: [
                        { id: 'cmp_bpufile', type: 'input_file', props: { name: 'file', label: 'Condition file', accept: '.icc,.txt,.xml', multiple: false, required: true, buttonLabel: 'Choose the file' }, style: { span: 12 } },
                        { id: 'cmp_bpudb', type: 'input_number', props: { name: 'database_id', label: 'Condition database id', required: true }, style: { span: 6 } },
                        { id: 'cmp_bpuproc', type: 'input_select', props: { name: 'process', label: 'After the import', options: PROCESS_MODES, defaultValue: 'DoNotProcess' }, style: { span: 6 } },
                    ],
                },
                {
                    id: 'cmp_bpugrid', type: 'data_grid',
                    props: {
                        source: { kind: 'records', tableId: 'tbl_bpcond', sort: [{ field: 'uploaded_at', dir: 'desc' }] },
                        columns: [
                            { key: 'filename', label: 'File', format: 'text' },
                            { key: 'uploaded_at', label: 'Uploaded', format: 'date' },
                            { key: 'ok', label: 'Imported', format: 'boolean' },
                            { key: 'rows_total', label: 'Rows', format: 'number' },
                            { key: 'rows_failed', label: 'Failed', format: 'number' },
                            { key: 'import_id', label: 'Import id', format: 'text' },
                        ],
                        emptyText: 'No condition file uploaded yet.',
                    },
                    style: { span: 12 },
                },
            ],
        }],
    },
];

/** One priced line of the automation's answer as a calculation line. */
const lineValues = {
    calculation: f('vars.calc.id'),
    ref: f('vars.line.ref'),
    article_number: f('default(vars.line.articleNumber, vars.line.input.tradeItemId)'),
    gtin: f('vars.line.input.gtin'),
    description: f('vars.line.description'),
    quantity: f('vars.line.quantity'),
    unit: f('vars.line.input.unit'),
    unit_net_price: f('vars.line.unitNetPrice'),
    line_total: f('vars.line.lineTotalExVat'),
    currency: f('vars.line.currency'),
    price_date: f('vars.line.priceDate'),
    condition_id: f('vars.line.conditionId'),
    price_basis: f('vars.line.scenarioName'),
    status: f('vars.line.status'),
    review: f('vars.line.review'),
    needs_check: f('!isEmpty(vars.line.review)'),
};

const actions = {
    act_bpprice: {
        kind: 'sequence',
        steps: [
            {
                kind: 'run_automation', automationId: null, resultVar: 'priced',
                inputMapping: {
                    bom: { kind: 'field', name: 'bom' },
                    supplierGln: { kind: 'field', name: 'supplier_gln' },
                    projectNumber: { kind: 'field', name: 'project_number' },
                },
            },
            {
                kind: 'create_record', tableId: 'tbl_bpcalc', resultVar: 'calc',
                values: {
                    name: f("default(form.project_number, 'Calculation') + ' · ' + formatDate(now, 'yyyy-MM-dd HH:mm')"),
                    supplier_gln: f('form.supplier_gln'),
                    project_number: f('form.project_number'),
                    condition_upload: f('form.condition_upload'),
                    bom_file: f('form.bom'),
                    priced_at: f('now'),
                    priced_by: f('currentUser.name'),
                    total_ex_vat: f(`round(sum(${ITEMS}, 'lineTotalExVat'), 2)`),
                    line_count: f(`count(${ITEMS})`),
                    priced_lines: countWhere('it.lineTotalExVat != null'),
                    lines_to_check: countWhere('!isEmpty(it.review)'),
                    not_found: countWhere("it.status == 'not_found'"),
                    ambiguous: countWhere("it.status == 'multiple' || it.status == 'code_mismatch'"),
                    unit_check: countWhere("includes(it.flags, 'unit_unknown') || includes(it.flags, 'unit_mismatch')"),
                    no_net_price: countWhere("includes(it.flags, 'no_price') || includes(it.flags, 'on_request') || includes(it.flags, 'price_on_request') || includes(it.flags, 'gross_only_no_condition')"),
                    run_id: f('vars.priced.runId'),
                },
            },
            {
                kind: 'loop', source: f(ITEMS), itemVar: 'line', maxIterations: 200,
                steps: [{ kind: 'create_record', tableId: 'tbl_bpline', values: lineValues }],
            },
            {
                kind: 'generate_file',
                rows: {
                    kind: 'records', tableId: 'tbl_bpline',
                    filter: [{ field: 'calculation', op: 'eq', value: f('vars.calc.id'), required: true }],
                    sort: [{ field: 'ref', dir: 'asc' }],
                    limit: 200,
                },
                columns: { kind: 'static', value: DOWNLOAD_COLUMNS },
                format: 'xlsx',
                sheetName: 'Priced',
                fileName: f("'priced-' + default(form.project_number, 'list') + '.xlsx'"),
                attachToRecordId: f('vars.calc.id'),
                attachToFieldKey: 'result_file',
                resultVar: 'xlsx',
            },
            { kind: 'update_record', tableId: 'tbl_bpcalc', recordId: f('vars.calc.id'), values: { result_file: f('vars.xlsx') } },
            { kind: 'refresh' },
            { kind: 'toast', message: 'Priced. The lines to check are at the top.', tone: 'success' },
            { kind: 'set_variable', name: 'download', value: f('vars.xlsx') },
            { kind: 'navigate', screenId: 'scr_bpcalc', params: { id: f('vars.calc.id') } },
        ],
    },
    // The open calculation's Excel file goes with it, for the Download button.
    act_bpopen: {
        kind: 'sequence',
        steps: [
            { kind: 'set_variable', name: 'download', value: f('item.result_file') },
            { kind: 'navigate', screenId: 'scr_bpcalc', params: { id: f('item.id') } },
        ],
    },
    act_bpback: { kind: 'navigate', screenId: 'scr_bpcalcs' },
    act_bpdl: {
        kind: 'sequence',
        steps: [
            {
                kind: 'condition', expr: '!vars.download',
                then: [{ kind: 'toast', message: 'This calculation has no Excel file.', tone: 'warning' }],
                else: [{ kind: 'download_file', file: f('vars.download'), fileName: f("default(vars.download.name, 'priced.xlsx')") }],
            },
        ],
    },
    act_bpupload: {
        kind: 'sequence',
        steps: [
            {
                kind: 'run_automation', automationId: null, resultVar: 'imported',
                inputMapping: {
                    file: { kind: 'field', name: 'file' },
                    databaseId: { kind: 'field', name: 'database_id' },
                    process: { kind: 'field', name: 'process' },
                },
            },
            {
                kind: 'create_record', tableId: 'tbl_bpcond',
                values: {
                    file: f('form.file'),
                    filename: f("default(vars.imported.output.filename, default(form.file.name, 'conditions'))"),
                    database_id: f('form.database_id'),
                    process: f("default(form.process, 'DoNotProcess')"),
                    sha256: f('vars.imported.output.sha256'),
                    import_id: f('default(vars.imported.output.importResult.id, first(pluck(vars.imported.output.files, \'importId\')))'),
                    rows_total: f('vars.imported.output.importResult.totalImportRows'),
                    rows_failed: f('vars.imported.output.importResult.totalImportRowsFailure'),
                    uploaded_at: f('now'),
                    ok: f('vars.imported.output.ok == true'),
                },
            },
            { kind: 'refresh', tableId: 'tbl_bpcond' },
            { kind: 'toast', message: 'Condition file sent to 2BA.', tone: 'success' },
        ],
    },
};

module.exports = {
    id: 'app-bom-pricing',
    version: 1,
    title: 'Bill of materials pricing',
    description: 'Upload a bill of materials, pick the supplier and get the list back with net purchase prices from your 2BA condition files, line totals and the lines to check, as an Excel file. Every calculation records which condition file was in use.',
    category: 'Data',
    icon: 'Calculator',
    tags: ['pricing', 'bill of materials', 'purchasing', '2ba'],
    dataModel,
    seed,
    definition: {
        schemaVersion: 2,
        meta: { name: 'Bill of materials pricing', description: 'Net purchase prices for a bill of materials.', icon: 'Calculator' },
        theme: { primary: '#0F766E', ...THEME_DEFAULTS },
        homeScreenId: 'scr_bpprice',
        roles: [],
        screens,
        actions,
        variables: [
            { name: 'priced', label: 'Priced list', type: 'any', default: null, description: 'What the pricing automation returned' },
            { name: 'calc', label: 'Calculation', type: 'any', default: null, description: 'The calculation just recorded' },
            { name: 'xlsx', label: 'Excel file', type: 'any', default: null, description: 'The priced list as a file' },
            { name: 'download', label: 'File to download', type: 'any', default: null, description: 'The Excel file of the open calculation' },
            { name: 'imported', label: 'Import answer', type: 'any', default: null, description: 'What 2BA answered to the condition file' },
        ],
    },
};
