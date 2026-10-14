import { deepFreeze } from './sampleFixtureFreeze';

/**
 * V2_SHOWCASE — the additive v2 logic-runtime fixture. Exercises the new,
 * formula-driven surfaces on top of the v1 schema (which stays byte-identical
 * in KITCHEN_SINK):
 *   - a `formula` value binding on a stat (kind:'formula', expr);
 *   - `visibleWhen` on a heading (a formula string evaluated against scope);
 *   - `enabledWhen` on a button (disables via the inert wrapper when false);
 *   - `validations` on an input (a rules array — {type, value?/expr?, message});
 *   - a repeating container (`repeat` binding → array) whose child text uses a
 *     `computed` prop reading the per-row `item` scope.
 * Every field is optional and back-compatible, so a v1 renderer ignores them.
 */
export const V2_SHOWCASE = deepFreeze({
    schemaVersion: 1,
    meta: {
        name: 'Logic showcase',
        description: 'Formula bindings, visibility, validation and per-row scope.',
        icon: 'LayoutGrid',
    },
    theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' },
    homeScreenId: 'scr_v2main',
    screens: [
        {
            id: 'scr_v2main',
            name: 'Main',
            icon: 'LayoutDashboard',
            showInNav: true,
            maxWidth: 'medium',
            sections: [
                {
                    id: 'sec_v2a',
                    style: { padding: 4, gap: 3, background: 'none' },
                    children: [
                        {
                            id: 'cmp_v2stat', type: 'stat', visible: true,
                            props: {
                                label: 'Computed total',
                                value: { kind: 'formula', expr: '2 + 2' },
                                caption: 'a formula binding', icon: 'Activity',
                            },
                            style: { span: 3, size: 'md', align: 'start', color: 'primary' },
                        },
                        {
                            id: 'cmp_v2hd', type: 'heading', visible: true,
                            visibleWhen: 'currentUser != null',
                            props: { text: 'Welcome back', level: 3 },
                            style: { span: 12, align: 'start', color: null },
                        },
                        {
                            id: 'cmp_v2btn', type: 'button', visible: true, onClick: 'act_v2toast',
                            enabledWhen: 'form.quantity > 0',
                            props: { label: 'Notify me', variant: 'secondary', iconLeft: null, role: 'button' },
                            style: { span: 3, size: 'md', align: 'start' },
                        },
                        {
                            id: 'cmp_v2form', type: 'form', visible: true, onSubmit: 'act_v2submit',
                            props: { name: 'req', submitLabel: 'Save', showReset: false },
                            style: { span: 12, gap: 3, padding: 0 },
                            children: [
                                {
                                    id: 'cmp_v2qty', type: 'input_number', visible: true,
                                    props: {
                                        name: 'quantity', label: 'Quantity', min: 1, max: 99, step: 1,
                                        required: true, defaultValue: 1,
                                    },
                                    validations: [
                                        { type: 'min', value: 1, message: 'Enter at least one.' },
                                        { type: 'expr', expr: 'form.quantity <= 99', message: 'That is too many.' },
                                    ],
                                    style: { span: 6, size: 'md' },
                                },
                            ],
                        },
                        {
                            id: 'cmp_v2rep', type: 'card', visible: true,
                            repeat: { kind: 'static', value: [{ name: 'Alpha' }, { name: 'Beta' }] },
                            props: { title: 'Team', description: null },
                            style: { span: 12, padding: 3, gap: 3, background: 'surface' },
                            children: [
                                {
                                    id: 'cmp_v2item', type: 'text', visible: true,
                                    props: { text: '—', muted: false },
                                    computed: { text: 'item.name' },
                                    style: { span: 12, align: 'start', color: null, weight: 'regular' },
                                },
                            ],
                        },
                    ],
                },
            ],
        },
    ],
    actions: {
        act_v2submit: { kind: 'run_automation', automationId: null },
        act_v2toast: { kind: 'toast', message: 'You will be notified.', tone: 'info' },
    },
});

/**
 * V2_RICH — a fixture that exercises the v2 RICH component library: the
 * data/visual components (data_grid, chart, pivot), the container types
 * (tabs/tab, modal, repeater) and the rich form inputs (file, richtext,
 * datetime, relation, multiselect), all bound to static data so they render
 * their real surfaces (not empty states) offline. The repeater mirrors its
 * props.source into node.forEach so AppRenderer's per-item scope mechanism
 * repeats its child once per row.
 */
