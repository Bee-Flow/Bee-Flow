/**
 * App Studio template — Sprint planning.
 *
 * An Azure-DevOps/Jira-shaped delivery workspace: a work-item hierarchy
 * (epic → feature → story/bug → task), a rank-ordered backlog, sprints with
 * capacity, and boards the TEAM configures — Kanban with WIP limits and Scrum
 * with a sprint scope, from the same data.
 *
 * ── THE ONE DECISION EVERYTHING ELSE FOLLOWS ────────────────────────────────
 *
 * Workflow states, work-item types and priorities are TEXT KEYS pointing at
 * CONFIG TABLES — not `select` fields with authored options.
 *
 * A `select` field's options live in the DATA MODEL, and the data model is only
 * editable from the builder. So "add an In review column" would mean a
 * developer opening App Studio and changing the schema of a live table. That is
 * the wrong person and the wrong risk for what is plainly configuration. With
 * keys plus a `workflow_states` table, the team lead adds a row on the Setup
 * screen and the board grows a column — no schema change, no deploy, no builder.
 *
 * The board reads its columns the same way, through the kanban's
 * `columnsSource` binding, so what the config table says IS what the board is.
 *
 * ── CONSTRAINTS THAT SHAPED THIS FILE (none of them obvious) ────────────────
 *
 *  • NO JOINS. Every read compiles to `FROM <one table>`; a filter or sort may
 *    only name the bound table's own columns. A card therefore cannot show its
 *    epic's title by following `parent_id`. So the two facts a board groups and
 *    filters by are DENORMALISED onto the work item — `epic_key` and
 *    `assignee_name` — and the actions that set a parent/assignee write them.
 *    They are display copies, and the app treats them as such.
 *
 *  • A BINDING FILTER FORMULA may only read currentUser / vars / forms /
 *    screen / today. Reading form.*, item.*, records.* or now makes the fetch
 *    layer and the read-side cache key diverge, and the component loads
 *    forever. Every dynamic filter here goes through `vars`.
 *
 *  • THE SERVER'S formula scope is a strict subset of the browser's: `screen`,
 *    `forms`, `actions`, `records` and `datasets` are all empty in a server
 *    step. So a step never reads `screen.params.*` — context reaches a write
 *    through `form` (the event payload) or `vars` (set by an earlier step).
 *    A `screen.params` binding would resolve in preview and write NULL in
 *    production, which is the worst kind of wrong.
 *
 *  • RANK IS A FLOAT and the kanban computes it. `onCardMove` carries a ready
 *    `form.rank` for the slot the card landed in, because the arithmetic needs
 *    the NEIGHBOURING ROWS and a server step cannot read another record.
 *    Fractional so an insert never renumbers its neighbours.
 *
 *  • `filter_bar` publishes to ONE hardcoded variable, `vars.filters`. One per
 *    screen, never two.
 *
 *  • A `height:'fill'` section stretches its FIRST grid row only. Every screen
 *    here is therefore built as: one auto-height header section, then one fill
 *    section whose children are a single row.
 *
 *  • An aggregate binding with no explicit `limit` is silently capped at 50.
 *
 * ── WHAT THIS TEMPLATE DELIBERATELY DOES NOT DO ────────────────────────────
 *
 * No projects table. A board is the container: two products are two boards,
 * which keeps every work-item query single-table and every filter one clause.
 *
 * No cross-item rollup of story points onto an epic. That needs an aggregate
 * grouped by a parent the row does not carry, and faking it with a stored
 * denormalised total would drift the moment anyone edited a child. The Epics
 * screen counts children instead, which is honest and always current.
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
// Two roles, and the split is the real one on a delivery team: everybody moves
// work, only leads change what the board IS. `default:'role'` inverts the
// default to deny so each grant below is a decision rather than an oversight.
// The owner is never listed — resolveScope short-circuits them to full access.
// ---------------------------------------------------------------------------

/** Board shape, states, types, sprints, people: the lead's to change. */
const ACCESS_CONFIG = {
    default: 'role',
    roles: {
        lead: { read: 'all', create: true, update: 'all', delete: 'all' },
        member: { read: 'all', create: false, update: false, delete: false },
    },
};

/**
 * Work items. Members update ALL of them, not just their own: a board where you
 * cannot drag someone else's card is not a board. Deleting is narrower —
 * a member may withdraw what they raised, a lead may remove anything.
 */
const ACCESS_ITEMS = {
    default: 'role',
    roles: {
        lead: { read: 'all', create: true, update: 'all', delete: 'all' },
        member: { read: 'all', create: true, update: 'all', delete: 'own' },
    },
};

/** Discussion. Append-mostly: you may edit and retract your own remarks. */
const ACCESS_COMMENTS = {
    default: 'role',
    roles: {
        lead: { read: 'all', create: true, update: 'own', delete: 'all' },
        member: { read: 'all', create: true, update: 'own', delete: 'own' },
    },
};

const COLOR_OPTIONS = [
    { value: 'primary', label: 'Primary' },
    { value: 'neutral', label: 'Neutral' },
    { value: 'success', label: 'Green' },
    { value: 'warning', label: 'Amber' },
    { value: 'danger', label: 'Red' },
    { value: 'info', label: 'Blue' },
];

const PRIORITY_OPTIONS = [
    { value: 'critical', label: 'Critical' },
    { value: 'high', label: 'High' },
    { value: 'medium', label: 'Medium' },
    { value: 'low', label: 'Low' },
];

const BOARD_TYPE_OPTIONS = [
    { value: 'scrum', label: 'Scrum — sprint scoped' },
    { value: 'kanban', label: 'Kanban — continuous flow' },
];

const SPRINT_STATUS_OPTIONS = [
    { value: 'planned', label: 'Planned' },
    { value: 'active', label: 'Active' },
    { value: 'closed', label: 'Closed' },
];

const STATE_CATEGORY_OPTIONS = [
    { value: 'todo', label: 'To do' },
    { value: 'doing', label: 'In progress' },
    { value: 'done', label: 'Done' },
];

const MEMBER_ROLE_OPTIONS = [
    { value: 'lead', label: 'Lead' },
    { value: 'member', label: 'Team member' },
    { value: 'stakeholder', label: 'Stakeholder' },
];

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

const dataModel = {
    modelVersion: 1,
    // This app reads the organisation's member list, so its person pickers can
    // offer real colleagues. Declared here rather than implied by the binding:
    // an app that quietly grew a directory read would be a privacy change
    // nobody could see in the schema.
    directory: { orgMembers: true },
    roles: [
        { key: 'lead', label: 'Lead' },
        { key: 'member', label: 'Team member' },
    ],
    roleMapping: { default: 'member', byGroup: {} },
    tables: [
        // ── Configuration ──────────────────────────────────────────────────
        {
            id: 'tbl_boards1',
            key: 'boards',
            name: 'Boards',
            icon: 'SquareKanban',
            access: ACCESS_CONFIG,
            fields: [
                { id: 'fld_bdname1', key: 'name', type: 'text', required: true, unique: false },
                {
                    id: 'fld_bdtype1', key: 'board_type', type: 'select', required: true, unique: false,
                    options: BOARD_TYPE_OPTIONS, default: 'scrum',
                },
                { id: 'fld_bdgoal1', key: 'description', type: 'text', required: false, unique: false },
                // Which column of the board carries the swimlane split. Read by
                // the Setup screen and by whoever is looking at the board; the
                // kanban's own swimlaneField is a design-time choice per screen,
                // so the Board screen renders the epic-laned variant only when
                // this says so.
                { id: 'fld_bdlane1', key: 'swimlane_by', type: 'text', required: false, unique: false, default: 'none' },
                { id: 'fld_bdwip01', key: 'wip_enabled', type: 'bool', required: false, unique: false, default: true },
                { id: 'fld_bdpos01', key: 'position', type: 'number', subtype: 'integer', required: false, unique: false, default: 1 },
            ],
        },
        {
            id: 'tbl_states1',
            key: 'workflow_states',
            name: 'Workflow states',
            icon: 'ListChecks',
            access: ACCESS_CONFIG,
            fields: [
                // The KEY is what a work item stores. Unique, because two states
                // sharing a key would silently merge two columns of work.
                { id: 'fld_stkey01', key: 'key', type: 'text', required: true, unique: true },
                { id: 'fld_stname1', key: 'name', type: 'text', required: true, unique: false },
                {
                    id: 'fld_stcat01', key: 'category', type: 'select', required: true, unique: false,
                    options: STATE_CATEGORY_OPTIONS, default: 'todo',
                },
                {
                    id: 'fld_stcol01', key: 'color', type: 'select', required: false, unique: false,
                    options: COLOR_OPTIONS, default: 'neutral',
                },
                { id: 'fld_stpos01', key: 'position', type: 'number', subtype: 'integer', required: false, unique: false, default: 1 },
            ],
        },
        {
            id: 'tbl_bcols01',
            key: 'board_columns',
            name: 'Board columns',
            icon: 'Columns2',
            access: ACCESS_CONFIG,
            fields: [
                { id: 'fld_bcbrd01', key: 'board_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_boards1' } },
                // The state this column collects. One column per state keeps the
                // board readable and the drop unambiguous: dropping a card into
                // a column IS setting its state. (Jira's many-states-per-column
                // is deliberately not modelled — it makes a drop ambiguous and
                // needs a rule nobody remembers.)
                { id: 'fld_bcstat1', key: 'state', type: 'text', required: true, unique: false },
                { id: 'fld_bclbl01', key: 'label', type: 'text', required: false, unique: false },
                {
                    id: 'fld_bccol01', key: 'color', type: 'select', required: false, unique: false,
                    options: COLOR_OPTIONS, default: 'neutral',
                },
                { id: 'fld_bcpos01', key: 'position', type: 'number', subtype: 'integer', required: false, unique: false, default: 1 },
                // 0 / empty = no limit. The kanban reads this as `wip_limit`.
                { id: 'fld_bcwip01', key: 'wip_limit', type: 'number', subtype: 'integer', required: false, unique: false, default: 0 },
            ],
        },
        {
            id: 'tbl_types01',
            key: 'item_types',
            name: 'Work item types',
            icon: 'Tags',
            access: ACCESS_CONFIG,
            fields: [
                { id: 'fld_tykey01', key: 'key', type: 'text', required: true, unique: true },
                { id: 'fld_tyname1', key: 'name', type: 'text', required: true, unique: false },
                {
                    id: 'fld_tycol01', key: 'color', type: 'select', required: false, unique: false,
                    options: COLOR_OPTIONS, default: 'neutral',
                },
                // 3 epic · 2 feature · 1 story/bug · 0 task. A number rather than
                // a fixed enum so a team can insert its own tier without a
                // schema change — the whole point of the config tables.
                { id: 'fld_tylvl01', key: 'level', type: 'number', subtype: 'integer', required: true, unique: false, default: 1 },
                { id: 'fld_typos01', key: 'position', type: 'number', subtype: 'integer', required: false, unique: false, default: 1 },
            ],
        },
        {
            id: 'tbl_member1',
            key: 'team_members',
            name: 'Team',
            icon: 'IdCard',
            access: ACCESS_CONFIG,
            fields: [
                { id: 'fld_mbname1', key: 'name', type: 'text', required: true, unique: false },
                // The identity a viewer is matched against. Inside Nextcloud the
                // embedded app resolves currentUser.email for the signed-in NC
                // user, and standalone it is the Bee Flow account's e-mail — the
                // same string either way, which is what makes "assigned to me"
                // work in both places without a second identity model.
                { id: 'fld_mbmail1', key: 'email', type: 'text', required: false, unique: false },
                {
                    id: 'fld_mbrole1', key: 'role', type: 'select', required: false, unique: false,
                    options: MEMBER_ROLE_OPTIONS, default: 'member',
                },
                { id: 'fld_mbcap01', key: 'capacity_points', type: 'number', required: false, unique: false, default: 0 },
                { id: 'fld_mbact01', key: 'is_active', type: 'bool', required: false, unique: false, default: true },
            ],
        },
        {
            id: 'tbl_sprint1',
            key: 'sprints',
            name: 'Sprints',
            icon: 'CalendarClock',
            access: ACCESS_CONFIG,
            fields: [
                { id: 'fld_spname1', key: 'name', type: 'text', required: true, unique: false },
                { id: 'fld_spbrd01', key: 'board_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_boards1' } },
                { id: 'fld_spgoal1', key: 'goal', type: 'text', required: false, unique: false },
                { id: 'fld_spstrt1', key: 'start_date', type: 'date', required: false, unique: false },
                { id: 'fld_spend01', key: 'end_date', type: 'date', required: false, unique: false },
                {
                    id: 'fld_spstat1', key: 'status', type: 'select', required: true, unique: false,
                    options: SPRINT_STATUS_OPTIONS, default: 'planned',
                },
                { id: 'fld_spcap01', key: 'capacity_points', type: 'number', required: false, unique: false, default: 0 },
            ],
        },

        // ── The work ───────────────────────────────────────────────────────
        {
            id: 'tbl_items01',
            key: 'work_items',
            name: 'Work items',
            icon: 'ListChecks',
            access: ACCESS_ITEMS,
            fields: [
                { id: 'fld_witit01', key: 'title', type: 'text', required: true, unique: false },
                { id: 'fld_widsc01', key: 'description', type: 'richtext', required: false, unique: false },
                // Keys into item_types / workflow_states. Text, not select — see
                // the header. This is what makes the vocabularies end-user
                // editable instead of schema.
                { id: 'fld_wityp01', key: 'item_type', type: 'text', required: false, unique: false, default: 'story' },
                { id: 'fld_wistt01', key: 'state', type: 'text', required: false, unique: false, default: 'todo' },
                {
                    id: 'fld_wipri01', key: 'priority', type: 'select', required: false, unique: false,
                    options: PRIORITY_OPTIONS, default: 'medium',
                },
                { id: 'fld_wibrd01', key: 'board_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_boards1' } },
                { id: 'fld_wispr01', key: 'sprint_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_sprint1' } },
                // The hierarchy. A self-relation, so ONE table holds epics,
                // features, stories, bugs and tasks — which is also what lets a
                // board show a story and a bug side by side, the way a real
                // board does.
                { id: 'fld_wipar01', key: 'parent_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_items01' } },
                // DENORMALISED display copies. There are no joins, so grouping a
                // board into epic swimlanes or showing who owns a card has to
                // read a column the row itself carries.
                { id: 'fld_wiepc01', key: 'epic_key', type: 'text', required: false, unique: false },
                // WHO OWNS THIS — three columns, and each earns its place.
                //
                // `assignee_id` is the real Bee Flow user id, written by the
                // person picker. It is what "assigned to me" compares against,
                // so that filter is an identity check rather than a hopeful
                // string match. `assignee_name` is the denormalised display
                // name: there are no joins, so a card that shows its owner has
                // to carry the name beside the id. `assignee_email` predates
                // both and stays — filters and apps built against it keep
                // working, and it costs one nullable column not to break them.
                { id: 'fld_wiasi01', key: 'assignee_id', type: 'text', subtype: 'user', required: false, unique: false },
                { id: 'fld_wiasg01', key: 'assignee_email', type: 'text', required: false, unique: false },
                { id: 'fld_wiasn01', key: 'assignee_name', type: 'text', required: false, unique: false },
                { id: 'fld_wipts01', key: 'points', type: 'number', required: false, unique: false },
                // Float, and never renumbered: the board inserts a card by
                // taking the midpoint of its new neighbours.
                { id: 'fld_wirnk01', key: 'rank', type: 'number', required: false, unique: false, default: 0 },
                { id: 'fld_widue01', key: 'due_date', type: 'date', required: false, unique: false },
                { id: 'fld_wiclo01', key: 'closed_at', type: 'datetime', required: false, unique: false },
                { id: 'fld_wiatt01', key: 'attachments', type: 'file', required: false, unique: false },
            ],
        },
        {
            id: 'tbl_notes01',
            key: 'work_item_notes',
            name: 'Notes',
            icon: 'MessagesSquare',
            access: ACCESS_COMMENTS,
            fields: [
                { id: 'fld_ntitm01', key: 'work_item_id', type: 'relation', required: false, unique: false, relation: { table: 'tbl_items01' } },
                { id: 'fld_ntbdy01', key: 'body', type: 'text', required: true, unique: false },
                { id: 'fld_ntwho01', key: 'author_name', type: 'text', required: false, unique: false },
            ],
        },
    ],
};

