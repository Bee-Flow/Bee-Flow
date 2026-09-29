/**
 * App Studio catalog — the interactive surfaces: the filter bar, the drag-drop
 * kanban board, the calendar and the AI chat.
 */

'use strict';

const { LIMITS } = require('./limits');
const { COLOR_ROLES } = require('./styleKnobs');

const INTERACTIVE_SPECS = {
    // ── v2.1 interactive data ────────────────────────────────────────────
    filter_bar: {
        label: 'Filter bar', category: 'Data',
        description: 'A row of filter controls (search, select, toggle, date). Each control writes vars.filters.<name>, for use in records-binding filter formulas.',
        props: {
            fields: {
                type: 'list', maxItems: LIMITS.MAX_FILTER_BAR_FIELDS, default: [],
                itemShape: {
                    name: { type: 'string', required: true, maxLen: 60 },
                    label: { type: 'string', maxLen: 120 },
                    type: { type: 'enum', values: ['search', 'select', 'toggle', 'date'], default: 'search' },
                    options: {
                        type: 'list', maxItems: LIMITS.MAX_SELECT_OPTIONS, default: [],
                        itemShape: { value: { type: 'string', required: true, maxLen: 200 }, label: { type: 'string', maxLen: 200 } },
                    },
                },
            },
        },
        styleKnobs: ['span', 'size', 'gap'],
        defaultStyle: { span: 12 },
    },
    kanban: {
        label: 'Kanban', category: 'Data',
        description: 'A kanban board over an array of objects, grouped into columns by groupByField and optionally into swimlanes by swimlaneField. Columns and swimlanes may be PINNED as literals or BOUND to a table (columnsSource/swimlanesSource) so the people using the app configure the board without opening the builder. Dragging a card fires onCardMove with { item, value, lane, index, beforeId, afterId } — enough to write both the new column and a new rank.',
        events: ['onRowClick', 'onCardMove'],
        props: {
            source: { type: 'binding', default: { kind: 'static', value: [] } },
            groupByField: { type: 'string', required: true, maxLen: 120, default: 'status' },
            columns: {
                type: 'list', maxItems: LIMITS.MAX_KANBAN_COLUMNS, default: [],
                itemShape: {
                    value: { type: 'string', required: true, maxLen: 200 },
                    label: { type: 'string', maxLen: 120 },
                    color: { type: 'enum', values: COLOR_ROLES, default: 'neutral' },
                    // Kanban's defining constraint, and the one thing that makes
                    // a Kanban board a Kanban board rather than a to-do list in
                    // three piles. 0/null means "no limit".
                    wipLimit: { type: 'int', min: 0, max: 999, default: null },
                },
            },
            /**
             * THE COLUMNS AS DATA.
             *
             * `columns` above is authored into the definition, so changing it
             * means opening the builder — which is the wrong person for the job.
             * A team lead adding an "In review" column is configuration, not
             * development. Bind this to a table of columns instead and the board
             * is configured from inside the running app.
             *
             * Rows are read leniently, because the table is the customer's:
             *   value  ← value | state | key         (required; the groupBy value)
             *   label  ← label | name  | title
             *   color  ← color | colour | tone       (a COLOR_ROLES name)
             *   wipLimit ← wipLimit | wip_limit
             *   order  ← order | position | sort_order   (sorted by, when present)
             * A bound row with no resolvable `value` is skipped rather than
             * collapsing every unlabelled card into one nameless column.
             *
             * When this resolves to a non-empty array it REPLACES `columns`;
             * while it is loading or empty, `columns` still renders, so a board
             * whose config table has not synced yet shows its designed default
             * rather than an empty page.
             */
            columnsSource: { type: 'binding', default: null },
            /**
             * Swimlanes — the horizontal split (by epic, by assignee, by
             * priority). `swimlaneField` alone derives lanes from the data in
             * first-seen order; `swimlanes`/`swimlanesSource` pin them, with the
             * same lenient row reading as columns (minus wipLimit).
             */
            swimlaneField: { type: 'string', maxLen: 120, default: null },
            swimlanes: {
                type: 'list', maxItems: LIMITS.MAX_KANBAN_SWIMLANES, default: [],
                itemShape: {
                    value: { type: 'string', required: true, maxLen: 200 },
                    label: { type: 'string', maxLen: 120 },
                    color: { type: 'enum', values: COLOR_ROLES, default: 'neutral' },
                },
            },
            swimlanesSource: { type: 'binding', default: null },
            titleKey: { type: 'string', maxLen: 120, default: 'title' },
            subtitleKey: { type: 'string', maxLen: 120, default: null },
            badgeKey: { type: 'string', maxLen: 120, default: null },
            /**
             * Extra card facts — the story points, the assignee, the estimate.
             * A board card that shows only a title cannot be planned against.
             *
             *   slot 'meta'  a small muted chip on the card's footer row
             *   slot 'chip'  a filled pill, for the one number that matters
             *   format       'text' | 'number' | 'date' — how the value renders
             * `label` is used as the accessible name (and the chip's tooltip),
             * so a bare number still says what it is to a screen reader.
             */
            cardFields: {
                type: 'list', maxItems: LIMITS.MAX_KANBAN_CARD_FIELDS, default: [],
                itemShape: {
                    key: { type: 'string', required: true, maxLen: 120 },
                    label: { type: 'string', maxLen: 80 },
                    slot: { type: 'enum', values: ['meta', 'chip'], default: 'meta' },
                    format: { type: 'enum', values: ['text', 'number', 'date'], default: 'text' },
                },
            },
            /**
             * The field holding the board's manual order. Set it and every
             * onCardMove also carries a ready-computed `rank` for the slot the
             * card landed in — midway between its new neighbours, one below the
             * bottom one, one above the top one, 0 into an empty column.
             *
             * The arithmetic lives HERE because this is the only place that has
             * the neighbouring ROWS. A server step can resolve form/vars/item
             * but cannot read another record, so an action handed only
             * beforeId/afterId would need a join the query engine does not have.
             * Handing it the number instead turns persisting a reorder into
             * `values: { rank: {kind:'formula', expr:'form.rank'} }`.
             *
             * Fractional by design: inserting between two cards must never
             * renumber their neighbours, because every renumbered row is another
             * write on a board other people are looking at.
             */
            rankKey: { type: 'string', maxLen: 120, default: null },
            /** Colour the card's left edge by a value — work-item type, usually. */
            colorKey: { type: 'string', maxLen: 120, default: null },
            cardColorMap: {
                type: 'list', maxItems: 12, default: [],
                itemShape: {
                    value: { type: 'string', required: true, maxLen: 200 },
                    label: { type: 'string', maxLen: 80 },
                    tone: { type: 'enum', values: COLOR_ROLES, default: 'neutral' },
                },
            },
            /** Let a column be folded away — a done column with 300 cards in it. */
            collapsible: { type: 'boolean', default: false },
            /** What an empty board says. The default is English; boards are not. */
            emptyText: { type: 'string', maxLen: 200, default: null },
            // Same shape as list.badgeToneMap. On a card there is no room for a
            // pill per row, so a MAPPED value renders as a coloured dot (label
            // as its tooltip/sr text) — a traffic light, not a word. Unmapped
            // values keep the plain text pill so data never silently vanishes.
            badgeToneMap: {
                type: 'list', maxItems: 12, default: [],
                itemShape: {
                    value: { type: 'string', required: true, maxLen: 200 },
                    label: { type: 'string', maxLen: 80 },
                    tone: { type: 'enum', values: COLOR_ROLES, default: 'neutral' },
                },
            },
            allowDrag: { type: 'boolean', default: true },
            // Look pass. Named cardLook, not look: colorKey/cardColorMap
            // already color individual cards BY DATA — this styles every card
            // the same way, and the two must not read as one mechanism.
            cardLook: {
                type: 'enum', values: ['default', 'tinted', 'raised'], default: 'default',
                description: 'default = the current flat card; tinted = soft primary wash on every card; raised = cards with shadow elevation.',
            },
        },
        styleKnobs: ['span', 'size', 'height'],
        defaultStyle: { span: 12 },
    },
    calendar: {
        label: 'Calendar', category: 'Data',
        description: 'A month/week/list calendar over an array of objects, dated by dateKey (optionally spanning to endDateKey).',
        events: ['onRowClick'],
        props: {
            source: { type: 'binding', default: { kind: 'static', value: [] } },
            dateKey: { type: 'string', required: true, maxLen: 120, default: 'date' },
            endDateKey: { type: 'string', maxLen: 120, default: null },
            titleKey: { type: 'string', maxLen: 120, default: 'title' },
            colorKey: { type: 'string', maxLen: 120, default: null },
            view: { type: 'enum', values: ['month', 'week', 'list'], default: 'month' },
            emptyText: { type: 'string', maxLen: 200, default: 'No events yet.' },
        },
        styleKnobs: ['span', 'height'],
        defaultStyle: { span: 12 },
    },
    ai_chat: {
        label: 'AI chat', category: 'AI',
        description: 'A chat surface the app\'s viewers can talk to. Runs on the app OWNER\'s model tier (acts-as-owner) and can be grounded in the owner\'s knowledge bases. `mode:"assistant"` answers one question at a time instead of keeping a conversation.',
        props: {
            systemPrompt: { type: 'string', maxLen: 4000, default: '' },
            modelTier: { type: 'string', maxLen: 60, default: 'auto' },
            knowledgeBaseIds: { type: 'stringList', maxItems: 10, itemMaxLen: 80, default: [] },
            greeting: { type: 'string', maxLen: 500, default: '' },
            placeholder: { type: 'string', maxLen: 120, default: 'Ask a question…' },
            starters: { type: 'stringList', maxItems: 6, itemMaxLen: 200, default: [] },
            mode: { type: 'enum', values: ['chat', 'assistant'], default: 'chat' },
        },
        styleKnobs: ['span', 'height'],
        defaultStyle: { span: 12 },
    },
};

module.exports = {
    INTERACTIVE_SPECS,
};