const V2_RICH_ROWS = [
    { id: 1, name: 'Ann', region: 'EU', amount: 10, open: 4 },
    { id: 2, name: 'Bo', region: 'US', amount: 20, open: 7 },
    { id: 3, name: 'Cy', region: 'EU', amount: 5, open: 2 },
];
export const V2_RICH = deepFreeze({
    schemaVersion: 2,
    meta: { name: 'Rich components', description: 'Every v2 rich component.', icon: 'LayoutGrid' },
    theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' },
    homeScreenId: 'scr_rich01',
    roles: [],
    screens: [{
        id: 'scr_rich01', name: 'Rich', icon: 'LayoutDashboard', showInNav: true, maxWidth: 'wide',
        sections: [{
            id: 'sec_rich01', style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_rstat1', type: 'stat', visible: true,
                    props: {
                        label: 'Revenue', value: { kind: 'static', value: '1,240' }, caption: 'this week', icon: 'Activity',
                        delta: { kind: 'static', value: 8 }, deltaFormat: 'percent',
                        trend: { kind: 'static', value: [3, 6, 4, 9, 7] }, positiveIsGood: true,
                    },
                    style: { span: 3, size: 'md', align: 'start', color: 'primary' },
                },
                {
                    id: 'cmp_rchrt1', type: 'chart', visible: true,
                    props: {
                        chartType: 'bar', source: { kind: 'static', value: V2_RICH_ROWS }, title: 'By person', xKey: 'name',
                        series: [{ key: 'amount', label: 'Amount' }, { key: 'open', label: 'Open' }],
                        stacked: false, showLegend: true, showGrid: true, valueFormat: 'number',
                    },
                    style: { span: 9, height: 'md' },
                },
                {
                    id: 'cmp_rgrid1', type: 'data_grid', visible: true, onRowSelect: 'act_rtoast', onRowClick: 'act_rtoast',
                    props: {
                        source: { kind: 'static', value: V2_RICH_ROWS },
                        columns: [
                            { key: 'name', label: 'Name', format: 'text', sortable: true, filterable: true },
                            { key: 'amount', label: 'Amount', format: 'number', editable: true },
                            { key: 'region', label: 'Region', format: 'badge' },
                        ],
                        pageSize: 25, selectable: 'multi', searchable: true,
                        rowActions: [{ label: 'Ping', actionId: 'act_rtoast' }],
                        density: 'comfortable', emptyText: 'Nothing to show yet.',
                    },
                    style: { span: 12, size: 'md' },
                },
                {
                    id: 'cmp_rpiv1', type: 'pivot', visible: true,
                    props: {
                        source: { kind: 'static', value: V2_RICH_ROWS },
                        rows: [{ key: 'region', label: 'Region' }],
                        columns: [], values: [{ key: 'amount', agg: 'sum', label: 'Amount', format: 'number' }],
                        showTotals: true, emptyText: 'Nothing to show yet.',
                    },
                    style: { span: 12, size: 'md' },
                },
                {
                    id: 'cmp_rtabs1', type: 'tabs', visible: true, props: {}, style: { span: 12, gap: 3, padding: 0 },
                    children: [
                        { id: 'cmp_rtaba', type: 'tab', visible: true, props: { label: 'One', icon: 'Home' }, style: { gap: 3, padding: 0 }, children: [{ id: 'cmp_rth1', type: 'heading', visible: true, props: { text: 'Tab one', level: 3 }, style: { span: 12 } }] },
                        { id: 'cmp_rtabb', type: 'tab', visible: true, props: { label: 'Two', icon: null }, style: { gap: 3, padding: 0 }, children: [{ id: 'cmp_rth2', type: 'heading', visible: true, props: { text: 'Tab two', level: 3 }, style: { span: 12 } }] },
                    ],
                },
                {
                    id: 'cmp_rmod1', type: 'modal', visible: true, props: { title: 'Details', size: 'md', triggerLabel: 'Open' }, style: { gap: 3, padding: 4 },
                    children: [{ id: 'cmp_rmh1', type: 'heading', visible: true, props: { text: 'Modal body', level: 3 }, style: { span: 12 } }],
                },
                {
                    id: 'cmp_rrep1', type: 'repeater', visible: true,
                    forEach: { kind: 'static', value: V2_RICH_ROWS },
                    props: { source: { kind: 'static', value: V2_RICH_ROWS }, itemActions: [{ label: 'Go', actionId: 'act_rtoast' }], emptyText: 'None.' },
                    style: { span: 12, gap: 3, padding: 0 },
                    children: [{ id: 'cmp_rri1', type: 'text', visible: true, props: { text: '—', muted: false }, computed: { text: 'item.name' }, style: { span: 12 } }],
                },
                {
                    id: 'cmp_rform1', type: 'form', visible: true, onSubmit: 'act_rtoast', props: { name: 'f', submitLabel: 'Save', showReset: false }, style: { span: 12, gap: 3, padding: 0 },
                    children: [
                        { id: 'cmp_rif1', type: 'input_file', visible: true, props: { name: 'file', label: 'File', accept: null, multiple: false, required: false }, style: { span: 6, size: 'md' } },
                        { id: 'cmp_rids1', type: 'input_dataset', visible: true, props: { name: 'genome', label: 'Genome file', required: false, buttonLabel: null, allowExisting: true }, style: { span: 12 } },
                        { id: 'cmp_rbv1', type: 'browser_view', visible: true, props: { actionId: 'act_rtoast', emptyText: null, aspect: '16:10' }, style: { span: 12 } },
                        { id: 'cmp_rirt1', type: 'input_richtext', visible: true, props: { name: 'body', label: 'Body', required: false, defaultValue: 'Hello **world**' }, style: { span: 12 } },
                        { id: 'cmp_rihm1', type: 'input_html', visible: true, props: { name: 'mailbody', label: 'Mail body', required: false, placeholder: null, defaultValue: '<p>Hallo <b>wereld</b></p>', minRows: 8, allowImages: true }, style: { span: 12 } },
                        { id: 'cmp_ridt1', type: 'input_datetime', visible: true, props: { name: 'when', label: 'When', required: false, withTime: true, defaultValue: 'now' }, style: { span: 6, size: 'md' } },
                        { id: 'cmp_rirl1', type: 'input_relation', visible: true, props: { name: 'owner', label: 'Owner', tableId: 't1', displayField: 'name', multiple: true, required: false, filter: null }, style: { span: 6, size: 'md' } },
                        { id: 'cmp_ripr1', type: 'input_person', visible: true, props: { name: 'assignee_id', label: 'Assignee', multiple: false, required: false, allowMe: true }, style: { span: 6, size: 'md' } },
                        { id: 'cmp_rims1', type: 'input_multiselect', visible: true, props: { name: 'tags', label: 'Tags', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], required: false, defaultValue: ['a'] }, style: { span: 6, size: 'md' } },
                    ],
                },
            ],
        }],
    }],
    actions: { act_rtoast: { kind: 'toast', message: 'hi', tone: 'info' } },
});