// ---------------------------------------------------------------------------
// Shared vocabularies for the SCREENS.
//
// These literal lists are the one place the config-as-data story has a seam:
// `filter_bar.options`, `data_grid.columns` and `input_select.options` are
// author-time lists, not bindings, so a type added on Setup shows up on the
// board (whose columns ARE bound) but not in the filter bar's dropdown. That is
// a platform limit, not a modelling choice, and it is called out on the Setup
// screen so nobody discovers it by surprise.
// ---------------------------------------------------------------------------

const TYPE_TONES = [
    { value: 'epic', label: 'Epic', tone: 'primary' },
    { value: 'feature', label: 'Feature', tone: 'info' },
    { value: 'story', label: 'User story', tone: 'success' },
    { value: 'bug', label: 'Bug', tone: 'danger' },
    { value: 'task', label: 'Task', tone: 'neutral' },
];

const PRIORITY_TONES = [
    { value: 'critical', label: 'Critical', tone: 'danger' },
    { value: 'high', label: 'High', tone: 'warning' },
    { value: 'medium', label: 'Medium', tone: 'neutral' },
    { value: 'low', label: 'Low', tone: 'info' },
];

/**
 * The workflow states, as the grids colour them.
 *
 * The `workflow_states` TABLE is the source of truth and can be edited on the
 * Setup screen — this list is the author-time echo the grid pills and their
 * dropdowns use, exactly as TYPE_TONES and PRIORITY_TONES already were for the
 * kanban. A state added in Setup still appears everywhere it matters (the board
 * grows a column, the grid shows the value); it just renders neutral here until
 * an editor adds it, which is the same trade the type filter already makes.
 */
const STATE_TONES = [
    { value: 'todo', label: 'To do', tone: 'neutral' },
    { value: 'ready', label: 'Ready', tone: 'info' },
    { value: 'doing', label: 'In progress', tone: 'primary' },
    { value: 'review', label: 'In review', tone: 'warning' },
    { value: 'done', label: 'Done', tone: 'success' },
];

/**
 * COLOR_OPTIONS as a tone map.
 *
 * The Setup tables have stored a `color` on every state, type and board column
 * since the template shipped, and until now nothing rendered it: the grid drew
 * one neutral grey pill for every value, so the colour a user picked showed up
 * nowhere at all. `toneFrom: 'color'` reads it off the row; this maps the
 * stored word onto itself so the Colour cell wears the colour it names.
 */
const COLOR_TONES = COLOR_OPTIONS.map((c) => ({ value: c.value, label: c.label, tone: c.value }));

const TYPE_FILTER_OPTIONS = TYPE_TONES.map((t) => ({ value: t.value, label: t.label }));

/** Cards carry the two numbers a board is planned against, and who owns it. */
const CARD_FIELDS = [
    { key: 'points', label: 'Points', slot: 'chip', format: 'number' },
    { key: 'assignee_name', label: 'Assignee', slot: 'meta', format: 'text' },
    { key: 'due_date', label: 'Due', slot: 'meta', format: 'date' },
];

/**
 * The board's cards. `board_id` is REQUIRED: with no board chosen the board
 * shows nothing rather than every work item in the workspace. `sprint_id` is
 * optional, and an optional filter whose formula resolves to null is OMITTED —
 * so the very same component is a Kanban board (no sprint chosen: everything on
 * the board) and a Scrum sprint board (a sprint chosen on the Sprints screen:
 * just that sprint). One component, both board types, no duplication.
 */
const boardItemsBinding = (extra = []) => ({
    kind: 'records',
    tableId: 'tbl_items01',
    filter: [
        { field: 'board_id', op: 'eq', value: { kind: 'formula', expr: 'vars.board.id' }, required: true },
        { field: 'sprint_id', op: 'eq', value: { kind: 'formula', expr: 'vars.sprint.id' }, required: false },
        ...extra,
    ],
    // Rank ascending IS the board's order — the kanban reads its cards in
    // source order, so the sort and the drag-computed rank are the same story.
    sort: [{ field: 'rank', dir: 'asc' }],
    limit: 400,
});

// ==================================================================
// SPRINTS — plan, start, close.
// ==================================================================
const SCREEN_SPRINTS = {
    id: 'scr_sprints',
    name: 'Sprints',
    icon: 'CalendarClock',
    showInNav: true,
    maxWidth: 'wide',
    description: 'Plan a sprint, then scope the board to it.',
    sections: [
        {
            id: 'sec_sptop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_sphdr',
                    type: 'page_header',
                    props: {
                        title: 'Sprints',
                        subtitle: 'Picking a sprint scopes the Board and Backlog to it. Clear it to see the whole board again.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'CalendarClock',
                        showDivider: false,
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_spclr',
                            type: 'button',
                            props: { label: 'Show whole board', variant: 'ghost', iconLeft: 'X', role: 'button' },
                            style: { span: 3 },
                            visible: { kind: 'formula', expr: 'vars.sprint.id' },
                            onClick: 'act_spclear',
                        },
                        {
                            id: 'cmp_spnew',
                            type: 'button',
                            props: { label: 'New sprint', variant: 'primary', iconLeft: 'Plus', role: 'button' },
                            style: { span: 3 },
                            visible: true,
                            onClick: 'act_spopen',
                        },
                    ],
                },
                {
                    id: 'cmp_spcap',
                    type: 'progress',
                    props: {
                        value: {
                            kind: 'aggregate',
                            tableId: 'tbl_items01',
                            aggregates: [{ fn: 'sum', field: 'points', as: 'pts' }],
                            filter: [{ field: 'sprint_id', op: 'eq', value: { kind: 'formula', expr: 'vars.sprint.id' }, required: true }],
                            limit: 1,
                            pick: { row: 'first', column: 'pts' },
                        },
                        // The denominator is the sprint's OWN capacity, read off
                        // the selected sprint — so the bar reads "planned
                        // against what we said we could do" rather than against
                        // an invented 100.
                        max: { kind: 'formula', expr: 'vars.sprint.capacity_points' },
                        format: 'fraction',
                        label: 'Points planned into the selected sprint',
                        tone: 'primary',
                        look: 'slim',
                    },
                    style: { span: 12 },
                    visible: { kind: 'formula', expr: 'vars.sprint.id' },
                },
            ],
        },
        {
            id: 'sec_spmain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_splist',
                    type: 'list',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_sprint1',
                            filter: [{ field: 'board_id', op: 'eq', value: { kind: 'formula', expr: 'vars.board.id' }, required: true }],
                            sort: [{ field: 'start_date', dir: 'desc' }],
                            limit: 50,
                        },
                        titleKey: 'name',
                        subtitleKey: 'goal',
                        metaKey: 'end_date',
                        timestampKey: null,
                        badgeKey: 'status',
                        badgeToneMap: [
                            { value: 'active', label: 'Active', tone: 'success' },
                            { value: 'planned', label: 'Planned', tone: 'info' },
                            { value: 'closed', label: 'Closed', tone: 'neutral' },
                        ],
                        unreadKey: null,
                        selectedWhen: 'item.id == vars.sprint.id',
                        icon: 'CalendarClock',
                        emptyText: 'No sprints on this board yet.',
                    },
                    style: { span: 5, height: 'fill' },
                    visible: true,
                    onRowClick: 'act_sppick',
                },
                {
                    id: 'cmp_spgrid',
                    type: 'data_grid',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_items01',
                            filter: [{ field: 'sprint_id', op: 'eq', value: { kind: 'formula', expr: 'vars.sprint.id' }, required: true }],
                            sort: [{ field: 'rank', dir: 'asc' }],
                            limit: 200,
                        },
                        columns: [
                            { key: 'item_type', label: 'Type', format: 'badge', width: 100, sortable: true, filterable: true, editable: false },
                            { key: 'title', label: 'Title', format: 'text', width: 320, sortable: true, filterable: true, editable: false },
                            { key: 'state', label: 'State', format: 'badge', width: 120, sortable: true, filterable: true, editable: false },
                            { key: 'points', label: 'Points', format: 'number', width: 90, sortable: true, filterable: false, editable: false },
                            { key: 'assignee_name', label: 'Assignee', format: 'text', width: 150, sortable: true, filterable: true, editable: false },
                        ],
                        pageSize: 25,
                        selectable: 'none',
                        searchable: false,
                        rowActions: [{ label: 'Remove from sprint', actionId: 'act_spdrop' }],
                        density: 'compact',
                        zebra: true,
                        look: 'minimal',
                        emptyText: 'Pick a sprint to see what is planned into it.',
                    },
                    style: { span: 7, height: 'fill' },
                    visible: true,
                },
            ],
        },
        {
            // The create form used to sit open at the foot of the screen, so a
            // page about CHOOSING a sprint always ended in a form for making
            // one — and its 4+2+2+2 row left a ragged gap. It is the same
            // pattern the Backlog already uses for "New work item": a button in
            // the header, the form in a modal.
            id: 'sec_spdlg',
            style: { padding: 0, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_spmodal',
                    type: 'modal',
                    props: { title: 'New sprint', size: 'md', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_spform',
                            type: 'form',
                            props: { name: 'newsprint', submitLabel: 'Create sprint', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_spcreate',
                            children: [
                                { id: 'cmp_spf1', type: 'input_text', props: { name: 'name', label: 'Sprint name', required: true, inputType: 'text' }, style: { span: 12 }, visible: true },
                                { id: 'cmp_spf2', type: 'input_date', props: { name: 'start_date', label: 'Starts', required: false, defaultValue: null }, style: { span: 6 }, visible: true },
                                { id: 'cmp_spf3', type: 'input_date', props: { name: 'end_date', label: 'Ends', required: false, defaultValue: null }, style: { span: 6 }, visible: true },
                                { id: 'cmp_spf4', type: 'input_number', props: { name: 'capacity_points', label: 'Capacity', required: false, min: 0, max: 999, step: 1, defaultValue: null }, style: { span: 6 }, visible: true },
                                { id: 'cmp_spf5', type: 'input_text', props: { name: 'goal', label: 'Sprint goal', required: false, inputType: 'text' }, style: { span: 12 }, visible: true },
                            ],
                        },
                    ],
                },
            ],
        },
    ],
};

