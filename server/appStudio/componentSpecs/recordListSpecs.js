/**
 * App Studio catalog — the record lists: the simple table, the list and the
 * approval inbox.
 */

'use strict';

const { LIMITS } = require('./limits');
const { COLOR_ROLES } = require('./styleKnobs');

const RECORD_LIST_SPECS = {
    table: {
        label: 'Table', category: 'Data',
        description: 'A table over an array of objects — usually an automation result. Missing keys render as “—”.',
        props: {
            source: { type: 'binding', default: { kind: 'static', value: [] } },
            columns: {
                type: 'list', maxItems: LIMITS.MAX_TABLE_COLUMNS, default: [],
                itemShape: {
                    key: { type: 'string', required: true, maxLen: 120 },
                    label: { type: 'string', maxLen: 120 },
                    // Kept in step with data_grid: both components render through
                    // the same cellValue module, so a format one understands and
                    // the other does not is a bug waiting to be filed.
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
                    align: { type: 'enum', values: ['auto', 'left', 'right', 'center'], default: 'auto' },
                    truncate: { type: 'boolean' },
                    hidden: { type: 'boolean' },
                    toneFrom: { type: 'string', maxLen: 120 },
                    labelFrom: { type: 'string', maxLen: 120 },
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
                    // the row as `item` and as form values, exactly like a row
                    // action does.
                    actionId: { type: 'string', maxLen: 20 },
                },
            },
            emptyText: { type: 'string', maxLen: 200, default: 'Nothing to show yet.' },
            rowLimit: { type: 'int', min: 1, max: 100, default: 25 },
            // Look pass.
            look: {
                type: 'enum', values: ['default', 'striped', 'minimal'], default: 'default',
                description: 'default = the current ruled table; striped = zebra rows; minimal = borderless, whitespace-separated rows.',
            },
        },
        styleKnobs: ['span', 'size'],
        defaultStyle: { span: 12 },
    },
    list: {
        label: 'List', category: 'Data',
        description: 'A card list over an array of objects — a friendlier alternative to a table, and the natural sidebar picker. badgeToneMap colours a status pill the way sideMap does for a message thread; timestampKey shows a short relative time; unreadKey bolds the row.',
        props: {
            source: { type: 'binding', default: { kind: 'static', value: [] } },
            titleKey: { type: 'string', maxLen: 120, default: 'title' },
            subtitleKey: { type: 'string', maxLen: 120, default: null },
            metaKey: { type: 'string', maxLen: 120, default: null },
            timestampKey: { type: 'string', maxLen: 120, default: null },
            badgeKey: { type: 'string', maxLen: 120, default: null },
            badgeToneMap: {
                type: 'list', maxItems: 12, default: [],
                itemShape: {
                    value: { type: 'string', required: true, maxLen: 200 },
                    label: { type: 'string', maxLen: 80 },
                    tone: { type: 'enum', values: COLOR_ROLES, default: 'neutral' },
                },
            },
            unreadKey: { type: 'string', maxLen: 120, default: null },
            // 'meta' (identity) = the badge on the third line; 'subtitle' moves
            // it to the right of the subtitle line, freeing the third line.
            badgePlacement: { type: 'enum', values: ['meta', 'subtitle'], default: 'meta' },
            // Which row is open. selectedWhen is a formula evaluated per row
            // (`item` in scope) — an inbox that cannot show which conversation
            // you are reading is broken, and there was no way to express it.
            selectedWhen: { type: 'formula', default: null },
            // Field shown as an extra accent line, only on the selected row.
            selectedDetailKey: { type: 'string', maxLen: 120, default: null },
            // Group rows under uppercase section headers by this field's value.
            // Empty values stay ungrouped, first (file_gallery precedent).
            groupKey: { type: 'string', maxLen: 120, default: null },
            // Fixed group order; values not listed follow in first-seen order.
            groupOrder: { type: 'stringList', maxItems: 24, itemMaxLen: 200, default: [] },
            groupLabelMap: {
                type: 'list', maxItems: 12, default: [],
                itemShape: {
                    value: { type: 'string', required: true, maxLen: 200 },
                    label: { type: 'string', maxLen: 80 },
                },
            },
            icon: { type: 'icon', default: null },
            emptyText: { type: 'string', maxLen: 200, default: 'Nothing to show yet.' },
            // Look pass. 'rows' names what the list renders today.
            look: {
                type: 'enum', values: ['rows', 'cards', 'tiles'], default: 'rows',
                description: 'rows = the current flat row list; cards = each item on its own card surface; tiles = a compact multi-column tile grid.',
            },
            // ── The peek: what is BEHIND a row ────────────────────────────
            //
            // A sidebar row says "needs attention" and the only way to learn
            // what needs attention is to open it — which is the click the
            // sidebar exists to help you avoid. The peek gives the row a
            // second, related query: its matching rows are counted INTO the
            // badge ("14 controleren" instead of "Nakijken") and listed in a
            // panel on hover or keyboard focus.
            //
            // The source is any binding. Prefer an `aggregate` for a long
            // table: it is small, and — unlike a second `records` query on a
            // table the screen already reads — it never takes over that
            // table's short name in formulas (`records.<tableId>`).
            peekSource: {
                type: 'binding', default: null,
                description: 'Rows related to the list rows — joined per row on peekMatchKey. An aggregate keeps it small on a long table.',
            },
            // The join. peekRowKey names the field on the LIST row; leave it
            // out when both sides carry the same field name.
            peekMatchKey: { type: 'string', maxLen: 120, default: null },
            peekRowKey: { type: 'string', maxLen: 120, default: null },
            peekTitleKey: { type: 'string', maxLen: 120, default: null },
            peekTextKey: { type: 'string', maxLen: 120, default: null },
            // Groups the panel AND names the badge: the biggest group's label
            // is the word next to the count, which is how "14 controleren"
            // and "2 onvolledig" tell you the reason without opening anything.
            peekGroupKey: { type: 'string', maxLen: 120, default: null },
            peekGroupLabelMap: {
                type: 'list', maxItems: 12, default: [],
                itemShape: {
                    value: { type: 'string', required: true, maxLen: 200 },
                    label: { type: 'string', maxLen: 80 },
                    // Optional, and only read when peekBadge is on: the badge
                    // takes this tone instead of the row's own. A row whose
                    // status says "fine" while fourteen of its records are
                    // flagged should not be showing that count in green.
                    tone: { type: 'enum', values: COLOR_ROLES, default: null },
                },
            },
            // An aggregate hands back one row per group with a count in it;
            // naming that field sums it instead of counting the rows.
            peekCountKey: { type: 'string', maxLen: 120, default: null },
            // How many related rows the panel lists before it stops and says
            // how many more there are. A hover panel that runs off the screen
            // is worse than one that admits it is showing the first few.
            peekLimit: { type: 'int', min: 1, max: 20, default: 6 },
            peekTitle: { type: 'string', maxLen: 80, default: null },
            // The tail under a truncated panel. `{count}` is replaced with how
            // many rows did not fit; it exists so an app that is not in English
            // can say so in its own words.
            peekMoreText: { type: 'string', maxLen: 80, default: null },
            // OFF by default: with a peek configured but this false, the badge
            // keeps reading badgeKey exactly as it always has.
            peekBadge: { type: 'boolean', default: false },
        },
        // A list is the natural sidebar picker, so it needs to be clickable —
        // without an event it could only ever display.
        events: ['onRowClick'],
        styleKnobs: ['span', 'size', 'height'],
        defaultStyle: { span: 12 },
    },
    /**
     * approval_list — the viewer's approvals, decided IN the app.
     *
     * Deliberately a component with its own session-authed fetch, NOT a data
     * binding: every binding read runs acts-as-owner, while approvals must be
     * read and decided as the REAL signed-in viewer (the server's canView /
     * canDecide scoping). Anonymous/public viewers get a static sign-in wall
     * and no fetch at all — an `anon:` id can request an approval, never see
     * or decide one.
     *
     * scope 'mine' = everything waiting on this viewer, any source; 'app' =
     * this app's own requests (requester dashboards). onDecided fires after a
     * decision lands, with { approvalId, decision, reason, answers, context }
     * in the triggering form scope.
     */
    approval_list: {
        label: 'Approvals', category: 'Data',
        description: 'The signed-in viewer’s approval requests, decided in place. scope "mine" shows everything waiting on them; "app" shows this app’s own requests. Public visitors see a sign-in wall.',
        props: {
            scope: { type: 'enum', values: ['mine', 'app'], default: 'mine' },
            show: { type: 'enum', values: ['waiting', 'decided', 'all'], default: 'waiting' },
            limit: { type: 'int', min: 1, max: 50, default: 10 },
            emptyText: { type: 'string', maxLen: 200, default: 'No approvals right now.' },
            // Inline expand with details + decision controls; false = a compact
            // read-only list that links to the Approvals section instead.
            showDetails: { type: 'boolean', default: true },
        },
        events: ['onDecided'],
        styleKnobs: ['span', 'size', 'height'],
        defaultStyle: { span: 12 },
    },
};

module.exports = {
    RECORD_LIST_SPECS,
};
