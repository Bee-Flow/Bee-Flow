/**
 * App Studio builder: the design material app_inspect_catalog serves on request.
 *
 *   LAYOUT_ARCHETYPES   six screen shapes (dashboard, list-detail, form wizard, landing, kanban
 *                       board, report), each a compact worked skeleton. The cached prompt keeps
 *                       one line that names them (builderPrompt.js, **Layout**); the skeletons
 *                       are the topic `layouts`, and each one alone is `layout_<name>`.
 *   DESIGN_EXAMPLE      one worked design: an ask, the direction it leads to, and the calls that
 *                       carry it out. The topic `design_example`. It is served, not sent as a
 *                       few-shot, so the cached prefix and its ceilings stay as they are.
 *
 * A skeleton is DATA, not prose: its sections and entries are in the exact shape
 * app_add_section and app_add_components take, and designTopics.test.js builds every one of
 * them through those tools on an empty draft (no refusal, no repair, no validation error). The
 * text the model reads is rendered from the same data, so a skeleton that the tools would
 * correct cannot be served.
 */

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** One app_add_components entry. */
export interface SkeletonNode {
    type: string;
    props?: Record<string, Json>;
    style?: Record<string, Json>;
    visibleWhen?: Json;
    children?: SkeletonNode[];
}

export interface SkeletonSection {
    /** What the section is for, in a few words. */
    role: string;
    style?: Record<string, Json>;
    children: SkeletonNode[];
}

export interface LayoutArchetype {
    name: string;
    title: string;
    /** When this shape is the right one. */
    when: string;
    /** app_add_screen / app_update_screen settings that belong to the shape. */
    screen: Record<string, Json>;
    variables?: { name: string; type: string; default?: Json }[];
    sections: SkeletonSection[];
    /** The wiring the skeleton needs, in the catalog's own words. */
    wire: string;
    /** How two apps on this shape still differ. */
    vary: string;
}

/** Stands in for a table id the build reads from a tool result. */
export const TABLE_PLACEHOLDER = '<tbl>';
const records = (extra: Record<string, Json> = {}): Json => ({ kind: 'records', tableId: TABLE_PLACEHOLDER, ...extra });
const formula = (expr: string): Json => ({ kind: 'formula', expr });

const DASHBOARD: LayoutArchetype = {
    name: 'dashboard',
    title: 'Dashboard',
    when: 'The screen people open first: a few numbers, one trend, what needs attention now.',
    screen: { maxWidth: 'wide', kind: 'dashboard' },
    sections: [
        { role: 'opening', children: [
            { type: 'page_header', props: { title: 'Overview', subtitle: 'What changed this week', look: 'banner', showDivider: false }, children: [
                { type: 'button', props: { label: 'New entry', variant: 'primary', iconLeft: 'Plus' } },
            ] },
        ] },
        { role: 'KPI row: ONE headline tile, the rest quieter', children: [
            { type: 'stat', props: { label: 'Open', look: 'gradient', icon: 'Inbox' }, style: { span: 3 } },
            { type: 'stat', props: { label: 'Due this week', look: 'tile' }, style: { span: 3 } },
            { type: 'stat', props: { label: 'Closed', look: 'tile' }, style: { span: 3 } },
            { type: 'stat', props: { label: 'Average days', look: 'tile' }, style: { span: 3 } },
        ] },
        { role: 'the trend beside the worklist, filling the rest of the screen', style: { height: 'fill' }, children: [
            { type: 'chart', props: { chartType: 'area', title: 'Per month', xKey: 'month', series: [{ key: 'total', label: 'Total' }] }, style: { span: 8, height: 'fill' } },
            { type: 'list', props: { source: records({ limit: 8 }), titleKey: 'title', badgeKey: 'status', look: 'cards' }, style: { span: 4, height: 'fill' } },
        ] },
    ],
    wire: 'Each stat value is an aggregate binding with pick {row:"first",column:<as>}; the chart source is an aggregate with groupBy [{field:<date field>,bucket:"month",as:"month"}].',
    vary: 'Two charts 6 + 6 in place of 8 + 4; the KPI section on background "tint"; a timeline or a calendar as the right column; page_header look "hero" when the app is its own product.',
};

