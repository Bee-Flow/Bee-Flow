/**
 * App Studio template — BI reports.
 *
 * A self-service reporting workspace: a SMALL relational data warehouse the
 * owner fills from the connectors they create, a report designer where a
 * viewer composes their own chart (group-by + measure + chart type) with a
 * live preview, and a six-slot dashboard that renders whatever reports the
 * team saved into its slots. This is deliberately not a "big data" product —
 * it is one fact table, two generic dimensions and a load log, which is what
 * "our numbers in one place" actually means for a small team.
 *
 * ── THE ONE DECISION EVERYTHING ELSE FOLLOWS ────────────────────────────────
 *
 * A REPORT IS A ROW, AND A CHART'S QUERY IS A FORMULA. An aggregate binding's
 * `groupBy`/`aggregates` may each be { kind:'formula', expr } resolved
 * client-side against the live scope before the fetch (resolveBindingShape),
 * and the server re-validates the resolved descriptor against the real table
 * (compileAggregate: known fields only, fn from its allowlist, aliases
 * sanitised, viewer RLS ANDed in). So the question a chart asks can come from
 * DATA — a saved report row, or the half-finished form in the designer — and
 * the same chart component answers all of them.
 *
 * ── CONSTRAINTS THAT SHAPED THIS FILE (none of them obvious) ────────────────
 *
 *  • DYNAMIC DESCRIPTORS MAY ONLY READ THE STABLE SCOPE ROOTS — currentUser,
 *    vars, forms, screen, today. The fetch layer resolves every binding
 *    against a scope built WITHOUT dataState ("the fetch layer must not
 *    depend on its own results" — AppRunPage/Canvas both), while the read
 *    side resolves against a scope that HAS records/datasets. A shape formula
 *    reading `records.<tableId>` therefore resolves to undefined at fetch
 *    time and to real rows at read time: two different cache keys, and the
 *    chart waits forever on an entry nobody fetched. THIS is why the
 *    dashboard slots are VARIABLES (vars.slot1..slot6) rather than formulas
 *    over the fetched reports rows, and why the designer's live preview reads
 *    `forms.designer.*` — both roots are identical on both sides.
 *
 *  • Dashboard slots must NOT be a repeater of charts. Data bindings are
 *    collected and fetched at SCREEN scope (AppDataScope.collectDataBindings
 *    deep-scans the static definition); a binding inside a repeater whose
 *    formula reads `item.*` never fetches per row. Six slots are therefore
 *    six authored chart components, each reading its own vars.slotN.
 *
 *  • THE EXPRESSION LANGUAGE HAS NO OBJECT LITERALS and no predicate
 *    find/filter (shared/expr/engine.mjs: paths, ternaries, and a closed
 *    function whitelist). A descriptor list like [{field, as}] therefore
 *    cannot be constructed directly — it is built as a JSON STRING with
 *    concat() and parsed with parseJson(), both whitelisted and
 *    deterministic. "The row where slot == 1" cannot be expressed either,
 *    which is the second reason slots are variables: an ACTION (loop over the
 *    saved reports + one flat condition per slot) routes each row into its
 *    slot, because steps can do what expressions cannot.
 *
 *  • AGGREGATE `sort` AND `limit` MUST BE LITERALS. resolveBindingShape would
 *    resolve a formula there, but validate.js special-cases only
 *    groupBy/aggregates — a formula-shaped sort fails binding.sort_invalid
 *    and a formula limit fails binding.limit_invalid. And a LITERAL aggregate
 *    sort may only name a real column (with a formula groupBy the validator
 *    sees no aliases to allow). So every report descriptor aliases its group
 *    to `label` and its measure to `value`, the one literal sort is
 *    [{ field:'label', dir:'asc' }], and `label` ALSO EXISTS as a real fact
 *    column (the row's display text) — which is what lets that sort validate
 *    today and still order every report by its group at run time.
 *
 *  • AN EMPTY SLOT MUST NOT FETCH. A descriptor whose groupBy/aggregates
 *    formulas resolve to nothing would be POSTed as an empty aggregate and
 *    rejected server-side. Every slot descriptor therefore carries a REQUIRED
 *    filter whose value formula yields null while the slot is unassigned —
 *    resolveBindingFilters returns null for the whole binding, the fetch hook
 *    disables itself, and the cell shows its quiet hint instead.
 *
 *  • NO JOINS. Every read compiles to `FROM <one table>`, so the fact table
 *    carries DENORMALISED text keys (category_key / entity_key) next to its
 *    relation fields (category_id / entity_id). Reports group by the text
 *    keys; the relations are what make the model honestly relational — the
 *    warehouse browser shows them, and deleting a dimension row does not
 *    corrupt facts (the display key stays).
 *
 *  • TEMPLATES CANNOT KNOW CONNECTOR IDS, so nothing here ships a
 *    { kind:'connector' } binding. The warehouse instead has a STAGING table
 *    as its landing zone: the owner points whatever connector they create at
 *    `staging_rows` in the Data panel, and the Load screen's action moves
 *    pending rows into the fact table (loop step, capped at the staging
 *    binding's own limit), logging a load_runs row with counts. The empty
 *    state on that screen says exactly how to wire it — and a manual staging
 *    form makes the whole flow demonstrable before any connector exists.
 *
 *  • A loop's `source` resolves client-side from the SAME data cache the
 *    screen fetched (useActionRunner resolves it against dataState). So the
 *    sync/load loops reuse byte-identical binding constants that an on-screen
 *    component also reads — same cache key, same rows, no second fetch path.
 *
 * ── WHAT THIS TEMPLATE DELIBERATELY DOES NOT DO ────────────────────────────
 *
 * No snowflake of lookup tables, no incremental-load bookkeeping, no
 * scheduled refresh: a small team's warehouse is reloaded by pressing the
 * button after the connector synced. And slot assignments live in variables
 * seeded from declared defaults (slots 1–3 mirror the seeded reports), so the
 * dashboard is alive on first open; after editing reports, one click —
 * "Show saved reports" — replays the saved rows into the slots.
 */

'use strict';

const THEME_DEFAULTS = {
    radius: 'md',
    density: 'comfortable',
    fontScale: 'md',
    appearance: 'auto',
};

// ---------------------------------------------------------------------------
// Access
//
// Two roles: analysts build (reports, dimensions, loads), viewers read. The
// default is deny-by-role so publication alone never grants write access to
// the warehouse. The owner is never listed — resolveScope short-circuits them.
// ---------------------------------------------------------------------------

const ACCESS_DATA = {
    default: 'role',
    roles: {
        analyst: { read: 'all', create: true, update: 'all', delete: 'all' },
        viewer: { read: 'all', create: false, update: false, delete: false },
    },
};

const CHART_TYPE_OPTIONS = [
    { value: 'bar', label: 'Bar' },
    { value: 'line', label: 'Line' },
    { value: 'area', label: 'Area' },
    { value: 'pie', label: 'Pie' },
    { value: 'donut', label: 'Donut' },
];

/**
 * What a report may group by. The values are FACT COLUMNS (plus the one
 * special 'month', which the descriptor formulas turn into a month bucket
 * over record_date) — the designer offers exactly what compileAggregate will
 * accept, so a saved report can never name a field the server refuses.
 */
const GROUP_FIELD_OPTIONS = [
    { value: 'category_key', label: 'Category' },
    { value: 'entity_key', label: 'Entity' },
    { value: 'source', label: 'Source system' },
    { value: 'month', label: 'Month (record date)' },
];

const MEASURE_FN_OPTIONS = [
    { value: 'sum', label: 'Sum' },
    { value: 'avg', label: 'Average' },
    { value: 'count', label: 'Row count' },
];

const MEASURE_FIELD_OPTIONS = [
    { value: 'amount', label: 'Amount' },
    { value: 'quantity', label: 'Quantity' },
];

const SLOT_OPTIONS = [
    { value: '0', label: 'Not on the dashboard' },
    { value: '1', label: 'Dashboard slot 1' },
    { value: '2', label: 'Dashboard slot 2' },
    { value: '3', label: 'Dashboard slot 3' },
    { value: '4', label: 'Dashboard slot 4' },
    { value: '5', label: 'Dashboard slot 5' },
    { value: '6', label: 'Dashboard slot 6' },
];

const STAGING_STATUS_OPTIONS = [
    { value: 'pending', label: 'Pending' },
    { value: 'loaded', label: 'Loaded' },
];

const LOAD_STATUS_OPTIONS = [
    { value: 'running', label: 'Running' },
    { value: 'done', label: 'Done' },
];

const CHART_TYPE_TONES = [
    { value: 'bar', label: 'Bar', tone: 'primary' },
    { value: 'line', label: 'Line', tone: 'info' },
    { value: 'area', label: 'Area', tone: 'success' },
    { value: 'pie', label: 'Pie', tone: 'warning' },
    { value: 'donut', label: 'Donut', tone: 'neutral' },
];

// Author-time select lists for the STAGING form. This is the config-as-data
// seam every template has: the seeded dimension keys appear here as literals,
// so a dimension added on Setup shows up in the grids and the reports but not
// in this dropdown until an editor adds it — the Setup screen says so.
const CATEGORY_KEY_OPTIONS = [
    { value: 'hardware', label: 'Hardware' },
    { value: 'software', label: 'Software' },
    { value: 'services', label: 'Services' },
    { value: 'support', label: 'Support' },
    { value: 'training', label: 'Training' },
    { value: 'licenses', label: 'Licenses' },
];

const ENTITY_KEY_OPTIONS = [
    { value: 'north', label: 'North' },
    { value: 'south', label: 'South' },
    { value: 'east', label: 'East' },
    { value: 'west', label: 'West' },
    { value: 'online', label: 'Online' },
    { value: 'partner', label: 'Partner' },
];

// ---------------------------------------------------------------------------
// Data model — a star, kept small on purpose.
// ---------------------------------------------------------------------------

const T = {
    dimCategories: 'tbl_bidimc1',
    dimEntities: 'tbl_bidime1',
    facts: 'tbl_bifact1',
    staging: 'tbl_bistg01',
    loads: 'tbl_biload1',
    reports: 'tbl_birep01',
};

