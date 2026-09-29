/**
 * App Studio catalog — the per-record display components: badges, progress,
 * stepper, file gallery, connector status, timeline, message thread and the
 * record detail sheet.
 */

'use strict';

const { LIMITS } = require('./limits');
const { COLOR_ROLES } = require('./styleKnobs');

const RECORD_DISPLAY_SPECS = {
    // ── v2.1 data display ────────────────────────────────────────────────
    badge_list: {
        label: 'Badge list', category: 'Data',
        description: 'A row of colored badges over an array of objects (e.g. tags or statuses). colorMap assigns a color role and a readable label per value; countKey shows a number on each badge, so an aggregate binding renders as clickable status pills.',
        events: ['onRowClick'],
        props: {
            source: { type: 'binding', default: { kind: 'static', value: [] } },
            labelKey: { type: 'string', maxLen: 120, default: 'label' },
            colorKey: { type: 'string', maxLen: 120, default: null },
            // An aggregate binding already computes "42 open" in SQL. Without a
            // key to read the number from, the count came back and was thrown
            // away — so the pills were decoration over a query that had the
            // answer.
            countKey: { type: 'string', maxLen: 120, default: null },
            colorMap: {
                type: 'list', maxItems: 20, default: [],
                itemShape: {
                    value: { type: 'string', required: true, maxLen: 200 },
                    // Drift, not new vocabulary: list.badgeToneMap has had
                    // `label` all along. Without it a pill grouped by a status
                    // column reads the raw value — "awaiting_user".
                    label: { type: 'string', maxLen: 80 },
                    color: { type: 'enum', values: COLOR_ROLES, default: 'neutral' },
                },
            },
            emptyText: { type: 'string', maxLen: 200, default: 'Nothing to show yet.' },
            // Per-pill formula (`item`, `index` in scope). A truthy match makes
            // that one pill solid (filled tone + contrast text) while the rest
            // keep `look` — a pill row reads as a visible filter state.
            activeWhen: { type: 'formula', default: null },
            // Look pass. 'soft' is truthful: today's pills are a soft tint of
            // their role color (12% wash), never a filled chip.
            look: {
                type: 'enum', values: ['soft', 'outline', 'solid'], default: 'soft',
                description: 'soft = the current soft-tinted pills; outline = transparent pills with a colored border; solid = filled pills with contrast text.',
            },
        },
        styleKnobs: ['span', 'size', 'align'],
        defaultStyle: { span: 12 },
    },
    progress: {
        label: 'Progress', category: 'Data',
        description: 'A progress bar: a bound value against a maximum, with an optional label and a percent/fraction caption.',
        props: {
            value: { type: 'binding', default: { kind: 'static', value: 0 } },
            /**
             * BINDABLE, because a denominator is usually data. A capacity bar
             * whose ceiling is a literal 100 is not measuring capacity — it is
             * drawing a percentage of an invented number, and it clamps, so
             * being over the real target reads as exactly on it.
             *
             * A bare number still works: canonicalize wraps it as
             * { kind:'static', value: n }, so every app saved before this keeps
             * its ceiling with no migration.
             */
            max: { type: 'binding', default: { kind: 'static', value: 100 } },
            format: { type: 'enum', values: ['percent', 'fraction', 'none'], default: 'percent' },
            label: { type: 'string', maxLen: 80, default: null },
            tone: { type: 'enum', values: COLOR_ROLES, default: 'primary' },
            // Empty = identity: the single value/max bar, byte-identical.
            segments: {
                type: 'list', maxItems: 6, default: [],
                itemShape: {
                    value: { type: 'binding', required: true },
                    tone: { type: 'enum', values: COLOR_ROLES, default: 'primary' },
                    label: { type: 'string', maxLen: 80 },
                },
                description: 'Stacked distribution bar (looks bar/slim): widths normalized to the sum of values.',
            },
            // Look pass. 'ring' is what turns a progress into a dashboard
            // gauge — the shape a completion KPI actually wants.
            /**
             * Refresh THIS component on a timer, without touching the rest of
             * the screen.
             *
             * The screen already has `refreshInterval`, and it applies to every
             * binding on it — which is why watching one long step made the
             * whole page twitch. These two say "only me, and only while
             * something is happening": `liveWhile` is a formula (an action's
             * status variable, say), and when it is falsy nothing polls at all.
             */
            liveSeconds: { type: 'enum', values: [0, 2, 5, 10, 30], default: 0 },
            liveWhile: { type: 'binding', default: null },
            look: {
                type: 'enum', values: ['bar', 'slim', 'ring'], default: 'bar',
                description: 'bar = the current horizontal bar; slim = a thin hairline bar; ring = a circular gauge with the value in the center.',
            },
        },
        styleKnobs: ['span', 'size'],
        defaultStyle: { span: 6 },
    },
    stepper: {
        label: 'Stepper', category: 'Data',
        description: 'The stages of a process: the step matching `value` is current, earlier ones done. Says where a record IS, which a status dropdown never does. onRowClick fires with { value, label, index }.',
        events: ['onRowClick'],
        props: {
            value: { type: 'binding', default: { kind: 'static', value: null } },
            steps: {
                type: 'list', maxItems: LIMITS.MAX_STEPPER_STEPS, default: [],
                itemShape: {
                    value: { type: 'string', required: true, maxLen: 200 },
                    label: { type: 'string', maxLen: 120 },
                    icon: { type: 'icon' },
                    // What this step is waiting on, shown on hover or focus.
                    // A binding, because the useful sentence is live — "2 lines
                    // are missing a material" — not a caption written once. It
                    // lets the progress bar carry the status note that would
                    // otherwise need its own permanent strip under it.
                    hint: { type: 'binding' },
                },
            },
            orientation: { type: 'enum', values: ['horizontal', 'vertical'], default: 'horizontal' },
            tone: { type: 'enum', values: COLOR_ROLES, default: 'primary' },
            showLabels: { type: 'boolean', default: true },
        },
        styleKnobs: ['span', 'size', 'align'],
        defaultStyle: { span: 12 },
    },
    file_gallery: {
        label: 'File gallery', category: 'Data',
        description: 'Attachments as cards: a thumbnail for images, a type icon otherwise, plus filename and size. Pairs with file_preview — onRowClick publishes the picked row so the preview can show it.',
        events: ['onRowClick'],
        props: {
            source: { type: 'binding', default: { kind: 'static', value: [] } },
            fileKey: { type: 'string', maxLen: 120, default: 'file' },
            titleKey: { type: 'string', maxLen: 120, default: 'filename' },
            subtitleKey: { type: 'string', maxLen: 120, default: null },
            sizeKey: { type: 'string', maxLen: 120, default: null },
            /**
             * Group the cards under a heading per value of this column, with a
             * count beside it. An unpacked order archive is one folder per
             * article plus a folder of labels; as 243 loose cards that is a
             * pile, and the folder is also the thing that says which of them
             * are parts. Rows whose value is empty stay ungrouped, first.
             */
            groupKey: { type: 'string', maxLen: 120, default: null },
            columns: { type: 'int', min: 1, max: 6, default: 3 },
            // 300, not 100: an order package runs to a few hundred files, and a
            // ceiling below the real number makes "show me everything"
            // impossible however well it is grouped.
            rowLimit: { type: 'int', min: 1, max: 300, default: 24 },
            emptyText: { type: 'string', maxLen: 200, default: 'No files yet.' },
            /**
             * Refresh THIS component on a timer, without touching the rest of
             * the screen.
             *
             * The screen already has `refreshInterval`, and it applies to every
             * binding on it — which is why watching one long step made the
             * whole page twitch. These two say "only me, and only while
             * something is happening": `liveWhile` is a formula (an action's
             * status variable, say), and when it is falsy nothing polls at all.
             */
            liveSeconds: { type: 'enum', values: [0, 2, 5, 10, 30], default: 0 },
            liveWhile: { type: 'binding', default: null },
        },
        styleKnobs: ['span', 'size', 'height'],
        defaultStyle: { span: 12 },
    },
    connector_status: {
        label: 'Connection status', category: 'Data',
        description: 'Live state of one connector: which account it reads, whether it is connected, when it last ran, and a Refresh now button. Put it on a settings screen so users can SEE their data source.',
        props: {
            connectorId: { type: 'string', required: true, maxLen: 40, default: '' },
            title: { type: 'string', maxLen: 120, default: null },
            showSync: { type: 'boolean', default: true },
        },
        styleKnobs: ['span', 'padding', 'background', 'radius', 'border'],
        defaultStyle: { span: 12 },
    },
    timeline: {
        label: 'Timeline', category: 'Data',
        description: 'A vertical timeline over an array of objects, one entry per row, dated by dateKey.',
        events: ['onRowClick'],
        props: {
            source: { type: 'binding', default: { kind: 'static', value: [] } },
            titleKey: { type: 'string', maxLen: 120, default: 'title' },
            dateKey: { type: 'string', maxLen: 120, default: 'created_at' },
            descriptionKey: { type: 'string', maxLen: 120, default: null },
            metaKey: {
                type: 'string', maxLen: 120, default: null,
                description: 'Field rendered beside the date as a byline — who or what produced the entry (an author, a source, a system name). Null keeps the date alone.',
            },
            icon: { type: 'icon', default: null },
            rowLimit: { type: 'int', min: 1, max: 100, default: 25 },
            emptyText: { type: 'string', maxLen: 200, default: 'Nothing to show yet.' },
        },
        styleKnobs: ['span', 'size', 'height'],
        defaultStyle: { span: 12 },
    },
    message_thread: {
        label: 'Message thread', category: 'Data',
        description: 'A chat-style conversation over message rows. sideMap maps a row value (who wrote it) to a side + colour: right for your team, left for the customer, center for system events. htmlField renders e-mail HTML in a sandboxed frame; otherwise bodyField is plain text.',
        events: ['onRowClick'],
        props: {
            source: { type: 'binding', default: { kind: 'static', value: [] } },
            bodyField: { type: 'string', maxLen: 120, default: 'body' },
            htmlField: { type: 'string', maxLen: 120, default: null },
            authorField: { type: 'string', maxLen: 120, default: 'author' },
            timestampField: { type: 'string', maxLen: 120, default: 'created_at' },
            sideField: { type: 'string', maxLen: 120, default: null },
            // One list instead of four booleans (internal note? system? ours?
            // theirs?). A repeater cannot express this at all: `computed`
            // overrides PROPS, never style, so per-row appearance driven by a
            // field has no other home.
            sideMap: {
                type: 'list', maxItems: 8, default: [],
                itemShape: {
                    value: { type: 'string', required: true, maxLen: 200 },
                    side: { type: 'enum', values: ['left', 'right', 'center'], default: 'left' },
                    tone: { type: 'enum', values: COLOR_ROLES, default: 'neutral' },
                },
            },
            attachmentsField: { type: 'string', maxLen: 120, default: null },
            attachmentLabelKey: { type: 'string', maxLen: 120, default: 'filename' },
            // Mail attachments almost never live ON the message row: a sync
            // writes them to their own table keyed by the provider's message
            // id. attachmentsField cannot reach those, so the chips silently
            // never appeared. Point attachmentsSource at that table and name
            // the id both rows carry; the rows are grouped once, not per row.
            attachmentsSource: { type: 'binding', default: null },
            attachmentMatchKey: { type: 'string', maxLen: 120, default: null },
            citationsField: { type: 'string', maxLen: 120, default: null },
            citationLabelKey: { type: 'string', maxLen: 120, default: 'title' },
            // Mail-header meta. Any of these (or showAvatar) turns the line above
            // the bubble into a header: name + <email>, an "Aan/Onderwerp" line,
            // time on the right. All null = today's author + time line, unchanged.
            emailField: { type: 'string', maxLen: 120, default: null },
            toField: { type: 'string', maxLen: 120, default: null },
            subjectField: { type: 'string', maxLen: 120, default: null },
            showAvatar: { type: 'boolean', default: false },
            // 'inline' prefixes system (center) rows with their timestamp.
            centerMeta: { type: 'enum', values: ['hidden', 'inline'], default: 'hidden' },
            // What happened BETWEEN the messages — read, assigned, extracted —
            // is a second table, and sideMap can only colour rows that are
            // already in `source`. These merge that table in by timestamp and
            // render its rows as center lines, so the trail reads in order
            // instead of forcing a second panel beside the conversation.
            eventsSource: { type: 'binding', default: null },
            eventsBodyField: { type: 'string', maxLen: 120, default: 'detail' },
            eventsTimestampField: { type: 'string', maxLen: 120, default: 'at' },
            rowLimit: { type: 'int', min: 1, max: 200, default: 100 },
            emptyText: { type: 'string', maxLen: 200, default: 'No messages yet.' },
        },
        styleKnobs: ['span', 'size', 'height'],
        defaultStyle: { span: 12, height: 'fill' },
    },
    record_detail: {
        label: 'Record detail', category: 'Data',
        description: 'Labeled fields of ONE record — typically a {kind:"record"} binding whose filter uses screen.params (pairs with navigate params).',
        props: {
            source: { type: 'binding', default: { kind: 'static', value: null } },
            fields: {
                type: 'list', maxItems: LIMITS.MAX_RECORD_DETAIL_FIELDS, default: [],
                itemShape: {
                    key: { type: 'string', required: true, maxLen: 120 },
                    label: { type: 'string', maxLen: 120 },
                    // 'document'/'cad' render the file itself — a thumbnail you
                    // can open — instead of the descriptor. Without them a file
                    // field had no honest format here: 'text' printed the raw
                    // {kind, fileId, mime, …} JSON into the panel, which is
                    // both unreadable and not clickable. Appended, never
                    // reordered: the first value stays the default.
                    format: { type: 'enum', values: ['text', 'number', 'date', 'datetime', 'badge', 'link', 'markdown', 'document', 'cad'], default: 'text' },
                    // Fields sharing a group render under one small uppercase
                    // heading, in order of first appearance. "Maten & bewerking"
                    // above six facts reads; six labels in a row does not.
                    group: { type: 'string', maxLen: 80 },
                },
            },
            columns: { type: 'int', min: 1, max: 3, default: 2 },
            emptyText: { type: 'string', maxLen: 200, default: 'No record selected.' },
            // 'stacked' is what every record_detail renders today: the label
            // above its value. 'rows' puts label and value on ONE line, value
            // right-aligned, a hairline under each — the fact sheet a narrow
            // side panel can actually hold, where the stacked form spends two
            // lines on "Certificaat / 0".
            layout: { type: 'enum', values: ['stacked', 'rows'], default: 'stacked' },
        },
        styleKnobs: ['span', 'padding', 'background', 'radius', 'border', 'height'],
        defaultStyle: { span: 12 },
    },
};

module.exports = {
    RECORD_DISPLAY_SPECS,
};