// ==================================================================
// WORK ITEM — the full record, its children and its notes.
// ==================================================================
const SCREEN_ITEM = {
    id: 'scr_item',
    name: 'Work item',
    icon: 'IdCard',
    showInNav: false,
    maxWidth: 'wide',
    description: 'One work item in full.',
    sections: [
        {
            id: 'sec_itop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_ihdr',
                    type: 'page_header',
                    props: {
                        title: 'Work item',
                        subtitle: null,
                        titleFrom: { kind: 'formula', expr: 'vars.item.title' },
                        subtitleFrom: { kind: 'formula', expr: 'vars.item.epic_key' },
                        icon: 'IdCard',
                        showDivider: true,
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_iback',
                            type: 'button',
                            props: { label: 'Back to board', variant: 'ghost', iconLeft: 'ArrowLeft', role: 'button' },
                            style: { span: 3 },
                            visible: true,
                            onClick: 'act_igoboard',
                        },
                        {
                            id: 'cmp_imine',
                            type: 'button',
                            props: { label: 'Assign to me', variant: 'soft', iconLeft: 'UserRound', role: 'button' },
                            style: { span: 3 },
                            visible: true,
                            onClick: 'act_imine',
                        },
                    ],
                },
                {
                    id: 'cmp_idet',
                    type: 'record_detail',
                    props: {
                        source: { kind: 'formula', expr: 'vars.item' },
                        columns: 3,
                        fields: [
                            { key: 'item_type', label: 'Type', format: 'badge' },
                            { key: 'state', label: 'State', format: 'badge' },
                            { key: 'priority', label: 'Priority', format: 'badge' },
                            { key: 'points', label: 'Points', format: 'number' },
                            { key: 'assignee_name', label: 'Assignee', format: 'text' },
                            { key: 'due_date', label: 'Due', format: 'date' },
                            { key: 'epic_key', label: 'Epic', format: 'text' },
                            { key: 'closed_at', label: 'Closed', format: 'datetime' },
                            { key: 'description', label: 'Description', format: 'markdown' },
                        ],
                        emptyText: 'Open an item from the board or backlog.',
                    },
                    style: { span: 12 },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_imain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_ikids',
                    type: 'list',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_items01',
                            filter: [{ field: 'parent_id', op: 'eq', value: { kind: 'formula', expr: 'vars.item.id' }, required: true }],
                            sort: [{ field: 'rank', dir: 'asc' }],
                            limit: 100,
                        },
                        titleKey: 'title',
                        subtitleKey: 'assignee_name',
                        metaKey: 'points',
                        timestampKey: null,
                        badgeKey: 'state',
                        badgeToneMap: [],
                        unreadKey: null,
                        selectedWhen: null,
                        icon: 'ListChecks',
                        emptyText: 'No child items.',
                    },
                    style: { span: 6, height: 'fill' },
                    visible: true,
                    onRowClick: 'act_ipickkid',
                },
                {
                    id: 'cmp_inotes',
                    type: 'list',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_notes01',
                            filter: [{ field: 'work_item_id', op: 'eq', value: { kind: 'formula', expr: 'vars.item.id' }, required: true }],
                            sort: [{ field: 'created_at', dir: 'desc' }],
                            limit: 100,
                        },
                        titleKey: 'body',
                        subtitleKey: 'author_name',
                        metaKey: null,
                        timestampKey: 'created_at',
                        badgeKey: null,
                        badgeToneMap: [],
                        unreadKey: null,
                        selectedWhen: null,
                        icon: 'MessagesSquare',
                        emptyText: 'No notes yet.',
                    },
                    style: { span: 6, height: 'fill' },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_inote',
            style: { padding: 4, gap: 3, background: 'panel' },
            children: [
                {
                    id: 'cmp_inform',
                    type: 'form',
                    props: { name: 'newnote', submitLabel: 'Add note', showReset: false, showSubmit: true },
                    style: { span: 12, gap: 3, padding: 0 },
                    visible: true,
                    onSubmit: 'act_inote',
                    children: [
                        { id: 'cmp_inf1', type: 'input_textarea', props: { name: 'body', label: 'Note', required: true, rows: 3 }, style: { span: 12 }, visible: true },
                    ],
                },
                {
                    // This screen has always SHOWN an assignee and never offered
                    // a way to set one — the record_detail above is read-only and
                    // there was no form on the page but the note box.
                    id: 'cmp_iasgform',
                    type: 'form',
                    props: { name: 'assign', submitLabel: 'Assign', showReset: false, showSubmit: true },
                    style: { span: 12, gap: 3, padding: 0 },
                    visible: true,
                    onSubmit: 'act_iassign',
                    children: [
                        { id: 'cmp_iasg1', type: 'input_person', props: { name: 'assignee_id', label: 'Give this to', multiple: false, required: true, allowMe: true }, style: { span: 12 }, visible: true },
                    ],
                },
            ],
        },
    ],
};

// ==================================================================
// EPICS — the top of the hierarchy, with how much sits under each.
// ==================================================================
const SCREEN_EPICS = {
    id: 'scr_epics',
    name: 'Epics',
    icon: 'LayoutTemplate',
    showInNav: true,
    maxWidth: 'wide',
    description: 'The big rocks, and what is underneath them.',
    sections: [
        {
            id: 'sec_eptop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_ephdr',
                    type: 'page_header',
                    props: {
                        title: 'Epics',
                        subtitle: 'Work grouped by the epic each item names. An epic with no items under it is a plan nobody started.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'LayoutTemplate',
                        showDivider: false,
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [],
                },
            ],
        },
        {
            id: 'sec_epmain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_epgrid',
                    type: 'data_grid',
                    props: {
                        source: {
                            kind: 'records',
                            tableId: 'tbl_items01',
                            filter: [
                                { field: 'board_id', op: 'eq', value: { kind: 'formula', expr: 'vars.board.id' }, required: true },
                                { field: 'item_type', op: 'eq', value: 'epic' },
                            ],
                            sort: [{ field: 'rank', dir: 'asc' }],
                            limit: 100,
                        },
                        columns: [
                            { key: 'title', label: 'Epic', format: 'text', width: 320, sortable: true, filterable: true, editable: false },
                            { key: 'epic_key', label: 'Key', format: 'text', width: 160, sortable: true, filterable: true, editable: false },
                            { key: 'state', label: 'State', format: 'badge', width: 130, sortable: true, filterable: true, editable: false },
                            { key: 'due_date', label: 'Target', format: 'date', width: 120, sortable: true, filterable: false, editable: false },
                        ],
                        pageSize: 25,
                        selectable: 'none',
                        searchable: true,
                        rowActions: [{ label: 'Open', actionId: 'act_gotorow' }],
                        density: 'comfortable',
                        zebra: true,
                        look: 'minimal',
                        emptyText: 'No epics on this board.',
                    },
                    style: { span: 6, height: 'fill' },
                    visible: true,
                },
                {
                    id: 'cmp_epchart',
                    type: 'chart',
                    props: {
                        chartType: 'bar',
                        source: {
                            kind: 'aggregate',
                            tableId: 'tbl_items01',
                            groupBy: [{ field: 'epic_key', as: 'epic' }],
                            aggregates: [{ fn: 'count', field: '*', as: 'items' }],
                            filter: [
                                { field: 'board_id', op: 'eq', value: { kind: 'formula', expr: 'vars.board.id' }, required: true },
                                // The grid lists the epics themselves; this counts the work
                                // UNDER them. Without this clause each epic also counted
                                // itself, so a plan nobody had started still showed a bar of
                                // 1 — the one number on this screen that must be able to
                                // read zero.
                                { field: 'item_type', op: 'neq', value: 'epic' },
                            ],
                            limit: 20,
                        },
                        title: 'Items per epic',
                        xKey: 'epic',
                        series: [{ key: 'items', label: 'Items', color: 'primary' }],
                        stacked: false,
                        showLegend: false,
                        showGrid: true,
                        valueFormat: 'number',
                    },
                    style: { span: 6, height: 'fill' },
                    visible: true,
                },
            ],
        },
    ],
};