const LIST_DETAIL: LayoutArchetype = {
    name: 'list_detail',
    title: 'List and detail',
    when: 'Working through records one at a time: an inbox, a register, a queue. The list stays in view while the detail changes.',
    screen: { maxWidth: 'full' },
    variables: [{ name: 'selectedId', type: 'text' }],
    sections: [
        { role: 'the whole screen: two panes that scroll on their own', style: { height: 'fill', padding: 0, gap: 0 }, children: [
            { type: 'pane', props: { scroll: 'auto' }, style: { span: 4, padding: 3, gap: 3, border: 'subtle' }, children: [
                { type: 'heading', props: { text: 'Requests', level: 2 } },
                { type: 'filter_bar', props: { fields: [{ name: 'status', label: 'Status', type: 'select', options: [{ value: 'open', label: 'Open' }, { value: 'done', label: 'Done' }] }] } },
                { type: 'list', props: { source: records(), titleKey: 'title', subtitleKey: 'requester', badgeKey: 'status', timestampKey: 'created_at', selectedWhen: 'item.id == vars.selectedId' }, style: { height: 'fill' } },
            ] },
            { type: 'pane', props: { scroll: 'auto' }, style: { span: 8, padding: 4, gap: 4 }, children: [
                { type: 'page_header', props: { title: 'Request', look: 'split' }, children: [
                    { type: 'button', props: { label: 'Close request', variant: 'soft' } },
                ] },
                { type: 'record_detail', props: { columns: 2, layout: 'stacked' } },
                { type: 'tabs', props: { look: 'pills' }, children: [
                    { type: 'tab', props: { label: 'Activity' }, children: [{ type: 'timeline', props: { titleKey: 'title', dateKey: 'created_at' } }] },
                    { type: 'tab', props: { label: 'Notes' }, children: [{ type: 'markdown', props: { content: 'Notes about this request.' } }] },
                ] },
            ] },
        ] },
    ],
    wire: 'Declare selectedId first. The list onRowClick runs {kind:"sequence",steps:[{kind:"set_variable",name:"selectedId",value:{kind:"formula",expr:"form.id"}}]} (a clicked row arrives as form.<field>). record_detail source = {kind:"record",tableId,filter:[{field:"id",op:"eq",value:{kind:"formula",expr:"vars.selectedId"}}]}; the list filter reads vars.filters.status. Computed {title} on the page_header shows the selected record.',
    vary: 'Spans 3 + 9 for a narrow picker or 5 + 7 for a rich one; list look "cards"; the left pane on background "panel"; a data_grid with onRowClick in place of the list when rows need columns.',
};