const dataModel = {
    modelVersion: 1,
    roles: [
        { key: 'analyst', label: 'Analyst' },
        { key: 'viewer', label: 'Viewer' },
    ],
    roleMapping: { default: 'viewer', byGroup: {} },
    tables: [
        // ── Dimensions ─────────────────────────────────────────────────────
        // Two GENERIC dimensions. Their MEANING is the owner's: rename the
        // rows (and the descriptions below explain that) — cost centres and
        // teams fit here just as well as product lines and regions. The KEY is
        // what a fact row stores, so it is unique.
        {
            id: T.dimCategories,
            key: 'dim_categories',
            name: 'Dimension: categories',
            icon: 'Tags',
            access: ACCESS_DATA,
            fields: [
                { id: 'fld_bidck01', key: 'key', type: 'text', required: true, unique: true },
                { id: 'fld_bidcn01', key: 'name', type: 'text', required: true, unique: false },
                { id: 'fld_bidcd01', key: 'description', type: 'text', required: false, unique: false },
                { id: 'fld_bidcp01', key: 'position', type: 'number', subtype: 'integer', required: false, unique: false, default: 1 },
            ],
        },
        {
            id: T.dimEntities,
            key: 'dim_entities',
            name: 'Dimension: entities',
            icon: 'Boxes',
            access: ACCESS_DATA,
            fields: [
                { id: 'fld_bidek01', key: 'key', type: 'text', required: true, unique: true },
                { id: 'fld_biden01', key: 'name', type: 'text', required: true, unique: false },
                { id: 'fld_bided01', key: 'description', type: 'text', required: false, unique: false },
                { id: 'fld_bidep01', key: 'position', type: 'number', subtype: 'integer', required: false, unique: false, default: 1 },
            ],
        },

        // ── The load log ───────────────────────────────────────────────────
        {
            id: T.loads,
            key: 'load_runs',
            name: 'Load runs',
            icon: 'History',
            access: ACCESS_DATA,
            fields: [
                { id: 'fld_bildt01', key: 'ran_at', type: 'datetime', required: false, unique: false },
                { id: 'fld_bilsr01', key: 'source', type: 'text', required: false, unique: false },
                { id: 'fld_biln001', key: 'rows_loaded', type: 'number', subtype: 'integer', required: false, unique: false, default: 0 },
                {
                    id: 'fld_bilst01', key: 'status', type: 'select', required: false, unique: false,
                    options: LOAD_STATUS_OPTIONS, default: 'done',
                },
                { id: 'fld_bilnt01', key: 'note', type: 'text', required: false, unique: false },
            ],
        },

        // ── The fact table ─────────────────────────────────────────────────
        {
            id: T.facts,
            key: 'fact_records',
            name: 'Fact records',
            icon: 'Database',
            access: ACCESS_DATA,
            fields: [
                { id: 'fld_bifdt01', key: 'record_date', type: 'date', required: true, unique: false },
                // The row's display text — AND the alias anchor: every report
                // descriptor aliases its group column to `label`, and the one
                // literal sort the validator accepts must name a real column.
                // See the header. Do not remove this field.
                { id: 'fld_biflb01', key: 'label', type: 'text', required: false, unique: false },
                // Denormalised copies of the dimension keys — there are no
                // joins, so these are what reports group and filter by.
                { id: 'fld_bifck01', key: 'category_key', type: 'text', required: false, unique: false },
                { id: 'fld_bifek01', key: 'entity_key', type: 'text', required: false, unique: false },
                // The relations that make the warehouse relational.
                { id: 'fld_bifci01', key: 'category_id', type: 'relation', required: false, unique: false, relation: { table: T.dimCategories } },
                { id: 'fld_bifei01', key: 'entity_id', type: 'relation', required: false, unique: false, relation: { table: T.dimEntities } },
                { id: 'fld_bifam01', key: 'amount', type: 'number', required: false, unique: false },
                { id: 'fld_bifqt01', key: 'quantity', type: 'number', required: false, unique: false },
                { id: 'fld_bifsr01', key: 'source', type: 'text', required: false, unique: false, default: 'manual' },
                // Provenance: which load brought this row in.
                { id: 'fld_biflr01', key: 'load_run_id', type: 'relation', required: false, unique: false, relation: { table: T.loads } },
            ],
        },

        // ── The connector landing zone ─────────────────────────────────────
        {
            id: T.staging,
            key: 'staging_rows',
            name: 'Staging rows',
            icon: 'Inbox',
            access: ACCESS_DATA,
            fields: [
                { id: 'fld_bisdt01', key: 'record_date', type: 'date', required: false, unique: false },
                { id: 'fld_bislb01', key: 'label', type: 'text', required: false, unique: false },
                { id: 'fld_bisck01', key: 'category_key', type: 'text', required: false, unique: false },
                { id: 'fld_bisek01', key: 'entity_key', type: 'text', required: false, unique: false },
                { id: 'fld_bisam01', key: 'amount', type: 'number', required: false, unique: false },
                { id: 'fld_bisqt01', key: 'quantity', type: 'number', required: false, unique: false },
                { id: 'fld_bissr01', key: 'source', type: 'text', required: false, unique: false, default: 'connector' },
                // TEXT status, not a bool: a boolean filter value round-trips
                // differently per SQL dialect; 'pending' is unambiguous in both.
                {
                    id: 'fld_bisst01', key: 'status', type: 'select', required: false, unique: false,
                    options: STAGING_STATUS_OPTIONS, default: 'pending',
                },
            ],
        },

        // ── Saved reports — the heart ──────────────────────────────────────
        {
            id: T.reports,
            key: 'reports',
            name: 'Reports',
            icon: 'BarChart3',
            access: ACCESS_DATA,
            fields: [
                { id: 'fld_birnm01', key: 'name', type: 'text', required: true, unique: false },
                { id: 'fld_birds01', key: 'description', type: 'text', required: false, unique: false },
                {
                    id: 'fld_birct01', key: 'chart_type', type: 'select', required: false, unique: false,
                    options: CHART_TYPE_OPTIONS, default: 'bar',
                },
                {
                    id: 'fld_birgf01', key: 'group_field', type: 'select', required: true, unique: false,
                    options: GROUP_FIELD_OPTIONS, default: 'category_key',
                },
                {
                    id: 'fld_birmf01', key: 'measure_fn', type: 'select', required: false, unique: false,
                    options: MEASURE_FN_OPTIONS, default: 'sum',
                },
                {
                    id: 'fld_birmc01', key: 'measure_field', type: 'select', required: false, unique: false,
                    options: MEASURE_FIELD_OPTIONS, default: 'amount',
                },
                { id: 'fld_birsn01', key: 'since', type: 'date', required: false, unique: false },
                // 0 = library only; 1..6 = dashboard position.
                { id: 'fld_birsl01', key: 'slot', type: 'number', subtype: 'integer', required: false, unique: false, default: 0 },
            ],
        },
    ],
};

// ---------------------------------------------------------------------------
// Shared bindings — ONE constant per query, reused byte-identically wherever
// the same rows are needed (component source AND loop source), so the loop
// resolves against the cache entry the screen already fetched.
// ---------------------------------------------------------------------------

const REPORTS_BINDING = {
    kind: 'records',
    tableId: T.reports,
    sort: [{ field: 'slot', dir: 'asc' }],
    limit: 50,
};

// Limit 100 on purpose: it equals the load loop's maxIterations, so the count
// the load_runs row records is the count the loop actually moved.
const STAGING_PENDING_BINDING = {
    kind: 'records',
    tableId: T.staging,
    filter: [{ field: 'status', op: 'eq', value: 'pending' }],
    sort: [{ field: 'record_date', dir: 'asc' }],
    limit: 100,
};

const LOADS_BINDING = {
    kind: 'records',
    tableId: T.loads,
    sort: [{ field: 'ran_at', dir: 'desc' }],
    limit: 50,
};

// ---------------------------------------------------------------------------
// The descriptor formulas.
//
// `root` is a stable scope path holding a report shape ('vars.slot1',
// 'forms.designer'). The expression language has no object literals, so the
// descriptor lists are built as JSON text (concat) and parsed (parseJson) —
// both whitelisted, pure and deterministic, so the fetch layer and the read
// layer compute the SAME resolved descriptor and land on the same cache key.
// Aliases are fixed ('label'/'value') because chart xKey/series are literal
// props — and 'label' is also a real fact column so the literal sort
// validates (see the header).
// ---------------------------------------------------------------------------

const groupByExpr = (root) => (
    `${root}.group_field == 'month' `
    + `? parseJson('[{"field":"record_date","bucket":"month","as":"label"}]') `
    + `: parseJson(concat('[{"field":"', ${root}.group_field, '","as":"label"}]'))`
);

const aggregatesExpr = (root) => (
    `${root}.measure_fn == 'count' `
    + `? parseJson('[{"fn":"count","field":"*","as":"value"}]') `
    + `: parseJson(concat('[{"fn":"', ${root}.measure_fn, '","field":"', `
    + `coalesce(${root}.measure_field, 'amount'), '","as":"value"}]'))`
);

/**
 * The gate: while the report shape has no group_field the value is null, the
 * REQUIRED filter cannot resolve, resolveBindingFilters returns null for the
 * whole binding, and nothing is fetched. When it has one, the same entry
 * doubles as the optional "since" date narrow (empty string is falsy, so a
 * cleared date input degrades to the epoch instead of an invalid SQL date).
 */
const sinceGateExpr = (root) => (
    `${root}.group_field ? (${root}.since ? ${root}.since : '1970-01-01') : null`
);

const reportChartSource = (root) => ({
    kind: 'aggregate',
    tableId: T.facts,
    groupBy: { kind: 'formula', expr: groupByExpr(root) },
    aggregates: { kind: 'formula', expr: aggregatesExpr(root) },
    filter: [
        { field: 'record_date', op: 'gte', value: { kind: 'formula', expr: sinceGateExpr(root) }, required: true },
    ],
    // Literal on purpose — a formula-shaped sort/limit fails validation (see
    // the header). 'label' is the group alias AND a real fact column.
    sort: [{ field: 'label', dir: 'asc' }],
    limit: 24,
});

/** The default descriptor a slot variable starts from (mirrors a seed row). */
const slotDefault = (name, chartType, groupField, measureFn, measureField, slot) => ({
    name,
    chart_type: chartType,
    group_field: groupField,
    measure_fn: measureFn,
    measure_field: measureField,
    since: null,
    slot,
});

// ---------------------------------------------------------------------------
// Dashboard slot cells — chart when the slot is assigned, a quiet hint when
// it is not. Each cell is its own authored component (NOT a repeater row; see
// the header) inside a chrome-free container so chart + hint share one cell.
// ---------------------------------------------------------------------------

