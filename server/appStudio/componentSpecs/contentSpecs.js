/**
 * App Studio catalog — content & display primitives: headings, text, buttons,
 * images, the file/browser viewers, dividers, callouts and the stat tile.
 */

'use strict';

const { LIMITS } = require('./limits');
const { TOAST_TONES } = require('./actionSpecs');
const { COLOR_ROLES } = require('./styleKnobs');

const CONTENT_SPECS = {
    heading: {
        label: 'Heading', category: 'Content',
        description: 'A section or page title.',
        props: {
            text: { type: 'string', required: true, maxLen: 200, default: 'Heading' },
            level: { type: 'int', min: 1, max: 3, default: 2 },
            // Look pass. A register for the title without touching type scale —
            // `level` says how big, `accent` says how loud.
            accent: {
                type: 'enum', values: ['none', 'bar', 'tinted'], default: 'none',
                description: 'none = plain title; bar = a short primary accent bar beside the title; tinted = the title set in the app primary color.',
            },
        },
        styleKnobs: ['span', 'align', 'color'],
        defaultStyle: { span: 12 },
    },
    text: {
        label: 'Text', category: 'Content',
        description: 'A paragraph of text. Supports a small markdown subset (bold, italic, links).',
        props: {
            text: { type: 'markdown', required: true, default: 'Text' },
            muted: { type: 'boolean', default: false },
        },
        styleKnobs: ['span', 'align', 'color', 'weight', 'size'],
        defaultStyle: { span: 12 },
    },
    button: {
        label: 'Button', category: 'Basics',
        description: 'A clickable button. Wire its onClick to an action; role "submit" submits the enclosing form.',
        events: ['onClick'],
        props: {
            label: { type: 'string', required: true, maxLen: 80, default: 'Button' },
            // Look pass appended 'outline' and 'soft' — appended, never
            // reordered, so 'primary' stays the default and stored buttons
            // keep their exact rendering.
            variant: {
                type: 'enum', values: ['primary', 'secondary', 'ghost', 'danger', 'outline', 'soft'], default: 'primary',
                description: 'outline = transparent with a primary border and primary text; soft = filled with the soft primary tint, primary text.',
            },
            iconLeft: { type: 'icon', default: null },
            role: { type: 'enum', values: ['button', 'submit'], default: 'button' },
            disabledWhen: {
                type: 'formula', default: null,
                description: 'Truthy disables the button and blocks its action.',
            },
        },
        styleKnobs: ['span', 'size', 'align'],
        defaultStyle: { span: 3 },
    },
    image: {
        label: 'Image', category: 'Content',
        description: 'An image from an https URL. Broken sources render a neutral placeholder (no layout shift).',
        props: {
            src: { type: 'url', default: null },
            alt: { type: 'string', maxLen: 200, default: '' },
            fit: { type: 'enum', values: ['cover', 'contain'], default: 'cover' },
        },
        styleKnobs: ['span', 'height', 'radius', 'align'],
        defaultStyle: { span: 6, height: 'md' },
    },
    file_preview: {
        label: 'File preview', category: 'Content',
        description: 'Shows a PDF or image from a file column inline. Other types get a download link. Bind source to a file field.',
        props: {
            source: { type: 'binding', default: { kind: 'static', value: null } },
            emptyText: { type: 'string', maxLen: 200, default: 'No document selected.' },
            allowDownload: { type: 'boolean', default: true },
        },
        styleKnobs: ['span', 'height', 'radius'],
        defaultStyle: { span: 12, height: 'lg' },
    },
    browser_view: {
        label: 'Live browser', category: 'Content',
        description: 'Shows the live screenshot stream while an ai_browse step of the named action runs — the viewer watches the agent work. Idle it renders a placeholder; frames are never stored, so a reload shows only the step\'s text result. Wire `actionId` to the action whose sequence contains the ai_browse step.',
        props: {
            actionId: { type: 'string', required: true, maxLen: 60, default: '' },
            emptyText: { type: 'string', maxLen: 200, default: null },
            aspect: { type: 'enum', values: ['16:10', '16:9', '4:3'], default: '16:10' },
        },
        styleKnobs: ['span'],
        defaultStyle: { span: 12 },
    },
    divider: {
        label: 'Divider', category: 'Layout',
        description: 'A thin separator line.',
        props: {
            orientation: {
                type: 'enum', values: ['horizontal', 'vertical'], default: 'horizontal',
                description: 'vertical = a self-stretching 1px separator for flex rows (e.g. between page-header buttons).',
            },
        },
        styleKnobs: ['span'],
        defaultStyle: { span: 12 },
    },
    spacer: {
        label: 'Spacer', category: 'Layout',
        description: 'Empty vertical space.',
        props: { steps: { type: 'int', min: 1, max: 8, default: 2 } },
        styleKnobs: ['span'],
        defaultStyle: { span: 12 },
    },
    callout: {
        label: 'Callout', category: 'Content',
        description: 'A highlighted note with a tone (info, success, warning, danger).',
        props: {
            title: { type: 'string', maxLen: 120, default: null },
            // Not required any more (markdown.contentFrom pattern): with
            // `textFrom` bound the literal is only the fallback, and demanding
            // placeholder prose would ship that prose to the user.
            text: { type: 'markdown', default: 'Something worth highlighting.' },
            textFrom: {
                type: 'binding', default: { kind: 'static', value: null },
                description: 'Wins over `text` when it resolves to text.',
            },
            tone: { type: 'enum', values: TOAST_TONES, default: 'info' },
            toneFrom: {
                type: 'binding', default: { kind: 'static', value: null },
                description: 'Data-driven tone; a value outside the tone vocabulary falls back to `tone`.',
            },
            meta: {
                type: 'string', maxLen: 120, default: null,
                description: 'Right-aligned muted metadata line (owner, date).',
            },
            metaFrom: { type: 'binding', default: { kind: 'static', value: null } },
            // One line until you look at it: the full text arrives on hover or
            // focus in a panel that overlays rather than pushes. For a note
            // worth keeping and not worth six permanent lines — an AI summary
            // above the thing it summarises.
            collapsible: { type: 'boolean', default: false },
        },
        styleKnobs: ['span'],
        defaultStyle: { span: 12 },
    },
    stat: {
        label: 'Stat', category: 'Data',
        description: 'A KPI tile: a label and a big value. The value can bind to an action result. v2 adds an optional delta/trend row.',
        props: {
            label: { type: 'string', required: true, maxLen: 80, default: 'Metric' },
            value: { type: 'binding', default: { kind: 'static', value: '0' } },
            caption: { type: 'string', maxLen: 120, default: null },
            // Non-empty replaces `caption`. Texts render verbatim in sequence
            // (the author owns spaces/separators), each in its tone color.
            captionSegments: {
                type: 'list', maxItems: 6, default: [],
                itemShape: {
                    text: { type: 'string', required: true, maxLen: 120 },
                    tone: { type: 'enum', values: ['muted', ...COLOR_ROLES], default: 'muted' },
                },
                description: 'Replaces caption: parts of one line, each colored by its tone.',
            },
            icon: { type: 'icon', default: null },
            // v2 (all optional, additive)
            delta: { type: 'binding', default: { kind: 'static', value: null } },
            deltaFormat: { type: 'enum', values: ['number', 'percent'], default: 'number' },
            trend: { type: 'binding', default: { kind: 'static', value: null } },
            positiveIsGood: { type: 'boolean', default: true },
            // Look pass. A KPI row is the first thing every dashboard shows,
            // so it is where sameness was most visible.
            look: {
                type: 'enum', values: ['plain', 'tile', 'tinted', 'accent', 'gradient'], default: 'plain',
                description: 'plain = label and value only; tile = on its own card surface; tinted = soft primary wash; accent = tile with a primary edge bar; gradient = soft primary gradient wash, value in the primary color.',
            },
        },
        styleKnobs: ['span', 'size', 'align', 'color'],
        defaultStyle: { span: 3 },
    },
    keyValue: {
        label: 'Key–value', category: 'Data',
        description: 'Renders an object as label/value rows (e.g. one record from a routine result).',
        props: {
            source: { type: 'binding', default: { kind: 'static', value: null } },
            fields: {
                type: 'list', maxItems: LIMITS.MAX_KEYVALUE_FIELDS, default: [],
                itemShape: { key: { type: 'string', required: true, maxLen: 120 }, label: { type: 'string', maxLen: 120 } },
            },
            // 'rows' (identity) = label left, value right. 'grid' stacks label
            // over value across `columns`, with a divider between columns.
            layout: { type: 'enum', values: ['rows', 'grid'], default: 'rows' },
            columns: { type: 'int', min: 1, max: 4, default: 2 },
            emptyText: { type: 'string', maxLen: 200, default: 'No data yet.' },
        },
        styleKnobs: ['span', 'size'],
        defaultStyle: { span: 6 },
    },
};

module.exports = {
    CONTENT_SPECS,
};