const FORM_WIZARD: LayoutArchetype = {
    name: 'form_wizard',
    title: 'Form wizard',
    when: 'One person fills something in, in steps: an intake, a request, an onboarding. One question group at a time, progress always visible.',
    screen: { maxWidth: 'narrow' },
    variables: [{ name: 'step', type: 'text', default: '1' }],
    sections: [
        { role: 'title and progress', children: [
            { type: 'page_header', props: { title: 'New request', subtitle: 'Three short steps', showDivider: false } },
            { type: 'stepper', props: { value: formula('vars.step'), steps: [{ value: '1', label: 'About you' }, { value: '2', label: 'The request' }, { value: '3', label: 'Check and send' }] } },
        ] },
        { role: 'one card per step, only the current one visible', children: [
            { type: 'card', props: { title: 'About you', look: 'raised' }, style: { span: 12, padding: 4 }, visibleWhen: formula("vars.step == '1'"), children: [
                { type: 'form', props: { name: 'step1', submitLabel: 'Next' }, style: { span: 12 }, children: [
                    { type: 'input_text', props: { name: 'full_name', label: 'Name', required: true }, style: { span: 6 } },
                    { type: 'input_text', props: { name: 'email', label: 'E-mail', inputType: 'email', required: true }, style: { span: 6 } },
                ] },
            ] },
            { type: 'card', props: { title: 'The request', look: 'raised' }, style: { span: 12, padding: 4 }, visibleWhen: formula("vars.step == '2'"), children: [
                { type: 'form', props: { name: 'step2', submitLabel: 'Next' }, style: { span: 12 }, children: [
                    { type: 'input_select', props: { name: 'topic', label: 'Topic', options: [{ value: 'question', label: 'Question' }, { value: 'change', label: 'Change' }] }, style: { span: 12 } },
                    { type: 'input_textarea', props: { name: 'details', label: 'Details', rows: 5 } },
                ] },
                { type: 'button', props: { label: 'Back', variant: 'ghost', iconLeft: 'ArrowLeft' }, style: { span: 3 } },
            ] },
            { type: 'card', props: { title: 'Check and send', look: 'raised' }, style: { span: 12, padding: 4 }, visibleWhen: formula("vars.step == '3'"), children: [
                { type: 'keyValue', props: { layout: 'rows' }, style: { span: 12 } },
                { type: 'button', props: { label: 'Back', variant: 'ghost', iconLeft: 'ArrowLeft' }, style: { span: 3 } },
                { type: 'button', props: { label: 'Send', variant: 'primary', iconLeft: 'Send' }, style: { span: 3 } },
            ] },
        ] },
    ],
    wire: 'Declare step (text, default "1") and one variable per answer. Each form onSubmit is a sequence: set_variable per answer from form.<inputName>, then set_variable step to the next value. Back sets step to the previous value. keyValue source = a formula building the object from vars. Send runs create_record with values from vars.<answer> (a server step reads vars, not other forms), refresh, toast, then navigate or step back to "1".',
    vary: 'card look "flat" on a section with background "panel"; a vertical stepper in a 4 + 8 row on wide screens; a callout as the closing step in place of the review.',
};

const LANDING: LayoutArchetype = {
    name: 'landing',
    title: 'Landing page',
    when: 'A home screen or public page that explains and invites: what this is, why it matters, one clear next step.',
    screen: { maxWidth: 'medium' },
    sections: [
        { role: 'the hero: one promise, one primary action', style: { padding: 6 }, children: [
            { type: 'page_header', props: { title: 'Report a problem in two minutes', subtitle: 'Tell us what is wrong. We keep you posted until it is fixed.', look: 'hero', showDivider: false }, children: [
                { type: 'button', props: { label: 'Start a report', variant: 'primary' } },
                { type: 'button', props: { label: 'Follow my report', variant: 'outline' } },
            ] },
        ] },
        { role: 'three reasons, side by side', style: { gap: 4 }, children: [
            { type: 'card', props: { title: 'Fast', description: 'Three questions, no account needed.', look: 'tinted' }, style: { span: 4 } },
            { type: 'card', props: { title: 'Clear', description: 'You see who has it and what happens next.', look: 'tinted' }, style: { span: 4 } },
            { type: 'card', props: { title: 'Safe', description: 'Only the team handling it reads your report.', look: 'tinted' }, style: { span: 4 } },
        ] },
        { role: 'a band that shows instead of tells', style: { background: 'panel', padding: 5 }, children: [
            { type: 'image', props: { alt: 'The report form on a phone', fit: 'cover' }, style: { span: 6, height: 'lg', radius: 'lg' } },
            { type: 'container', props: { look: 'plain' }, style: { span: 6, gap: 3 }, children: [
                { type: 'heading', props: { text: 'How it works', level: 2, accent: 'bar' } },
                { type: 'text', props: { text: 'Describe the problem, add a photo, choose a location. That is all.' } },
                { type: 'button', props: { label: 'See an example', variant: 'soft' }, style: { span: 6 } },
            ] },
        ] },
        { role: 'the closing call to action', children: [
            { type: 'card', props: { title: 'Ready?', description: 'It takes two minutes.', look: 'solid' }, style: { span: 12, padding: 5 }, children: [
                { type: 'button', props: { label: 'Start a report', variant: 'secondary' }, style: { span: 4 } },
            ] },
        ] },
    ],
    wire: 'Buttons navigate to the screen that does the work. On a public page (app_set_public_access) the page may wear its own theme.',
    vary: 'page_header look "banner" for a calmer opening; the reasons as stats with look "accent"; image left or right; the closing card look "gradient".',
};