const slotCell = (n) => ({
    id: `cmp_bislot${n}`,
    type: 'container',
    props: {},
    style: { span: 4, gap: 3 },
    visible: true,
    children: [
        {
            id: `cmp_bisch${n}`,
            type: 'chart',
            props: {
                chartType: 'bar',
                source: reportChartSource(`vars.slot${n}`),
                title: `Slot ${n}`,
                xKey: 'label',
                series: [{ key: 'value', label: 'Value', color: 'primary' }],
                stacked: false,
                showLegend: false,
                showGrid: true,
                valueFormat: 'number',
            },
            // chartType/title are presentation, not part of the fetch key —
            // safe to override read-side from the slot's saved shape.
            computed: {
                chartType: { kind: 'formula', expr: `vars.slot${n}.chart_type ? vars.slot${n}.chart_type : 'bar'` },
                title: { kind: 'formula', expr: `vars.slot${n}.name ? vars.slot${n}.name : 'Slot ${n}'` },
            },
            style: { span: 12, height: 'md' },
            visible: { kind: 'formula', expr: `vars.slot${n}.group_field` },
        },
        {
            id: `cmp_bishint${n}`,
            type: 'text',
            props: {
                text: `Slot ${n} is empty. Save a report with dashboard slot ${n}, or press “Show saved reports”.`,
                muted: true,
            },
            style: { span: 12, align: 'start', color: null, weight: 'regular', size: 'sm' },
            visible: { kind: 'formula', expr: `!vars.slot${n}.group_field` },
        },
    ],
});

// ==================================================================
// DASHBOARD — six report slots, fixed KPIs, and the report library.
// ==================================================================
const SCREEN_DASHBOARD = {
    id: 'scr_bidash',
    name: 'Dashboard',
    icon: 'LayoutDashboard',
    showInNav: true,
    maxWidth: 'wide',
    kind: 'dashboard',
    description: 'Six slots showing the reports your team saved, plus the warehouse vitals.',
    refreshInterval: 60,
    sections: [
        {
            id: 'sec_bidtop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_bidhdr',
                    type: 'page_header',
                    props: {
                        title: 'Dashboard',
                        subtitle: 'Slots 1–6 render saved reports. Build new ones in the designer; a slot updates the moment a report is saved into it.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'LayoutDashboard',
                        showDivider: false,
                    },
                    style: { span: 12, gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_bidsync',
                            type: 'button',
                            props: { label: 'Show saved reports', variant: 'secondary', iconLeft: 'RefreshCw', role: 'button' },
                            style: { span: 3, size: 'md', align: 'start' },
                            visible: true,
                            onClick: 'act_bidsync',
                        },
                        {
                            id: 'cmp_bidnew',
                            type: 'button',
                            props: { label: 'New report', variant: 'primary', iconLeft: 'Plus', role: 'button' },
                            style: { span: 3, size: 'md', align: 'start' },
                            visible: true,
                            onClick: 'act_bigodsg',
                        },
                    ],
                },
                {
                    id: 'cmp_bidkpi1',
                    type: 'stat',
                    props: {
                        label: 'Warehouse rows',
                        value: {
                            kind: 'aggregate',
                            tableId: T.facts,
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            limit: 1,
                            // An aggregate binding resolves to the ROWS ARRAY;
                            // pick is the read-side lens that narrows it to the
                            // one number this tile is for.
                            pick: { row: 'first', column: 'n' },
                        },
                        caption: 'facts in the warehouse',
                        icon: 'Database',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: true,
                    },
                    style: { span: 3, size: 'md', align: 'start', color: null },
                    visible: true,
                },
                {
                    id: 'cmp_bidkpi2',
                    type: 'stat',
                    props: {
                        label: 'Total amount',
                        value: {
                            kind: 'aggregate',
                            tableId: T.facts,
                            aggregates: [{ fn: 'sum', field: 'amount', as: 'total' }],
                            limit: 1,
                            pick: { row: 'first', column: 'total' },
                        },
                        caption: 'summed over every fact row',
                        icon: 'Sigma',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: true,
                    },
                    style: { span: 3, size: 'md', align: 'start', color: null },
                    visible: true,
                },
                {
                    id: 'cmp_bidkpi3',
                    type: 'stat',
                    props: {
                        label: 'Staged, waiting',
                        value: {
                            kind: 'aggregate',
                            tableId: T.staging,
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            filter: [{ field: 'status', op: 'eq', value: 'pending' }],
                            limit: 1,
                            pick: { row: 'first', column: 'n' },
                        },
                        caption: 'rows ready to load',
                        icon: 'Inbox',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: false,
                    },
                    style: { span: 3, size: 'md', align: 'start', color: null },
                    visible: true,
                },
                {
                    id: 'cmp_bidkpi4',
                    type: 'stat',
                    props: {
                        label: 'Load runs',
                        value: {
                            kind: 'aggregate',
                            tableId: T.loads,
                            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                            limit: 1,
                            pick: { row: 'first', column: 'n' },
                        },
                        caption: 'loads into the warehouse',
                        icon: 'History',
                        delta: { kind: 'static', value: null },
                        deltaFormat: 'number',
                        trend: { kind: 'static', value: null },
                        positiveIsGood: true,
                    },
                    style: { span: 3, size: 'md', align: 'start', color: null },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_bidrow1',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [slotCell(1), slotCell(2), slotCell(3)],
        },
        {
            id: 'sec_bidrow2',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [slotCell(4), slotCell(5), slotCell(6)],
        },
        {
            id: 'sec_bidlib',
            style: { padding: 4, gap: 3, background: 'surface' },
            children: [
                {
                    id: 'cmp_bidlib',
                    type: 'list',
                    props: {
                        // The SAME constant the sync loop reads — the loop can
                        // only resolve a binding this screen fetched.
                        source: REPORTS_BINDING,
                        titleKey: 'name',
                        subtitleKey: 'description',
                        metaKey: 'slot',
                        timestampKey: null,
                        badgeKey: 'chart_type',
                        badgeToneMap: CHART_TYPE_TONES,
                        unreadKey: null,
                        selectedWhen: null,
                        icon: 'BarChart3',
                        emptyText: 'No saved reports yet — build the first one in the designer.',
                    },
                    style: { span: 12, size: 'md', height: 'auto' },
                    visible: true,
                    onRowClick: 'act_bidapply',
                },
            ],
        },
    ],
};

// ==================================================================
// REPORT DESIGNER — compose a report, watch it live, save it.
// ==================================================================
const SCREEN_DESIGNER = {
    id: 'scr_bidsg',
    name: 'Report designer',
    icon: 'PencilRuler',
    showInNav: true,
    maxWidth: 'wide',
    description: 'Pick a group-by, a measure and a chart type — the preview answers live, Save keeps it.',
    sections: [
        {
            id: 'sec_bigtop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_bighdr',
                    type: 'page_header',
                    props: {
                        title: 'Report designer',
                        subtitle: 'The preview runs the exact query the saved report will run — same table, same fields, same access rules.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'PencilRuler',
                        showDivider: false,
                    },
                    style: { span: 12, gap: 3, padding: 0 },
                    visible: true,
                    children: [],
                },
            ],
        },
        {
            id: 'sec_bigmain',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_bigform',
                    type: 'form',
                    props: { name: 'designer', submitLabel: 'Save report', showReset: false, showSubmit: true },
                    style: { span: 7, gap: 3, padding: 0 },
                    visible: true,
                    onSubmit: 'act_birepsave',
                    children: [
                        { id: 'cmp_bigf1', type: 'input_text', props: { name: 'name', label: 'Report name', placeholder: 'e.g. Amount by category', required: true, defaultValue: null, inputType: 'text', valueFrom: { kind: 'static', value: null } }, style: { span: 8, size: 'md' }, visible: true },
                        {
                            id: 'cmp_bigf2',
                            type: 'input_select',
                            props: { name: 'slot', label: 'Dashboard slot', options: SLOT_OPTIONS, required: true, defaultValue: '0', placeholder: null, valueFrom: { kind: 'static', value: null } },
                            style: { span: 4, size: 'md' },
                            visible: true,
                        },
                        {
                            id: 'cmp_bigf3',
                            type: 'input_select',
                            props: { name: 'group_field', label: 'Group by', options: GROUP_FIELD_OPTIONS, required: true, defaultValue: 'category_key', placeholder: null, valueFrom: { kind: 'static', value: null } },
                            style: { span: 4, size: 'md' },
                            visible: true,
                        },
                        {
                            id: 'cmp_bigf4',
                            type: 'input_select',
                            props: { name: 'measure_fn', label: 'Measure', options: MEASURE_FN_OPTIONS, required: true, defaultValue: 'sum', placeholder: null, valueFrom: { kind: 'static', value: null } },
                            style: { span: 4, size: 'md' },
                            visible: true,
                        },
                        {
                            id: 'cmp_bigf5',
                            type: 'input_select',
                            props: { name: 'measure_field', label: 'Of field', options: MEASURE_FIELD_OPTIONS, required: false, defaultValue: 'amount', placeholder: null, valueFrom: { kind: 'static', value: null } },
                            style: { span: 4, size: 'md' },
                            visible: true,
                        },
                        {
                            id: 'cmp_bigf6',
                            type: 'input_select',
                            props: { name: 'chart_type', label: 'Chart type', options: CHART_TYPE_OPTIONS, required: true, defaultValue: 'bar', placeholder: null, valueFrom: { kind: 'static', value: null } },
                            style: { span: 4, size: 'md' },
                            visible: true,
                        },
                        { id: 'cmp_bigf7', type: 'input_date', props: { name: 'since', label: 'Only rows since (optional)', required: false, defaultValue: null, valueFrom: { kind: 'static', value: null } }, style: { span: 4, size: 'md' }, visible: true },
                        { id: 'cmp_bigf8', type: 'input_text', props: { name: 'description', label: 'Description', placeholder: 'What question does this answer?', required: false, defaultValue: null, inputType: 'text', valueFrom: { kind: 'static', value: null } }, style: { span: 8, size: 'md' }, visible: true },
                    ],
                },
                {
                    id: 'cmp_bigprev',
                    type: 'container',
                    props: {},
                    style: { span: 5, gap: 3 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_bigchart',
                            type: 'chart',
                            props: {
                                chartType: 'bar',
                                // The live preview IS the form: the descriptor
                                // resolves from forms.designer.*, which the
                                // form publishes on mount and on every change.
                                source: reportChartSource('forms.designer'),
                                title: 'Live preview',
                                xKey: 'label',
                                series: [{ key: 'value', label: 'Value', color: 'primary' }],
                                stacked: false,
                                showLegend: false,
                                showGrid: true,
                                valueFormat: 'number',
                            },
                            computed: {
                                chartType: { kind: 'formula', expr: "forms.designer.chart_type ? forms.designer.chart_type : 'bar'" },
                                title: { kind: 'formula', expr: "forms.designer.name ? forms.designer.name : 'Live preview'" },
                            },
                            style: { span: 12, height: 'lg' },
                            visible: { kind: 'formula', expr: 'forms.designer.group_field' },
                        },
                        {
                            id: 'cmp_bighint',
                            type: 'text',
                            props: { text: 'Pick a group-by on the left and the preview answers immediately.', muted: true },
                            style: { span: 12, align: 'start', color: null, weight: 'regular', size: 'sm' },
                            visible: { kind: 'formula', expr: '!forms.designer.group_field' },
                        },
                    ],
                },
            ],
        },
        {
            id: 'sec_biglib',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_biggrid',
                    type: 'data_grid',
                    props: {
                        source: REPORTS_BINDING,
                        columns: [
                            { key: 'name', label: 'Report', format: 'text', width: 240, sortable: true, filterable: true, editable: false },
                            { key: 'chart_type', label: 'Chart', format: 'badge', width: 100, sortable: true, filterable: true, editable: false },
                            { key: 'group_field', label: 'Group by', format: 'badge', width: 130, sortable: true, filterable: true, editable: false },
                            { key: 'measure_fn', label: 'Measure', format: 'badge', width: 110, sortable: false, filterable: false, editable: false },
                            { key: 'measure_field', label: 'Of', format: 'text', width: 100, sortable: false, filterable: false, editable: false },
                            { key: 'slot', label: 'Slot', format: 'number', width: 80, sortable: true, filterable: false, editable: false },
                            { key: 'description', label: 'Description', format: 'text', width: 300, sortable: false, filterable: false, editable: false },
                        ],
                        pageSize: 25,
                        selectable: 'none',
                        searchable: true,
                        rowActions: [
                            { label: 'To dashboard', actionId: 'act_bidapply' },
                            { label: 'Delete', actionId: 'act_birepdel' },
                        ],
                        density: 'compact',
                        zebra: true,
                        emptyText: 'Nothing saved yet — compose a report above and press Save.',
                    },
                    style: { span: 12, size: 'md', height: 'fill' },
                    visible: true,
                },
            ],
        },
    ],
};