// ==================================================================
// SETUP — the configuration that makes the board the team's own.
//
// This screen is where the header's central claim has to become true. Adding an
// "In review" column, a new work-item type, a second board — all of it happens
// HERE, in the running app, by someone with no access to the builder. So every
// config table needs three affordances, not one: read it, ADD to it, and REMOVE
// from it. A grid that can only edit rows somebody else seeded is a demo of the
// idea, not the idea.
//
// The add dialogs live in their own section rather than inside the tabs. Nesting
// them would read section → tabs → tab → modal → form → input, which is exactly
// the depth ceiling; hoisting them keeps every form two levels clear of it and
// costs nothing, since a modal is positioned by the runtime, not by its slot.
// ==================================================================
const SCREEN_SETUP = {
    id: 'scr_setup',
    name: 'Setup',
    icon: 'TableProperties',
    showInNav: true,
    maxWidth: 'wide',
    description: 'Boards, columns, states, types and people.',
    sections: [
        {
            id: 'sec_sutop',
            style: { padding: 4, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_suhdr',
                    type: 'page_header',
                    props: {
                        title: 'Setup',
                        subtitle: 'Everything here is data, not code — add a state and the boards that use it grow a column.',
                        titleFrom: { kind: 'static', value: null },
                        subtitleFrom: { kind: 'static', value: null },
                        icon: 'TableProperties',
                        showDivider: false,
                    },
                    style: { span: 12 },
                    visible: true,
                    children: [],
                },
                {
                    id: 'cmp_sunote',
                    type: 'callout',
                    props: {
                        title: 'One thing to know',
                        text: 'Boards read their columns, states and types from these tables live, so anything you add here shows up on the board straight away. The one exception is the Type dropdown in the Backlog filter bar: that list is fixed in the app design, so a new type appears on the board and in the grids but not in that dropdown until an editor adds it there.',
                        tone: 'info',
                    },
                    style: { span: 12 },
                    visible: true,
                },
            ],
        },
        {
            id: 'sec_sumain',
            style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
            children: [
                {
                    id: 'cmp_sutabs',
                    type: 'tabs',
                    props: { look: 'pills' },
                    style: { span: 12 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_sutab0',
                            type: 'tab',
                            props: { label: 'Boards', icon: 'SquareKanban' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_suboards',
                                    type: 'data_grid',
                                    props: {
                                        source: { kind: 'records', tableId: 'tbl_boards1', sort: [{ field: 'position', dir: 'asc' }], limit: 50 },
                                        columns: [
                                            { key: 'position', label: 'Order', format: 'number', width: 80, sortable: true, filterable: false, editable: true },
                                            { key: 'name', label: 'Board', format: 'text', width: 220, sortable: true, filterable: true, editable: true },
                                            { key: 'board_type', label: 'Type', format: 'badge', width: 120, sortable: true, filterable: true, editable: true },
                                            { key: 'description', label: 'Description', format: 'text', width: 320, sortable: false, filterable: false, editable: true },
                                        ],
                                        pageSize: 25,
                                        selectable: 'none',
                                        searchable: false,
                                        rowActions: [{ label: 'Delete', actionId: 'act_subddel' }],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'No boards yet — add one below.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                    onRowSelect: 'act_subdsave',
                                },
                                {
                                    id: 'cmp_subdadd',
                                    type: 'button',
                                    props: { label: 'Add board', variant: 'primary', iconLeft: 'Plus', role: 'button' },
                                    style: { span: 3 },
                                    visible: true,
                                    onClick: 'act_subdopen',
                                },
                            ],
                        },
                        {
                            id: 'cmp_sutab1',
                            type: 'tab',
                            props: { label: 'Columns', icon: 'Columns2' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_sucols',
                                    type: 'data_grid',
                                    props: {
                                        source: {
                                            kind: 'records',
                                            tableId: 'tbl_bcols01',
                                            filter: [{ field: 'board_id', op: 'eq', value: { kind: 'formula', expr: 'vars.board.id' }, required: true }],
                                            sort: [{ field: 'position', dir: 'asc' }],
                                            limit: 50,
                                        },
                                        columns: [
                                            { key: 'position', label: 'Order', format: 'number', width: 80, sortable: true, filterable: false, editable: true },
                                            { key: 'state', label: 'State key', format: 'text', width: 160, sortable: true, filterable: true, editable: true },
                                            { key: 'label', label: 'Shown as', format: 'badge', width: 180, sortable: false, filterable: false, editable: true, toneFrom: 'color' },
                                            { key: 'color', label: 'Colour', format: 'badge', width: 120, sortable: false, filterable: false, editable: true, toneFrom: 'color', toneMap: COLOR_TONES },
                                            { key: 'wip_limit', label: 'WIP limit', format: 'number', width: 110, sortable: false, filterable: false, editable: true },
                                        ],
                                        pageSize: 25,
                                        selectable: 'none',
                                        searchable: false,
                                        rowActions: [{ label: 'Delete', actionId: 'act_sucoldel' }],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'Pick a board on the Board screen, then add its columns here.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                    onRowSelect: 'act_sucolsave',
                                },
                                {
                                    id: 'cmp_sucoladd',
                                    type: 'button',
                                    props: { label: 'Add column', variant: 'primary', iconLeft: 'Plus', role: 'button' },
                                    style: { span: 3 },
                                    visible: true,
                                    onClick: 'act_sucolopen',
                                },
                            ],
                        },
                        {
                            id: 'cmp_sutab2',
                            type: 'tab',
                            props: { label: 'States', icon: 'ListChecks' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_sustates',
                                    type: 'data_grid',
                                    props: {
                                        source: { kind: 'records', tableId: 'tbl_states1', sort: [{ field: 'position', dir: 'asc' }], limit: 50 },
                                        columns: [
                                            { key: 'position', label: 'Order', format: 'number', width: 80, sortable: true, filterable: false, editable: true },
                                            { key: 'key', label: 'Key', format: 'text', width: 160, sortable: true, filterable: true, editable: false },
                                            { key: 'name', label: 'Name', format: 'badge', width: 200, sortable: false, filterable: false, editable: true, toneFrom: 'color' },
                                            { key: 'category', label: 'Counts as', format: 'badge', width: 140, sortable: true, filterable: true, editable: true },
                                            { key: 'color', label: 'Colour', format: 'badge', width: 120, sortable: false, filterable: false, editable: true, toneFrom: 'color', toneMap: COLOR_TONES },
                                        ],
                                        pageSize: 25,
                                        selectable: 'none',
                                        searchable: false,
                                        rowActions: [{ label: 'Delete', actionId: 'act_sustdel' }],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'No states configured.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                    onRowSelect: 'act_sustsave',
                                },
                                {
                                    id: 'cmp_sustadd',
                                    type: 'button',
                                    props: { label: 'Add state', variant: 'primary', iconLeft: 'Plus', role: 'button' },
                                    style: { span: 3 },
                                    visible: true,
                                    onClick: 'act_sustopen',
                                },
                            ],
                        },
                        {
                            id: 'cmp_sutab3',
                            type: 'tab',
                            props: { label: 'Types', icon: 'Tags' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_sutypes',
                                    type: 'data_grid',
                                    props: {
                                        source: { kind: 'records', tableId: 'tbl_types01', sort: [{ field: 'position', dir: 'asc' }], limit: 50 },
                                        columns: [
                                            { key: 'position', label: 'Order', format: 'number', width: 80, sortable: true, filterable: false, editable: true },
                                            { key: 'key', label: 'Key', format: 'text', width: 140, sortable: true, filterable: true, editable: false },
                                            { key: 'name', label: 'Name', format: 'badge', width: 180, sortable: false, filterable: false, editable: true, toneFrom: 'color' },
                                            { key: 'level', label: 'Level', format: 'number', width: 90, sortable: true, filterable: false, editable: true },
                                            { key: 'color', label: 'Colour', format: 'badge', width: 120, sortable: false, filterable: false, editable: true, toneFrom: 'color', toneMap: COLOR_TONES },
                                        ],
                                        pageSize: 25,
                                        selectable: 'none',
                                        searchable: false,
                                        rowActions: [{ label: 'Delete', actionId: 'act_sutydel' }],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'No work item types configured.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                    onRowSelect: 'act_sutysave',
                                },
                                {
                                    id: 'cmp_sutyadd',
                                    type: 'button',
                                    props: { label: 'Add type', variant: 'primary', iconLeft: 'Plus', role: 'button' },
                                    style: { span: 3 },
                                    visible: true,
                                    onClick: 'act_sutyopen',
                                },
                            ],
                        },
                        {
                            id: 'cmp_sutab4',
                            type: 'tab',
                            props: { label: 'Team', icon: 'IdCard' },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_sumem',
                                    type: 'data_grid',
                                    props: {
                                        source: { kind: 'records', tableId: 'tbl_member1', sort: [{ field: 'name', dir: 'asc' }], limit: 100 },
                                        columns: [
                                            { key: 'name', label: 'Name', format: 'text', width: 200, sortable: true, filterable: true, editable: true },
                                            { key: 'email', label: 'E-mail', format: 'text', width: 240, sortable: true, filterable: true, editable: true },
                                            { key: 'role', label: 'Role', format: 'badge', width: 140, sortable: true, filterable: true, editable: true },
                                            { key: 'capacity_points', label: 'Capacity', format: 'number', width: 110, sortable: false, filterable: false, editable: true },
                                            { key: 'is_active', label: 'Active', format: 'boolean', width: 90, sortable: false, filterable: false, editable: true },
                                        ],
                                        pageSize: 25,
                                        selectable: 'none',
                                        searchable: true,
                                        rowActions: [{ label: 'Delete', actionId: 'act_sumemdel' }],
                                        density: 'compact',
                                        zebra: true,
                                        emptyText: 'Nobody on the team yet.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                    onRowSelect: 'act_sumemsave',
                                },
                                {
                                    id: 'cmp_sumemadd',
                                    type: 'button',
                                    props: { label: 'Add person', variant: 'primary', iconLeft: 'Plus', role: 'button' },
                                    style: { span: 3 },
                                    visible: true,
                                    onClick: 'act_sumemopen',
                                },
                            ],
                        },
                    ],
                },
            ],
        },
        {
            // Every add dialog, hoisted out of the tabs — see the screen header.
            id: 'sec_sudlg',
            style: { padding: 0, gap: 3, background: 'none' },
            children: [
                {
                    id: 'cmp_subdmod',
                    type: 'modal',
                    props: { title: 'Add board', size: 'md', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_subdfrm',
                            type: 'form',
                            props: { name: 'newboard', submitLabel: 'Create board', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_subdadd',
                            children: [
                                { id: 'cmp_subdf1', type: 'input_text', props: { name: 'name', label: 'Board name', required: true, inputType: 'text' }, style: { span: 8 }, visible: true },
                                { id: 'cmp_subdf2', type: 'input_number', props: { name: 'position', label: 'Order', required: false, min: 1, max: 99, step: 1, defaultValue: 1 }, style: { span: 4 }, visible: true },
                                { id: 'cmp_subdf3', type: 'input_select', props: { name: 'board_type', label: 'Board type', required: true, options: BOARD_TYPE_OPTIONS, defaultValue: 'scrum', placeholder: null, valueFrom: { kind: 'static', value: null } }, style: { span: 12 }, visible: true },
                                { id: 'cmp_subdf4', type: 'input_text', props: { name: 'description', label: 'Description', required: false, inputType: 'text' }, style: { span: 12 }, visible: true },
                            ],
                        },
                    ],
                },
                {
                    id: 'cmp_sucolmod',
                    type: 'modal',
                    props: { title: 'Add column', size: 'md', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_sucolfrm',
                            type: 'form',
                            props: { name: 'newcol', submitLabel: 'Add column', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_sucoladd2',
                            children: [
                                { id: 'cmp_sucolf1', type: 'input_text', props: { name: 'state', label: 'State key (must match a state below)', required: true, inputType: 'text' }, style: { span: 8 }, visible: true },
                                { id: 'cmp_sucolf2', type: 'input_number', props: { name: 'position', label: 'Order', required: false, min: 1, max: 99, step: 1, defaultValue: 1 }, style: { span: 4 }, visible: true },
                                { id: 'cmp_sucolf3', type: 'input_text', props: { name: 'label', label: 'Shown as', required: false, inputType: 'text' }, style: { span: 6 }, visible: true },
                                { id: 'cmp_sucolf4', type: 'input_select', props: { name: 'color', label: 'Colour', required: false, options: COLOR_OPTIONS, defaultValue: 'neutral', placeholder: null, valueFrom: { kind: 'static', value: null } }, style: { span: 6 }, visible: true },
                                { id: 'cmp_sucolf5', type: 'input_number', props: { name: 'wip_limit', label: 'WIP limit (0 = none)', required: false, min: 0, max: 99, step: 1, defaultValue: 0 }, style: { span: 6 }, visible: true },
                            ],
                        },
                    ],
                },
                {
                    id: 'cmp_sustmod',
                    type: 'modal',
                    props: { title: 'Add state', size: 'md', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_sustfrm',
                            type: 'form',
                            props: { name: 'newstate', submitLabel: 'Add state', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_sustadd',
                            children: [
                                { id: 'cmp_sustf1', type: 'input_text', props: { name: 'key', label: 'Key (what a work item stores, e.g. in_review)', required: true, inputType: 'text' }, style: { span: 8 }, visible: true },
                                { id: 'cmp_sustf2', type: 'input_number', props: { name: 'position', label: 'Order', required: false, min: 1, max: 99, step: 1, defaultValue: 1 }, style: { span: 4 }, visible: true },
                                { id: 'cmp_sustf3', type: 'input_text', props: { name: 'name', label: 'Name', required: true, inputType: 'text' }, style: { span: 6 }, visible: true },
                                { id: 'cmp_sustf4', type: 'input_select', props: { name: 'category', label: 'Counts as', required: true, options: STATE_CATEGORY_OPTIONS, defaultValue: 'todo', placeholder: null, valueFrom: { kind: 'static', value: null } }, style: { span: 6 }, visible: true },
                                { id: 'cmp_sustf5', type: 'input_select', props: { name: 'color', label: 'Colour', required: false, options: COLOR_OPTIONS, defaultValue: 'neutral', placeholder: null, valueFrom: { kind: 'static', value: null } }, style: { span: 6 }, visible: true },
                            ],
                        },
                    ],
                },
                {
                    id: 'cmp_sutymod',
                    type: 'modal',
                    props: { title: 'Add work item type', size: 'md', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_sutyfrm',
                            type: 'form',
                            props: { name: 'newtype', submitLabel: 'Add type', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_sutyadd',
                            children: [
                                { id: 'cmp_sutyf1', type: 'input_text', props: { name: 'key', label: 'Key (e.g. spike)', required: true, inputType: 'text' }, style: { span: 8 }, visible: true },
                                { id: 'cmp_sutyf2', type: 'input_number', props: { name: 'position', label: 'Order', required: false, min: 1, max: 99, step: 1, defaultValue: 1 }, style: { span: 4 }, visible: true },
                                { id: 'cmp_sutyf3', type: 'input_text', props: { name: 'name', label: 'Name', required: true, inputType: 'text' }, style: { span: 6 }, visible: true },
                                { id: 'cmp_sutyf4', type: 'input_number', props: { name: 'level', label: 'Level (3 epic, 1 story, 0 task)', required: true, min: 0, max: 9, step: 1, defaultValue: 1 }, style: { span: 6 }, visible: true },
                                { id: 'cmp_sutyf5', type: 'input_select', props: { name: 'color', label: 'Colour', required: false, options: COLOR_OPTIONS, defaultValue: 'neutral', placeholder: null, valueFrom: { kind: 'static', value: null } }, style: { span: 6 }, visible: true },
                            ],
                        },
                    ],
                },
                {
                    id: 'cmp_sumemmod',
                    type: 'modal',
                    props: { title: 'Add person', size: 'md', triggerLabel: null },
                    style: { gap: 3, padding: 0 },
                    visible: true,
                    children: [
                        {
                            id: 'cmp_sumemfrm',
                            type: 'form',
                            props: { name: 'newmember', submitLabel: 'Add person', showReset: false, showSubmit: true },
                            style: { span: 12, gap: 3, padding: 0 },
                            visible: true,
                            onSubmit: 'act_sumemadd',
                            children: [
                                { id: 'cmp_sumemf1', type: 'input_text', props: { name: 'name', label: 'Name', required: true, inputType: 'text' }, style: { span: 6 }, visible: true },
                                // The e-mail is the identity "Only mine" matches
                                // on, and it is the SAME string embedded in
                                // Nextcloud as standalone.
                                { id: 'cmp_sumemf2', type: 'input_text', props: { name: 'email', label: 'E-mail', required: false, inputType: 'email' }, style: { span: 6 }, visible: true },
                                { id: 'cmp_sumemf3', type: 'input_select', props: { name: 'role', label: 'Role', required: false, options: MEMBER_ROLE_OPTIONS, defaultValue: 'member', placeholder: null, valueFrom: { kind: 'static', value: null } }, style: { span: 6 }, visible: true },
                                { id: 'cmp_sumemf4', type: 'input_number', props: { name: 'capacity_points', label: 'Capacity (points per sprint)', required: false, min: 0, max: 999, step: 1, defaultValue: 0 }, style: { span: 6 }, visible: true },
                            ],
                        },
                    ],
                },
            ],
        },
    ],
};

/**
 * ── THE LOGIC BEHIND THE CONTROLS ──────────────────────────────────────────
 *
 * Two rules run through all of it.
 *
 * WHERE CONTEXT COMES FROM. A server step (create/update/delete_record) sees
 * `form`, `vars`, `item`, `value` and `currentUser` — and NOT `screen`,
 * `forms`, `actions` or `records`. So a write reads the event payload (`form.*`,
 * which for a card drag is { item, value, lane, index, beforeId, afterId, rank })
 * or a variable an earlier CLIENT step put there. Nothing here reads
 * `screen.params`: that resolves in preview and writes NULL in production.
 *
 * WHY EVERY MUTATION ENDS IN `refresh`. Nothing invalidates a bound query after
 * a write, so without it the dragged card springs back to its old column until
 * something else happens to refetch. `refresh` names the table it dirtied.
 */