const KANBAN_BOARD: LayoutArchetype = {
    name: 'kanban_board',
    title: 'Kanban board',
    when: 'Work that moves through stages and is picked up by dragging: a pipeline, a sprint, a planning.',
    screen: { maxWidth: 'full' },
    sections: [
        { role: 'title, the one action, the filters', children: [
            { type: 'page_header', props: { title: 'Board', subtitle: 'Drag a card to move it', look: 'split' }, children: [
                { type: 'button', props: { label: 'New card', variant: 'primary', iconLeft: 'Plus' } },
            ] },
            { type: 'filter_bar', props: { fields: [{ name: 'owner', label: 'Owner', type: 'select', options: [{ value: 'me', label: 'Mine' }] }, { name: 'urgent', label: 'Urgent only', type: 'toggle' }] } },
        ] },
        { role: 'the board takes the rest of the screen', style: { height: 'fill' }, children: [
            { type: 'kanban', props: {
                source: records({ sort: [{ field: 'rank', dir: 'asc' }], limit: 200 }), groupByField: 'status', titleKey: 'title', subtitleKey: 'owner_label', rankKey: 'rank', cardLook: 'raised',
                columns: [{ value: 'todo', label: 'To do', color: 'neutral' }, { value: 'doing', label: 'Doing', color: 'info', wipLimit: 4 }, { value: 'done', label: 'Done', color: 'success' }],
            }, style: { span: 12, height: 'fill' } },
        ] },
        { role: 'dialogs in their own section, never inside the board', children: [
            { type: 'modal', props: { title: 'New card', size: 'md' }, children: [
                { type: 'form', props: { name: 'new_card', submitLabel: 'Add card' }, style: { span: 12 }, children: [
                    { type: 'input_text', props: { name: 'title', label: 'Title', required: true } },
                ] },
            ] },
        ] },
    ],
    wire: 'onCardMove runs a sequence: update_record {recordId:{kind:"formula",expr:"form.item.id"}, values:{status:{kind:"formula",expr:"form.value"}}} then refresh. Give every seeded row a DISTINCT rank. New card: open_modal with the modal id; the form onSubmit ends with close_modal.',
    vary: 'swimlaneField for a second dimension; cardLook "tinted" with cardColorMap by priority; a stat row above the board for the counts per stage; page_header look "banner".',
};

const REPORT: LayoutArchetype = {
    name: 'report',
    title: 'Report',
    when: 'Something that is READ top to bottom and may be exported: a monthly report, a summary for a board, an audit overview.',
    screen: { maxWidth: 'medium' },
    sections: [
        { role: 'title, period, export', children: [
            { type: 'page_header', props: { title: 'Monthly report', subtitle: 'Figures for the selected period' }, children: [
                { type: 'button', props: { label: 'Download', variant: 'outline', iconLeft: 'Download' } },
            ] },
            { type: 'filter_bar', props: { fields: [{ name: 'period', label: 'Period', type: 'select', options: [{ value: 'month', label: 'This month' }, { value: 'quarter', label: 'This quarter' }] }] } },
        ] },
        { role: 'the figures the text is about, as one calm band', style: { background: 'panel' }, children: [
            { type: 'stat', props: { label: 'Total', deltaFormat: 'percent' }, style: { span: 4 } },
            { type: 'stat', props: { label: 'New', deltaFormat: 'percent' }, style: { span: 4 } },
            { type: 'stat', props: { label: 'Resolved', deltaFormat: 'percent' }, style: { span: 4 } },
        ] },
        { role: 'a chapter: heading, what it means, then the picture', children: [
            { type: 'heading', props: { text: 'Development', level: 2, accent: 'bar' } },
            { type: 'markdown', props: { content: 'What stands out this period, in two or three sentences.' } },
            { type: 'chart', props: { chartType: 'line', xKey: 'month', series: [{ key: 'total', label: 'Total' }], showLegend: false }, style: { span: 12, height: 'lg' } },
        ] },
        { role: 'a chapter: the breakdown as a quiet table', children: [
            { type: 'heading', props: { text: 'By category', level: 2, accent: 'bar' } },
            { type: 'table', props: { columns: [{ key: 'category', label: 'Category' }, { key: 'count', label: 'Count', format: 'number', align: 'right' }], look: 'minimal' } },
        ] },
    ],
    wire: 'Stats, chart and table read aggregate bindings whose filter values read vars.filters.period. markdown contentFrom a variable an ai_generate step fills gives a written summary. Download runs a sequence with generate_file.',
    vary: 'A 4 + 8 row per chapter (text beside its chart); stat look "accent" for the one figure that matters; a callout for the conclusion; tabs per audience.',
};