// ==================================================================
// LOAD DATA — the connector landing zone and the load button.
// ==================================================================
const SCREEN_LOAD = {
    id: 'scr_biload',
    name: 'Load data',
    icon: 'DownloadCloud',
    showInNav: true,
    maxWidth: 'wide',
    description: 'Rows your connector staged, waiting to be loaded into the warehouse — with a logged run per load.',
    sections: [
        {
            id: 'sec_biltop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_bilhdr',
                    type: 'page_header',
                    props: {
                        title: 'Load data',
                        subtitle: 'Staging is the landing zone: connectors write here, and “Load staged rows” moves everything pending into the fact table.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'DownloadCloud',
                        showDivider: false,
                    },
                    style: { span: 12, gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_bilrun',
                            type: 'button',
                            props: { label: 'Load staged rows', variant: 'primary', iconLeft: 'DownloadCloud', role: 'button' },
                            style: { span: 3, size: 'md', align: 'start' },
                            visible: true,
                            onClick: 'act_biload',
                        },
                    ],
                },
                {
                    // The connector empty state — a template cannot know the
                    // ids of connectors the OWNER will create, so instead of a
                    // dead { kind:'connector' } placeholder this tells them
                    // exactly how to wire their own.
                    id: 'cmp_bilhow',
                    type: 'callout',
                    props: {
                        title: 'Wire your connector here',
                        text: 'This app ships without a connector on purpose — connectors are yours. Open the app’s **Data panel → Connectors**, create one (or pick an existing one), and point its sync at the **Staging rows** table: date → `record_date`, description → `label`, your two dimension values → `category_key` / `entity_key`, numbers → `amount` / `quantity`, and let `status` default to `pending`. Every synced row appears below; **Load staged rows** moves it into the warehouse and logs a load run. No connector yet? The manual form below feeds the exact same flow.',
                        tone: 'info',
                    },
                    style: { span: 12 },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_bilmain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_bilstg',
                    type: 'data_grid',
                    props: {
                        // The SAME constant the load action reads — see header.
                        source: STAGING_PENDING_BINDING,
                        columns: [
                            { key: 'record_date', label: 'Date', format: 'date', width: 110, sortable: true, filterable: false, editable: false },
                            { key: 'label', label: 'Label', format: 'text', width: 240, sortable: true, filterable: true, editable: false },
                            { key: 'category_key', label: 'Category', format: 'badge', width: 120, sortable: true, filterable: true, editable: false },
                            { key: 'entity_key', label: 'Entity', format: 'badge', width: 110, sortable: true, filterable: true, editable: false },
                            { key: 'amount', label: 'Amount', format: 'number', width: 100, sortable: true, filterable: false, editable: false },
                            { key: 'quantity', label: 'Qty', format: 'number', width: 80, sortable: false, filterable: false, editable: false },
                            { key: 'source', label: 'Source', format: 'text', width: 130, sortable: true, filterable: true, editable: false },
                        ],
                        pageSize: 25,
                        selectable: 'none',
                        searchable: true,
                        rowActions: [{ label: 'Delete', actionId: 'act_bistgdel' }],
                        density: 'compact',
                        zebra: true,
                        emptyText: 'Nothing pending. Sync your connector into Staging rows, or add a row with the form below.',
                    },
                    style: { span: 7, size: 'md', height: 'fill' },
                    visible: true,
                },
                {
                    id: 'cmp_bilruns',
                    type: 'list',
                    props: {
                        source: LOADS_BINDING,
                        titleKey: 'note',
                        subtitleKey: 'source',
                        metaKey: 'rows_loaded',
                        timestampKey: 'ran_at',
                        badgeKey: 'status',
                        badgeToneMap: [
                            { value: 'done', label: 'Done', tone: 'success' },
                            { value: 'running', label: 'Running', tone: 'warning' },
                        ],
                        unreadKey: null,
                        selectedWhen: null,
                        icon: 'History',
                        emptyText: 'No loads yet — the first run appears here with its row count.',
                    },
                    style: { span: 5, size: 'md', height: 'fill' },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_bilform',
            style: { padding: 4, gap: 3, background: 'surface' },
            children: [
                {
                    id: 'cmp_bilform',
                    type: 'form',
                    props: { name: 'stagerow', submitLabel: 'Stage row', showReset: false, showSubmit: true },
                    style: { span: 12, gap: 3, padding: 0 },
                    visible: true,
                    onSubmit: 'act_bistgadd',
                    children: [
                        { id: 'cmp_bilf1', type: 'input_date', props: { name: 'record_date', label: 'Date', required: true, defaultValue: 'today', valueFrom: { kind: 'static', value: null } }, style: { span: 2, size: 'md' }, visible: true },
                        { id: 'cmp_bilf2', type: 'input_text', props: { name: 'label', label: 'Label', placeholder: 'What is this row?', required: true, defaultValue: null, inputType: 'text', valueFrom: { kind: 'static', value: null } }, style: { span: 4, size: 'md' }, visible: true },
                        {
                            id: 'cmp_bilf3',
                            type: 'input_select',
                            props: { name: 'category_key', label: 'Category', options: CATEGORY_KEY_OPTIONS, required: true, defaultValue: 'hardware', placeholder: null, valueFrom: { kind: 'static', value: null } },
                            style: { span: 2, size: 'md' },
                            visible: true,
                        },
                        {
                            id: 'cmp_bilf4',
                            type: 'input_select',
                            props: { name: 'entity_key', label: 'Entity', options: ENTITY_KEY_OPTIONS, required: true, defaultValue: 'north', placeholder: null, valueFrom: { kind: 'static', value: null } },
                            style: { span: 2, size: 'md' },
                            visible: true,
                        },
                        { id: 'cmp_bilf5', type: 'input_number', props: { name: 'amount', label: 'Amount', min: 0, max: 1000000, step: 0.01, required: false, defaultValue: null }, style: { span: 1, size: 'md' }, visible: true },
                        { id: 'cmp_bilf6', type: 'input_number', props: { name: 'quantity', label: 'Qty', min: 0, max: 100000, step: 1, required: false, defaultValue: null }, style: { span: 1, size: 'md' }, visible: true },
                    ],
                },
            ],
        },
    ],
};

// ==================================================================
// WAREHOUSE — the relational model, tangible.
// ==================================================================
const SCREEN_WAREHOUSE = {
    id: 'scr_biwh',
    name: 'Warehouse',
    icon: 'Database',
    showInNav: true,
    maxWidth: 'full',
    description: 'Browse the fact table with filters, follow its relations, and audit the load history.',
    sections: [
        {
            id: 'sec_biwtop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_biwhdr',
                    type: 'page_header',
                    props: {
                        title: 'Warehouse',
                        subtitle: 'One fact table, two dimensions, one load log. Amounts and labels are editable inline — click a cell.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'Database',
                        showDivider: false,
                    },
                    style: { span: 12, gap: 3, padding: 0 },
                    visible: true,
                    children: [],
                },
                {
                    id: 'cmp_biwfilt',
                    type: 'filter_bar',
                    props: {
                        fields: [
                            { name: 'q', label: 'Search label', type: 'search', options: [] },
                            { name: 'category', label: 'Category', type: 'select', options: CATEGORY_KEY_OPTIONS },
                            { name: 'entity', label: 'Entity', type: 'select', options: ENTITY_KEY_OPTIONS },
                        ],
                    },
                    style: { span: 12, size: 'md', gap: 3 },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_biwmain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_biwtabs',
                    type: 'tabs',
                    props: {},
                    style: { span: 12, gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_biwtab1',
                            type: 'tab',
                            props: { label: 'Fact records', icon: 'Database' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_biwfacts',
                                    type: 'data_grid',
                                    props: {
                                        source: {
                                            kind: 'records',
                                            tableId: T.facts,
                                            filter: [
                                                { field: 'label', op: 'contains', value: { kind: 'formula', expr: 'vars.filters.q' }, required: false },
                                                { field: 'category_key', op: 'eq', value: { kind: 'formula', expr: 'vars.filters.category' }, required: false },
                                                { field: 'entity_key', op: 'eq', value: { kind: 'formula', expr: 'vars.filters.entity' }, required: false },
                                            ],
                                            sort: [{ field: 'record_date', dir: 'desc' }],
                                            limit: 400,
                                        },
                                        columns: [
                                            { key: 'record_date', label: 'Date', format: 'date', width: 110, sortable: true, filterable: false, editable: false },
                                            { key: 'label', label: 'Label', format: 'text', width: 260, sortable: true, filterable: true, editable: true },
                                            { key: 'category_key', label: 'Category', format: 'badge', width: 120, sortable: true, filterable: true, editable: false },
                                            { key: 'entity_key', label: 'Entity', format: 'badge', width: 110, sortable: true, filterable: true, editable: false },
                                            { key: 'category_id', label: 'Category →', format: 'relation', width: 140, sortable: false, filterable: false, editable: false },
                                            { key: 'entity_id', label: 'Entity →', format: 'relation', width: 130, sortable: false, filterable: false, editable: false },
                                            { key: 'amount', label: 'Amount', format: 'number', width: 100, sortable: true, filterable: false, editable: true },
                                            { key: 'quantity', label: 'Qty', format: 'number', width: 80, sortable: true, filterable: false, editable: true },
                                            { key: 'source', label: 'Source', format: 'text', width: 120, sortable: true, filterable: true, editable: false },
                                            { key: 'load_run_id', label: 'Load →', format: 'relation', width: 130, sortable: false, filterable: false, editable: false },
                                        ],
                                        pageSize: 50,
                                        selectable: 'none',
                                        searchable: false,
                                        rowActions: [{ label: 'Delete', actionId: 'act_bifactdel' }],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'The warehouse is empty — load staged rows on the Load data screen.',
                                    },
                                    style: { span: 12, size: 'md', height: 'fill' },
                                    visible: true,
                                    onRowSelect: 'act_bifactsave',
                                },
                            ],
                        },
                        {
                            id: 'cmp_biwtab2',
                            type: 'tab',
                            props: { label: 'Load runs', icon: 'History' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_biwloads',
                                    type: 'data_grid',
                                    props: {
                                        source: LOADS_BINDING,
                                        columns: [
                                            { key: 'ran_at', label: 'Ran', format: 'date', width: 130, sortable: true, filterable: false, editable: false },
                                            { key: 'source', label: 'Source', format: 'text', width: 140, sortable: true, filterable: true, editable: false },
                                            { key: 'rows_loaded', label: 'Rows', format: 'number', width: 90, sortable: true, filterable: false, editable: false },
                                            { key: 'status', label: 'Status', format: 'badge', width: 110, sortable: true, filterable: true, editable: false },
                                            { key: 'note', label: 'Note', format: 'text', width: 320, sortable: false, filterable: false, editable: false },
                                        ],
                                        pageSize: 25,
                                        selectable: 'none',
                                        searchable: false,
                                        rowActions: [],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'No load runs yet.',
                                    },
                                    style: { span: 12, size: 'md', height: 'fill' },
                                    visible: true,
                                },
                            ],
                        },
                    ],
                },
            ],
        },
    ],
};