const actions = {
    // ── Board ──────────────────────────────────────────────────────────────

    /** Pick the board every screen is scoped to. `item` is the clicked row. */
    act_bdpick: {
        kind: 'sequence',
        steps: [
            { kind: 'set_variable', name: 'board', value: { kind: 'formula', expr: 'item' } },
            // A sprint belongs to ONE board, so a stale selection would scope
            // the new board to a sprint that is not on it — and silently show
            // an empty board.
            { kind: 'set_variable', name: 'sprint', value: { kind: 'static', value: null } },
        ],
    },

    /**
     * The drag. `form.value` is the column the card was dropped in — which for
     * this board IS the state, one column per state — and `form.rank` is the
     * order the kanban computed from the card's new neighbours.
     */
    act_bdmove: {
        kind: 'sequence',
        steps: [
            {
                // The board is laned by `epic_key`, and a card's epic is decided
                // by its PARENT, not by where it was dropped. So a cross-lane
                // drag is refused rather than half-applied: writing form.lane
                // would leave epic_key disagreeing with parent_id, and writing
                // the rank alone would persist a position bracketed by the
                // neighbours of a lane the card is not in. Re-parenting is a
                // decision, so it belongs on the work item, not on a drag.
                kind: 'condition',
                expr: 'form.lane == null || form.lane == form.item.epic_key',
                then: [
                    {
                        kind: 'update_record',
                        tableId: 'tbl_items01',
                        recordId: { kind: 'formula', expr: 'form.item.id' },
                        values: {
                            state: { kind: 'formula', expr: 'form.value' },
                            rank: { kind: 'formula', expr: 'form.rank' },
                        },
                    },
                    { kind: 'refresh', tableId: 'tbl_items01' },
                ],
                else: [
                    { kind: 'toast', message: 'Change the epic on the work item itself — a card cannot be dragged into another epic.', tone: 'info' },
                    { kind: 'refresh', tableId: 'tbl_items01' },
                ],
            },
        ],
    },

    /** Open a card in the dialog. */
    act_bdopen: {
        kind: 'sequence',
        steps: [
            { kind: 'set_variable', name: 'item', value: { kind: 'formula', expr: 'item' } },
            { kind: 'open_modal', modalId: 'cmp_bdmodal' },
        ],
    },

    act_gotoitem: {
        kind: 'sequence',
        steps: [
            { kind: 'close_modal', modalId: 'cmp_bdmodal' },
            { kind: 'navigate', screenId: 'scr_item' },
        ],
    },

    /** A grid row action: remember the row, then show it in full. */
    act_gotorow: {
        kind: 'sequence',
        steps: [
            { kind: 'set_variable', name: 'item', value: { kind: 'formula', expr: 'item' } },
            { kind: 'navigate', screenId: 'scr_item' },
        ],
    },

    // ── Backlog ────────────────────────────────────────────────────────────

    act_blopen: { kind: 'open_modal', modalId: 'cmp_blmodal' },

    /**
     * Raise a new item. rank 0 puts it at the TOP of a rank-ascending backlog
     * (the seeded work starts at 100), which is where something nobody has
     * triaged yet belongs.
     */
    act_blcreate: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_items01',
                resultVar: 'created',
                values: {
                    title: { kind: 'formula', expr: 'form.title' },
                    description: { kind: 'formula', expr: 'form.description' },
                    item_type: { kind: 'formula', expr: 'form.item_type' },
                    priority: { kind: 'formula', expr: 'form.priority' },
                    points: { kind: 'formula', expr: 'form.points' },
                    due_date: { kind: 'formula', expr: 'form.due_date' },
                    board_id: { kind: 'formula', expr: 'vars.board.id' },
                    sprint_id: { kind: 'formula', expr: 'vars.sprint.id' },
                    state: { kind: 'static', value: 'todo' },
                    // Both halves, together. The picker submits the id and
                    // publishes `<name>_label` beside it precisely because the
                    // server has no directory to look the name up from at write
                    // time — writing only the id would store a row whose owner
                    // nobody can read.
                    assignee_id: { kind: 'formula', expr: 'form.assignee_id' },
                    assignee_name: { kind: 'formula', expr: 'form.assignee_id_label' },
                    // A DISTINCT, descending rank per item, so newly raised work
                    // stacks at the top of a rank-ascending backlog where
                    // something untriaged belongs — and, more importantly, so no
                    // two items ever tie. Tied neighbours have no gap to insert
                    // between, and expressing "between two equal ranks" would
                    // need the neighbours renumbered in the same transaction,
                    // which there is no atomic multi-row write for.
                    // `now` is one of the few roots a server step can read; the
                    // replaces strip the punctuation out of the ISO timestamp so
                    // number() sees 20260815100437 — monotonic to the second.
                    rank: { kind: 'formula', expr: "0 - number(replace(replace(replace(substring(now,0,19),'-',''),':',''),'T',''))" },
                },
            },
            { kind: 'close_modal', modalId: 'cmp_blmodal' },
            { kind: 'reset_form', form: 'newitem' },
            { kind: 'refresh', tableId: 'tbl_items01' },
            { kind: 'toast', message: 'Added to the backlog.', tone: 'success' },
        ],
    },

    /**
     * Inline grid edits. The grid is selectable:'none', so onRowSelect only
     * ever fires for a committed cell edit — it carries the whole edited row.
     */
    act_blsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_items01',
                recordId: { kind: 'formula', expr: 'form.id' },
                // Compare-and-set: refuse the write if somebody else changed
                // the row since this grid loaded it, rather than overwriting
                // them without a word.
                expectedUpdatedAt: { kind: 'formula', expr: 'form.updated_at' },
                values: {
                    title: { kind: 'formula', expr: 'form.title' },
                    state: { kind: 'formula', expr: 'form.state' },
                    priority: { kind: 'formula', expr: 'form.priority' },
                    points: { kind: 'formula', expr: 'form.points' },
                    due_date: { kind: 'formula', expr: 'form.due_date' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_items01' },
        ],
    },

    /**
     * Take this one. One click, from the row.
     *
     * `currentUser` is in scope on both sides of the wire, so the id and the
     * name are both available without a directory lookup — which is just as
     * well, because a server step has no directory to look one up in.
     */
    act_blmine: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_items01',
                recordId: { kind: 'formula', expr: 'item.id' },
                values: {
                    assignee_id: { kind: 'formula', expr: 'currentUser.id' },
                    assignee_name: { kind: 'formula', expr: 'currentUser.name' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_items01' },
            { kind: 'toast', message: 'Assigned to you.', tone: 'success' },
        ],
    },

    /** The same one-click take, from the work-item screen. */
    act_imine: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_items01',
                recordId: { kind: 'formula', expr: 'vars.item.id' },
                values: {
                    assignee_id: { kind: 'formula', expr: 'currentUser.id' },
                    assignee_name: { kind: 'formula', expr: 'currentUser.name' },
                },
                resultVar: 'assignedItem',
            },
            // The screen reads `vars.item`, so the record it was opened with has
            // to be replaced or the detail panel keeps showing the old owner
            // until someone navigates away and back.
            { kind: 'set_variable', name: 'item', value: { kind: 'formula', expr: 'actions.assignedItem' } },
            { kind: 'refresh', tableId: 'tbl_items01' },
            { kind: 'toast', message: 'Assigned to you.', tone: 'success' },
        ],
    },

    /** Give this item to somebody else. */
    act_iassign: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_items01',
                recordId: { kind: 'formula', expr: 'vars.item.id' },
                values: {
                    assignee_id: { kind: 'formula', expr: 'form.assignee_id' },
                    assignee_name: { kind: 'formula', expr: 'form.assignee_id_label' },
                },
                resultVar: 'assignedItem',
            },
            { kind: 'set_variable', name: 'item', value: { kind: 'formula', expr: 'actions.assignedItem' } },
            { kind: 'reset_form', form: 'assign' },
            { kind: 'refresh', tableId: 'tbl_items01' },
            { kind: 'toast', message: 'Assigned.', tone: 'success' },
        ],
    },

    /** Pull a backlog item into the selected sprint. */
    act_tosprint: {
        kind: 'sequence',
        steps: [
            {
                kind: 'condition',
                expr: 'vars.sprint.id',
                then: [
                    {
                        kind: 'update_record',
                        tableId: 'tbl_items01',
                        recordId: { kind: 'formula', expr: 'item.id' },
                        values: { sprint_id: { kind: 'formula', expr: 'vars.sprint.id' } },
                    },
                    { kind: 'refresh', tableId: 'tbl_items01' },
                    { kind: 'toast', message: 'Moved into the sprint.', tone: 'success' },
                ],
                else: [
                    { kind: 'toast', message: 'Pick a sprint on the Sprints screen first.', tone: 'info' },
                ],
            },
        ],
    },

    // ── Sprints ────────────────────────────────────────────────────────────

    act_sppick: {
        kind: 'sequence',
        steps: [{ kind: 'set_variable', name: 'sprint', value: { kind: 'formula', expr: 'item' } }],
    },

    act_spclear: {
        kind: 'sequence',
        steps: [{ kind: 'set_variable', name: 'sprint', value: { kind: 'static', value: null } }],
    },

    /** Open the create-sprint dialog. */
    act_spopen: { kind: 'open_modal', modalId: 'cmp_spmodal' },

    act_spcreate: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_sprint1',
                resultVar: 'createdSprint',
                values: {
                    name: { kind: 'formula', expr: 'form.name' },
                    goal: { kind: 'formula', expr: 'form.goal' },
                    start_date: { kind: 'formula', expr: 'form.start_date' },
                    end_date: { kind: 'formula', expr: 'form.end_date' },
                    capacity_points: { kind: 'formula', expr: 'form.capacity_points' },
                    board_id: { kind: 'formula', expr: 'vars.board.id' },
                    status: { kind: 'static', value: 'planned' },
                },
            },
            { kind: 'reset_form', form: 'newsprint' },
            { kind: 'close_modal', modalId: 'cmp_spmodal' },
            { kind: 'refresh', tableId: 'tbl_sprint1' },
            { kind: 'toast', message: 'Sprint created.', tone: 'success' },
        ],
    },

    /** Take an item back out of the sprint, leaving it on the backlog. */
    act_spdrop: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_items01',
                recordId: { kind: 'formula', expr: 'item.id' },
                values: { sprint_id: { kind: 'static', value: null } },
            },
            { kind: 'refresh', tableId: 'tbl_items01' },
        ],
    },

    // ── Work item ──────────────────────────────────────────────────────────

    act_igoboard: { kind: 'navigate', screenId: 'scr_board' },

    /** Walk DOWN the hierarchy: a child becomes the item on screen. */
    act_ipickkid: {
        kind: 'sequence',
        steps: [{ kind: 'set_variable', name: 'item', value: { kind: 'formula', expr: 'item' } }],
    },

    act_inote: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_notes01',
                values: {
                    work_item_id: { kind: 'formula', expr: 'vars.item.id' },
                    body: { kind: 'formula', expr: 'form.body' },
                    // currentUser IS populated server-side, so the note is
                    // attributed to whoever wrote it — including a Nextcloud
                    // user in the embedded app.
                    author_name: { kind: 'formula', expr: 'currentUser.name' },
                },
            },
            { kind: 'reset_form', form: 'newnote' },
            { kind: 'refresh', tableId: 'tbl_notes01' },
        ],
    },

    // ── Setup — inline edits on the configuration grids ─────────────────────

    act_sucolsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_bcols01',
                recordId: { kind: 'formula', expr: 'form.id' },
                values: {
                    position: { kind: 'formula', expr: 'form.position' },
                    state: { kind: 'formula', expr: 'form.state' },
                    label: { kind: 'formula', expr: 'form.label' },
                    color: { kind: 'formula', expr: 'form.color' },
                    wip_limit: { kind: 'formula', expr: 'form.wip_limit' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_bcols01' },
        ],
    },

    act_sustsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_states1',
                recordId: { kind: 'formula', expr: 'form.id' },
                values: {
                    position: { kind: 'formula', expr: 'form.position' },
                    name: { kind: 'formula', expr: 'form.name' },
                    category: { kind: 'formula', expr: 'form.category' },
                    color: { kind: 'formula', expr: 'form.color' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_states1' },
        ],
    },

    act_sutysave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_types01',
                recordId: { kind: 'formula', expr: 'form.id' },
                values: {
                    position: { kind: 'formula', expr: 'form.position' },
                    name: { kind: 'formula', expr: 'form.name' },
                    level: { kind: 'formula', expr: 'form.level' },
                    color: { kind: 'formula', expr: 'form.color' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_types01' },
        ],
    },

    /**
     * ── ADD AND REMOVE, per config table ───────────────────────────────────
     *
     * This is what turns "the board is configured from data" from a diagram
     * into something a team lead can actually do. Each pair is the same shape:
     * a button opens a dialog, the form creates the row, the dialog closes, the
     * form resets, and the table refreshes so the change is on screen — and on
     * the board — immediately.
     *
     * Adding a COLUMN is the one that needs a guard: a column belongs to a
     * board, so with no board picked there is nothing to attach it to. Saying so
     * beats writing an orphan row nobody can see.
     */
    act_subdopen: { kind: 'open_modal', modalId: 'cmp_subdmod' },
    act_subdadd: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_boards1',
                values: {
                    name: { kind: 'formula', expr: 'form.name' },
                    board_type: { kind: 'formula', expr: 'form.board_type' },
                    description: { kind: 'formula', expr: 'form.description' },
                    position: { kind: 'formula', expr: 'form.position' },
                    swimlane_by: { kind: 'static', value: 'none' },
                    wip_enabled: { kind: 'static', value: true },
                },
            },
            { kind: 'close_modal', modalId: 'cmp_subdmod' },
            { kind: 'reset_form', form: 'newboard' },
            { kind: 'refresh', tableId: 'tbl_boards1' },
            { kind: 'toast', message: 'Board created. Give it some columns next.', tone: 'success' },
        ],
    },
    act_subddel: {
        kind: 'sequence',
        steps: [
            { kind: 'confirm', message: 'Delete this board? Its work items and sprints stay, but they will no longer appear on any board.', title: 'Delete board' },
            { kind: 'delete_record', tableId: 'tbl_boards1', recordId: { kind: 'formula', expr: 'item.id' } },
            { kind: 'refresh', tableId: 'tbl_boards1' },
        ],
    },

    act_sucolopen: { kind: 'open_modal', modalId: 'cmp_sucolmod' },
    act_sucoladd2: {
        kind: 'sequence',
        steps: [
            {
                kind: 'condition',
                expr: 'vars.board.id',
                then: [
                    {
                        kind: 'create_record',
                        tableId: 'tbl_bcols01',
                        values: {
                            board_id: { kind: 'formula', expr: 'vars.board.id' },
                            state: { kind: 'formula', expr: 'form.state' },
                            label: { kind: 'formula', expr: 'form.label' },
                            color: { kind: 'formula', expr: 'form.color' },
                            position: { kind: 'formula', expr: 'form.position' },
                            wip_limit: { kind: 'formula', expr: 'form.wip_limit' },
                        },
                    },
                    { kind: 'close_modal', modalId: 'cmp_sucolmod' },
                    { kind: 'reset_form', form: 'newcol' },
                    { kind: 'refresh', tableId: 'tbl_bcols01' },
                    { kind: 'toast', message: 'Column added — it is on the board now.', tone: 'success' },
                ],
                else: [
                    { kind: 'toast', message: 'Pick a board on the Board screen first — a column belongs to one.', tone: 'info' },
                ],
            },
        ],
    },
    act_sucoldel: {
        kind: 'sequence',
        steps: [
            { kind: 'confirm', message: 'Remove this column from the board? The work items in it keep their state and will appear in a trailing column until another one collects them.', title: 'Remove column' },
            { kind: 'delete_record', tableId: 'tbl_bcols01', recordId: { kind: 'formula', expr: 'item.id' } },
            { kind: 'refresh', tableId: 'tbl_bcols01' },
        ],
    },

    act_sustopen: { kind: 'open_modal', modalId: 'cmp_sustmod' },
    act_sustadd: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_states1',
                values: {
                    key: { kind: 'formula', expr: 'form.key' },
                    name: { kind: 'formula', expr: 'form.name' },
                    category: { kind: 'formula', expr: 'form.category' },
                    color: { kind: 'formula', expr: 'form.color' },
                    position: { kind: 'formula', expr: 'form.position' },
                },
            },
            { kind: 'close_modal', modalId: 'cmp_sustmod' },
            { kind: 'reset_form', form: 'newstate' },
            { kind: 'refresh', tableId: 'tbl_states1' },
            { kind: 'toast', message: 'State added. Add a column for it to show it on a board.', tone: 'success' },
        ],
    },
    act_sustdel: {
        kind: 'sequence',
        steps: [
            { kind: 'confirm', message: 'Delete this state? Work items already in it keep the key, so they will need moving.', title: 'Delete state' },
            { kind: 'delete_record', tableId: 'tbl_states1', recordId: { kind: 'formula', expr: 'item.id' } },
            { kind: 'refresh', tableId: 'tbl_states1' },
        ],
    },

    act_sutyopen: { kind: 'open_modal', modalId: 'cmp_sutymod' },
    act_sutyadd: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_types01',
                values: {
                    key: { kind: 'formula', expr: 'form.key' },
                    name: { kind: 'formula', expr: 'form.name' },
                    level: { kind: 'formula', expr: 'form.level' },
                    color: { kind: 'formula', expr: 'form.color' },
                    position: { kind: 'formula', expr: 'form.position' },
                },
            },
            { kind: 'close_modal', modalId: 'cmp_sutymod' },
            { kind: 'reset_form', form: 'newtype' },
            { kind: 'refresh', tableId: 'tbl_types01' },
            { kind: 'toast', message: 'Type added.', tone: 'success' },
        ],
    },
    act_sutydel: {
        kind: 'sequence',
        steps: [
            { kind: 'confirm', message: 'Delete this work item type? Items already using it keep the key.', title: 'Delete type' },
            { kind: 'delete_record', tableId: 'tbl_types01', recordId: { kind: 'formula', expr: 'item.id' } },
            { kind: 'refresh', tableId: 'tbl_types01' },
        ],
    },

    act_sumemopen: { kind: 'open_modal', modalId: 'cmp_sumemmod' },
    act_sumemadd: {
        kind: 'sequence',
        steps: [
            {
                kind: 'create_record',
                tableId: 'tbl_member1',
                values: {
                    name: { kind: 'formula', expr: 'form.name' },
                    email: { kind: 'formula', expr: 'form.email' },
                    role: { kind: 'formula', expr: 'form.role' },
                    capacity_points: { kind: 'formula', expr: 'form.capacity_points' },
                    is_active: { kind: 'static', value: true },
                },
            },
            { kind: 'close_modal', modalId: 'cmp_sumemmod' },
            { kind: 'reset_form', form: 'newmember' },
            { kind: 'refresh', tableId: 'tbl_member1' },
        ],
    },
    act_sumemdel: {
        kind: 'sequence',
        steps: [
            { kind: 'confirm', message: 'Remove this person from the team? Work assigned to them keeps their name.', title: 'Remove person' },
            { kind: 'delete_record', tableId: 'tbl_member1', recordId: { kind: 'formula', expr: 'item.id' } },
            { kind: 'refresh', tableId: 'tbl_member1' },
        ],
    },

    act_subdsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_boards1',
                recordId: { kind: 'formula', expr: 'form.id' },
                values: {
                    name: { kind: 'formula', expr: 'form.name' },
                    board_type: { kind: 'formula', expr: 'form.board_type' },
                    description: { kind: 'formula', expr: 'form.description' },
                    position: { kind: 'formula', expr: 'form.position' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_boards1' },
        ],
    },

    act_sumemsave: {
        kind: 'sequence',
        steps: [
            {
                kind: 'update_record',
                tableId: 'tbl_member1',
                recordId: { kind: 'formula', expr: 'form.id' },
                values: {
                    name: { kind: 'formula', expr: 'form.name' },
                    email: { kind: 'formula', expr: 'form.email' },
                    role: { kind: 'formula', expr: 'form.role' },
                    capacity_points: { kind: 'formula', expr: 'form.capacity_points' },
                    is_active: { kind: 'formula', expr: 'form.is_active' },
                },
            },
            { kind: 'refresh', tableId: 'tbl_member1' },
        ],
    },
};