export const LAYOUT_ARCHETYPES: readonly LayoutArchetype[] = Object.freeze([DASHBOARD, LIST_DETAIL, FORM_WIZARD, LANDING, KANBAN_BOARD, REPORT]);

/** JSON with bare keys: the notation the catalog itself uses. */
function lit(value: Json): string {
    if (Array.isArray(value)) return `[${value.map(lit).join(',')}]`;
    if (value !== null && typeof value === 'object') return `{${Object.entries(value).map(([k, v]) => `${k}:${lit(v)}`).join(',')}}`;
    return JSON.stringify(value);
}

/** One entry as app_add_components takes it. */
export function renderSkeletonNode(node: SkeletonNode): string {
    const parts = [`type:${JSON.stringify(node.type)}`];
    if (node.props) parts.push(`props:${lit(node.props)}`);
    if (node.style) parts.push(`style:${lit(node.style)}`);
    if (node.visibleWhen !== undefined) parts.push(`visibleWhen:${lit(node.visibleWhen)}`);
    if (node.children) parts.push(`children:[${node.children.map(renderSkeletonNode).join(',')}]`);
    return `{${parts.join(',')}}`;
}

export function renderArchetype(archetype: LayoutArchetype): string {
    const lines = [
        `${archetype.title.toUpperCase()} (${archetype.name}). ${archetype.when}`,
        `Screen: ${lit(archetype.screen)}`,
    ];
    if (archetype.variables) lines.push(`Variables (app_set_variables, before the components): ${lit(archetype.variables as Json)}`);
    archetype.sections.forEach((section, i) => {
        lines.push(`Section ${i + 1}${section.style ? ` style ${lit(section.style)}` : ''}: ${section.role}`);
        for (const node of section.children) lines.push(`  ${renderSkeletonNode(node)}`);
    });
    lines.push(`Wire: ${archetype.wire}`, `Vary: ${archetype.vary}`);
    return lines.join('\n');
}

const LAYOUTS_LEAD = `LAYOUT ARCHETYPES. Six screen shapes; pick one per SCREEN by what the screen is for, and mix them across an app (a dashboard home, a list-detail work screen, a wizard for intake). Each skeleton is in the shape app_add_section and app_add_components take: copy the structure, then make the labels, looks and spans this app's own. "${TABLE_PLACEHOLDER}" stands for a real tbl_… id from a tool result; a source left out is yours to bind.
Rules every shape keeps: one section with height "fill" per screen at most, holding a SINGLE 12-column row (fill stretches the first row only); the sections above it are auto-height; dialogs sit in their own section.`;

/** The topic `layout_<name>`: the lead and that one skeleton. */
export function renderLayoutTopic(archetype: LayoutArchetype): string {
    return `${LAYOUTS_LEAD}\n\n${renderArchetype(archetype)}`;
}

/** The topic `layouts`: the lead and the six skeletons. */
export function renderLayoutsTopic(): string {
    return [LAYOUTS_LEAD, ...LAYOUT_ARCHETYPES.map(renderArchetype)].join('\n\n');
}