// ==================================================================
// SETUP — the model in plain words, and the dimensions to make your own.
// ==================================================================
const SCREEN_SETUP = {
    id: 'scr_bisetup',
    name: 'Setup',
    icon: 'Settings2',
    showInNav: true,
    maxWidth: 'wide',
    description: 'What the warehouse is, and the two dimensions you rename to make it yours.',
    sections: [
        {
            id: 'sec_bistop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_bishdr',
                    type: 'page_header',
                    props: {
                        title: 'Setup',
                        subtitle: 'Rename the dimensions to whatever your data really splits by — the model does not care what they are called.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'Settings2',
                        showDivider: false,
                    },
                    style: { span: 12, gap: 3, padding: 0 },
                    visible: true,
                    children: [],
                },
                {
                    id: 'cmp_bisdoc',
                    type: 'markdown',
                    props: {
                        content: [
                            '## How this warehouse works',
                            '',
                            'It is a small **star schema** — one fact table with two dimensions and a load log:',
                            '',
                            '- **Fact records** — one row per thing that happened: a date, an amount, a quantity, and two dimension keys.',
                            '- **Dimension: categories** and **Dimension: entities** — the two axes reports group by. They are deliberately generic: product lines and regions, cost centres and teams, projects and customers — rename the rows here and the meaning follows.',
                            '- **Load runs** — every load is logged with a timestamp and a row count, so “where did these numbers come from?” always has an answer.',
                            '',
                            'Because every query reads **one table** (no joins), each fact row carries a text copy of its dimension keys (`category_key`, `entity_key`) next to the real relations — the copies are what reports group by, the relations are what makes the model relational.',
                            '',
                            'One seam to know about: the **dropdowns** in the staging form and the warehouse filter bar are fixed lists in the app design. A dimension row added below shows up in reports and grids immediately, but an editor has to add it to those dropdowns.',
                        ].join('\n'),
                        contentFrom: { kind: 'static', value: null },
                    },
                    style: { span: 12, color: null },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_bisdims',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_bisdim1',
                    type: 'data_grid',
                    props: {
                        source: { kind: 'records', tableId: T.dimCategories, sort: [{ field: 'position', dir: 'asc' }], limit: 50 },
                        columns: [
                            { key: 'position', label: 'Order', format: 'number', width: 80, sortable: true, filterable: false, editable: true },
                            { key: 'key', label: 'Key', format: 'text', width: 130, sortable: true, filterable: true, editable: false },
                            { key: 'name', label: 'Name', format: 'text', width: 160, sortable: false, filterable: false, editable: true },
                            { key: 'description', label: 'Description', format: 'text', width: 260, sortable: false, filterable: false, editable: true },
                        ],
                        pageSize: 25,
                        selectable: 'none',
                        searchable: false,
                        rowActions: [{ label: 'Delete', actionId: 'act_bidim1del' }],
                        density: 'compact',
                        zebra: true,
                        emptyText: 'No categories yet — add the first below.',
                    },
                    style: { span: 6, size: 'md', height: 'auto' },
                    visible: true,
                    onRowSelect: 'act_bidim1save',
                },
                {
                    id: 'cmp_bisdim2',
                    type: 'data_grid',
                    props: {
                        source: { kind: 'records', tableId: T.dimEntities, sort: [{ field: 'position', dir: 'asc' }], limit: 50 },
                        columns: [
                            { key: 'position', label: 'Order', format: 'number', width: 80, sortable: true, filterable: false, editable: true },
                            { key: 'key', label: 'Key', format: 'text', width: 130, sortable: true, filterable: true, editable: false },
                            { key: 'name', label: 'Name', format: 'text', width: 160, sortable: false, filterable: false, editable: true },
                            { key: 'description', label: 'Description', format: 'text', width: 260, sortable: false, filterable: false, editable: true },
                        ],
                        pageSize: 25,
                        selectable: 'none',
                        searchable: false,
                        rowActions: [{ label: 'Delete', actionId: 'act_bidim2del' }],
                        density: 'compact',
                        zebra: true,
                        emptyText: 'No entities yet — add the first below.',
                    },
                    style: { span: 6, size: 'md', height: 'auto' },
                    visible: true,
                    onRowSelect: 'act_bidim2save',
                },
                {
                    id: 'cmp_bisadd1',
                    type: 'button',
                    props: { label: 'Add category', variant: 'primary', iconLeft: 'Plus', role: 'button' },
                    style: { span: 3, size: 'md', align: 'start' },
                    visible: true,
                    onClick: 'act_bidim1open',
                },
                {
                    id: 'cmp_bisadd2',
                    type: 'button',
                    props: { label: 'Add entity', variant: 'primary', iconLeft: 'Plus', role: 'button' },
                    style: { span: 3, size: 'md', align: 'start' },
                    visible: true,
                    onClick: 'act_bidim2open',
                },
            ],
        },
        {
            // Add dialogs, hoisted into their own section — a modal is
            // positioned by the runtime, not by its grid slot.
            id: 'sec_bisdlg',
            style: { padding: 0, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_bidm1mod',
                    type: 'modal',
                    props: { title: 'Add category', size: 'md', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_bidm1frm',
                            type: 'form',
                            props: { name: 'newdim1', submitLabel: 'Add category', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_bidim1add',
                            children: [
                                { id: 'cmp_bidm1f1', type: 'input_text', props: { name: 'key', label: 'Key (what a fact row stores, e.g. consulting)', placeholder: null, required: true, defaultValue: null, inputType: 'text', valueFrom: { kind: 'static', value: null } }, style: { span: 8, size: 'md' }, visible: true },
                                { id: 'cmp_bidm1f2', type: 'input_number', props: { name: 'position', label: 'Order', min: 1, max: 99, step: 1, required: false, defaultValue: 1 }, style: { span: 4, size: 'md' }, visible: true },
                                { id: 'cmp_bidm1f3', type: 'input_text', props: { name: 'name', label: 'Name', placeholder: null, required: true, defaultValue: null, inputType: 'text', valueFrom: { kind: 'static', value: null } }, style: { span: 6, size: 'md' }, visible: true },
                                { id: 'cmp_bidm1f4', type: 'input_text', props: { name: 'description', label: 'Description', placeholder: null, required: false, defaultValue: null, inputType: 'text', valueFrom: { kind: 'static', value: null } }, style: { span: 6, size: 'md' }, visible: true },
                            ],
                        },
                    ],
                },
                {
                    id: 'cmp_bidm2mod',
                    type: 'modal',
                    props: { title: 'Add entity', size: 'md', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_bidm2frm',
                            type: 'form',
                            props: { name: 'newdim2', submitLabel: 'Add entity', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_bidim2add',
                            children: [
                                { id: 'cmp_bidm2f1', type: 'input_text', props: { name: 'key', label: 'Key (what a fact row stores, e.g. berlin)', placeholder: null, required: true, defaultValue: null, inputType: 'text', valueFrom: { kind: 'static', value: null } }, style: { span: 8, size: 'md' }, visible: true },
                                { id: 'cmp_bidm2f2', type: 'input_number', props: { name: 'position', label: 'Order', min: 1, max: 99, step: 1, required: false, defaultValue: 1 }, style: { span: 4, size: 'md' }, visible: true },
                                { id: 'cmp_bidm2f3', type: 'input_text', props: { name: 'name', label: 'Name', placeholder: null, required: true, defaultValue: null, inputType: 'text', valueFrom: { kind: 'static', value: null } }, style: { span: 6, size: 'md' }, visible: true },
                                { id: 'cmp_bidm2f4', type: 'input_text', props: { name: 'description', label: 'Description', placeholder: null, required: false, defaultValue: null, inputType: 'text', valueFrom: { kind: 'static', value: null } }, style: { span: 6, size: 'md' }, visible: true },
                            ],
                        },
                    ],
                },
            ],
        },
    ],
};

// ---------------------------------------------------------------------------
// Actions.
//
// Two rules run through all of it (same as every template here):
//   WHERE CONTEXT COMES FROM — a server step (create/update/delete) sees only
//   form / vars / item / index / value / currentUser / now. Nothing reads
//   screen.* or records.* in a server step.
//   EVERY MUTATION ENDS IN refresh, named by the table it dirtied.
//
// The slot routing is the one piece of real logic: expressions cannot say
// "the row where slot == N" (no find/filter in the engine), so a LOOP with
// six FLAT conditions does it in steps. Flat, not chained — nested else-if
// would blow the action-depth cap for no benefit.
// ---------------------------------------------------------------------------