const definition = {
    schemaVersion: 2,
    meta: {
        name: 'Sprint planning',
        description: 'Boards, backlog and sprints for a delivery team.',
        icon: 'SquareKanban',
    },
    theme: { ...THEME_DEFAULTS, primary: '#1D4ED8', radius: 'lg' },
    // The atlas identity with the geist face: a product-shaped delivery tool,
    // airy surfaces and full motion — and an icon RAIL for navigation, because
    // on a board tool the screen is the workspace and the chrome should get
    // out of its way. The groups become the rail's separators.
    design: { preset: 'atlas', font: 'geist', surface: 'soft', motion: 'full', chartPalette: 'brand', accentEdge: 'bar', logoUrl: null },
    nav: {
        style: 'rail',
        groups: [
            { id: 'nvg_work', label: 'Work', icon: 'SquareKanban', screens: ['scr_board', 'scr_backlog'] },
            { id: 'nvg_plan', label: 'Planning', icon: 'CalendarClock', screens: ['scr_sprints', 'scr_epics'] },
            { id: 'nvg_admin', label: 'Admin', icon: 'TableProperties', screens: ['scr_setup'] },
        ],
    },
    roles: [
        { id: 'lead', name: 'Lead' },
        { id: 'member', name: 'Team member' },
    ],
    /**
     * `filters` is NOT declared — it is a reserved name owned by filter_bar,
     * which publishes into it directly.
     */
    variables: [
        { name: 'board', label: 'Selected board', type: 'record', default: null, description: 'The board every screen is scoped to. Set by picking one in the board list.' },
        { name: 'sprint', label: 'Selected sprint', type: 'record', default: null, description: 'Optional. When set, the board and backlog narrow to this sprint; when null the whole board shows.' },
        { name: 'item', label: 'Open work item', type: 'record', default: null, description: 'The card the detail dialog is showing.' },
    ],
    homeScreenId: 'scr_board',
    screens: [
        // ==================================================================
        // BOARD — the daily driver.
        // ==================================================================
        {
            id: 'scr_board',
            name: 'Board',
            icon: 'SquareKanban',
            showInNav: true,
            maxWidth: 'full',
            description: 'Drag work across the columns your team configured.',
            sections: [
                {
                    id: 'sec_bdtop',
                    style: { padding: 4, gap: 3, background: 'none' },
                    children: [
                        {
                            id: 'cmp_bdhdr',
                            type: 'page_header',
                            props: {
                                title: 'Board',
                                subtitle: 'Pick a board on the left. Drag a card to change its state — where you drop it also sets its order.',
                                titleFrom: { kind: 'formula', expr: 'vars.board.name' },
                                icon: 'SquareKanban',
                                showDivider: false,
                                // The home screen opens on a soft primary band —
                                // the first thing that says this app is a product,
                                // not a form.
                                look: 'banner',
                            },
                            style: { span: 12 },
                            visible: true,
                            children: [],
                        },
                        {
                            id: 'cmp_bdfilt',
                            type: 'filter_bar',
                            props: {
                                fields: [
                                    { name: 'q', label: 'Search', type: 'search', options: [] },
                                    { name: 'item_type', label: 'Type', type: 'select', options: TYPE_FILTER_OPTIONS },
                                    { name: 'mine', label: 'Only mine', type: 'toggle', options: [] },
                                ],
                            },
                            style: { span: 12 },
                            visible: true,
                        },
                    ],
                },
                {
                    // ONE row of children, because a fill section stretches its
                    // first grid row only.
                    id: 'sec_bdmain',
                    style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
                    children: [
                        {
                            // A FIXED rail and a Kanban that takes the rest.
                            //
                            // As a 3/12 + 9/12 grid row the rail kept growing
                            // with the window — on a wide monitor it was a
                            // column of two cards in a lake of whitespace,
                            // while the board, which wants every pixel it can
                            // get, was capped at three quarters. A percentage
                            // would not have fixed that: a pct width resolves
                            // against the GRID CELL, so it can only ever be a
                            // fraction of the same three columns.
                            //
                            // A horizontal pane is the shape that expresses it:
                            // inside a pane `span` is ignored, an exact width
                            // pins the rail, and the child that says height
                            // 'fill' grows along the main axis — which in a row
                            // is the width. Below 640px runtime.css turns the
                            // pane back into a stack and drops the fixed width.
                            id: 'cmp_bdpane',
                            type: 'pane',
                            props: { direction: 'horizontal', scroll: 'none' },
                            style: { span: 12, gap: 3, height: 'fill' },
                            visible: true,
                            children: [
                        {
                            id: 'cmp_bdbrds',
                            type: 'list',
                            props: {
                                source: { kind: 'records', tableId: 'tbl_boards1', sort: [{ field: 'position', dir: 'asc' }], limit: 50 },
                                titleKey: 'name',
                                subtitleKey: 'description',
                                badgeKey: 'board_type',
                                badgeToneMap: [
                                    { value: 'scrum', label: 'Scrum', tone: 'primary' },
                                    { value: 'kanban', label: 'Kanban', tone: 'info' },
                                ],
                                metaKey: null,
                                timestampKey: null,
                                unreadKey: null,
                                selectedWhen: 'item.id == vars.board.id',
                                icon: 'SquareKanban',
                                emptyText: 'No boards yet — add one on Setup.',
                            },
                            style: { span: 3, height: 'fill', widthMode: 'px', widthValue: 280 },
                            visible: true,
                            onRowClick: 'act_bdpick',
                        },
                        {
                            id: 'cmp_bdkb',
                            type: 'kanban',
                            props: {
                                source: boardItemsBinding([
                                    { field: 'title', op: 'contains', value: { kind: 'formula', expr: 'vars.filters.q' }, required: false },
                                    { field: 'item_type', op: 'eq', value: { kind: 'formula', expr: 'vars.filters.item_type' }, required: false },
                                    // A toggle that is off must not filter to
                                    // "assigned to nobody", so it resolves to
                                    // null and the clause drops out entirely.
                                    // Identity, not a name. This matched on
                                    // e-mail because e-mail was the only thing
                                    // both sides had — but nothing in the app
                                    // could ever WRITE an assignee, so the
                                    // toggle had nothing to find. It now
                                    // compares the viewer's user id against the
                                    // id the person picker stored.
                                    { field: 'assignee_id', op: 'eq', value: { kind: 'formula', expr: 'vars.filters.mine ? currentUser.id : null' }, required: false },
                                ]),
                                groupByField: 'state',
                                // THE BOARD IS ITS CONFIG TABLE. Add a row on
                                // Setup and the board grows a column.
                                columnsSource: {
                                    kind: 'records',
                                    tableId: 'tbl_bcols01',
                                    filter: [{ field: 'board_id', op: 'eq', value: { kind: 'formula', expr: 'vars.board.id' }, required: true }],
                                    sort: [{ field: 'position', dir: 'asc' }],
                                    limit: 24,
                                },
                                columns: [],
                                // Lanes by epic. `epic_key` is the denormalised
                                // copy — there is no join to follow parent_id.
                                swimlaneField: 'epic_key',
                                swimlanes: [],
                                swimlanesSource: { kind: 'static', value: null },
                                titleKey: 'title',
                                subtitleKey: null,
                                badgeKey: 'priority',
                                badgeToneMap: PRIORITY_TONES,
                                cardFields: CARD_FIELDS,
                                rankKey: 'rank',
                                colorKey: 'item_type',
                                cardColorMap: TYPE_TONES,
                                collapsible: true,
                                emptyText: 'Nothing on this board yet.',
                                allowDrag: true,
                                // Every card on a soft primary-tinted surface;
                                // colorKey keeps colouring the accent edge BY
                                // TYPE — the two mechanisms coexist.
                                cardLook: 'tinted',
                            },
                            style: { span: 9, height: 'fill' },
                            visible: true,
                            onCardMove: 'act_bdmove',
                            onRowClick: 'act_bdopen',
                        },
                            ],
                        },
                    ],
                },
                {
                    id: 'sec_bddlg',
                    style: { padding: 0, gap: 3, background: 'none' },
                    children: [
                        {
                            id: 'cmp_bdmodal',
                            type: 'modal',
                            props: { title: 'Work item', size: 'lg', triggerLabel: null },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_bddet',
                                    type: 'record_detail',
                                    props: {
                                        source: { kind: 'formula', expr: 'vars.item' },
                                        columns: 2,
                                        fields: [
                                            { key: 'title', label: 'Title', format: 'text' },
                                            { key: 'item_type', label: 'Type', format: 'badge' },
                                            { key: 'state', label: 'State', format: 'badge' },
                                            { key: 'priority', label: 'Priority', format: 'badge' },
                                            { key: 'points', label: 'Points', format: 'number' },
                                            { key: 'assignee_name', label: 'Assignee', format: 'text' },
                                            { key: 'epic_key', label: 'Epic', format: 'text' },
                                            { key: 'due_date', label: 'Due', format: 'date' },
                                            { key: 'description', label: 'Description', format: 'markdown' },
                                        ],
                                        emptyText: 'Open a card to see it here.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                },
                                {
                                    id: 'cmp_bdopen',
                                    type: 'button',
                                    props: { label: 'Open full item', variant: 'secondary', iconLeft: 'ExternalLink', role: 'button' },
                                    style: { span: 4 },
                                    visible: true,
                                    onClick: 'act_gotoitem',
                                },
                                {
                                    // Opening a card and being able to do nothing
                                    // with it but leave is the commonest dead end
                                    // on this screen. The one thing people want
                                    // here is to hand the card to somebody.
                                    id: 'cmp_bdasgform',
                                    type: 'form',
                                    props: { name: 'assign', submitLabel: 'Assign', showReset: false, showSubmit: true },
                                    style: { span: 8, gap: 3, padding: 0 },
                                    visible: true,
                                    onSubmit: 'act_iassign',
                                    children: [
                                        { id: 'cmp_bdasg1', type: 'input_person', props: { name: 'assignee_id', label: 'Give this to', multiple: false, required: true, allowMe: true }, style: { span: 12 }, visible: true },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ],
        },

        // ==================================================================
        // BACKLOG — the ordered list, and where new work is raised.
        // ==================================================================
        {
            id: 'scr_backlog',
            name: 'Backlog',
            icon: 'ListChecks',
            showInNav: true,
            maxWidth: 'full',
            description: 'Everything on this board, in priority order.',
            sections: [
                {
                    id: 'sec_bltop',
                    style: { padding: 4, gap: 3, background: 'none' },
                    children: [
                        {
                            id: 'cmp_blhdr',
                            type: 'page_header',
                            props: {
                                title: 'Backlog',
                                subtitle: 'Points and state are editable inline — click a cell.',
                                titleFrom: { kind: 'static', value: null },
                                subtitleFrom: { kind: 'static', value: null },
                                icon: 'ListChecks',
                                showDivider: false,
                            },
                            style: { span: 12 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_blnew',
                                    type: 'button',
                                    props: { label: 'New work item', variant: 'primary', iconLeft: 'Plus', role: 'button' },
                                    style: { span: 3 },
                                    visible: true,
                                    onClick: 'act_blopen',
                                },
                            ],
                        },
                        {
                            id: 'cmp_blstat1',
                            type: 'stat',
                            props: {
                                label: 'Items',
                                value: {
                                    kind: 'aggregate',
                                    tableId: 'tbl_items01',
                                    aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                                    filter: [{ field: 'board_id', op: 'eq', value: { kind: 'formula', expr: 'vars.board.id' }, required: true }],
                                    limit: 1,
                                    // An aggregate binding resolves to the ROWS
                                    // ARRAY. `pick` is the read-side lens that
                                    // narrows it to the one number the tile is
                                    // for; without it the tile renders the array.
                                    pick: { row: 'first', column: 'n' },
                                },
                                caption: 'on this board',
                                icon: 'ListChecks',
                                delta: { kind: 'static', value: null },
                                deltaFormat: 'number',
                                trend: { kind: 'static', value: null },
                                positiveIsGood: true,
                                look: 'tile',
                            },
                            style: { span: 3 },
                            visible: true,
                        },
                        {
                            id: 'cmp_blstat2',
                            type: 'stat',
                            props: {
                                label: 'Points',
                                value: {
                                    kind: 'aggregate',
                                    tableId: 'tbl_items01',
                                    aggregates: [{ fn: 'sum', field: 'points', as: 'pts' }],
                                    filter: [{ field: 'board_id', op: 'eq', value: { kind: 'formula', expr: 'vars.board.id' }, required: true }],
                                    limit: 1,
                                    pick: { row: 'first', column: 'pts' },
                                },
                                caption: 'estimated in total',
                                icon: 'Gauge',
                                delta: { kind: 'static', value: null },
                                deltaFormat: 'number',
                                trend: { kind: 'static', value: null },
                                positiveIsGood: true,
                                look: 'tile',
                            },
                            style: { span: 3 },
                            visible: true,
                        },
                        {
                            id: 'cmp_blstat3',
                            type: 'stat',
                            props: {
                                label: 'Unestimated',
                                value: {
                                    kind: 'aggregate',
                                    tableId: 'tbl_items01',
                                    aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                                    filter: [
                                        { field: 'board_id', op: 'eq', value: { kind: 'formula', expr: 'vars.board.id' }, required: true },
                                        { field: 'points', op: 'isNull' },
                                    ],
                                    limit: 1,
                                    pick: { row: 'first', column: 'n' },
                                },
                                caption: 'need a number before planning',
                                icon: 'Percent',
                                delta: { kind: 'static', value: null },
                                deltaFormat: 'number',
                                trend: { kind: 'static', value: null },
                                positiveIsGood: false,
                                look: 'tile',
                            },
                            style: { span: 3 },
                            visible: true,
                        },
                        {
                            // The fourth tile. The header row was 12 + 3 + 3 + 3
                            // and left a three-column hole, and the number that
                            // belongs in it is the one a person opening a backlog
                            // actually wants: how much of this is mine.
                            id: 'cmp_blstat4',
                            type: 'stat',
                            props: {
                                label: 'Mine',
                                value: {
                                    kind: 'aggregate',
                                    tableId: 'tbl_items01',
                                    aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                                    filter: [
                                        { field: 'board_id', op: 'eq', value: { kind: 'formula', expr: 'vars.board.id' }, required: true },
                                        { field: 'assignee_id', op: 'eq', value: { kind: 'formula', expr: 'currentUser.id' }, required: true },
                                    ],
                                    limit: 1,
                                    pick: { row: 'first', column: 'n' },
                                },
                                caption: 'assigned to you on this board',
                                icon: 'UserRound',
                                delta: { kind: 'static', value: null },
                                deltaFormat: 'number',
                                trend: { kind: 'static', value: null },
                                positiveIsGood: true,
                                look: 'tile',
                            },
                            style: { span: 3 },
                            visible: true,
                        },
                    ],
                },
                {
                    id: 'sec_blgrid',
                    style: { padding: 4, gap: 3, background: 'none', height: 'fill' },
                    children: [
                        {
                            id: 'cmp_blgrid',
                            type: 'data_grid',
                            props: {
                                // BOARD-scoped, never sprint-scoped. A backlog is
                                // the pool you pull FROM: if it narrowed to the
                                // selected sprint it would list only the items
                                // already in it, and "To sprint" — the one action
                                // that matters here — would have nothing to act on.
                                source: {
                                    kind: 'records',
                                    tableId: 'tbl_items01',
                                    filter: [{ field: 'board_id', op: 'eq', value: { kind: 'formula', expr: 'vars.board.id' }, required: true }],
                                    sort: [{ field: 'rank', dir: 'asc' }],
                                    limit: 400,
                                },
                                // The tone maps are the SAME constants the kanban
                                // cards colour by, so a bug is red in both places.
                                // An editable column with a toneMap also edits as
                                // a dropdown of exactly these values, which is how
                                // a typo can no longer put a card in a state no
                                // board column matches.
                                columns: [
                                    { key: 'item_type', label: 'Type', format: 'badge', width: 110, sortable: true, filterable: true, editable: false, toneMap: TYPE_TONES },
                                    { key: 'title', label: 'Title', format: 'text', width: 380, sortable: true, filterable: true, editable: true },
                                    { key: 'state', label: 'State', format: 'badge', width: 130, sortable: true, filterable: true, editable: true, toneMap: STATE_TONES },
                                    { key: 'priority', label: 'Priority', format: 'badge', width: 110, sortable: true, filterable: true, editable: true, toneMap: PRIORITY_TONES },
                                    { key: 'points', label: 'Points', format: 'number', width: 90, sortable: true, filterable: false, editable: true },
                                    // Stores the user id, shows the name beside it.
                                    { key: 'assignee_id', label: 'Assignee', format: 'user', width: 180, sortable: true, filterable: false, editable: false, labelFrom: 'assignee_name' },
                                    { key: 'epic_key', label: 'Epic', format: 'text', width: 160, sortable: true, filterable: true, editable: false },
                                    { key: 'due_date', label: 'Due', format: 'date', width: 120, sortable: true, filterable: false, editable: true },
                                ],
                                pageSize: 50,
                                selectable: 'none',
                                searchable: true,
                                rowActions: [
                                    { label: 'Open', actionId: 'act_gotorow' },
                                    { label: 'Mine', actionId: 'act_blmine' },
                                    { label: 'To sprint', actionId: 'act_tosprint' },
                                ],
                                density: 'compact',
                                zebra: true,
                                // Airy borderless rows — the backlog is read
                                // top-to-bottom by rank, not tracked across
                                // columns, so the rules earn nothing here.
                                // (`look` wins over the legacy zebra flag.)
                                look: 'minimal',
                                emptyText: 'Nothing here — pick a board, or raise the first item.',
                            },
                            style: { span: 12, height: 'fill' },
                            visible: true,
                            onRowSelect: 'act_blsave',
                        },
                    ],
                },
                {
                    id: 'sec_bldlg',
                    style: { padding: 0, gap: 3, background: 'none' },
                    children: [
                        {
                            id: 'cmp_blmodal',
                            type: 'modal',
                            props: { title: 'New work item', size: 'md', triggerLabel: null },
                            style: { gap: 3, padding: 0 },
                            visible: true,
                            children: [
                                {
                                    id: 'cmp_blform',
                                    type: 'form',
                                    props: { name: 'newitem', submitLabel: 'Add to backlog', showReset: false, showSubmit: true },
                                    style: { span: 12, gap: 3, padding: 0 },
                                    visible: true,
                                    onSubmit: 'act_blcreate',
                                    children: [
                                        { id: 'cmp_blf1', type: 'input_text', props: { name: 'title', label: 'Title', required: true, inputType: 'text' }, style: { span: 12 }, visible: true },
                                        {
                                            id: 'cmp_blf2',
                                            type: 'input_select',
                                            props: { name: 'item_type', label: 'Type', required: true, options: TYPE_FILTER_OPTIONS, defaultValue: 'story', placeholder: null, valueFrom: { kind: 'static', value: null } },
                                            style: { span: 6 },
                                            visible: true,
                                        },
                                        {
                                            id: 'cmp_blf3',
                                            type: 'input_select',
                                            props: { name: 'priority', label: 'Priority', required: false, options: PRIORITY_TONES.map((p) => ({ value: p.value, label: p.label })), defaultValue: 'medium', placeholder: null, valueFrom: { kind: 'static', value: null } },
                                            style: { span: 6 },
                                            visible: true,
                                        },
                                        { id: 'cmp_blf4', type: 'input_number', props: { name: 'points', label: 'Points', required: false, min: 0, max: 100, step: 1, defaultValue: null }, style: { span: 6 }, visible: true },
                                        { id: 'cmp_blf5', type: 'input_date', props: { name: 'due_date', label: 'Due', required: false, defaultValue: null }, style: { span: 6 }, visible: true },
                                        // The field this app was missing. Work could be
                                        // created, ranked, moved and closed — but never
                                        // given to anybody.
                                        { id: 'cmp_blf7', type: 'input_person', props: { name: 'assignee_id', label: 'Assignee', multiple: false, required: false, allowMe: true }, style: { span: 12 }, visible: true },
                                        { id: 'cmp_blf6', type: 'input_textarea', props: { name: 'description', label: 'Description', required: false, rows: 4 }, style: { span: 12 }, visible: true },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ],
        },
        SCREEN_SPRINTS,
        SCREEN_ITEM,
        SCREEN_EPICS,
        SCREEN_SETUP,
    ],
    actions,
};

// ---------------------------------------------------------------------------
// Seed
//
// A board you can actually read on the first screen: two boards (one Scrum, one
// Kanban) over one team, a closed sprint and a live one, and a three-level
// hierarchy — epic → story/bug → task — so the swimlanes, the parent list and
// the rank ordering all have something to show.
//
// `$id` is a LOCAL alias, never a column; { $ref } points at a row seeded
// earlier. templateInstall seeds parent tables first and rewrites the refs to
// real rec_ ids — and within one table a later row may reference an earlier
// one, which is what makes the self-referencing hierarchy seedable at all.
//
// Ranks start at 100 and step by 100: fractional inserts have room on both
// sides forever, and a newly raised item (rank 0) surfaces at the top of the
// backlog where something untriaged belongs.
// ---------------------------------------------------------------------------

const seed = {
    tbl_boards1: [
        { $id: 'bd_scrum', name: 'Product delivery', board_type: 'scrum', description: 'Two-week sprints for the product team.', swimlane_by: 'epic', wip_enabled: false, position: 1 },
        { $id: 'bd_kanban', name: 'Support flow', board_type: 'kanban', description: 'Continuous flow, limited work in progress.', swimlane_by: 'none', wip_enabled: true, position: 2 },
    ],

    tbl_states1: [
        { key: 'todo', name: 'To do', category: 'todo', color: 'neutral', position: 1 },
        { key: 'ready', name: 'Ready', category: 'todo', color: 'info', position: 2 },
        { key: 'doing', name: 'In progress', category: 'doing', color: 'primary', position: 3 },
        { key: 'review', name: 'In review', category: 'doing', color: 'warning', position: 4 },
        { key: 'done', name: 'Done', category: 'done', color: 'success', position: 5 },
    ],

    tbl_types01: [
        { key: 'epic', name: 'Epic', color: 'primary', level: 3, position: 1 },
        { key: 'feature', name: 'Feature', color: 'info', level: 2, position: 2 },
        { key: 'story', name: 'User story', color: 'success', level: 1, position: 3 },
        { key: 'bug', name: 'Bug', color: 'danger', level: 1, position: 4 },
        { key: 'task', name: 'Task', color: 'neutral', level: 0, position: 5 },
    ],

    tbl_member1: [
        { name: 'Anna de Vries', email: 'anna@example.com', role: 'lead', capacity_points: 18, is_active: true },
        { name: 'Bas Jansen', email: 'bas@example.com', role: 'member', capacity_points: 20, is_active: true },
        { name: 'Chidi Okafor', email: 'chidi@example.com', role: 'member', capacity_points: 16, is_active: true },
        { name: 'Dana Silva', email: 'dana@example.com', role: 'stakeholder', capacity_points: 0, is_active: true },
    ],

    // The Scrum board's columns skip 'ready' — a board shows the subset of the
    // workflow it cares about, which is exactly why columns are per board
    // rather than a property of the state itself.
    tbl_bcols01: [
        { board_id: { $ref: 'bd_scrum' }, state: 'todo', label: 'To do', color: 'neutral', position: 1, wip_limit: 0 },
        { board_id: { $ref: 'bd_scrum' }, state: 'doing', label: 'In progress', color: 'primary', position: 2, wip_limit: 0 },
        { board_id: { $ref: 'bd_scrum' }, state: 'review', label: 'In review', color: 'warning', position: 3, wip_limit: 0 },
        { board_id: { $ref: 'bd_scrum' }, state: 'done', label: 'Done', color: 'success', position: 4, wip_limit: 0 },
        // The Kanban board limits work in progress — the point of the method.
        { board_id: { $ref: 'bd_kanban' }, state: 'todo', label: 'Queued', color: 'neutral', position: 1, wip_limit: 0 },
        { board_id: { $ref: 'bd_kanban' }, state: 'ready', label: 'Ready', color: 'info', position: 2, wip_limit: 5 },
        { board_id: { $ref: 'bd_kanban' }, state: 'doing', label: 'Doing', color: 'primary', position: 3, wip_limit: 3 },
        { board_id: { $ref: 'bd_kanban' }, state: 'done', label: 'Done', color: 'success', position: 4, wip_limit: 0 },
    ],

    tbl_sprint1: [
        { $id: 'sp_prev', name: 'Sprint 23', board_id: { $ref: 'bd_scrum' }, goal: 'Ship the new sign-up flow.', start_date: '2026-07-06', end_date: '2026-07-17', status: 'closed', capacity_points: 34 },
        { $id: 'sp_cur', name: 'Sprint 24', board_id: { $ref: 'bd_scrum' }, goal: 'Self-service billing, end to end.', start_date: '2026-07-20', end_date: '2026-07-31', status: 'active', capacity_points: 38 },
    ],

    tbl_items01: [
        // ── Epics (level 3) — seeded first so children can $ref them. ───────
        { $id: 'ep_onb', title: 'Onboarding', item_type: 'epic', state: 'doing', priority: 'high', board_id: { $ref: 'bd_scrum' }, epic_key: 'ONBOARDING', rank: 100, due_date: '2026-09-30', description: 'Everything between landing on the site and a first successful login.' },
        { $id: 'ep_bil', title: 'Billing', item_type: 'epic', state: 'doing', priority: 'critical', board_id: { $ref: 'bd_scrum' }, epic_key: 'BILLING', rank: 200, due_date: '2026-08-31', description: 'Self-service plans, invoices and dunning.' },
        { $id: 'ep_plt', title: 'Platform health', item_type: 'epic', state: 'todo', priority: 'medium', board_id: { $ref: 'bd_scrum' }, epic_key: 'PLATFORM', rank: 300, description: 'The work that keeps the lights on.' },
        // The Kanban cards all carry epic_key 'SUPPORT'. Without a row of type
        // 'epic' to match, the Epics chart drew a SUPPORT bar that the grid
        // beside it could not explain — the screen contradicted itself.
        { $id: 'ep_sup', title: 'Support', item_type: 'epic', state: 'todo', priority: 'medium', board_id: { $ref: 'bd_kanban' }, epic_key: 'SUPPORT', rank: 50, description: 'Whatever comes in from customers, worked in a continuous flow.' },

        // ── Stories and bugs (level 1), parented to an epic. ────────────────
        { $id: 'st_sso', title: 'Sign in with Nextcloud', item_type: 'story', state: 'done', priority: 'high', board_id: { $ref: 'bd_scrum' }, sprint_id: { $ref: 'sp_prev' }, parent_id: { $ref: 'ep_onb' }, epic_key: 'ONBOARDING', assignee_email: 'anna@example.com', assignee_name: 'Anna de Vries', points: 8, rank: 400, closed_at: '2026-07-16T14:20:00.000Z', description: 'As a Nextcloud user I want to open the app without a second password.' },
        { $id: 'st_inv', title: 'Invite a colleague', item_type: 'story', state: 'review', priority: 'medium', board_id: { $ref: 'bd_scrum' }, sprint_id: { $ref: 'sp_cur' }, parent_id: { $ref: 'ep_onb' }, epic_key: 'ONBOARDING', assignee_email: 'bas@example.com', assignee_name: 'Bas Jansen', points: 5, rank: 500, description: 'As an admin I want to invite teammates by e-mail.' },
        { $id: 'st_tour', title: 'First-run tour', item_type: 'story', state: 'todo', priority: 'low', board_id: { $ref: 'bd_scrum' }, parent_id: { $ref: 'ep_onb' }, epic_key: 'ONBOARDING', points: 3, rank: 600, description: 'Three cards explaining the board, the backlog and the sprint.' },
        { $id: 'st_plan', title: 'Choose a plan', item_type: 'story', state: 'doing', priority: 'critical', board_id: { $ref: 'bd_scrum' }, sprint_id: { $ref: 'sp_cur' }, parent_id: { $ref: 'ep_bil' }, epic_key: 'BILLING', assignee_email: 'chidi@example.com', assignee_name: 'Chidi Okafor', points: 8, rank: 700, due_date: '2026-07-29', description: 'As a customer I want to pick a plan and pay without talking to sales.' },
        { $id: 'st_inv2', title: 'Download an invoice', item_type: 'story', state: 'todo', priority: 'high', board_id: { $ref: 'bd_scrum' }, sprint_id: { $ref: 'sp_cur' }, parent_id: { $ref: 'ep_bil' }, epic_key: 'BILLING', assignee_email: 'bas@example.com', assignee_name: 'Bas Jansen', points: 5, rank: 800, description: 'As a customer I want a PDF invoice for every payment.' },
        { $id: 'bg_vat', title: 'VAT is wrong for Belgian customers', item_type: 'bug', state: 'doing', priority: 'critical', board_id: { $ref: 'bd_scrum' }, sprint_id: { $ref: 'sp_cur' }, parent_id: { $ref: 'ep_bil' }, epic_key: 'BILLING', assignee_email: 'anna@example.com', assignee_name: 'Anna de Vries', points: 3, rank: 900, description: '21% is applied where 6% is due on the reduced category.' },
        { $id: 'st_bkp', title: 'Nightly backup verification', item_type: 'story', state: 'todo', priority: 'medium', board_id: { $ref: 'bd_scrum' }, parent_id: { $ref: 'ep_plt' }, epic_key: 'PLATFORM', points: 5, rank: 1000, description: 'Restore last night into a scratch database and diff the row counts.' },
        { $id: 'bg_slow', title: 'Board is slow above 500 cards', item_type: 'bug', state: 'todo', priority: 'medium', board_id: { $ref: 'bd_scrum' }, parent_id: { $ref: 'ep_plt' }, epic_key: 'PLATFORM', points: 8, rank: 1100, description: 'Dragging stutters once a column holds a few hundred cards.' },

        // ── Tasks (level 0), parented to a story. ──────────────────────────
        { title: 'Wire the OAuth callback', item_type: 'task', state: 'done', priority: 'high', board_id: { $ref: 'bd_scrum' }, sprint_id: { $ref: 'sp_prev' }, parent_id: { $ref: 'st_sso' }, epic_key: 'ONBOARDING', assignee_email: 'anna@example.com', assignee_name: 'Anna de Vries', points: 3, rank: 1200, closed_at: '2026-07-14T09:05:00.000Z' },
        { title: 'Map the Nextcloud user to a member', item_type: 'task', state: 'done', priority: 'medium', board_id: { $ref: 'bd_scrum' }, sprint_id: { $ref: 'sp_prev' }, parent_id: { $ref: 'st_sso' }, epic_key: 'ONBOARDING', assignee_email: 'chidi@example.com', assignee_name: 'Chidi Okafor', points: 2, rank: 1300, closed_at: '2026-07-15T16:40:00.000Z' },
        { title: 'Invite e-mail template', item_type: 'task', state: 'review', priority: 'medium', board_id: { $ref: 'bd_scrum' }, sprint_id: { $ref: 'sp_cur' }, parent_id: { $ref: 'st_inv' }, epic_key: 'ONBOARDING', assignee_email: 'bas@example.com', assignee_name: 'Bas Jansen', points: 2, rank: 1400 },
        { title: 'Expire an invite after 14 days', item_type: 'task', state: 'todo', priority: 'low', board_id: { $ref: 'bd_scrum' }, sprint_id: { $ref: 'sp_cur' }, parent_id: { $ref: 'st_inv' }, epic_key: 'ONBOARDING', points: 1, rank: 1500 },
        { title: 'Plan comparison table', item_type: 'task', state: 'doing', priority: 'high', board_id: { $ref: 'bd_scrum' }, sprint_id: { $ref: 'sp_cur' }, parent_id: { $ref: 'st_plan' }, epic_key: 'BILLING', assignee_email: 'chidi@example.com', assignee_name: 'Chidi Okafor', points: 3, rank: 1600 },
        { title: 'Handle a declined card', item_type: 'task', state: 'todo', priority: 'critical', board_id: { $ref: 'bd_scrum' }, sprint_id: { $ref: 'sp_cur' }, parent_id: { $ref: 'st_plan' }, epic_key: 'BILLING', points: 3, rank: 1700 },

        // ── The Kanban board — no sprints, work in progress limited. ────────
        { $id: 'kb_1', title: 'Password reset e-mail never arrives', item_type: 'bug', state: 'doing', priority: 'critical', board_id: { $ref: 'bd_kanban' }, epic_key: 'SUPPORT', assignee_email: 'anna@example.com', assignee_name: 'Anna de Vries', points: 2, rank: 100 },
        { $id: 'kb_2', title: 'Export a board to CSV', item_type: 'story', state: 'doing', priority: 'medium', board_id: { $ref: 'bd_kanban' }, epic_key: 'SUPPORT', assignee_email: 'bas@example.com', assignee_name: 'Bas Jansen', points: 3, rank: 200 },
        { $id: 'kb_3', title: 'Dark mode contrast on the board', item_type: 'bug', state: 'doing', priority: 'low', board_id: { $ref: 'bd_kanban' }, epic_key: 'SUPPORT', assignee_email: 'chidi@example.com', assignee_name: 'Chidi Okafor', points: 1, rank: 300 },
        // A fourth card in a column limited to 3 — the board flags it, which is
        // the whole point of shipping a WIP limit in the seed.
        { $id: 'kb_4', title: 'Timezone shown wrong in the sprint dates', item_type: 'bug', state: 'doing', priority: 'high', board_id: { $ref: 'bd_kanban' }, epic_key: 'SUPPORT', points: 2, rank: 400 },
        { $id: 'kb_5', title: 'Keyboard shortcuts for the board', item_type: 'story', state: 'ready', priority: 'low', board_id: { $ref: 'bd_kanban' }, epic_key: 'SUPPORT', points: 5, rank: 500 },
        { $id: 'kb_6', title: 'Bulk-move items between boards', item_type: 'story', state: 'todo', priority: 'medium', board_id: { $ref: 'bd_kanban' }, epic_key: 'SUPPORT', points: 8, rank: 600 },
        { $id: 'kb_7', title: 'Archive a finished board', item_type: 'story', state: 'done', priority: 'low', board_id: { $ref: 'bd_kanban' }, epic_key: 'SUPPORT', assignee_email: 'anna@example.com', assignee_name: 'Anna de Vries', points: 3, rank: 700, closed_at: '2026-07-22T11:00:00.000Z' },
    ],

    tbl_notes01: [
        { work_item_id: { $ref: 'bg_vat' }, body: 'Reproduced on the staging tenant — the reduced-rate category is not passed to the tax lookup.', author_name: 'Anna de Vries' },
        { work_item_id: { $ref: 'st_plan' }, body: 'Design signed off. Waiting on the final copy for the annual discount line.', author_name: 'Dana Silva' },
        { work_item_id: { $ref: 'kb_4' }, body: 'Only wrong for users west of UTC — the date is formatted before the offset is applied.', author_name: 'Chidi Okafor' },
    ],
};

/**
 * Replace the demo people with the installer's real colleagues.
 *
 * The seeded board is worth keeping — an app that opens empty teaches nothing
 * about what it is for — but now that an assignee is a real user id, "Anna de
 * Vries" would be a row whose owner does not exist and whose "assigned to me"
 * can never be true. So the WORK stays and the PEOPLE change: Setup ▸ Team is
 * filled from the organisation (the installer first, because your own board
 * should have you on it), and every card the template handed to a fictional
 * person is dealt round-robin to a real one.
 *
 * `capacity_points` and `role` survive from the authored rows, so a team still
 * opens with a sensible capacity to plan against. E-mail is cleared rather than
 * invented: the directory deliberately does not return one.
 *
 * An org with one member — a self-host trial, a first login — keeps the authored
 * demo exactly as written. See applySeedPeople in templateInstall.js.
 */
const seedPeople = {
    roster: { tableId: 'tbl_member1', nameField: 'name', emailField: 'email' },
    assign: {
        tableId: 'tbl_items01',
        idField: 'assignee_id',
        nameField: 'assignee_name',
        emailField: 'assignee_email',
    },
};

module.exports = {
    id: 'app-sprint-board',
    version: 1,
    title: 'Sprint planning',
    description: 'Boards your team configures, a rank-ordered backlog and sprints with capacity. Epics, stories, bugs and tasks in one hierarchy — Scrum and Kanban from the same data.',
    category: 'Data',
    icon: 'SquareKanban',
    tags: ['agile', 'scrum', 'kanban', 'backlog', 'sprints', 'planning'],
    definition,
    dataModel,
    seed,
    seedPeople,
};