/**
 * V21_BATCH — a fixture exercising the v2.1 catalog batch: the chrome-free
 * container, page_header (children = action area), the markdown block
 * renderer, the new data displays (badge_list/progress/timeline/record_detail)
 * and the interactive types (filter_bar/kanban/calendar), all statically bound
 * so every real surface renders offline. Kept separate from V2_RICH so tests
 * pinned to that fixture's shape stay untouched.
 */
const V21_TASKS = [
    { id: 'rec_1', title: 'Fix hive', status: 'open', owner: 'Ann', due: '2026-03-03', done: 40, tag: 'urgent' },
    { id: 'rec_2', title: 'Order frames', status: 'open', owner: 'Bo', due: '2026-03-10', done: 10, tag: 'supply' },
    { id: 'rec_3', title: 'Paint boxes', status: 'done', owner: 'Cy', due: '2026-03-27', done: 100, tag: 'yard' },
];
// A conversation exercising all three sides of the message thread.
const V21_MESSAGES = [
    { id: 'msg_1', author_kind: 'requester', author: 'Jan Klant', body: 'Waar blijft mijn pakket?', sent_at: '2026-03-01T09:00:00Z', attachments: [{ filename: 'bon.pdf' }] },
    { id: 'msg_2', author_kind: 'agent', author: 'Ann', body: 'Het is onderweg, morgen bezorgd.', sent_at: '2026-03-01T09:12:00Z', attachments: [] },
    { id: 'msg_3', author_kind: 'system', author: null, body: 'Ticket gesloten', sent_at: '2026-03-02T08:00:00Z', attachments: [] },
];
// Attachment rows for the file gallery: a descriptor plus the metadata columns
// a mailbox connector writes alongside it.
const V21_FILES = [
    { id: 'att_1', filename: 'drawing.pdf', mime_type: 'application/pdf', size: 284213, file: { name: 'drawing.pdf', mimeType: 'application/pdf' } },
    { id: 'att_2', filename: 'photo.jpg', mime_type: 'image/jpeg', size: 91240, file: { name: 'photo.jpg', mimeType: 'image/jpeg' } },
    { id: 'att_3', filename: 'parts.xlsx', mime_type: 'application/vnd.ms-excel', size: 15870, file: { name: 'parts.xlsx', mimeType: 'application/vnd.ms-excel' } },
];
export const V21_BATCH = deepFreeze({
    schemaVersion: 2,
    meta: { name: 'v2.1 components', description: 'Every v2.1 component.', icon: 'LayoutGrid' },
    theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' },
    homeScreenId: 'scr_v21a01',
    roles: [],
    screens: [{
        id: 'scr_v21a01', name: 'Batch', icon: 'LayoutDashboard', showInNav: true, maxWidth: 'wide',
        sections: [{
            id: 'sec_v21a01', style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_v21ph', type: 'page_header', visible: true,
                    props: { title: 'Hive tasks', subtitle: 'Everything in flight', icon: 'LayoutGrid', showDivider: true },
                    style: { span: 12, gap: 3, padding: 0 },
                    children: [
                        { id: 'cmp_v21pb', type: 'button', visible: true, onClick: 'act_v21t', props: { label: 'New task', variant: 'primary', iconLeft: null, role: 'button' }, style: { span: 3 } },
                    ],
                },
                {
                    id: 'cmp_v21ct', type: 'container', visible: true, props: {},
                    style: { span: 6, gap: 3 },
                    children: [
                        { id: 'cmp_v21md', type: 'markdown', visible: true, props: { content: '## Notes\n\nKeep the **smoker** ready.\n\n- check queen\n- refill feeder\n\n```\nbrood ok\n```' }, style: { span: 12 } },
                        { id: 'cmp_v21pr', type: 'progress', visible: true, props: { value: { kind: 'static', value: 40 }, max: 100, format: 'percent', label: 'Season prep', tone: 'success' }, style: { span: 12, size: 'md' } },
                    ],
                },
                { id: 'cmp_v21bl', type: 'badge_list', visible: true, props: { source: { kind: 'static', value: V21_TASKS }, labelKey: 'tag', colorKey: 'status', colorMap: [{ value: 'open', color: 'info' }, { value: 'done', color: 'success' }], emptyText: 'No tags.' }, style: { span: 6, size: 'md', align: 'start' } },
                { id: 'cmp_v21tl', type: 'timeline', visible: true, onRowClick: 'act_v21t', props: { source: { kind: 'static', value: V21_TASKS }, titleKey: 'title', dateKey: 'due', descriptionKey: 'owner', icon: null, rowLimit: 25, emptyText: 'Nothing yet.' }, style: { span: 6, size: 'md' } },
                { id: 'cmp_v21rd', type: 'record_detail', visible: true, props: { source: { kind: 'static', value: V21_TASKS[0] }, fields: [{ key: 'title', label: 'Title', format: 'text' }, { key: 'due', label: 'Due', format: 'date' }, { key: 'status', label: 'Status', format: 'badge' }], columns: 2, emptyText: 'No record selected.' }, style: { span: 12 } },
                { id: 'cmp_v21fb', type: 'filter_bar', visible: true, props: { fields: [{ name: 'q', label: 'Search', type: 'search', options: [] }, { name: 'status', label: 'Status', type: 'select', options: [{ value: 'open', label: 'Open' }, { value: 'done', label: 'Done' }] }] }, style: { span: 12, size: 'md', gap: 3 } },
                { id: 'cmp_v21kb', type: 'kanban', visible: true, onRowClick: 'act_v21t', onCardMove: 'act_v21t', props: { source: { kind: 'static', value: V21_TASKS }, groupByField: 'status', columns: [{ value: 'open', label: 'Open', color: 'info' }, { value: 'done', label: 'Done', color: 'success' }], titleKey: 'title', subtitleKey: 'owner', badgeKey: 'tag', allowDrag: true }, style: { span: 12, size: 'md' } },
                { id: 'cmp_v21cl', type: 'calendar', visible: true, onRowClick: 'act_v21t', props: { source: { kind: 'static', value: V21_TASKS }, dateKey: 'due', endDateKey: null, titleKey: 'title', colorKey: null, view: 'month', emptyText: 'No events yet.' }, style: { span: 12 } },
                { id: 'cmp_v21ap', type: 'approval_list', visible: true, props: { scope: 'mine', show: 'waiting', limit: 10, emptyText: 'No approvals right now.', showDetails: true }, style: { span: 12 } },
                { id: 'cmp_v21ai', type: 'ai_chat', visible: true, props: { systemPrompt: 'You answer questions about the tasks board.', modelTier: 'auto', knowledgeBaseIds: [], greeting: 'Ask me about this board.', placeholder: 'Ask a question…', starters: ['What is overdue?'], mode: 'chat' }, style: { span: 12 } },
                // A pane: the flex stack that makes a sidebar/detail split
                // expressible. Its child with height 'fill' is the one that grows.
                {
                    id: 'cmp_v21pn', type: 'pane', visible: true, props: { direction: 'horizontal', scroll: 'none' },
                    style: { span: 12, gap: 3, height: 'fill' },
                    children: [
                        { id: 'cmp_v21pl', type: 'list', visible: true, onRowClick: 'act_v21t', props: { source: { kind: 'static', value: V21_TASKS }, titleKey: 'title', subtitleKey: 'owner', icon: null, emptyText: 'Nothing to show yet.' }, style: { span: 4, height: 'fill' } },
                        { id: 'cmp_v21pd', type: 'text', visible: true, props: { content: 'Pick a task on the left.' }, style: { span: 8, height: 'fill' } },
                    ],
                },
                {
                    id: 'cmp_v21mt', type: 'message_thread', visible: true, onRowClick: 'act_v21t',
                    props: {
                        source: { kind: 'static', value: V21_MESSAGES },
                        bodyField: 'body', htmlField: null, authorField: 'author', timestampField: 'sent_at',
                        sideField: 'author_kind',
                        sideMap: [
                            { value: 'requester', side: 'left', tone: 'neutral' },
                            { value: 'agent', side: 'right', tone: 'primary' },
                            { value: 'system', side: 'center', tone: 'neutral' },
                        ],
                        attachmentsField: 'attachments', attachmentLabelKey: 'filename',
                        citationsField: null, citationLabelKey: 'title',
                        rowLimit: 100, emptyText: 'No messages yet.',
                    },
                    style: { span: 12, height: 'fill' },
                },
                {
                    // A file column holds whatever arrived; the preview shows a
                    // PDF or an image inline and offers everything else as a
                    // download. Static value = no fetch in the fixture.
                    id: 'cmp_v21fp', type: 'file_preview', visible: true,
                    props: {
                        source: { kind: 'static', value: null },
                        emptyText: 'No document selected.',
                        allowDownload: true,
                    },
                    style: { span: 12, height: 'lg' },
                },
                // ── v3 ──────────────────────────────────────────────────
                {
                    id: 'cmp_v21st', type: 'stepper', visible: true, onRowClick: 'act_v21t',
                    props: {
                        value: { kind: 'static', value: 'open' },
                        steps: [
                            { value: 'new', label: 'New', icon: null },
                            { value: 'open', label: 'Open', icon: null },
                            { value: 'done', label: 'Done', icon: null },
                        ],
                        orientation: 'horizontal', tone: 'primary', showLabels: true,
                    },
                    style: { span: 12 },
                },
                {
                    id: 'cmp_v21fg', type: 'file_gallery', visible: true, onRowClick: 'act_v21t',
                    props: {
                        source: { kind: 'static', value: V21_FILES },
                        fileKey: 'file', titleKey: 'filename', subtitleKey: 'mime_type', sizeKey: 'size',
                        columns: 3, rowLimit: 24, emptyText: 'No files yet.',
                    },
                    style: { span: 12 },
                },
                {
                    // No appId in a fixture, so this renders its preview shape —
                    // which is exactly what the editor canvas shows too.
                    id: 'cmp_v21cs', type: 'connector_status', visible: true,
                    props: { connectorId: 'conn_v21m', title: 'Mailbox', showSync: true },
                    style: { span: 12 },
                },
            ],
        }],
    }],
    actions: { act_v21t: { kind: 'toast', message: 'v2.1', tone: 'info' } },
});
