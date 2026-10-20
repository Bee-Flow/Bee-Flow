/**
 * Gallery recipes for the table steps: someone uploads a spreadsheet or CSV on
 * a form, the table is edited without code, a short plain summary is written
 * from the result, and a PDF with the summary and the table is offered for
 * download.
 *
 * Every recipe has the same spine, so the differences are the point:
 *
 *   form (one file field) → Read table → Edit table → AI summary → PDF → ending page
 *
 * Each recipe names a made-up sample file (agent-hub/public/automation-samples)
 * whose header matches the columns the recipe uses, so a person can try it
 * before they have data of their own. Spread into TEMPLATES by ./templates.js.
 */

'use strict';

const step = (id, type, extras) => ({ id, type, ...extras });
const ref = (path) => ({ kind: 'ref', path });
const col = (name, value) => ({ name, value });
const expr = (value) => ({ kind: 'expr', value });

const SAMPLE_DIR = '/automation-samples';
// The platform ceiling for one uploaded file is 25 MB (formFieldTypes MAX_UPLOAD_MB).
const UPLOAD_MB = 25;

const SUMMARY_RULES = [
    'Write a short summary in plain language: at most five sentences, no headings.',
    'Use only the numbers that appear in the table. Never calculate new totals, never estimate, never invent a figure.',
    'If a cell is empty, say that the figure is not shown (for example because too few answers sit behind it) instead of guessing.',
].join(' ');

const sampleOf = (filename) => ({ filename, url: `${SAMPLE_DIR}/${filename}` });

function formTrigger({ title, description, fileLabel, info }) {
    return {
        id: 'trg',
        type: 'trigger',
        kind: 'form',
        form: {
            title,
            description,
            submitLabel: 'Create the report',
            successMessage: 'Your file is being processed.',
            fields: [
                { name: 'info', type: 'info', content: info },
                { name: 'file', type: 'file', label: fileLabel, required: true, accept: '.csv,.xlsx', maxSizeMb: UPLOAD_MB },
            ],
        },
    };
}

const readStep = () => step('read', 'read_table', {
    label: 'Read table',
    source: ref('trigger.output.file'),
    sheets: 'first',
    headerRow: 1,
});

/** The AI summary: given one or more table renderings, never the whole table. */
const summaryStep = (what, tables) => step('summary', 'ai_step', {
    label: 'Write the summary',
    systemPrompt: 'You write short, factual summaries of tables for a report. You never add information that is not in the table.',
    prompt: `${what} ${SUMMARY_RULES}`,
    inputs: Object.fromEntries(tables.map(([name, stepId]) => [name, ref(`steps.${stepId}.output.markdown`)])),
    outputSchema: { type: 'object', properties: { text: { type: 'string' } } },
});

const documentStep = (title, tables) => step('doc', 'generate_document', {
    label: 'Make the PDF',
    format: 'pdf',
    contentFormat: 'markdown',
    title,
    fileName: title,
    expiresInDays: 7,
    content: [
        `# ${title}`,
        '{{steps.summary.output.text}}',
        ...tables.flatMap(([heading, stepId]) => [`## ${heading}`, `{{steps.${stepId}.output.markdown}}`]),
    ].join('\n\n'),
});

const endingStep = () => step('done', 'form_page', {
    label: 'Offer the download',
    mode: 'ending',
    form: {
        title: 'Your report is ready',
        description: 'The report is kept for 7 days.',
        fields: [{ name: 'report', type: 'download', label: 'Download the report (PDF)', fileId: '{{steps.doc.output.fileId}}' }],
    },
});

function chain(ids) {
    const edges = [];
    for (let i = 0; i < ids.length - 1; i++) edges.push({ from: ids[i], to: ids[i + 1] });
    return edges;
}

/** Assemble one recipe: the form, Read table, the table steps, summary, PDF and ending. */
function recipe({ id, title, description, icon, tags, sample, trigger, tableSteps, summary, document }) {
    const steps = [readStep(), ...tableSteps, summary, document, endingStep()];
    return {
        id,
        title,
        description,
        category: 'Reports',
        icon,
        tags: ['tables', 'forms', 'ai', 'pdf', ...tags],
        sampleData: sampleOf(sample),
        definition: {
            trigger,
            steps,
            edges: chain(['trg', ...steps.map(s => s.id)]),
        },
    };
}