/** The six slot conditions, shared by the sync loop and the row-apply. */
const slotRouteSteps = (rootExpr) => [1, 2, 3, 4, 5, 6].map((n) => ({
    kind: 'condition',
    expr: `${rootExpr}.slot == ${n}`,
    then: [{ kind: 'set_variable', name: `slot${n}`, value: { kind: 'formula', expr: rootExpr } }],
}));

const actions = {
    // ── Dashboard ──────────────────────────────────────────────────────────

    /**
     * Replay the saved reports into the slot variables. The loop's source is
     * the byte-identical REPORTS_BINDING the library list fetched, so it
     * resolves from the same cache entry (a loop cannot fetch on its own).
     */
    act_bidsync: {
        kind: 'sequence',
        steps: [
            {
                kind: 'loop',
                source: REPORTS_BINDING,
                itemVar: 'report',
                indexVar: 'reportIndex',
                maxIterations: 50,
                steps: slotRouteSteps('item'),
            },
            { kind: 'toast', message: 'Dashboard slots now follow the saved reports.', tone: 'success' },
        ],
    },

    /** One report → its slot, from a row click or a grid row action. */
    act_bidapply: {
        kind: 'sequence',
        steps: [
            ...slotRouteSteps('item'),
            {
                kind: 'condition',
                expr: '!(item.slot >= 1 && item.slot <= 6)',
                then: [{ kind: 'toast', message: 'This report has no dashboard slot — give it slot 1–6 in the designer and save.', tone: 'info' }],
            },
        ],
    },

    act_bigodsg: { kind: 'navigate', screenId: 'scr_bidsg' },

    // ── Report designer ────────────────────────────────────────────────────

    /**
     * Save = create the report row, then route the just-saved shape into its
     * slot variable so the dashboard is current WITHOUT waiting for a
     * refetch. `form` carries the designer's values on both sides: the server
     * step reads it as the event payload, the client conditions read it from
     * the submitted form scope. Selects submit strings, so slot is number()ed
     * for the record and compared loosely in the conditions.
     */
    act_birepsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: T.reports,
                resultVar: 'savedReport',
                values: {
                    name: { kind: 'formula', expr: 'form.name' },
                    description: { kind: 'formula', expr: 'form.description' },
                    chart_type: { kind: 'formula', expr: 'form.chart_type' },
                    group_field: { kind: 'formula', expr: 'form.group_field' },
                    measure_fn: { kind: 'formula', expr: 'form.measure_fn' },
                    measure_field: { kind: 'formula', expr: 'form.measure_field' },
                    // '' would be an invalid SQL date on Postgres — a cleared
                    // date input must write NULL, not the empty string.
                    since: { kind: 'formula', expr: 'form.since ? form.since : null' },
                    slot: { kind: 'formula', expr: 'number(form.slot)' },
                },
            },
            ...slotRouteSteps('form'),
            { kind: 'refresh', tableId: T.reports },
            { kind: 'toast', message: 'Report saved.', tone: 'success' },
        ],
    },

    act_birepdel: {
        kind: 'sequence',
        steps: [
            { kind: 'confirm', message: 'Delete this report? A dashboard slot showing it keeps its current chart until the slots are synced again.', title: 'Delete report' },
            { kind: 'delete_record', tableId: T.reports, recordId: { kind: 'formula', expr: 'item.id' } },
            { kind: 'refresh', tableId: T.reports },
        ],
    },

    // ── Load data ──────────────────────────────────────────────────────────

    /**
     * The warehouse load. Snapshot the pending rows into vars.staged FIRST
     * (the loop must not see rows the mid-loop updates would re-filter), log
     * the run, move every row, close the run. rows_loaded is len(vars.staged)
     * — trustworthy because the binding's limit equals the loop's cap.
     */
    act_biload: {
        kind: 'sequence',
        steps: [
            { kind: 'set_variable', name: 'staged', value: STAGING_PENDING_BINDING },
            {
                kind: 'condition',
                expr: 'len(vars.staged) > 0',
                then: [
                    {
                        kind: 'create_record',
                        tableId: T.loads,
                        resultVar: 'run',
                        values: {
                            ran_at: { kind: 'formula', expr: 'now' },
                            source: { kind: 'static', value: 'staging' },
                            rows_loaded: { kind: 'formula', expr: 'len(vars.staged)' },
                            status: { kind: 'static', value: 'running' },
                            note: { kind: 'formula', expr: "concat('Loaded by ', currentUser.name)" },
                        },
                    },
                    {
                        kind: 'loop',
                        source: { kind: 'formula', expr: 'vars.staged' },
                        itemVar: 'stagedRow',
                        indexVar: 'stagedIndex',
                        maxIterations: 100,
                        steps: [
                            {
                                kind: 'create_record',
                                tableId: T.facts,
                                values: {
                                    record_date: { kind: 'formula', expr: 'item.record_date' },
                                    label: { kind: 'formula', expr: 'item.label' },
                                    category_key: { kind: 'formula', expr: 'item.category_key' },
                                    entity_key: { kind: 'formula', expr: 'item.entity_key' },
                                    amount: { kind: 'formula', expr: 'item.amount' },
                                    quantity: { kind: 'formula', expr: 'item.quantity' },
                                    source: { kind: 'formula', expr: "coalesce(item.source, 'staging')" },
                                    load_run_id: { kind: 'formula', expr: 'vars.run.id' },
                                },
                            },
                            {
                                kind: 'update_record',
                                tableId: T.staging,
                                recordId: { kind: 'formula', expr: 'item.id' },
                                values: { status: { kind: 'static', value: 'loaded' } },
                            },
                        ],
                    },
                    {
                        kind: 'update_record',
                        tableId: T.loads,
                        recordId: { kind: 'formula', expr: 'vars.run.id' },
                        values: { status: { kind: 'static', value: 'done' } },
                    },
                    { kind: 'refresh', tableId: T.facts },
                    { kind: 'refresh', tableId: T.staging },
                    { kind: 'refresh', tableId: T.loads },
                    { kind: 'toast', message: 'Staged rows are in the warehouse — the dashboard reads them already.', tone: 'success' },
                ],
                else: [
                    { kind: 'toast', message: 'Nothing to load — every staged row is already in the warehouse.', tone: 'info' },
                ],
            },
        ],
    },

    act_bistgadd: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: T.staging,
                values: {
                    record_date: { kind: 'formula', expr: 'form.record_date' },
                    label: { kind: 'formula', expr: 'form.label' },
                    category_key: { kind: 'formula', expr: 'form.category_key' },
                    entity_key: { kind: 'formula', expr: 'form.entity_key' },
                    amount: { kind: 'formula', expr: 'form.amount' },
                    quantity: { kind: 'formula', expr: 'form.quantity' },
                    source: { kind: 'static', value: 'manual' },
                    status: { kind: 'static', value: 'pending' },
                },
            },
            { kind: 'reset_form', form: 'stagerow' },
            { kind: 'refresh', tableId: T.staging },
            { kind: 'toast', message: 'Row staged — press “Load staged rows” to move it into the warehouse.', tone: 'success' },
        ],
    },

    act_bistgdel: {
        kind: 'sequence',
        steps: [
            { kind: 'confirm', message: 'Delete this staged row? It will not be loaded into the warehouse.', title: 'Delete staged row' },
            { kind: 'delete_record', tableId: T.staging, recordId: { kind: 'formula', expr: 'item.id' } },
            { kind: 'refresh', tableId: T.staging },
        ],
    },

    // ── Warehouse ──────────────────────────────────────────────────────────

    /**
     * Inline cell edits on the fact grid. selectable:'none' makes onRowSelect
     * a pure cell-commit event carrying the whole edited row. Compare-and-set
     * via updated_at; the STRICT empty-string ternary on the numbers — 0 == ''
     * is true, a loose ternary would turn a real 0 into NULL.
     */
    act_bifactsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: T.facts,
                recordId: { kind: 'formula', expr: 'form.id' },
                expectedUpdatedAt: { kind: 'formula', expr: 'form.updated_at' },
                values: {
                    label: { kind: 'formula', expr: 'form.label' },
                    amount: { kind: 'formula', expr: "form.amount === '' ? null : form.amount" },
                    quantity: { kind: 'formula', expr: "form.quantity === '' ? null : form.quantity" },
                },
            },
            { kind: 'refresh', tableId: T.facts },
        ],
    },

    act_bifactdel: {
        kind: 'sequence',
        steps: [
            { kind: 'confirm', message: 'Delete this fact row? Reports recompute without it immediately.', title: 'Delete fact row' },
            { kind: 'delete_record', tableId: T.facts, recordId: { kind: 'formula', expr: 'item.id' } },
            { kind: 'refresh', tableId: T.facts },
        ],
    },

    // ── Setup: dimensions ──────────────────────────────────────────────────

    act_bidim1open: { kind: 'open_modal', modalId: 'cmp_bidm1mod' },
    act_bidim1add: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: T.dimCategories,
                values: {
                    key: { kind: 'formula', expr: 'form.key' },
                    name: { kind: 'formula', expr: 'form.name' },
                    description: { kind: 'formula', expr: 'form.description' },
                    position: { kind: 'formula', expr: 'form.position' },
                },
            },
            { kind: 'close_modal', modalId: 'cmp_bidm1mod' },
            { kind: 'reset_form', form: 'newdim1' },
            { kind: 'refresh', tableId: T.dimCategories },
            { kind: 'toast', message: 'Category added. Facts using its key group under it straight away.', tone: 'success' },
        ],
    },
    act_bidim1save: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: T.dimCategories,
                recordId: { kind: 'formula', expr: 'form.id' },
                values: {
                    position: { kind: 'formula', expr: 'form.position' },
                    name: { kind: 'formula', expr: 'form.name' },
                    description: { kind: 'formula', expr: 'form.description' },
                },
            },
            { kind: 'refresh', tableId: T.dimCategories },
        ],
    },
    act_bidim1del: {
        kind: 'sequence',
        steps: [
            { kind: 'confirm', message: 'Delete this category? Fact rows keep their text key, so nothing breaks — the key just stops resolving to a dimension row.', title: 'Delete category' },
            { kind: 'delete_record', tableId: T.dimCategories, recordId: { kind: 'formula', expr: 'item.id' } },
            { kind: 'refresh', tableId: T.dimCategories },
        ],
    },

    act_bidim2open: { kind: 'open_modal', modalId: 'cmp_bidm2mod' },
    act_bidim2add: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: T.dimEntities,
                values: {
                    key: { kind: 'formula', expr: 'form.key' },
                    name: { kind: 'formula', expr: 'form.name' },
                    description: { kind: 'formula', expr: 'form.description' },
                    position: { kind: 'formula', expr: 'form.position' },
                },
            },
            { kind: 'close_modal', modalId: 'cmp_bidm2mod' },
            { kind: 'reset_form', form: 'newdim2' },
            { kind: 'refresh', tableId: T.dimEntities },
            { kind: 'toast', message: 'Entity added.', tone: 'success' },
        ],
    },
    act_bidim2save: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: T.dimEntities,
                recordId: { kind: 'formula', expr: 'form.id' },
                values: {
                    position: { kind: 'formula', expr: 'form.position' },
                    name: { kind: 'formula', expr: 'form.name' },
                    description: { kind: 'formula', expr: 'form.description' },
                },
            },
            { kind: 'refresh', tableId: T.dimEntities },
        ],
    },
    act_bidim2del: {
        kind: 'sequence',
        steps: [
            { kind: 'confirm', message: 'Delete this entity? Fact rows keep their text key.', title: 'Delete entity' },
            { kind: 'delete_record', tableId: T.dimEntities, recordId: { kind: 'formula', expr: 'item.id' } },
            { kind: 'refresh', tableId: T.dimEntities },
        ],
    },
};

