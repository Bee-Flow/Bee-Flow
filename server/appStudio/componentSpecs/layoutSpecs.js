/**
 * App Studio catalog — the container types (tabs/tab, modal, repeater,
 * container, pane) plus the page header and the markdown block they frame.
 */

'use strict';

const { COLOR_ROLES } = require('./styleKnobs');

const LAYOUT_SPECS = {
    // ── v2 containers ────────────────────────────────────────────────────
    tabs: {
        label: 'Tabs', category: 'Layout',
        description: 'A tab strip. Its children should be `tab` containers; each tab holds its own 12-column grid.',
        container: true,
        props: {
            // Look pass. 'underline' is truthful: AppTabs renders a bottom-
            // ruled strip whose active tab carries a 2px primary underline.
            look: {
                type: 'enum', values: ['underline', 'pills', 'boxed'], default: 'underline',
                description: 'underline = the current underlined strip (active tab gets a primary underline); pills = rounded filled tab buttons; boxed = bordered folder-style tabs joined to the panel.',
            },
        },
        styleKnobs: ['span', 'gap', 'padding', 'height'],
        defaultStyle: { span: 12, gap: 3, padding: 0 },
    },
    tab: {
        label: 'Tab', category: 'Layout',
        description: 'A single tab panel inside a `tabs` container.',
        container: true,
        props: {
            label: { type: 'string', required: true, maxLen: 80, default: 'Tab' },
            icon: { type: 'icon', default: null },
            badge: {
                type: 'binding', default: null,
                description: 'Count or short text beside the label; empty/0 shows nothing.',
            },
            // Identity first: 'neutral' is the plain muted counter.
            badgeTone: {
                type: 'enum', values: ['neutral', ...COLOR_ROLES.filter((t) => t !== 'neutral')], default: 'neutral',
                description: 'neutral = plain muted count; other tones = a small tinted pill.',
            },
        },
        styleKnobs: ['gap', 'padding', 'height'],
        defaultStyle: { gap: 3, padding: 0 },
    },
    modal: {
        label: 'Modal', category: 'Layout',
        description: 'A dialog opened by an open_modal action (targeting its id). Groups components on its own grid.',
        container: true,
        props: {
            title: { type: 'string', maxLen: 120, default: null },
            size: { type: 'enum', values: ['sm', 'md', 'lg'], default: 'md' },
            // Identity first: 'center' is the dialog it has always been.
            placement: {
                type: 'enum', values: ['center', 'left', 'right', 'bottom'], default: 'center',
                description: 'center = the current dialog; left/right = a full-height panel against that edge; bottom = a sheet.',
            },
            triggerLabel: { type: 'string', maxLen: 80, default: null },
        },
        styleKnobs: ['gap', 'padding'],
        defaultStyle: { gap: 3, padding: 4 },
    },
    repeater: {
        label: 'Repeater', category: 'Data',
        description: 'Repeats its child components once per item of an array binding. Inside, `item` and `index` are in scope for formulas.',
        container: true,
        props: {
            source: { type: 'binding', default: { kind: 'static', value: [] } },
            itemActions: {
                type: 'list', maxItems: 8, default: [],
                itemShape: { label: { type: 'string', required: true, maxLen: 80 }, actionId: { type: 'string', maxLen: 20 } },
            },
            emptyText: { type: 'string', maxLen: 200, default: 'Nothing to show yet.' },
        },
        styleKnobs: ['span', 'gap', 'padding'],
        defaultStyle: { span: 12, gap: 3, padding: 0 },
    },

    // ── v2.1 layout & content ────────────────────────────────────────────
    container: {
        label: 'Container', category: 'Layout',
        description: 'A chrome-free container. Children lay out on its own 12-column grid — use several side by side for column layouts.',
        container: true,
        props: {
            // Look pass. 'plain' = the chrome-free container it has always
            // been; the others give a grouping a face without reaching for a
            // card (whose title/padding semantics are often unwanted).
            look: {
                type: 'enum', values: ['plain', 'panel', 'tinted', 'outlined'], default: 'plain',
                description: 'plain = invisible, layout only; panel = recessed grouping surface; tinted = soft primary wash; outlined = hairline border, no fill.',
            },
        },
        styleKnobs: ['span', 'padding', 'gap', 'background', 'radius', 'height', 'border'],
        defaultStyle: { span: 6, gap: 3 },
    },
    pane: {
        label: 'Pane', category: 'Layout',
        description: 'A stack; children keep their natural size except one with height "fill", which takes the rest. scroll:"auto" gives it its own scrollbar. Two panes in a section with height "fill" = a sidebar plus detail, scrolling independently. Children are stacked, so their span is IGNORED — nest a container for columns.',
        container: true,
        props: {
            direction: { type: 'enum', values: ['vertical', 'horizontal'], default: 'vertical' },
            scroll: { type: 'enum', values: ['none', 'auto'], default: 'none' },
        },
        styleKnobs: ['span', 'padding', 'gap', 'background', 'radius', 'height', 'border'],
        defaultStyle: { span: 12, gap: 3, height: 'fill' },
    },
    page_header: {
        label: 'Page header', category: 'Content',
        description: 'A page title with optional subtitle, icon and divider. Children render right-aligned as the action area (e.g. buttons).',
        container: true,
        props: {
            title: { type: 'string', required: true, maxLen: 120, default: 'Page title' },
            subtitle: { type: 'string', maxLen: 300, default: null },
            // The title of the thing on screen, not of the screen. Without these
            // an e-mail subject could only be shown as a labelled field inside a
            // record_detail — which is exactly why a conversation view read like
            // a form instead of like a conversation.
            titleFrom: { type: 'binding', default: { kind: 'static', value: null } },
            subtitleFrom: { type: 'binding', default: { kind: 'static', value: null } },
            icon: { type: 'icon', default: null },
            showDivider: { type: 'boolean', default: true },
            // Look pass. The header is the first thing a screen says about
            // itself — four registers instead of one is what makes two
            // generated apps stop opening identically.
            look: {
                type: 'enum', values: ['plain', 'banner', 'hero', 'split'], default: 'plain',
                description: 'plain = the current title row; banner = a full-width soft primary band; hero = a tall centered primary-gradient opening; split = title left, actions right on a panel surface.',
            },
        },
        styleKnobs: ['span', 'padding', 'gap'],
        defaultStyle: { span: 12, gap: 3, padding: 0 },
    },
    markdown: {
        label: 'Markdown', category: 'Content',
        description: 'A block of markdown: headings, lists, code blocks, links, bold/italic. No images or raw HTML. Bind contentFrom to show generated text (e.g. an AI summary in a variable).',
        props: {
            // Not required any more: with `contentFrom` bound the literal is the
            // fallback, and demanding placeholder prose for a block that shows
            // generated text would mean shipping that prose to the user.
            content: { type: 'markdown', default: '## Heading\n\nWrite **markdown** here.' },
            // Same pattern as `valueFrom` on the inputs: a binding that wins over
            // the literal when it resolves to text. Without it there was no way
            // to display anything an action produced — every text component took
            // a fixed string.
            contentFrom: { type: 'binding', default: { kind: 'static', value: null } },
        },
        styleKnobs: ['span', 'color'],
        defaultStyle: { span: 12 },
    },
};

module.exports = {
    LAYOUT_SPECS,
};