const TABLE_TEMPLATES = [
    recipe({
        id: 'table-satisfaction-by-region',
        title: 'Satisfaction by region',
        description: 'Upload survey answers → drop the empty scores → count scores per region as percentages (small groups hidden) → short summary and PDF.',
        icon: 'BarChart3',
        tags: ['survey'],
        sample: 'customer-satisfaction.csv',
        trigger: formTrigger({
            title: 'Satisfaction report',
            description: 'Upload a file with one row per answer.',
            fileLabel: 'Survey answers (.csv or .xlsx)',
            info: 'The file needs a header row with the columns **region** and **score**. Try it with the sample file from the template gallery.',
        }),
        tableSteps: [step('tbl', 'table', {
            label: 'Scores per region',
            source: ref('steps.read.output.table'),
            name: 'Scores per region',
            ops: [
                { id: 'scored', op: 'filter', rules: [{ column: 'score', test: 'is_not_empty' }], note: 'Answers without a score are left out.' },
                { id: 'overview', op: 'describe', columns: ['region', 'score'] },
                {
                    id: 'by_region', op: 'pivot', rows: 'region', columns: 'score',
                    value: { fn: 'count' }, percent: 'row', totals: true, minN: 10, decimals: 1,
                    columnOrder: ['1', '2', '3', '4', '5'],
                    note: 'Each row adds up to 100%. Cells built on fewer than 10 answers are left empty.',
                },
            ],
        })],
        summary: summaryStep(
            'The table shows, for each region, the share of answers (in percent) per score from 1 to 5, and the number of answers in the Total column. Describe where the scores are highest and lowest.',
            [['table', 'tbl']],
        ),
        document: documentStep('Satisfaction by region', [['Scores per region (% of answers)', 'tbl']]),
    }),

    recipe({
        id: 'table-sales-by-month',
        title: 'Sales by month and product',
        description: 'Upload an order list → take the month from each order date → total amount, orders and units per month and product → short summary and PDF.',
        icon: 'LineChart',
        tags: ['sales'],
        sample: 'sales-by-month.csv',
        trigger: formTrigger({
            title: 'Sales report',
            description: 'Upload a file with one row per order.',
            fileLabel: 'Orders (.csv or .xlsx)',
            info: 'The file needs a header row with the columns **order_date**, **product**, **amount** and **units**. Try it with the sample file from the template gallery.',
        }),
        tableSteps: [step('tbl', 'table', {
            label: 'Totals per month and product',
            source: ref('steps.read.output.table'),
            name: 'Totals per month and product',
            ops: [
                { id: 'month', op: 'derive', columns: [col('month', expr("formatDate(row.order_date, 'YYYY-MM', 'en')"))] },
                {
                    id: 'totals', op: 'group', by: ['month', 'product'],
                    aggregates: [
                        { fn: 'sum', column: 'amount', as: 'Revenue' },
                        { fn: 'count', as: 'Orders' },
                        { fn: 'sum', column: 'units', as: 'Units' },
                    ],
                    sort: [{ column: 'month', dir: 'asc' }, { column: 'product', dir: 'asc' }],
                },
                { id: 'tidy', op: 'derive', columns: [col('Revenue', expr('round(row.Revenue, 2)'))], note: 'Round the revenue to cents.' },
            ],
        })],
        summary: summaryStep(
            'The table shows revenue, number of orders and units per month and product. Name the months and products with the highest and lowest revenue.',
            [['table', 'tbl']],
        ),
        document: documentStep('Sales by month and product', [['Totals per month and product', 'tbl']]),
    }),

    recipe({
        id: 'table-tickets-by-category',
        title: 'Resolution time by category',
        description: 'Upload a ticket list → average and count per category, and a category by speed-band table (under 4, 4 to 24, 24 to 72, over 72 hours) → short summary and PDF.',
        icon: 'Timer',
        tags: ['support'],
        sample: 'support-tickets.csv',
        trigger: formTrigger({
            title: 'Resolution time report',
            description: 'Upload a file with one row per ticket.',
            fileLabel: 'Tickets (.csv or .xlsx)',
            info: 'The file needs a header row with the columns **category** and **resolution_hours**. Try it with the sample file from the template gallery.',
        }),
        tableSteps: [
            step('tbl', 'table', {
                label: 'Per category',
                source: ref('steps.read.output.table'),
                name: 'Per category',
                ops: [
                    { id: 'resolved', op: 'filter', rules: [{ column: 'resolution_hours', test: 'is_not_empty' }] },
                    {
                        id: 'by_category', op: 'group', by: ['category'],
                        aggregates: [
                            { fn: 'count', as: 'Tickets' },
                            { fn: 'mean', column: 'resolution_hours', as: 'Average hours' },
                        ],
                        sort: [{ column: 'Average hours', dir: 'desc' }],
                    },
                    { id: 'tidy', op: 'derive', columns: [col('Average hours', expr('round(row["Average hours"], 1)'))], note: 'One decimal is enough.' },
                ],
            }),
            step('bands', 'table', {
                label: 'Category by speed',
                source: ref('steps.read.output.table'),
                name: 'Category by speed',
                ops: [
                    { id: 'resolved', op: 'filter', rules: [{ column: 'resolution_hours', test: 'is_not_empty' }] },
                    {
                        id: 'speed', op: 'bucket', column: 'resolution_hours', output: 'speed', mode: 'bands',
                        bands: [
                            { label: 'Under 4 hours', max: 4 },
                            { label: '4 to 24 hours', min: 4, max: 24 },
                            { label: '24 to 72 hours', min: 24, max: 72 },
                            { label: 'Over 72 hours', min: 72 },
                        ],
                    },
                    {
                        id: 'by_speed', op: 'pivot', rows: 'category', columns: 'speed',
                        value: { fn: 'count' }, percent: 'none', totals: true,
                        columnOrder: ['Under 4 hours', '4 to 24 hours', '24 to 72 hours', 'Over 72 hours'],
                    },
                ],
            }),
        ],
        summary: summaryStep(
            'The first table shows the number of tickets and the average resolution time in hours per category. The second table counts tickets per category and speed band. Name the slowest and fastest categories.',
            [['per_category', 'tbl'], ['per_speed', 'bands']],
        ),
        document: documentStep('Resolution time by category', [['Per category', 'tbl'], ['Category by speed', 'bands']]),
    }),

    recipe({
        id: 'table-segment-overview',
        title: 'Anonymous segment overview',
        description: 'Upload survey answers → replace the answer id by a pseudonym and drop free text → count answers per region and channel, hiding groups under 30 → short summary and PDF. Needs a Solution variable named TABLE_SALT (at least 16 characters).',
        icon: 'ShieldCheck',
        tags: ['privacy'],
        sample: 'customer-satisfaction.csv',
        trigger: formTrigger({
            title: 'Segment overview',
            description: 'Upload a file with one row per answer.',
            fileLabel: 'Survey answers (.csv or .xlsx)',
            info: 'The file needs a header row with the columns **rec_id**, **region** and **channel**. The id is replaced by a pseudonym and free text is dropped before anything is counted.',
        }),
        tableSteps: [step('tbl', 'table', {
            label: 'Answers per segment',
            source: ref('steps.read.output.table'),
            name: 'Answers per segment',
            ops: [
                {
                    id: 'anonymise', op: 'pseudonymise', columns: ['rec_id'], saltVar: 'TABLE_SALT',
                    dropColumns: ['comment'],
                    note: 'The salt comes from the Solution variable TABLE_SALT; set it before you activate this automation.',
                },
                {
                    id: 'segments', op: 'groups',
                    splits: [{ column: 'region', label: 'Region' }, { column: 'channel', label: 'Channel' }],
                    includeTotal: true, totalLabel: 'All answers', minN: 30,
                },
            ],
        })],
        summary: summaryStep(
            'The table lists segments (all answers, each region, each channel) with the number of answers. A segment with an empty count has too few answers to show. Describe which segments are largest.',
            [['table', 'tbl']],
        ),
        document: documentStep('Answers per segment', [['Segments', 'tbl']]),
    }),
];

module.exports = { TABLE_TEMPLATES, SAMPLE_DIR };