const definition = {
    schemaVersion: 2,
    meta: {
        name: 'BI reports',
        description: 'A small relational warehouse, a report designer with live preview, and a slot dashboard.',
        icon: 'BarChart3',
    },
    theme: { primary: '#0891B2', ...THEME_DEFAULTS },
    design: { preset: 'custom', font: 'satoshi', surface: 'soft', motion: 'subtle', chartPalette: 'brand', accentEdge: 'bar', logoUrl: null },
    nav: { style: 'sidebar' },
    roles: [
        { id: 'analyst', name: 'Analyst' },
        { id: 'viewer', name: 'Viewer' },
    ],
    /**
     * The slot variables ARE the dashboard state. Their DEFAULTS mirror the
     * seeded reports for slots 1–3 (appBiReports.test.js pins the mirror), so
     * the dashboard is alive on the very first open with no click and no
     * fetch-order luck; 4–6 start empty and show their hints. `filters` is
     * NOT declared — it is reserved for the filter_bar.
     */
    variables: [
        { name: 'slot1', label: 'Dashboard slot 1', type: 'record', default: slotDefault('Amount by category', 'bar', 'category_key', 'sum', 'amount', 1), description: 'The report shape slot 1 renders. Defaults to the seeded slot-1 report; rewritten by saving a report into slot 1 or by “Show saved reports”.' },
        { name: 'slot2', label: 'Dashboard slot 2', type: 'record', default: slotDefault('Monthly amount trend', 'line', 'month', 'sum', 'amount', 2), description: 'The report shape slot 2 renders.' },
        { name: 'slot3', label: 'Dashboard slot 3', type: 'record', default: slotDefault('Quantity by entity', 'donut', 'entity_key', 'sum', 'quantity', 3), description: 'The report shape slot 3 renders.' },
        { name: 'slot4', label: 'Dashboard slot 4', type: 'record', default: {}, description: 'Empty until a report is saved into slot 4.' },
        { name: 'slot5', label: 'Dashboard slot 5', type: 'record', default: {}, description: 'Empty until a report is saved into slot 5.' },
        { name: 'slot6', label: 'Dashboard slot 6', type: 'record', default: {}, description: 'Empty until a report is saved into slot 6.' },
        { name: 'staged', label: 'Pending staging rows', type: 'list', default: [], description: 'Snapshot of the pending staging rows the load action is moving — taken before the loop so mid-loop updates cannot shrink it.' },
        { name: 'run', label: 'Current load run', type: 'record', default: {}, description: 'The load_runs row the load action just created; its id stamps every fact row of that load.' },
    ],
    homeScreenId: 'scr_bidash',
    screens: [
        SCREEN_DASHBOARD,
        SCREEN_DESIGNER,
        SCREEN_LOAD,
        SCREEN_WAREHOUSE,
        SCREEN_SETUP,
    ],
    actions,
};

// ---------------------------------------------------------------------------
// Seed
//
// A warehouse that LOOKS ALIVE on first open: six categories × six entities,
// forty fact rows spread over March–August 2026 (two logged load runs whose
// rows_loaded genuinely equal the rows that reference them), a handful of
// pending staging rows so the Load screen has something to move, and four
// saved reports — three pre-assigned to dashboard slots 1–3, one library-only
// so the designer grid shows both states.
//
// `$id` is a LOCAL alias, never a column; { $ref } points at a row seeded
// earlier — templateInstall orders parent tables first (dims and load runs
// before facts) and rewrites the refs to real ids.
// ---------------------------------------------------------------------------