/** The calls of the worked example, in order: [tool, arguments]. The test runs them. */
export const DESIGN_EXAMPLE_CALLS: readonly (readonly [string, { [key: string]: unknown }])[] = Object.freeze([
    ['app_set_theme', { preset: 'field', primary: '#C2410C', font: 'general-sans', surface: 'soft', navStyle: 'tabs' }],
    ['app_update_section', { style: { padding: 5 } }],
    ['app_add_components', { components: [
        { type: 'page_header', props: { title: 'Good morning', subtitle: 'Three repairs are waiting for you today', look: 'hero', showDivider: false }, children: [
            { type: 'button', props: { label: 'Report a repair', variant: 'primary', iconLeft: 'Plus' } },
        ] },
    ] }],
    ['app_add_section', { style: { gap: 3 } }],
    ['app_add_components', { components: [
        { type: 'stat', props: { label: 'Waiting', look: 'gradient', icon: 'Wrench' }, style: { span: 6 } },
        { type: 'stat', props: { label: 'Planned', look: 'tile' }, style: { span: 3 } },
        { type: 'stat', props: { label: 'Done this week', look: 'tile' }, style: { span: 3 } },
    ] }],
    ['app_add_section', { style: { background: 'panel', padding: 4 } }],
    ['app_add_components', { components: [
        { type: 'heading', props: { text: 'Today', level: 2, accent: 'bar' } },
        { type: 'list', props: { titleKey: 'title', subtitleKey: 'address', badgeKey: 'urgency', look: 'cards', badgeToneMap: [{ value: 'urgent', label: 'Urgent', tone: 'danger' }, { value: 'normal', label: 'Normal', tone: 'neutral' }] } },
    ] }],
]);

const EXAMPLE_PLAN_DESIGN: Json = {
    direction: 'A warm, thumb-friendly field tool: big targets, one loud number, nothing decorative.',
    preset: 'field', primary: '#C2410C', font: 'general-sans', navStyle: 'tabs', surface: 'soft',
    signatureMoves: ['A hero greeting that says how many repairs wait today', 'One double-width gradient tile for the waiting count', 'Today\'s repairs as cards on a raised band, urgency as a red pill'],
};

/** The topic `design_example`. */
export function renderDesignExampleTopic(): string {
    const calls = DESIGN_EXAMPLE_CALLS.map(([tool, args], i) => `${i + 1}. ${tool} ${lit(args as Json)}`);
    return [
        'A WORKED DESIGN EXAMPLE. Not a template: the reasoning is what to copy, the choices are this ask\'s own.',
        'ASK: "An app for our maintenance crew to see and report repairs in the buildings we manage. They use it on their phones, the office follows along."',
        'READ THE ASK FOR ITS LOOK: phones in the field (large targets, spacious, light for daylight), hands-on work (warm, not corporate blue), two audiences (the crew acts, the office reads). The nearest preset is field; its green says "nature", so the primary moves to a brick orange that says "repair".',
        `THE DIRECTION, as the plan's design (app_propose_plan): ${lit(EXAMPLE_PLAN_DESIGN)}`,
        'Three signature moves are enough. Each is something a person would point at; "clean and modern" is not a move.',
        'THE CALLS for the home screen (parentId and sectionId left out: they are the ids the previous results return):',
        ...calls,
        'WHAT WAS DECIDED, call by call: the preset plus the knobs the ask leans on, in ONE theme call. The hero spends its subtitle on a live fact (make it computed). The KPI row is 6 + 3 + 3, not four equal tiles: the waiting count is the headline, so it is wider and the only gradient. The list is cards, on the one section with a panel background, which gives the screen its rhythm.',
        'WHAT WAS LEFT OUT on purpose: a chart (the crew does not read trends on a phone; the office gets a report screen), a sidebar (three screens), a second accent colour, look "gradient" on more than one thing.',
        'THE OTHER SCREENS follow the direction, not the home screen\'s layout: the report form is the form_wizard archetype with card look "raised"; the office overview is the report archetype with stat look "plain". One identity, different shapes.',
    ].join('\n');
}
