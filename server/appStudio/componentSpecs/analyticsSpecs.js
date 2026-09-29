/**
 * App Studio catalog — the analytics surfaces: the data grid, the chart and
 * the pivot.
 */

'use strict';

const { LIMITS } = require('./limits');
const { COLOR_ROLES } = require('./styleKnobs');

const ANALYTICS_SPECS = {
    // ── v2 data & visualization ──────────────────────────────────────────
    data_grid: {
        label: 'Data grid', category: 'Data',
        description: 'A powerful table over an array of objects: sortable/filterable columns, paging, selection, search and row actions.',
        events: ['onRowClick', 'onRowSelect'],
        props: {
            source: { type: 'binding', default: { kind: 'static', value: [] } },
            columns: {
                type: 'list', maxItems: LIMITS.MAX_DATA_GRID_COLUMNS, default: [],
                itemShape: {
                    key: { type: 'string', required: true, maxLen: 120 },
                    label: { type: 'string', maxLen: 120 },
                    // APPENDED, never reordered — 'text' stays the default and
                    // every stored column keeps its exact rendering.
                    format: {
                        type: 'enum',
                        values: [
                            'text', 'number', 'date', 'badge', 'link', 'boolean', 'relation',
                            'currency', 'percent', 'datetime', 'relative', 'check', 'tags', 'progress', 'user',
                            // A quantity list the value already writes as "2x M5 + 4x M8":
                            // rendered as one chip per part, count set apart from label.
                            // As plain text it wraps to many lines and takes the whole
                            // row's height with it.
                            'breakdown',
                            // A 3D file (.step/.iges) drawn as a small picture in the
                            // cell, opening full size on click. Only a `file`
                            // column can carry one; anything else stays a dash.
                            'cad',
                            // A drawing or scan on the row: a small tile that opens
                            // the PDF (or image) full screen. Same gesture as 'cad',
                            // different file.
                            'document',
                        ],
                        default: 'text',
                    },
                    width: { type: 'int', min: 40, max: 800 },
                    sortable: { type: 'boolean' },
                    filterable: { type: 'boolean' },
                    editable: { type: 'boolean' },
                    // 'auto' right-aligns the numeric formats and left-aligns
                    // the rest. Identity: 'auto' is what every stored column
                    // already got, because nothing else was on offer.
                    align: { type: 'enum', values: ['auto', 'left', 'right', 'center'], default: 'auto' },
                    truncate: { type: 'boolean' },
                    // Off the screen, still in the definition — so a toneFrom or
                    // labelFrom can point at a column the viewer never sees.
                    hidden: { type: 'boolean' },
                    // A sibling column whose value IS the tone. This is how a
                    // config table's own `color` column finally reaches the
                    // pill, instead of every status on every screen being grey.
                    toneFrom: { type: 'string', maxLen: 120 },
                    // A sibling column holding the readable name for a `user`
                    // column that stores an id.
                    labelFrom: { type: 'string', maxLen: 120 },
                    // A sibling column rendered as a second, smaller line under
                    // the cell value — "what is wrong with this row" belongs
                    // under the description, not in a column of its own.
                    subtextFrom: { type: 'string', maxLen: 120 },
                    // A sibling column whose value colours the subtext: mapped
                    // through this column's toneMap (value→tone), or taken as a
                    // tone name itself.
                    subtextToneFrom: { type: 'string', maxLen: 120 },
                    // Identity first: 'pill' is the existing badge rendering.
                    // 'dot' keeps the pill and adds a 6px dot in the tone colour.
                    badgeStyle: { type: 'enum', values: ['pill', 'dot'], default: 'pill' },
                    // A sibling column whose truthy value renders as a small
                    // uppercase inline badge beside the main text (SPOED-style
                    // markers that must not need their own column).
                    flagFrom: { type: 'string', maxLen: 120 },
                    flagTone: { type: 'enum', values: COLOR_ROLES, default: 'warning' },
                    // The tone an EMPTY cell takes. In most columns a gap is an
                    // absence and the muted dash is right; in a column where a
                    // gap is a defect — the material a part cannot be cut
                    // without — the dash has to be the colour of a problem.
                    emptyTone: { type: 'enum', values: COLOR_ROLES, default: null },
                    // Per-value tones for a `badge`/`tags` column whose table has
                    // no colour of its own. Same shape as list.badgeToneMap. On a
                    // text/number column the resolved tone colours the text
                    // itself (there is no pill to colour).
                    toneMap: {
                        type: 'list', maxItems: 16,
                        itemShape: {
                            value: { type: 'string', required: true, maxLen: 200 },
                            label: { type: 'string', maxLen: 80 },
                            tone: { type: 'enum', values: COLOR_ROLES, default: 'neutral' },
                        },
                    },
                    // One line explaining what lives in this column, shown on
                    // hover over its header. Labels get abbreviated to fit
                    // ("Snijkw.", "Afbr.", "Cert.") and then only the person who
                    // built the table knows what the numbers under them mean;
                    // everyone else guesses, or asks whoever built it.
                    help: { type: 'string', maxLen: 200 },
                    // Make THIS cell a button. A status column is the thing
                    // people reach for when they want to change the status, and
                    // sending them to a separate button at the end of the row to
                    // do it is a detour they have to be taught. The action gets
                    // the row as `item` and as form values, like a row action.
                    actionId: { type: 'string', maxLen: 20 },
                },
            },
            pageSize: { type: 'int', min: 5, max: 100, default: 25 },
            selectable: { type: 'enum', values: ['none', 'single', 'multi'], default: 'none' },
            searchable: { type: 'boolean', default: false },
            rowActions: {
                type: 'list', maxItems: 8, default: [],
                itemShape: { label: { type: 'string', required: true, maxLen: 80 }, actionId: { type: 'string', maxLen: 20 } },
            },
            // Actions on the SELECTION, shown in the bar that appears once rows
            // are ticked. Selection was already possible and led nowhere: you
            // could tick twenty rows and the only thing on offer was "Clear".
            //
            // The action receives the picked rows as form values —
            // `form.selectedRows` (the records), `form.selectedIds` and
            // `form.selectedCount` — so a bulk delete is an ordinary loop over
            // form.selectedRows, with no new scope root to learn. Needs
            // selectable 'multi' (or 'single') to be reachable at all.
            // Buttons in the table's OWN toolbar, beside the search box.
            // Without these an action that belongs to this table (export it,
            // regenerate it) had to live in a page header above — which meant a
            // second title bar repeating the tab's name just to have somewhere
            // to put a button, and a row of chrome between the reader and the
            // rows. A tone of 'primary' fills the button; anything else outlines it.
            toolbarActions: {
                type: 'list', maxItems: 4, default: [],
                itemShape: {
                    label: { type: 'string', required: true, maxLen: 80 },
                    actionId: { type: 'string', maxLen: 20 },
                    tone: { type: 'enum', values: COLOR_ROLES, default: 'neutral' },
                },
            },
            // An "add a row" line at the FOOT of the table, inside it rather
            // than as a button floating above the screen. A table people add to
            // all day should carry that where the rows are: the last line is
            // where your eye already is when you notice one is missing, and a
            // button in the page header belongs to the page, not to this table.
            addRowLabel: { type: 'string', maxLen: 80 },
            addRowActionId: { type: 'string', maxLen: 20 },
            bulkActions: {
                type: 'list', maxItems: 4, default: [],
                itemShape: {
                    label: { type: 'string', required: true, maxLen: 80 },
                    actionId: { type: 'string', maxLen: 20 },
                    tone: { type: 'enum', values: COLOR_ROLES, default: 'neutral' },
                },
            },
            density: { type: 'enum', values: ['compact', 'comfortable', 'spacious'], default: 'comfortable' },
            // How many lines one cell may take before it is cut off. 'off' is
            // wrap-forever, which is right until a single free-text column
            // decides the height of every row: a table with two eight-line
            // remarks in it has no scannable rows left, however good the other
            // thirteen columns are. Set this where long prose shares a table
            // with short facts. The reader can override it per grid (View
            // menu) and the full value stays in the cell's tooltip, so nothing
            // is lost by clamping — only by pretending prose is a data point.
            clamp: { type: 'enum', values: ['1', '2', '3', 'off'], default: 'off' },
            // Mark whole ROWS, not cells. A status column says "check this one"
            // in a badge that, on a fifteen-column table, sits past the right
            // edge of the screen — so the one row that needed a human was the
            // least visible thing on it. A rule here paints the row's left edge
            // and tints it, which reads before anything is scrolled or parsed.
            // Rules are tried in order and the first match wins, so put the
            // loudest one first; a row matching nothing is drawn normally.
            rowTone: {
                type: 'list', maxItems: 8, default: [],
                itemShape: {
                    field: { type: 'string', required: true, maxLen: 100 },
                    value: { type: 'string', required: true, maxLen: 200 },
                    tone: { type: 'enum', values: COLOR_ROLES, default: 'neutral' },
                },
            },
            // Rows grouped under clickable header rows. Null (the default) is
            // the identity path: no grouping, byte-identical rendering.
            groupBy: {
                type: 'string', maxLen: 120, default: null,
                description: 'Column key to group rows under collapsible header rows.',
            },
            // Fixed group order + per-group header label/tone/initial collapse.
            // Values missing from the data render no header; values missing
            // from this list follow the listed ones, in data order.
            groupOrder: {
                type: 'list', maxItems: 8, default: [],
                itemShape: {
                    value: { type: 'string', required: true, maxLen: 200 },
                    label: { type: 'string', maxLen: 80 },
                    tone: { type: 'enum', values: COLOR_ROLES, default: 'neutral' },
                    collapsed: { type: 'boolean', default: false },
                },
                description: 'Group order; unlisted values follow in data order. collapsed:true starts a group closed.',
            },
            // The vars-driven master/detail pattern, made visible: the row an
            // onRowClick action stored in a variable gets the accent wash and
            // edge bar, without touching the (overloaded) onRowSelect event.
            activeWhen: {
                type: 'formula', default: null,
                description: 'Formula per row (item, index in scope); a match highlights the row as active.',
            },
            // Alternating row tint — helps the eye track a row across many
            // columns. Off by default: it is noise on a short, wide-spaced grid.
            zebra: { type: 'boolean', default: false },
            emptyText: { type: 'string', maxLen: 200, default: 'Nothing to show yet.' },
            // Look pass. `zebra` predates this and stays honoured — it is the
            // same effect as look:'striped', kept so stored grids keep their
            // stripes without a migration; `look` wins when both are set.
            look: {
                type: 'enum', values: ['default', 'striped', 'minimal', 'cards'], default: 'default',
                description: 'default = the current ruled grid; striped = zebra rows; minimal = borderless rows; cards = each row rendered as its own card.',
            },
        },
        styleKnobs: ['span', 'size', 'height'],
        defaultStyle: { span: 12 },
    },
    chart: {
        label: 'Chart', category: 'Data',
        description: 'A bar/line/area/pie/donut chart over an array of objects. x-axis from xKey, one or more series by key. xType:"time" spaces points by date rather than evenly, so a gap in the data reads as a gap. referenceLines/referenceBands draw a target or healthy range behind the series; unitLabel suffixes the axis and tooltip. onRowClick fires with the clicked row.',
        props: {
            chartType: { type: 'enum', values: ['bar', 'line', 'area', 'pie', 'donut'], default: 'bar' },
            // Identity first: 'vertical' is the standing bars chart has always
            // drawn. Only meaningful for chartType 'bar'; other types ignore it.
            orientation: {
                type: 'enum', values: ['vertical', 'horizontal'], default: 'vertical',
                description: 'bar only: horizontal = categories on the Y axis, value labels right of the bars.',
            },
            source: { type: 'binding', default: { kind: 'static', value: [] } },
            title: { type: 'string', maxLen: 120, default: null },
            xKey: { type: 'string', maxLen: 120, default: 'label' },
            // 'category' spaces points evenly by position; 'time' parses xKey as
            // a date and spaces them by elapsed time. A weight history with a
            // three-week hole is a straight line under 'category' and an honest
            // gap under 'time'.
            xType: { type: 'enum', values: ['category', 'time'], default: 'category' },
            series: {
                type: 'list', maxItems: LIMITS.MAX_CHART_SERIES, default: [],
                itemShape: {
                    key: { type: 'string', required: true, maxLen: 120 },
                    label: { type: 'string', maxLen: 120 },
                    color: { type: 'string', maxLen: 40 },
                },
            },
            stacked: { type: 'boolean', default: false },
            showLegend: { type: 'boolean', default: true },
            showGrid: { type: 'boolean', default: true },
            valueFormat: { type: 'enum', values: ['number', 'percent', 'currency'], default: 'number' },
            // Null means "let the data decide". Pinning one end is what makes
            // two charts of the same measurement comparable at a glance.
            yMin: { type: 'number', default: null },
            yMax: { type: 'number', default: null },
            referenceLines: {
                type: 'list', maxItems: LIMITS.MAX_CHART_REFERENCES, default: [],
                itemShape: {
                    value: { type: 'number', required: true },
                    label: { type: 'string', maxLen: 60 },
                    color: { type: 'string', maxLen: 40 },
                },
            },
            referenceBands: {
                type: 'list', maxItems: LIMITS.MAX_CHART_REFERENCES, default: [],
                itemShape: {
                    from: { type: 'number', required: true },
                    to: { type: 'number', required: true },
                    label: { type: 'string', maxLen: 60 },
                    color: { type: 'string', maxLen: 40 },
                },
            },
            // A bare number on a health axis is unreadable — 72 what?
            unitLabel: { type: 'string', maxLen: 20, default: null },
        },
        events: ['onRowClick'],
        styleKnobs: ['span', 'height'],
        defaultStyle: { span: 6, height: 'md' },
    },
    pivot: {
        label: 'Pivot table', category: 'Data',
        description: 'A cross-tab over an array of objects: group by row and column dimensions, aggregate value fields.',
        props: {
            source: { type: 'binding', default: { kind: 'static', value: [] } },
            rows: {
                type: 'list', maxItems: 6, default: [],
                itemShape: { key: { type: 'string', required: true, maxLen: 120 }, label: { type: 'string', maxLen: 120 } },
            },
            columns: {
                type: 'list', maxItems: 6, default: [],
                itemShape: { key: { type: 'string', required: true, maxLen: 120 }, label: { type: 'string', maxLen: 120 } },
            },
            values: {
                type: 'list', maxItems: 6, default: [],
                itemShape: {
                    key: { type: 'string', required: true, maxLen: 120 },
                    agg: { type: 'enum', values: ['sum', 'avg', 'count', 'min', 'max'], default: 'sum' },
                    label: { type: 'string', maxLen: 120 },
                    format: { type: 'enum', values: ['number', 'percent', 'currency', 'date'], default: 'number' },
                },
            },
            showTotals: { type: 'boolean', default: true },
            emptyText: { type: 'string', maxLen: 200, default: 'Nothing to show yet.' },
        },
        styleKnobs: ['span', 'size'],
        defaultStyle: { span: 12 },
    },
};

module.exports = {
    ANALYTICS_SPECS,
};