const seed = {
    [T.dimCategories]: [
        { $id: 'dc_hw', key: 'hardware', name: 'Hardware', description: 'Physical goods. Rename these six to whatever your first dimension really is — cost centres, product lines, teams.', position: 1 },
        { $id: 'dc_sw', key: 'software', name: 'Software', description: 'Software products.', position: 2 },
        { $id: 'dc_sv', key: 'services', name: 'Services', description: 'Billable project work.', position: 3 },
        { $id: 'dc_su', key: 'support', name: 'Support', description: 'Support contracts and renewals.', position: 4 },
        { $id: 'dc_tr', key: 'training', name: 'Training', description: 'Courses and workshops.', position: 5 },
        { $id: 'dc_li', key: 'licenses', name: 'Licenses', description: 'Licence packs and subscriptions.', position: 6 },
    ],

    [T.dimEntities]: [
        { $id: 'de_no', key: 'north', name: 'North', description: 'The second dimension is just as renameable — regions here, but customers or projects work the same.', position: 1 },
        { $id: 'de_so', key: 'south', name: 'South', description: 'Southern region.', position: 2 },
        { $id: 'de_ea', key: 'east', name: 'East', description: 'Eastern region.', position: 3 },
        { $id: 'de_we', key: 'west', name: 'West', description: 'Western region.', position: 4 },
        { $id: 'de_on', key: 'online', name: 'Online', description: 'Direct online channel.', position: 5 },
        { $id: 'de_pa', key: 'partner', name: 'Partner', description: 'Partner-sourced business.', position: 6 },
    ],

    [T.loads]: [
        { $id: 'run_hist', ran_at: '2026-07-01T08:30:00.000Z', source: 'backfill', rows_loaded: 24, status: 'done', note: 'Initial backfill of the demo warehouse (March–June).' },
        { $id: 'run_aug', ran_at: '2026-08-08T07:45:00.000Z', source: 'staging', rows_loaded: 16, status: 'done', note: 'July–August staging load.' },
    ],

    [T.facts]: [
        // ── March–June: the backfill run (24 rows). ─────────────────────────
        { record_date: '2026-03-04', label: 'Workstations — North', category_key: 'hardware', entity_key: 'north', category_id: { $ref: 'dc_hw' }, entity_id: { $ref: 'de_no' }, amount: 5200, quantity: 8, source: 'demo', load_run_id: { $ref: 'run_hist' } },
        { record_date: '2026-03-09', label: 'CRM licences — Online', category_key: 'licenses', entity_key: 'online', category_id: { $ref: 'dc_li' }, entity_id: { $ref: 'de_on' }, amount: 2400, quantity: 12, source: 'demo', load_run_id: { $ref: 'run_hist' } },
        { record_date: '2026-03-12', label: 'Onboarding services — South', category_key: 'services', entity_key: 'south', category_id: { $ref: 'dc_sv' }, entity_id: { $ref: 'de_so' }, amount: 3600, quantity: 3, source: 'demo', load_run_id: { $ref: 'run_hist' } },
        { record_date: '2026-03-17', label: 'Support renewal — West', category_key: 'support', entity_key: 'west', category_id: { $ref: 'dc_su' }, entity_id: { $ref: 'de_we' }, amount: 1450, quantity: 5, source: 'demo', load_run_id: { $ref: 'run_hist' } },
        { record_date: '2026-03-21', label: 'Analytics suite — Partner', category_key: 'software', entity_key: 'partner', category_id: { $ref: 'dc_sw' }, entity_id: { $ref: 'de_pa' }, amount: 3100, quantity: 7, source: 'demo', load_run_id: { $ref: 'run_hist' } },
        { record_date: '2026-03-27', label: 'Training day — East', category_key: 'training', entity_key: 'east', category_id: { $ref: 'dc_tr' }, entity_id: { $ref: 'de_ea' }, amount: 980, quantity: 2, source: 'demo', load_run_id: { $ref: 'run_hist' } },
        { record_date: '2026-04-02', label: 'Laptops — South', category_key: 'hardware', entity_key: 'south', category_id: { $ref: 'dc_hw' }, entity_id: { $ref: 'de_so' }, amount: 4700, quantity: 6, source: 'demo', load_run_id: { $ref: 'run_hist' } },
        { record_date: '2026-04-08', label: 'Reporting add-on — Online', category_key: 'software', entity_key: 'online', category_id: { $ref: 'dc_sw' }, entity_id: { $ref: 'de_on' }, amount: 1900, quantity: 9, source: 'demo', load_run_id: { $ref: 'run_hist' } },
        { record_date: '2026-04-11', label: 'Migration services — North', category_key: 'services', entity_key: 'north', category_id: { $ref: 'dc_sv' }, entity_id: { $ref: 'de_no' }, amount: 5100, quantity: 4, source: 'demo', load_run_id: { $ref: 'run_hist' } },
        { record_date: '2026-04-16', label: 'Support renewal — East', category_key: 'support', entity_key: 'east', category_id: { $ref: 'dc_su' }, entity_id: { $ref: 'de_ea' }, amount: 1320, quantity: 4, source: 'demo', load_run_id: { $ref: 'run_hist' } },
        { record_date: '2026-04-22', label: 'Team training — Partner', category_key: 'training', entity_key: 'partner', category_id: { $ref: 'dc_tr' }, entity_id: { $ref: 'de_pa' }, amount: 1600, quantity: 3, source: 'demo', load_run_id: { $ref: 'run_hist' } },
        { record_date: '2026-04-28', label: 'Licence pack — West', category_key: 'licenses', entity_key: 'west', category_id: { $ref: 'dc_li' }, entity_id: { $ref: 'de_we' }, amount: 2750, quantity: 15, source: 'demo', load_run_id: { $ref: 'run_hist' } },
        { record_date: '2026-05-05', label: 'Rack servers — Partner', category_key: 'hardware', entity_key: 'partner', category_id: { $ref: 'dc_hw' }, entity_id: { $ref: 'de_pa' }, amount: 8900, quantity: 3, source: 'demo', load_run_id: { $ref: 'run_hist' } },
        { record_date: '2026-05-09', label: 'Security suite — North', category_key: 'software', entity_key: 'north', category_id: { $ref: 'dc_sw' }, entity_id: { $ref: 'de_no' }, amount: 3400, quantity: 6, source: 'demo', load_run_id: { $ref: 'run_hist' } },
        { record_date: '2026-05-13', label: 'Audit services — Online', category_key: 'services', entity_key: 'online', category_id: { $ref: 'dc_sv' }, entity_id: { $ref: 'de_on' }, amount: 2800, quantity: 2, source: 'demo', load_run_id: { $ref: 'run_hist' } },
        { record_date: '2026-05-18', label: 'Priority support — South', category_key: 'support', entity_key: 'south', category_id: { $ref: 'dc_su' }, entity_id: { $ref: 'de_so' }, amount: 2100, quantity: 6, source: 'demo', load_run_id: { $ref: 'run_hist' } },
        { record_date: '2026-05-23', label: 'Workshop — West', category_key: 'training', entity_key: 'west', category_id: { $ref: 'dc_tr' }, entity_id: { $ref: 'de_we' }, amount: 1150, quantity: 2, source: 'demo', load_run_id: { $ref: 'run_hist' } },
        { record_date: '2026-05-29', label: 'Licence pack — East', category_key: 'licenses', entity_key: 'east', category_id: { $ref: 'dc_li' }, entity_id: { $ref: 'de_ea' }, amount: 2300, quantity: 11, source: 'demo', load_run_id: { $ref: 'run_hist' } },
        { record_date: '2026-06-03', label: 'Monitors — Online', category_key: 'hardware', entity_key: 'online', category_id: { $ref: 'dc_hw' }, entity_id: { $ref: 'de_on' }, amount: 2600, quantity: 14, source: 'demo', load_run_id: { $ref: 'run_hist' } },
        { record_date: '2026-06-08', label: 'Planning suite — South', category_key: 'software', entity_key: 'south', category_id: { $ref: 'dc_sw' }, entity_id: { $ref: 'de_so' }, amount: 2950, quantity: 5, source: 'demo', load_run_id: { $ref: 'run_hist' } },
        { record_date: '2026-06-12', label: 'Integration services — West', category_key: 'services', entity_key: 'west', category_id: { $ref: 'dc_sv' }, entity_id: { $ref: 'de_we' }, amount: 4400, quantity: 3, source: 'demo', load_run_id: { $ref: 'run_hist' } },
        { record_date: '2026-06-17', label: 'Support renewal — Partner', category_key: 'support', entity_key: 'partner', category_id: { $ref: 'dc_su' }, entity_id: { $ref: 'de_pa' }, amount: 1700, quantity: 5, source: 'demo', load_run_id: { $ref: 'run_hist' } },
        { record_date: '2026-06-23', label: 'Admin training — North', category_key: 'training', entity_key: 'north', category_id: { $ref: 'dc_tr' }, entity_id: { $ref: 'de_no' }, amount: 1250, quantity: 2, source: 'demo', load_run_id: { $ref: 'run_hist' } },
        { record_date: '2026-06-27', label: 'CRM licences — East', category_key: 'licenses', entity_key: 'east', category_id: { $ref: 'dc_li' }, entity_id: { $ref: 'de_ea' }, amount: 2050, quantity: 10, source: 'demo', load_run_id: { $ref: 'run_hist' } },

        // ── July–August: the staging run (16 rows). ─────────────────────────
        { record_date: '2026-07-02', label: 'Tablets — West', category_key: 'hardware', entity_key: 'west', category_id: { $ref: 'dc_hw' }, entity_id: { $ref: 'de_we' }, amount: 3300, quantity: 9, source: 'staging', load_run_id: { $ref: 'run_aug' } },
        { record_date: '2026-07-07', label: 'Analytics suite — South', category_key: 'software', entity_key: 'south', category_id: { $ref: 'dc_sw' }, entity_id: { $ref: 'de_so' }, amount: 3250, quantity: 6, source: 'staging', load_run_id: { $ref: 'run_aug' } },
        { record_date: '2026-07-10', label: 'Rollout services — Partner', category_key: 'services', entity_key: 'partner', category_id: { $ref: 'dc_sv' }, entity_id: { $ref: 'de_pa' }, amount: 5600, quantity: 4, source: 'staging', load_run_id: { $ref: 'run_aug' } },
        { record_date: '2026-07-15', label: 'Priority support — North', category_key: 'support', entity_key: 'north', category_id: { $ref: 'dc_su' }, entity_id: { $ref: 'de_no' }, amount: 2250, quantity: 7, source: 'staging', load_run_id: { $ref: 'run_aug' } },
        { record_date: '2026-07-18', label: 'Training week — Online', category_key: 'training', entity_key: 'online', category_id: { $ref: 'dc_tr' }, entity_id: { $ref: 'de_on' }, amount: 2100, quantity: 4, source: 'staging', load_run_id: { $ref: 'run_aug' } },
        { record_date: '2026-07-22', label: 'Licence pack — Partner', category_key: 'licenses', entity_key: 'partner', category_id: { $ref: 'dc_li' }, entity_id: { $ref: 'de_pa' }, amount: 3050, quantity: 16, source: 'staging', load_run_id: { $ref: 'run_aug' } },
        { record_date: '2026-07-27', label: 'Workstations — East', category_key: 'hardware', entity_key: 'east', category_id: { $ref: 'dc_hw' }, entity_id: { $ref: 'de_ea' }, amount: 4950, quantity: 7, source: 'staging', load_run_id: { $ref: 'run_aug' } },
        { record_date: '2026-07-30', label: 'Reporting add-on — North', category_key: 'software', entity_key: 'north', category_id: { $ref: 'dc_sw' }, entity_id: { $ref: 'de_no' }, amount: 1850, quantity: 8, source: 'staging', load_run_id: { $ref: 'run_aug' } },
        { record_date: '2026-08-03', label: 'Laptops — Online', category_key: 'hardware', entity_key: 'online', category_id: { $ref: 'dc_hw' }, entity_id: { $ref: 'de_on' }, amount: 5150, quantity: 7, source: 'staging', load_run_id: { $ref: 'run_aug' } },
        { record_date: '2026-08-05', label: 'Security suite — West', category_key: 'software', entity_key: 'west', category_id: { $ref: 'dc_sw' }, entity_id: { $ref: 'de_we' }, amount: 3500, quantity: 6, source: 'staging', load_run_id: { $ref: 'run_aug' } },
        { record_date: '2026-08-07', label: 'Data services — East', category_key: 'services', entity_key: 'east', category_id: { $ref: 'dc_sv' }, entity_id: { $ref: 'de_ea' }, amount: 3900, quantity: 3, source: 'staging', load_run_id: { $ref: 'run_aug' } },
        { record_date: '2026-08-10', label: 'Support renewal — Online', category_key: 'support', entity_key: 'online', category_id: { $ref: 'dc_su' }, entity_id: { $ref: 'de_on' }, amount: 1550, quantity: 5, source: 'staging', load_run_id: { $ref: 'run_aug' } },
        { record_date: '2026-08-11', label: 'Admin training — South', category_key: 'training', entity_key: 'south', category_id: { $ref: 'dc_tr' }, entity_id: { $ref: 'de_so' }, amount: 1050, quantity: 2, source: 'staging', load_run_id: { $ref: 'run_aug' } },
        { record_date: '2026-08-12', label: 'CRM licences — North', category_key: 'licenses', entity_key: 'north', category_id: { $ref: 'dc_li' }, entity_id: { $ref: 'de_no' }, amount: 2650, quantity: 13, source: 'staging', load_run_id: { $ref: 'run_aug' } },
        { record_date: '2026-08-13', label: 'Monitors — Partner', category_key: 'hardware', entity_key: 'partner', category_id: { $ref: 'dc_hw' }, entity_id: { $ref: 'de_pa' }, amount: 2200, quantity: 12, source: 'staging', load_run_id: { $ref: 'run_aug' } },
        { record_date: '2026-08-14', label: 'Migration services — South', category_key: 'services', entity_key: 'south', category_id: { $ref: 'dc_sv' }, entity_id: { $ref: 'de_so' }, amount: 4800, quantity: 4, source: 'staging', load_run_id: { $ref: 'run_aug' } },
    ],

    [T.staging]: [
        // Pending — what "Load staged rows" will move. One already-loaded row
        // shows the other badge state.
        { record_date: '2026-08-14', label: 'Rack servers — North', category_key: 'hardware', entity_key: 'north', amount: 9100, quantity: 3, source: 'connector-demo', status: 'pending' },
        { record_date: '2026-08-14', label: 'Planning suite — Online', category_key: 'software', entity_key: 'online', amount: 2850, quantity: 5, source: 'connector-demo', status: 'pending' },
        { record_date: '2026-08-15', label: 'Priority support — West', category_key: 'support', entity_key: 'west', amount: 2050, quantity: 6, source: 'connector-demo', status: 'pending' },
        { record_date: '2026-08-15', label: 'Workshop — Partner', category_key: 'training', entity_key: 'partner', amount: 1350, quantity: 2, source: 'connector-demo', status: 'pending' },
        { record_date: '2026-08-15', label: 'Licence pack — South', category_key: 'licenses', entity_key: 'south', amount: 2400, quantity: 12, source: 'connector-demo', status: 'pending' },
        { record_date: '2026-08-12', label: 'CRM licences — North', category_key: 'licenses', entity_key: 'north', amount: 2650, quantity: 13, source: 'connector-demo', status: 'loaded' },
    ],

    [T.reports]: [
        // Slots 1–3 mirror the slot variable DEFAULTS above — the test pins it.
        { name: 'Amount by category', description: 'Total amount split by product category.', chart_type: 'bar', group_field: 'category_key', measure_fn: 'sum', measure_field: 'amount', slot: 1 },
        { name: 'Monthly amount trend', description: 'Total amount per month — the warehouse heartbeat.', chart_type: 'line', group_field: 'month', measure_fn: 'sum', measure_field: 'amount', slot: 2 },
        { name: 'Quantity by entity', description: 'Units per entity.', chart_type: 'donut', group_field: 'entity_key', measure_fn: 'sum', measure_field: 'quantity', slot: 3 },
        { name: 'Rows per source', description: 'Where warehouse rows come from. Library-only until you give it a slot.', chart_type: 'bar', group_field: 'source', measure_fn: 'count', measure_field: 'amount', slot: 0 },
    ],
};

module.exports = {
    id: 'app-bi-reports',
    version: 1,
    title: 'BI reports',
    description: 'A self-service reporting workspace: a small relational warehouse your connectors fill, a report designer with a live preview, and a six-slot dashboard of the reports your team saves.',
    category: 'Data',
    icon: 'BarChart3',
    tags: ['bi', 'reports', 'dashboard', 'warehouse', 'analytics', 'charts'],
    definition,
    dataModel,
    seed,
};
